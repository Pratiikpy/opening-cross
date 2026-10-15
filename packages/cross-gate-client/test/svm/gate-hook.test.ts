// cross_gate as a Token-2022 transfer hook with compliance rules (ADR-0900): recipients need a pass, affiliates are
// held to blackout windows and a rolling volume limit, resale locks follow the lock delegate and the cross program,
// and the CPI-only hooks (allocation reservations, resale locks on receipt) refuse every caller but a real cross.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Address, type KeyPairSigner, address, generateKeyPairSigner } from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import { TOKEN_2022_PROGRAM_ADDRESS, getTransferCheckedInstruction, getInitializeMint2Instruction, getPreInitializeInstructionsForMintExtensions, getMintSize, getMintToInstruction } from '@solana-program/token-2022';
import {
  FLAG,
  Mode,
  Tier,
  allocationKey,
  buildRules,
  countryNumeric,
  decodeAllocation,
  decodeVolume,
  findAllocationAddress,
  findConfigPda,
  findExtraMetasPda,
  findLockAddress,
  findPassAddress,
  findTermsAddress,
  findVolumeAddress,
  getCreateConfigInstruction,
  getGrantPassInstruction,
  getInitHookMetasInstruction,
  getLockDecoder,
  getReceiveLockedInstruction,
  getReleaseAllocationInstruction,
  getReserveAllocationInstruction,
  getSetLockInstruction,
  getUpdateHookMetasInstruction,
  detectHookListVersion,
  updateHookMetas,
  grantPassTerms,
  openVolume,
  initRules,
  initRulesWithHook,
  setRules,
  withHookAccounts,
  CROSS_GATE_PROGRAM_ADDRESS,
} from '../../src/index.js';
import { CROSS_CORE_PROGRAM_ADDRESS } from '../../../cross-core-client/src/index.js';
import { World } from '../../../../tests/core/src/world.js';
import { T0 } from '../../../../tests/core/src/harness.js';

const IN = countryNumeric('IN')!;
const id32 = (n: number) => new Uint8Array(32).fill(n);
const terms = (n: number, flags = FLAG.kyc, cap = 0n) => ({ identity: id32(n), country: IN, tier: Tier.retail, flags, cap, expiresTs: 0n });

/** A Token-2022 mint whose transfer hook is cross_gate, with its gate config, mint authority kept by `admin`. */
async function hookedMint(w: World, opts: { v1List?: boolean } = {}) {
  const mint = await generateKeyPairSigner();
  const extensions = [{ __kind: 'TransferHook' as const, authority: w.admin.address, programId: CROSS_GATE_PROGRAM_ADDRESS }];
  const space = getMintSize(extensions);
  await w.h.send(
    [
      getCreateAccountInstruction({ payer: w.admin, newAccount: mint, lamports: w.h.svm.minimumBalanceForRentExemption(BigInt(space)), space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
      ...getPreInitializeInstructionsForMintExtensions(mint.address, extensions),
      getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: w.admin.address, freezeAuthority: null }),
    ],
    w.admin,
  );
  const [config] = await findConfigPda({ mint: mint.address });
  const [extraMetas] = await findExtraMetasPda({ mint: mint.address });
  await w.h.send(
    [
      getCreateConfigInstruction({ payer: w.admin, mintAuthority: w.admin, mint: mint.address, config, authority: w.admin.address, mode: Mode.Allowlist }),
      getInitHookMetasInstruction({ payer: w.admin, authority: w.admin, mint: mint.address, config, extraMetas }),
    ],
    w.admin,
  );
  void opts;
  return { mint: mint.address, config, extraMetas };
}

async function fund(w: World, mint: Address, to: Address, amount: bigint) {
  const ata = await w.h.ata(to, mint, w.admin);
  await w.h.send([getMintToInstruction({ mint, token: ata, mintAuthority: w.admin, amount }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })], w.admin);
  return ata;
}

async function holder(w: World, mint: Address, who: KeyPairSigner, n: number, flags = FLAG.kyc) {
  await w.h.send([await grantPassTerms({ authority: w.admin, mint, owner: who.address, terms: terms(n, flags) })], w.admin);
  return w.h.ata(who.address, mint, w.admin);
}

const send = async (_w: World, mint: Address, from: KeyPairSigner, fromAta: Address, to: Address, toAta: Address, amount: bigint, listVersion: 1 | 2 = 2) =>
  withHookAccounts(getTransferCheckedInstruction({ source: fromAta, mint, destination: toAta, authority: from, amount, decimals: 6 }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }), { mint, sourceOwner: from.address, destinationOwner: to, listVersion });

describe('cross_gate transfer hook with rules', () => {
  it('only a wallet with a pass can receive; the rules add nothing for ordinary holders', async () => {
    const w = await World.create();
    const { mint, config } = await hookedMint(w);
    await w.h.send(await initRulesWithHook({ payer: w.admin, authority: w.admin, mint, rules: buildRules({ affiliateLimit: { windowSecs: 3600n, maxAmount: 100n } }) }), w.admin);
    void config;
    const alice = await w.trader();
    const bob = await w.trader();
    const carol = await w.trader();
    const aliceAta = await holder(w, mint, alice, 1);
    const bobAta = await holder(w, mint, bob, 2);
    const carolAta = await w.h.ata(carol.address, mint, w.admin);
    await w.h.send([getMintToInstruction({ mint, token: aliceAta, mintAuthority: w.admin, amount: 1_000_000n }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })], w.admin);
    await w.h.send([await send(w, mint, alice, aliceAta, bob.address, bobAta, 400_000n)], alice);
    expect(w.h.balance(bobAta)).toBe(400_000n);
    expect(await w.h.fail([await send(w, mint, alice, aliceAta, carol.address, carolAta, 1n)], alice)).toContain('RecipientNotAllowed');
  });

  it('an affiliate is blocked inside a blackout window and held to the volume limit; everyone else is not', async () => {
    const w = await World.create();
    const { mint } = await hookedMint(w);
    const blackout = { start: T0 + 1_000n, end: T0 + 2_000n };
    await w.h.send(await initRulesWithHook({ payer: w.admin, authority: w.admin, mint, rules: buildRules({ blackouts: [blackout], affiliateLimit: { windowSecs: 400n, maxAmount: 300n } }) }), w.admin);
    const insider = await w.trader();
    const retail = await w.trader();
    const sink = await w.trader();
    const insiderAta = await holder(w, mint, insider, 1, FLAG.kyc | FLAG.affiliate);
    const retailAta = await holder(w, mint, retail, 2);
    const sinkAta = await holder(w, mint, sink, 3);
    await w.h.send([getMintToInstruction({ mint, token: insiderAta, mintAuthority: w.admin, amount: 10_000n }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }), getMintToInstruction({ mint, token: retailAta, mintAuthority: w.admin, amount: 10_000n }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })], w.admin);
    const volume = async () => decodeVolume((w.h.svm.getAccount((await findVolumeAddress(mint, insider.address))[0]) as { data: Uint8Array }).data);

    // Within the volume window: 200 + 100 = 300 passes, one more atom does not.
    await w.h.send([await send(w, mint, insider, insiderAta, sink.address, sinkAta, 200n)], insider);
    await w.h.send([await send(w, mint, insider, insiderAta, sink.address, sinkAta, 100n)], insider);
    expect((await volume()).sold).toBe(300n);
    expect(await w.h.fail([await send(w, mint, insider, insiderAta, sink.address, sinkAta, 1n)], insider)).toContain('VolumeLimit');
    expect((await volume()).sold).toBe(300n);
    // An ordinary holder is not limited by the affiliate rules.
    await w.h.send([await send(w, mint, retail, retailAta, sink.address, sinkAta, 5_000n)], retail);
    // The window rolls: after it ends the insider may sell again.
    w.h.setTime(T0 + 400n);
    await w.h.send([await send(w, mint, insider, insiderAta, sink.address, sinkAta, 50n)], insider);
    expect((await volume()).sold).toBe(50n);
    // Inside the blackout the insider cannot move anything, the ordinary holder still can.
    w.h.setTime(T0 + 1_500n);
    expect(await w.h.fail([await send(w, mint, insider, insiderAta, sink.address, sinkAta, 1n)], insider)).toContain('Blackout');
    await w.h.send([await send(w, mint, retail, retailAta, sink.address, sinkAta, 1n)], retail);
    // After the blackout the insider is free again (inside the volume limit).
    w.h.setTime(T0 + 2_000n);
    await w.h.send([await send(w, mint, insider, insiderAta, sink.address, sinkAta, 10n)], insider);
  });

  it('the receiver is held to the rules at every transfer: lapsed terms and a rule change stop a transfer before anyone closes the pass', async () => {
    const w = await World.create();
    const { mint } = await hookedMint(w);
    await w.h.send(await initRulesWithHook({ payer: w.admin, authority: w.admin, mint, rules: buildRules({ countryPolicy: 'allow', countries: ['IN', 'GB'] }) }), w.admin);
    const GB = countryNumeric('GB')!;
    const sender = await w.trader();
    const indian = await w.trader();
    const briton = await w.trader();
    const lapsing = await w.trader();
    const grant = (who: KeyPairSigner, n: number, o: { country?: number; expiresTs?: bigint } = {}) =>
      grantPassTerms({ authority: w.admin, mint, owner: who.address, terms: { ...terms(n), country: o.country ?? IN, expiresTs: o.expiresTs ?? 0n } });
    await w.h.send([await grant(sender, 1), await grant(indian, 2), await grant(briton, 3, { country: GB }), await grant(lapsing, 4, { expiresTs: T0 + 500n })], w.admin);
    const senderAta = await w.h.ata(sender.address, mint, w.admin);
    await w.h.send([getMintToInstruction({ mint, token: senderAta, mintAuthority: w.admin, amount: 1_000n }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })], w.admin);
    const ataOf = new Map<Address, Address>();
    for (const who of [indian, briton, lapsing]) ataOf.set(who.address, await w.h.ata(who.address, mint, w.admin));
    const pay = (to: KeyPairSigner, amount = 1n) => send(w, mint, sender, senderAta, to.address, ataOf.get(to.address)!, amount);

    await w.h.send([await pay(indian)], sender);
    await w.h.send([await pay(briton)], sender);
    await w.h.send([await pay(lapsing)], sender);
    // The terms of one receiver lapse: the pass is still on chain (nobody has closed it) but it no longer admits transfers.
    w.h.setTime(T0 + 500n);
    expect(await w.h.fail([await pay(lapsing)], sender)).toContain('TermsExpired');
    await w.h.send([await pay(indian)], sender);
    // The issuer drops the UK from the allow list. The British holder's pass still exists, and cannot receive any more.
    await w.h.send([await setRules({ authority: w.admin, mint, rules: buildRules({ countryPolicy: 'allow', countries: ['IN'] }) })], w.admin);
    expect(await w.h.fail([await pay(briton)], sender)).toContain('CountryNotAllowed');
    await w.h.send([await pay(indian)], sender);
    // The British holder keeps what it already had.
    expect(w.h.balance(ataOf.get(briton.address)!)).toBe(1n);
  });

  it('open_volume lets an affiliate transfer once the gate turns the volume limit on after its pass was issued', async () => {
    const w = await World.create();
    const { mint } = await hookedMint(w);
    await w.h.send(await initRulesWithHook({ payer: w.admin, authority: w.admin, mint, rules: buildRules({}) }), w.admin);
    const insider = await w.trader();
    const sink = await w.trader();
    const retail = await w.trader();
    const insiderAta = await holder(w, mint, insider, 1, FLAG.kyc | FLAG.affiliate);
    const sinkAta = await holder(w, mint, sink, 2);
    const retailAta = await holder(w, mint, retail, 3);
    await w.h.send([getMintToInstruction({ mint, token: insiderAta, mintAuthority: w.admin, amount: 1_000n }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })], w.admin);
    // Without a limit the insider's pass has no volume account and needs none.
    expect(await w.h.fail([await openVolume({ payer: w.admin, mint, owner: insider.address })], w.admin)).toContain('NoVolumeLimit');
    await w.h.send([await send(w, mint, insider, insiderAta, sink.address, sinkAta, 10n)], insider);
    // The limit comes on later: the insider's pass was issued without a volume account, so it cannot sell until one exists.
    await w.h.send([await setRules({ authority: w.admin, mint, rules: buildRules({ affiliateLimit: { windowSecs: 3_600n, maxAmount: 100n } }) })], w.admin);
    expect(await w.h.fail([await send(w, mint, insider, insiderAta, sink.address, sinkAta, 1n)], insider)).toContain('VolumeMissing');
    // Only an affiliate has one, whoever pays for it.
    expect(await w.h.fail([await openVolume({ payer: w.admin, mint, owner: retail.address })], w.admin)).toContain('NotAffiliate');
    await w.h.send([await openVolume({ payer: sink, mint, owner: insider.address })], sink);
    const [volume] = await findVolumeAddress(mint, insider.address);
    expect(decodeVolume((w.h.svm.getAccount(volume) as { data: Uint8Array }).data).sold).toBe(0n);
    await w.h.send([await send(w, mint, insider, insiderAta, sink.address, sinkAta, 100n)], insider);
    expect(await w.h.fail([await send(w, mint, insider, insiderAta, sink.address, sinkAta, 1n)], insider)).toContain('VolumeLimit');
    // Opening it again changes nothing.
    await w.h.send([await openVolume({ payer: sink, mint, owner: insider.address })], sink);
    expect(decodeVolume((w.h.svm.getAccount(volume) as { data: Uint8Array }).data).sold).toBe(100n);
    // A retail holder is never limited.
    await w.h.send([getMintToInstruction({ mint, token: retailAta, mintAuthority: w.admin, amount: 1_000n }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })], w.admin);
    await w.h.send([await send(w, mint, retail, retailAta, sink.address, sinkAta, 900n)], retail);
  });

  it('a gate keeps the short hook list until it asks for rules; the list grows only through the authority, and only for a hooked mint', async () => {
    const w = await World.create();
    const { mint, config, extraMetas } = await hookedMint(w);
    const list = () => (w.h.svm.getAccount(extraMetas) as { data: Uint8Array }).data;
    expect(detectHookListVersion(list())).toBe(1);
    const a = await w.trader();
    const b = await w.trader();
    const [passA] = await findPassAddress(mint, a.address);
    const [passB] = await findPassAddress(mint, b.address);
    await w.h.send([getGrantPassInstruction({ authority: w.admin, config, owner: a.address, pass: passA } as never), getGrantPassInstruction({ authority: w.admin, config, owner: b.address, pass: passB } as never)], w.admin);
    const aAta = await fund(w, mint, a.address, 1_000n);
    const bAta = await w.h.ata(b.address, mint, w.admin);
    // Without rules there is nothing to rewrite, and the short list is the whole contract with existing clients.
    expect(await w.h.fail([await updateHookMetas({ payer: w.admin, authority: w.admin, mint })], w.admin)).toContain('RulesNotActive');
    expect(detectHookListVersion(list())).toBe(1);
    await w.h.send([await send(w, mint, a, aAta, b.address, bAta, 10n, 1)], a);
    // Rules on, list not yet rewritten: transfers are refused, not waved through.
    await w.h.send([await initRules({ authority: w.admin, mint, rules: buildRules({ passes: 2 }) })], w.admin);
    expect(await w.h.fail([await send(w, mint, a, aAta, b.address, bAta, 1n, 1)], a)).toContain('RulesAccountsMissing');
    const stranger = await w.trader();
    expect(await w.h.fail([await updateHookMetas({ payer: stranger, authority: stranger, mint })], stranger)).toContain('Unauthorized');
    await w.h.send([await updateHookMetas({ payer: w.admin, authority: w.admin, mint })], w.admin);
    expect(detectHookListVersion(list())).toBe(2);
    await w.h.send([await send(w, mint, a, aAta, b.address, bAta, 1n, 2)], a);
    expect(w.h.balance(bAta)).toBe(11n);
    // Rewriting again changes nothing.
    await w.h.send([await updateHookMetas({ payer: w.admin, authority: w.admin, mint })], w.admin);
    expect(detectHookListVersion(list())).toBe(2);

    // A mint whose transfer hook is not this program has no list to rewrite.
    const plain = await w.h.mint(w.admin, 6);
    const [plainConfig] = await findConfigPda({ mint: plain });
    await w.h.send([getCreateConfigInstruction({ payer: w.admin, mintAuthority: w.admin, mint: plain, config: plainConfig, authority: w.admin.address, mode: Mode.Allowlist })], w.admin);
    await w.h.send([await initRules({ authority: w.admin, mint: plain, rules: buildRules({}) })], w.admin);
    expect(await w.h.fail([await updateHookMetas({ payer: w.admin, authority: w.admin, mint: plain })], w.admin)).toContain('WrongHookProgram');
  });

  // The pre-rules binary is the program deployed on devnet before this work (dump it with
  // `solana program dump 2pE7gApapcdmbk6713VbrWNjEg1iFFrd15SLt1pQwWqr <file> -u devnet`).
  const BASELINE = process.env.OC_GATE_BASELINE;
  it.skipIf(!BASELINE || !existsSync(BASELINE))('a gate created by the pre-rules binary survives the upgrade: transfers keep working on the old hook list, a gate with transfer rules refuses until the list is rewritten', async () => {
    const w = await World.create();
    const upgraded = `${(process.env.OC_DEPLOY_DIR ?? '').replace(/\/$/, '')}/cross_gate.so`;
    w.h.svm.addProgramFromFile(CROSS_GATE_PROGRAM_ADDRESS, BASELINE!);
    const { mint, config, extraMetas } = await hookedMint(w);
    // Written by the old binary: three extra accounts.
    expect((w.h.svm.getAccount(extraMetas) as { data: Uint8Array }).data.length).toBeLessThan(150);
    const a = await w.trader();
    const b = await w.trader();
    const [passA] = await findPassAddress(mint, a.address);
    const [passB] = await findPassAddress(mint, b.address);
    await w.h.send([getGrantPassInstruction({ authority: w.admin, config, owner: a.address, pass: passA } as never), getGrantPassInstruction({ authority: w.admin, config, owner: b.address, pass: passB } as never)], w.admin);
    const aAta = await fund(w, mint, a.address, 1_000n);
    const bAta = await w.h.ata(b.address, mint, w.admin);
    await w.h.send([await send(w, mint, a, aAta, b.address, bAta, 100n, 1)], a);

    // Upgrade the program in place.
    w.h.svm.addProgramFromFile(CROSS_GATE_PROGRAM_ADDRESS, upgraded);
    await w.h.send([await send(w, mint, a, aAta, b.address, bAta, 100n, 1)], a);
    expect(w.h.balance(bAta)).toBe(200n);
    // Once rules are on, the hook needs the receiver's and the sender's terms, which the old list does not carry: it fails
    // closed instead of skipping the rules, and keeps refusing until the list is rewritten.
    await w.h.send([await initRules({ authority: w.admin, mint, rules: buildRules({ passes: 2 }) })], w.admin);
    expect(await w.h.fail([await send(w, mint, a, aAta, b.address, bAta, 1n, 1)], a)).toContain('RulesAccountsMissing');
    // Only the authority rewrites the list; afterwards a current client's transfer works and the old client's does not.
    const stranger = await w.trader();
    expect(await w.h.fail([getUpdateHookMetasInstruction({ payer: stranger, authority: stranger, mint, config, extraMetas })], stranger)).toContain('Unauthorized');
    await w.h.send([getUpdateHookMetasInstruction({ payer: w.admin, authority: w.admin, mint, config, extraMetas })], w.admin);
    expect((w.h.svm.getAccount(extraMetas) as { data: Uint8Array }).data.length).toBeGreaterThan(150);
    await w.h.send([await send(w, mint, a, aAta, b.address, bAta, 1n)], a);
    expect(await w.h.fail([await send(w, mint, a, aAta, b.address, bAta, 1n, 1)], a)).toBeTruthy();
    // The passes issued before the rules existed have no terms, so the rules leave them alone.
    await w.h.send([await send(w, mint, a, aAta, b.address, bAta, 99n)], a);
    expect(w.h.balance(bAta)).toBe(300n);
  });

  it('the lock delegate can lock but never weaken; a stranger cannot lock at all', async () => {
    const w = await World.create();
    const { mint, config } = await hookedMint(w);
    const keeper = await w.trader();
    await w.h.send(await initRulesWithHook({ payer: w.admin, authority: w.admin, mint, rules: buildRules({ lockDelegate: keeper.address }) }), w.admin);
    const a = await w.trader();
    const b = await w.trader();
    const aAta = await holder(w, mint, a, 1);
    const bAta = await holder(w, mint, b, 2);
    await w.h.send([getMintToInstruction({ mint, token: aAta, mintAuthority: w.admin, amount: 1_000n }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })], w.admin);
    const [lock] = await findLockAddress(mint, a.address);
    const setLock = (signer: KeyPairSigner, amount: bigint, unlock: bigint) => getSetLockInstruction({ authority: signer, config, lock, owner: a.address, amount, unlockTs: unlock });
    const stranger = await w.trader();
    expect(await w.h.fail([setLock(stranger, 600n, T0 + 1_000n)], stranger)).toContain('Unauthorized');
    await w.h.send([setLock(keeper, 600n, T0 + 1_000n)], keeper);
    // Locked: 400 may move, 401 may not.
    expect(await w.h.fail([await send(w, mint, a, aAta, b.address, bAta, 401n)], a)).toContain('Locked');
    await w.h.send([await send(w, mint, a, aAta, b.address, bAta, 400n)], a);
    // The delegate cannot weaken an active lock, the authority cannot either, both can strengthen it.
    expect(await w.h.fail([setLock(keeper, 500n, T0 + 1_000n)], keeper)).toContain('LockCannotWeaken');
    expect(await w.h.fail([setLock(w.admin, 600n, T0 + 999n)], w.admin)).toContain('LockCannotWeaken');
    await w.h.send([setLock(keeper, 600n, T0 + 2_000n)], keeper);
    w.h.setTime(T0 + 2_000n);
    await w.h.send([await send(w, mint, a, aAta, b.address, bAta, 600n)], a);
  });

  it('the cross-only hooks accept only a genuine cross of this gate, refuse every imitation; reservations enforce the cap; release never fails; resale locks apply on receipt', async () => {
    const w = await World.create();
    // The gated token is also what the cross sells, as in a launch: a plain Token-2022 mint with a gate and rules.
    const mint = await w.h.mint(w.admin, 6);
    const [config] = await findConfigPda({ mint });
    await w.h.send([getCreateConfigInstruction({ payer: w.admin, mintAuthority: w.admin, mint, config, authority: w.admin.address, mode: Mode.Allowlist })], w.admin);
    await w.h.send([await initRules({ authority: w.admin, mint, rules: buildRules({ defaultCap: 1_000n, lockPolicy: { durationSecs: 3_600n } }) })], w.admin);
    const alice = await w.trader();
    const bob = await w.trader();
    await w.h.send([await grantPassTerms({ authority: w.admin, mint, owner: alice.address, terms: terms(1) })], w.admin);
    await w.h.send([await grantPassTerms({ authority: w.admin, mint, owner: bob.address, terms: terms(2, FLAG.kyc, 5_000n) })], w.admin);

    // Real crosses, created by cross_core: one that sells the gated token and is gated by it, one gated by it that sells
    // another token, one gated by another gate. Only cross_core can sign for them, so the test copies each one's bytes
    // into an account whose key we hold (anyone can assign such an account to cross_core, which is exactly the
    // imitation the program must refuse). This also pins the field offsets the program reads to the real layout.
    const standIn = async (real: Address, owner: Address = CROSS_CORE_PROGRAM_ADDRESS) => {
      const kp = await generateKeyPairSigner();
      const data = (w.h.svm.getAccount(real) as { data: Uint8Array }).data;
      w.h.svm.setAccount({ address: kp.address, data, executable: false, lamports: 1_000_000_000n as never, programAddress: owner, space: BigInt(data.length) });
      return kp;
    };
    const savedBase = w.baseMint;
    w.baseMint = mint;
    const sells = await w.newCross({ gateMint: mint });
    w.baseMint = savedBase;
    const other = await w.newCross({ gateMint: mint }); // sells the world's base mint, gated by `mint`
    const otherGate = await w.h.mint(w.admin, 6);
    const elsewhere = await w.newCross({ gateMint: otherGate });
    expect(w.view(sells.address).data.baseMint).toBe(mint);

    const cross = await standIn(sells.address);
    const sellsOther = await standIn(other.address);
    const wrongGate = await standIn(elsewhere.address);
    const notCross = await w.trader();
    const empty = await generateKeyPairSigner(); // assigned to cross_core by its holder, but with no cross data
    w.h.svm.setAccount({ address: empty.address, data: new Uint8Array(400), executable: false, lamports: 1_000_000_000n as never, programAddress: CROSS_CORE_PROGRAM_ADDRESS, space: 400n });
    const wrongOwner = await standIn(sells.address, address('11111111111111111111111111111111'));

    const reserve = async (signer: KeyPairSigner, owner: Address, amount: bigint) => {
      const [terms_] = await findTermsAddress(mint, owner);
      const t = (w.h.svm.getAccount(terms_) as { data: Uint8Array }).data;
      const key = allocationKey(t.slice(8 + 64, 8 + 96), owner);
      const [alloc] = await findAllocationAddress(signer.address, key);
      return { alloc, key, ix: getReserveAllocationInstruction({ payer: w.admin, cross: signer, config, terms: terms_, alloc, amount }) };
    };
    // Imitations.
    for (const bad of [notCross, empty, wrongOwner]) expect(await w.h.fail([(await reserve(bad, alice.address, 1n)).ix], w.admin)).toContain('NotCross');

    // Alice has the gate default cap of 1,000; Bob his own 5,000.
    const r1 = await reserve(cross, alice.address, 600n);
    await w.h.send([r1.ix], w.admin);
    const readAlloc = (a: Address) => decodeAllocation((w.h.svm.getAccount(a) as { data: Uint8Array }).data);
    expect(readAlloc(r1.alloc).reserved).toBe(600n);
    expect(await w.h.fail([(await reserve(cross, alice.address, 401n)).ix], w.admin)).toContain('OverIdentityCap');
    await w.h.send([(await reserve(cross, alice.address, 400n)).ix], w.admin);
    expect(readAlloc(r1.alloc).reserved).toBe(1_000n);
    const rb = await reserve(cross, bob.address, 4_000n);
    await w.h.send([rb.ix], w.admin);
    expect(readAlloc(rb.alloc).reserved).toBe(4_000n);
    // Any genuine cross may reserve: the cap is on identities, and cross_core decides which crosses are gated by this gate.
    await w.h.send([(await reserve(sellsOther, bob.address, 1n)).ix], w.admin);

    // Release: reduces, never underflows, never fails for an unknown allocation, and is cross-only.
    const release = (signer: KeyPairSigner, alloc: Address, key: Uint8Array, amount: bigint) => getReleaseAllocationInstruction({ cross: signer, alloc, key, amount });
    await w.h.send([release(cross, r1.alloc, r1.key, 300n)], w.admin);
    expect(readAlloc(r1.alloc).reserved).toBe(700n);
    await w.h.send([release(cross, r1.alloc, r1.key, 10_000n)], w.admin);
    expect(readAlloc(r1.alloc).reserved).toBe(0n);
    const [unknown] = await findAllocationAddress(cross.address, id32(99));
    await w.h.send([release(cross, unknown, id32(99), 5n)], w.admin);
    expect(await w.h.fail([release(notCross, r1.alloc, r1.key, 1n)], w.admin)).toContain('NotCross');

    // Resale lock on receipt: the received amount is locked for the policy's duration; a second receipt stacks.
    const [lock] = await findLockAddress(mint, alice.address);
    const receive = (signer: KeyPairSigner, amount: bigint) => getReceiveLockedInstruction({ payer: w.admin, cross: signer, config, lock, owner: alice.address, amount });
    expect(await w.h.fail([receive(notCross, 100n)], w.admin)).toContain('NotCross');
    expect(await w.h.fail([receive(wrongGate, 100n)], w.admin)).toContain('WrongGate');
    // Only a cross that sells this token can lock it.
    expect(await w.h.fail([receive(sellsOther, 100n)], w.admin)).toContain('WrongGate');
    await w.h.send([receive(cross, 100n)], w.admin);
    let l = getLockDecoder().decode((w.h.svm.getAccount(lock) as { data: Uint8Array }).data);
    expect([l.amount, l.unlockTs]).toEqual([100n, T0 + 3_600n]);
    w.h.setTime(T0 + 1_000n);
    await w.h.send([receive(cross, 50n)], w.admin);
    l = getLockDecoder().decode((w.h.svm.getAccount(lock) as { data: Uint8Array }).data);
    expect([l.amount, l.unlockTs]).toEqual([150n, T0 + 1_000n + 3_600n]);
    // Once the lock has expired a new receipt starts a fresh lock for just that amount.
    w.h.setTime(T0 + 10_000n);
    await w.h.send([receive(cross, 7n)], w.admin);
    l = getLockDecoder().decode((w.h.svm.getAccount(lock) as { data: Uint8Array }).data);
    expect([l.amount, l.unlockTs]).toEqual([7n, T0 + 10_000n + 3_600n]);
    void setRules;
    void findPassAddress;
  });
});
