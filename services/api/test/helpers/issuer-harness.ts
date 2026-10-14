// A local harness for the issuer screens of the Wave 2D features (rules, treasury extension, settle path), for the browser tests in
// apps/web/e2e/issuer-w3b-*.mjs. It is the real API (`buildServer` with the rules, treasury and settle routes, a PGlite database with the real
// migrations) over an in-memory chain, plus a small JSON-RPC endpoint the web app reads and sends through (`/rpc`).
//
// What is real: every unsigned transaction the web app gets is built by the real route and the real SDK and client builders; the web app's wallet
// signs it with a real Ed25519 key, and this harness checks every signature before it accepts the transaction.
// What is emulated: the cluster. No program runs. `ISSUER_MODE=new` behaves as if the extended programs were deployed; `old` as the first release
// (the programs answer the instructions they do not have with Anchor error 101, exactly as the deployed ones do, W3A-builders-devnet.md), and
// GET /v1/programs reads the same program bytes the mode puts in place. A sent transaction is recorded and decoded; its effects on accounts are NOT
// applied, so a screen is checked for the transaction it signs, not for the state afterwards. Those effects are what the LiteSVM suites prove.
//
//   cd services/api && ISSUER_PORT=8190 ISSUER_KEY_FILE=<scratch>/issuer-key.json npx tsx test/helpers/issuer-harness.ts
//   GET  /__fixtures          addresses of everything seeded and the disposable issuer key
//   GET  /__sent              every transaction the web app sent, decoded (program, instruction, accounts, arguments)
//   POST /__reset             forget the sent transactions
//   POST /__mode {"mode":"old"|"new"}   switch the deployed programs
//   POST /__fail {"in":2}              refuse the 2nd transaction sent from now (a half-landed action)
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import {
  type Address,
  type Instruction,
  address,
  createKeyPairSignerFromBytes,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getBase58Decoder,
  getTransactionDecoder,
  none,
  some,
} from '@solana/kit';
import { AccountState, TOKEN_2022_PROGRAM_ADDRESS, getMintEncoder, getTokenEncoder } from '@solana-program/token-2022';
import * as core from '@opening-cross/cross-core-client';
import * as settleClient from '@opening-cross/cross-settle-client';
import * as treasury from '@opening-cross/treasury-client';
import { CROSS_BODY_LEN, CROSS_CORE_PROGRAM_ADDRESS, CrossKind, CrossState, Disclosure, SupplyMode, crossAddress, getCrossEncoder, protocolAddress } from '@opening-cross/sdk';
import { dlmmAddresses, greenshoeAddresses } from '@opening-cross/adapters';
import { SPL_TOKEN_PROGRAM_ADDRESS } from '@opening-cross/token-safety';
import { buildServer } from '../../src/server.js';

const PORT = Number(process.env.ISSUER_PORT ?? 8190);
const KEY_FILE = process.env.ISSUER_KEY_FILE;
let mode: 'old' | 'new' = process.env.ISSUER_MODE === 'old' ? 'old' : 'new';
/** When set, the Nth sendTransaction from now is refused (as a cluster would refuse a transaction that failed), so a half-landed action can be tested. */
let failIn: number | null = null;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const ZERO = '11111111111111111111111111111111' as Address;
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111' as Address;
const DLMM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo' as Address;
const BLOCKHASH = '4NCYB3kRT8sCNodPNuCZo8VkwveZSHhg7R7mrRBFM1Uy';
const SLOT = 400_000_000;

type Account = { data: Uint8Array; owner: Address; lamports?: number; parsed?: { program: string; parsed: unknown } };
const accounts = new Map<string, Account>();
const key = async () => (await generateKeyPairSigner()).address;

// ------------------------------------------------------------------------------------------------ the issuer's key

async function issuerSigner() {
  if (KEY_FILE && existsSync(KEY_FILE)) return { signer: await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(KEY_FILE, 'utf8')) as number[])), secret: JSON.parse(readFileSync(KEY_FILE, 'utf8')) as number[] };
  const pair = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey));
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  const secret = [...pkcs8.slice(-32), ...raw];
  if (KEY_FILE) writeFileSync(KEY_FILE, JSON.stringify(secret));
  return { signer: await createKeyPairSignerFromBytes(Uint8Array.from(secret)), secret };
}

// ------------------------------------------------------------------------------------------------ account encoders

const mintBytes = (supply: bigint, decimals: number, authority: Address | null) =>
  new Uint8Array(getMintEncoder().encode({ mintAuthority: authority ? some(authority) : none(), supply, decimals, isInitialized: true, freezeAuthority: none(), extensions: none() } as never).slice(0, 82));
const tokenBytes = (mint: Address, owner: Address, amount: bigint) => {
  const out = new Uint8Array(165);
  out.set(getTokenEncoder().encode({ mint, owner, amount, delegate: none(), state: AccountState.Initialized, isNative: none(), delegatedAmount: 0n, closeAuthority: none(), extensions: none() } as never).slice(0, 165));
  return out;
};
function putMint(mint: Address, program: Address, decimals: number, supply: bigint, authority: Address | null) {
  accounts.set(mint, {
    data: mintBytes(supply, decimals, authority),
    owner: program,
    parsed: { program: program === SPL_TOKEN_PROGRAM_ADDRESS ? 'spl-token' : 'spl-token-2022', parsed: { type: 'mint', info: { decimals, supply: supply.toString(), mintAuthority: authority, freezeAuthority: null, isInitialized: true } } },
  });
}
async function hold(owner: Address, mint: Address, amount: bigint, program: Address) {
  const at = await treasury.associatedTokenAddress(owner, mint, program);
  accounts.set(at, { data: tokenBytes(mint, owner, amount), owner: program, parsed: { program: program === SPL_TOKEN_PROGRAM_ADDRESS ? 'spl-token' : 'spl-token-2022', parsed: { type: 'account', info: { mint, owner, tokenAmount: { amount: amount.toString(), decimals: 6 }, state: 'initialized' } } } });
  return at;
}

/** A program the way the upgradeable loader holds it: a program account naming a ProgramData account whose bytes carry the instructions it loads. */
async function putProgram(programId: Address, control: Uint8Array, extra: Uint8Array[]) {
  const dataAddress = await key();
  const lddw = (d: Uint8Array) => Uint8Array.from([0x18, 0, 0, 0, d[0]!, d[1]!, d[2]!, d[3]!, 0, 0, 0, 0, d[4]!, d[5]!, d[6]!, d[7]!, 0, 0, 0, 0, 0, 0, 0, 0]);
  const elf = new Uint8Array(2048);
  let at = 64;
  for (const d of [control, ...(mode === 'new' ? extra : [])]) {
    elf.set(lddw(d), at);
    at += 32;
  }
  const header = new Uint8Array(45);
  const view = new DataView(header.buffer);
  view.setUint32(0, 3, true);
  view.setBigUint64(4, 123n, true);
  const data = new Uint8Array(45 + elf.length);
  data.set(header);
  data.set(elf, 45);
  accounts.set(dataAddress, { data, owner: LOADER });
  const program = new Uint8Array(36);
  new DataView(program.buffer).setUint32(0, 2, true);
  program.set(getAddressEncoder().encode(dataAddress), 4);
  accounts.set(programId, { data: program, owner: LOADER });
  void getAddressDecoder;
}
async function putPrograms() {
  await putProgram(core.CROSS_CORE_PROGRAM_ADDRESS, core.CREATE_CROSS_DISCRIMINATOR as Uint8Array, [core.SET_RULES_DISCRIMINATOR, core.COMMIT_ORDER_EXT_DISCRIMINATOR, core.DRAW_BEGIN_DISCRIMINATOR] as Uint8Array[]);
  await putProgram(treasury.TREASURY_PROGRAM_ADDRESS, treasury.SPEND_DISCRIMINATOR as Uint8Array, [treasury.INIT_EXT_DISCRIMINATOR, treasury.VOTE_DISCRIMINATOR, treasury.NAV_REDEEM_DISCRIMINATOR, treasury.STAKE_DISCRIMINATOR] as Uint8Array[]);
  // The extended cross_settle carries every instruction of its client; the first release only the pool opening.
  const settleExtra = Object.entries(settleClient)
    .filter(([name, v]) => /_DISCRIMINATOR$/.test(name) && name !== 'OPEN_DBC_POOL_DISCRIMINATOR' && v instanceof Uint8Array)
    .map(([, v]) => v as Uint8Array);
  await putProgram(settleClient.CROSS_SETTLE_PROGRAM_ADDRESS, settleClient.OPEN_DBC_POOL_DISCRIMINATOR as Uint8Array, settleExtra);
}

// ------------------------------------------------------------------------------------------------ instruction names

type Table = Map<string, { program: Address; name: string; decoder: string }>;
function discriminatorTable(): Table {
  const out: Table = new Map();
  for (const [program, mod] of [
    [core.CROSS_CORE_PROGRAM_ADDRESS, core],
    [treasury.TREASURY_PROGRAM_ADDRESS, treasury],
    [settleClient.CROSS_SETTLE_PROGRAM_ADDRESS, settleClient],
  ] as [Address, Record<string, unknown>][]) {
    for (const [k, v] of Object.entries(mod)) {
      const m = /^([A-Z0-9_]+)_DISCRIMINATOR$/.exec(k);
      if (!m || !(v instanceof Uint8Array) || v.length !== 8) continue;
      const pascal = m[1]!.toLowerCase().replace(/(^|_)([a-z0-9])/g, (_s, _u, c: string) => c.toUpperCase());
      if (typeof mod[`get${pascal}InstructionDataDecoder`] !== 'function') continue; // an account's discriminator, not an instruction's
      out.set(`${program}:${Buffer.from(v).toString('hex')}`, { program, name: m[1]!.toLowerCase(), decoder: `get${pascal}InstructionDataDecoder` });
    }
  }
  return out;
}
const TABLE = discriminatorTable();
const MODULES: Record<string, Record<string, unknown>> = { [core.CROSS_CORE_PROGRAM_ADDRESS]: core, [treasury.TREASURY_PROGRAM_ADDRESS]: treasury, [settleClient.CROSS_SETTLE_PROGRAM_ADDRESS]: settleClient };
const PROGRAM_NAME: Record<string, string> = { [core.CROSS_CORE_PROGRAM_ADDRESS]: 'cross_core', [treasury.TREASURY_PROGRAM_ADDRESS]: 'treasury', [settleClient.CROSS_SETTLE_PROGRAM_ADDRESS]: 'cross_settle' };

/**
 * The instructions of the first release of each program, read from the generated clients as they stood before the Wave 2D commit (863d8cd~1,
 * `git ls-tree packages/<client>/src/generated/instructions`). Anything else is an instruction only the extended build has.
 */
const FIRST_RELEASE: Record<string, Set<string>> = {
  [core.CROSS_CORE_PROGRAM_ADDRESS]: new Set('abandon_settlement accept_admin bind_base_mint cancel_order claim clear commit_order create_cross finalize init_protocol init_shard merge_shard migrate_protocol propose_admin reveal_order set_guardian set_paused set_protocol_fees'.split(' ')),
  [treasury.TREASURY_PROGRAM_ADDRESS]: new Set('create_treasury record_attested record_lapse redeem spend trigger_liquidation'.split(' ')),
  [settleClient.CROSS_SETTLE_PROGRAM_ADDRESS]: new Set('bind_dbc_mint open_dbc_pool open_dlmm_pair seed_damm_v2 seed_raydium_cpmm'.split(' ')),
};
const lacksInFirstRelease = (program: string, name: string): boolean => FIRST_RELEASE[program] !== undefined && !FIRST_RELEASE[program]!.has(name);

function decodeTransaction(wire: Uint8Array) {
  const tx = getTransactionDecoder().decode(wire);
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const decompiled = decompileTransactionMessage(message);
  const keys = message.staticAccounts;
  const instructions = (decompiled.instructions as Instruction[]).map((ix, index) => {
    const data = ix.data ? new Uint8Array(ix.data) : new Uint8Array();
    const hit = TABLE.get(`${ix.programAddress}:${Buffer.from(data.subarray(0, 8)).toString('hex')}`);
    let args: unknown = null;
    if (hit) {
      try {
        const decoder = (MODULES[hit.program]![hit.decoder] as () => { decode: (b: Uint8Array) => unknown })();
        args = JSON.parse(JSON.stringify(decoder.decode(data), (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v)));
      } catch (e) {
        args = { undecodable: String(e) };
      }
    }
    return { index, program: PROGRAM_NAME[ix.programAddress] ?? ix.programAddress, programAddress: ix.programAddress, instruction: hit?.name ?? null, accounts: (ix.accounts ?? []).map((a) => ({ address: a.address, writable: (a.role & 1) === 1, signer: a.role >= 2 })), args };
  });
  return { tx, keys, instructions, requiredSigners: message.header.numSignerAccounts };
}

async function verifySignatures(wire: Uint8Array): Promise<string | null> {
  const { tx, keys, requiredSigners } = decodeTransaction(wire);
  for (let i = 0; i < requiredSigners; i++) {
    const sig = tx.signatures[keys[i]!];
    if (!sig || sig.every((b) => b === 0)) return `the signature of ${keys[i]} is missing`;
    const pub = await webcrypto.subtle.importKey('raw', getAddressEncoder().encode(keys[i]!), { name: 'Ed25519' }, false, ['verify']);
    if (!(await webcrypto.subtle.verify({ name: 'Ed25519' }, pub, sig, tx.messageBytes))) return `the signature of ${keys[i]} does not verify`;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ the chain

async function main() {
  const { signer: issuer, secret } = await issuerSigner();
  const wallet = issuer.address;
  const [alice, bob, integrator, feeRecipient, gateMint, credential, schema, recovery, attester, stranger] = await Promise.all(Array.from({ length: 10 }, key));
  const [baseMint, quoteMint, coinPlain, coinExt, coinLiq] = await Promise.all(Array.from({ length: 5 }, key));

  putMint(baseMint!, SPL_TOKEN_PROGRAM_ADDRESS, 6, 0n, wallet);
  putMint(quoteMint!, SPL_TOKEN_PROGRAM_ADDRESS, 6, 10_000_000_000_000n, null);
  for (const c of [coinPlain!, coinExt!, coinLiq!]) putMint(c, TOKEN_2022_PROGRAM_ADDRESS, 6, 1_000_000_000n, null);
  await hold(wallet, quoteMint!, 5_000_000_000n, SPL_TOKEN_PROGRAM_ADDRESS);
  for (const c of [coinPlain!, coinExt!, coinLiq!]) await hold(wallet, c, 200_000_000n, TOKEN_2022_PROGRAM_ADDRESS);
  for (const c of [coinPlain!, coinExt!]) {
    await hold(alice!, c, 400_000_000n, TOKEN_2022_PROGRAM_ADDRESS);
    await hold(bob!, c, 300_000_000n, TOKEN_2022_PROGRAM_ADDRESS);
  }
  await hold(wallet, quoteMint!, 5_000_000_000n, SPL_TOKEN_PROGRAM_ADDRESS);

  // protocol
  const protocolBody = core.getProtocolEncoder().encode({ admin: wallet, guardian: wallet, feeRecipient: feeRecipient!, feeBps: [30, 5, 15, 30], paused: false, bump: 255, pendingAdmin: none() });
  accounts.set(await protocolAddress(), { data: new Uint8Array(protocolBody), owner: CROSS_CORE_PROGRAM_ADDRESS });
  await putPrograms();

  // treasuries
  const ext = (over: Partial<treasury.TreasuryExt> = {}): treasury.TreasuryExt => ({
    magic: treasury.TREASURY_EXT_MAGIC, coinVaultBump: 255, distVaultBump: 255, votePeriodSecs: BigInt(7 * DAY), timelockSecs: BigInt(2 * DAY), quorumBps: 2_000, thresholdBps: 5_000, maxProposalBps: 5_000, proposerMinBps: 100,
    proposalCount: 0n, votesLocked: 0n, totalStaked: 0n, grantsUnreleased: 0n, grantCount: 0n, minLockupSecs: BigInt(90 * DAY), navOpen: false, navPeriodSecs: BigInt(7 * DAY), navCapBps: 1_000, navPeriodStart: 0n, navPeriodSupply: 0n, navBurned: 0n,
    insiders: [wallet, ZERO, ZERO, ZERO], accPerStake: 0n, streamSecs: BigInt(7 * DAY), streamAmount: 0n, streamEnd: 0n, streamLast: 0n, revShareBps: 1_000, revCredential: credential!, revSchema: schema!, roundSecs: BigInt(7 * DAY),
    revStart: BigInt(NOW - 24 * DAY), payGraceSecs: BigInt(5 * DAY), missedRounds: 0, trancheMinRevenue: 1_000_000_000n, trancheAmount: 100_000_000n, disclosurePeriodSecs: BigInt(14 * DAY), lastDisclosureTs: 0n, lastDisclosureHash: new Uint8Array(32),
    disclosures: 0, openRequestTs: 0n, requestMinBps: 100, assignRequired: true, assigned: false, assignCredential: credential!, assignSchema: schema!, windowSecs: BigInt(180 * DAY), recovery: recovery!, windStart: 0n, swept: false, ...over,
  });
  async function putTreasury(coinMint: Address, o: { ext?: treasury.TreasuryExt | null; state?: treasury.TreasuryState; vault?: bigint; lapsedSince?: bigint } = {}) {
    const [address] = await treasury.findTreasuryPda({ coinMint });
    const body = treasury.getTreasuryEncoder().encode({
      authority: wallet, coinMint, quoteMint: quoteMint!, quoteDecimals: 6, allowance: 1_000_000_000n, periodSecs: BigInt(30 * DAY), periodStart: 0n, spentInPeriod: 0n, credential: credential!, schema: schema!, graceSecs: BigInt(7 * DAY),
      lapsedSince: o.state === treasury.TreasuryState.Liquidating ? some(o.lapsedSince ?? BigInt(NOW - 220 * DAY)) : none(), state: o.state ?? treasury.TreasuryState.Active, snapshotVault: 10_000_000_000n, snapshotSupply: 1_000_000_000n, bump: 255, vaultBump: 255,
    });
    const tail = o.ext ? treasury.getTreasuryExtEncoder().encode(o.ext) : null;
    const data = new Uint8Array(tail ? treasury.TREASURY_EXT_OFFSET + tail.length : body.length);
    data.set(body);
    if (tail) data.set(tail, treasury.TREASURY_EXT_OFFSET);
    accounts.set(address, { owner: treasury.TREASURY_PROGRAM_ADDRESS, data });
    const [vault] = await treasury.findVaultPda({ treasury: address });
    accounts.set(vault, { owner: TOKEN_2022_PROGRAM_ADDRESS, data: tokenBytes(quoteMint!, address, o.vault ?? 10_000_000_000n) });
    return address;
  }
  const treasuryPlain = await putTreasury(coinPlain!);
  const treasuryExt = await putTreasury(coinExt!, {
    ext: ext({ proposalCount: 3n, grantCount: 2n, totalStaked: 100_000_000n, grantsUnreleased: 100_000_000n, openRequestTs: BigInt(NOW - 2 * DAY), disclosures: 1, lastDisclosureTs: BigInt(NOW - 40 * DAY), missedRounds: 0 }),
  });
  const treasuryLiq = await putTreasury(coinLiq!, { state: treasury.TreasuryState.Liquidating, ext: ext({ windStart: BigInt(NOW - 200 * DAY), assignRequired: false, assigned: false }) });

  const SPEND_DEST = await treasury.associatedTokenAddress(bob!, quoteMint!, SPL_TOKEN_PROGRAM_ADDRESS);
  const putProposal = async (id: bigint, over: Record<string, unknown>) =>
    accounts.set(await treasury.proposalAddress(treasuryExt, id), {
      owner: treasury.TREASURY_PROGRAM_ADDRESS,
      data: new Uint8Array(
        treasury.getProposalEncoder().encode({ treasury: treasuryExt, id, proposer: alice!, kind: treasury.ProposalKind.Spend, amount: 1_000_000_000n, destination: SPEND_DEST, descHash: new Uint8Array(32), createdTs: BigInt(NOW - 6 * DAY), voteEndTs: BigInt(NOW - 3 * DAY), executableTs: BigInt(NOW - 2 * DAY), expiresTs: BigInt(NOW + 12 * DAY), yes: 400_000_000n, no: 0n, executed: false, bump: 255, ...over } as never),
      ),
    });
  await putProposal(0n, {});
  await putProposal(1n, { createdTs: BigInt(NOW - DAY), voteEndTs: BigInt(NOW + 2 * DAY), executableTs: BigInt(NOW + 4 * DAY), expiresTs: BigInt(NOW + 16 * DAY), yes: 100_000_000n, no: 50_000_000n });
  await putProposal(2n, { kind: treasury.ProposalKind.OpenNav, amount: 0n, destination: ZERO, yes: 10_000_000n, no: 300_000_000n });
  accounts.set(await treasury.positionAddress(treasuryExt, wallet), { owner: treasury.TREASURY_PROGRAM_ADDRESS, data: new Uint8Array(treasury.getPositionEncoder().encode({ treasury: treasuryExt, owner: wallet, amount: 100_000_000n, debt: 0n, pending: 7n, bump: 255 })) });
  const putGrant = async (id: bigint, over: Record<string, unknown>) =>
    accounts.set(await treasury.grantAddress(treasuryExt, id), {
      owner: treasury.TREASURY_PROGRAM_ADDRESS,
      data: new Uint8Array(
        treasury.getGrantEncoder().encode({
          treasury: treasuryExt, id, beneficiary: bob!, total: 100_000_000n, released: 0n, lockupEnd: BigInt(NOW + 30 * DAY), expiryTs: BigInt(NOW + 400 * DAY),
          milestones: [{ bps: 2_500, requiresAttestation: false, released: false }, { bps: 5_000, requiresAttestation: true, released: false }, { bps: 0, requiresAttestation: false, released: false }, { bps: 0, requiresAttestation: false, released: false }],
          milestoneCount: 2, credential: credential!, schema: schema!, burned: false, bump: 255, ...over,
        } as never),
      ),
    });
  await putGrant(0n, {});
  await putGrant(1n, { lockupEnd: BigInt(NOW - DAY) });
  await hold(wallet, coinExt!, 200_000_000n, TOKEN_2022_PROGRAM_ADDRESS);
  await hold(bob!, coinExt!, 300_000_000n, TOKEN_2022_PROGRAM_ADDRESS);
  accounts.set(await treasury.roundRecordAddress(treasuryExt, 0n), { owner: treasury.TREASURY_PROGRAM_ADDRESS, data: new Uint8Array(treasury.getRoundRecordEncoder().encode({ treasury: treasuryExt, round: 0n, revenue: 5_000_000_000n, due: 500_000_000n, missed: false, trancheReleased: false, bump: 255 })) });
  const e0 = ext();
  for (const round of [1n, 2n]) accounts.set(await treasury.revenueAttestationAddress({ treasury: treasuryExt, revCredential: e0.revCredential, revSchema: e0.revSchema }, round), { owner: ZERO, data: new Uint8Array(8) });

  // crosses for the settle screens
  const crossRows: { address: Address; state: string; id: bigint }[] = [];
  async function putCross(id: bigint, state: CrossState, stateName: string) {
    const address = await crossAddress(wallet, id);
    const body = getCrossEncoder().encode({
      creator: wallet, crossId: id, kind: CrossKind.Launch, supplyMode: SupplyMode.DeferredMint, disclosure: Disclosure.Open, state, baseMint: baseMint!, quoteMint: quoteMint!, baseTokenProgram: SPL_TOKEN_PROGRAM_ADDRESS, quoteTokenProgram: SPL_TOKEN_PROGRAM_ADDRESS,
      baseDecimals: 6, quoteDecimals: 6, proceedsTo: wallet, minPrice: 1_000_000n, tick: 100_000n, ticks: 20, priceScale: 1_000_000n, openTs: BigInt(NOW - 20 * DAY), closeTs: BigInt(NOW - 19 * DAY), revealEndTs: BigInt(NOW - 19 * DAY), referencePrice: none(), minMatched: 0n,
      maxImbalanceBps: none(), protocolFeeBps: 30, integratorFeeBps: 20, integrator: integrator!, feeRecipient: feeRecipient!, gateMint: none(), shards: 2, maxOrders: 64, dustBond: 0n, ordersTotal: 0, ordersOpen: 0, mergedMask: 3, clearing: none(), noPrintReason: none(),
      buyerPaid: 2_600_000_000n, baseBought: 0n, baseSold: 0n, sellerPaid: 0n, feesAccrued: 0n, oracle: none(), calendar: none(), settler: none(), settleDeadlineTs: 0n, baseBound: true, bump: 1, quoteVaultBump: 1, baseVaultBump: 1, bookBump: 1,
    } as never);
    const data = new Uint8Array(CROSS_BODY_LEN);
    data.set(body);
    accounts.set(address, { owner: CROSS_CORE_PROGRAM_ADDRESS, data });
    crossRows.push({ address, state: stateName, id });
    return address;
  }
  const crossFresh = await putCross(1n, CrossState.Finalized, 'Finalized'); // no greenshoe yet
  const crossBids = await putCross(2n, CrossState.Finalized, 'Finalized'); // a greenshoe with level 0 placed, the week still running
  const crossOver = await putCross(3n, CrossState.Finalized, 'Finalized'); // a greenshoe whose week is over, level 0 placed
  const crossLive = await putCross(4n, CrossState.Live, 'Live');
  accounts.set(dlmmAddresses(baseMint!, quoteMint!).lbPair, { owner: DLMM, data: (() => { const d = new Uint8Array(904); const v = new DataView(d.buffer); v.setInt32(76, 262, true); v.setUint16(80, 10, true); return d; })() });

  const limitOrderA = await key();
  const shoe = async (cross: Address, over: Record<string, unknown>) => {
    const a = await greenshoeAddresses(cross);
    accounts.set(a.greenshoe, {
      owner: settleClient.CROSS_SETTLE_PROGRAM_ADDRESS,
      data: new Uint8Array(
        settleClient.getGreenshoeEncoder().encode({
          cross, creator: wallet, lbPair: dlmmAddresses(baseMint!, quoteMint!).lbPair, baseMint: baseMint!, quoteMint: quoteMint!, referencePrice: 1_300_000n, priceScale: 1_000_000n, startTs: BigInt(NOW - 2 * DAY), expiresTs: BigInt(NOW + 5 * DAY),
          budget: 300_000_000n, deployed: 100_000_000n, periodSecs: 3_600n, periodCap: 300_000_000n, periodStart: 0n, periodDeployed: 0n, orders: [limitOrderA, ZERO, ZERO], bins: [250, 0, 0], amounts: [100_000_000n, 0n, 0n], levelSettled: [false, false, false], finished: false, bump: 1, vaultBump: 1, baseBump: 1, ...over,
        } as never),
      ),
    });
    return a.greenshoe;
  };
  const shoeBids = await shoe(crossBids, {});
  const shoeOver = await shoe(crossOver, { startTs: BigInt(NOW - 9 * DAY), expiresTs: BigInt(NOW - 2 * DAY) });

  // the database
  const pg = new PGlite();
  const dir = fileURLToPath(new URL('../../../indexer/migrations/', import.meta.url));
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) await pg.exec(readFileSync(`${dir}${f}`, 'utf8'));
  for (const [i, c] of crossRows.entries()) {
    await pg.query("INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, created_slot, updated_slot, orders_committed) VALUES ($1,$2,0,2,1,$3,$4,$5,$6,$6,30,20,$7,$8,$8,0)", [c.address, wallet, baseMint, quoteMint, NOW - 20 * DAY, NOW - 19 * DAY, c.state, 100 + i]);
  }
  await pg.query("INSERT INTO settle_venues (cross_address, venue, pool, clearing_price, detail, slot) VALUES ($1,'dbc',$2,1300000,'{}',200), ($3,'dlmm',$4,1300000,'{}',201)", [crossFresh, await key(), crossBids, dlmmAddresses(baseMint!, quoteMint!).lbPair]);
  await pg.query("INSERT INTO settle_partner (cross_address, fee_base, fee_quote, fee_claims, surplus_withdrawn, migration_fee, pool_creation_lamports, pol_token_a, pol_token_b, pol_claims, updated_slot) VALUES ($1, 0, 25000000, 2, 0, 0, 0, 0, 0, 0, 210)", [crossFresh]);
  await pg.query("INSERT INTO settle_greenshoes (greenshoe, cross_address, budget, start_ts, expires_ts, bids, settled_levels, finished, created_slot) VALUES ($1,$2,300000000,$3,$4,$5,'[]',false,220), ($6,$7,300000000,$8,$9,$10,'[]',false,221)", [
    shoeBids, crossBids, NOW - 2 * DAY, NOW + 5 * DAY, JSON.stringify([{ level: 0, binId: 250, amount: '100000000', limitOrder: limitOrderA }]),
    shoeOver, crossOver, NOW - 9 * DAY, NOW - 2 * DAY, JSON.stringify([{ level: 0, binId: 250, amount: '100000000', limitOrder: limitOrderA }]),
  ]);

  // ---- the API
  const app = await buildServer({
    db: { query: (text: string, params?: unknown[]) => pg.query(text, params as never[]) } as never,
    network: 'devnet',
    account: async (a: Address) => {
      const x = accounts.get(a);
      return x ? { data: x.data, owner: x.owner } : null;
    },
    lifetime: async () => ({ blockhash: BLOCKHASH as never, lastValidBlockHeight: 100n }),
    w2a: false,
    // GET /v1/programs is registered by the server itself; its answer must follow the mode switch at once.
    programsTtlMs: 0,
  } as never);

  // ---- the JSON-RPC endpoint the web app reads and sends through
  const sent: { signature: string; transaction: ReturnType<typeof decodeTransaction>['instructions']; feePayer: string; at: number }[] = [];
  const rpcInfo = (a: Account, enc: string, slice?: { offset: number; length: number }) => {
    const data = slice ? a.data.subarray(slice.offset, slice.offset + slice.length) : a.data;
    const base = { executable: false, lamports: a.lamports ?? 2_000_000, owner: a.owner, rentEpoch: 0, space: a.data.length };
    if (enc === 'jsonParsed' && a.parsed) return { ...base, data: { program: a.parsed.program, parsed: a.parsed.parsed, space: a.data.length } };
    return { ...base, data: [Buffer.from(data).toString('base64'), 'base64'] };
  };
  const refusal = (wire: Uint8Array) => {
    if (mode === 'new') return null;
    const { instructions } = decodeTransaction(wire);
    for (const ix of instructions) {
      if (ix.instruction && lacksInFirstRelease(ix.programAddress, ix.instruction)) return { index: ix.index, program: ix.programAddress };
    }
    return null;
  };
  const refusedLogs = (p: string) => [`Program ${p} invoke [1]`, 'Program log: AnchorError occurred. Error Code: InstructionFallbackNotFound. Error Number: 101. Error Message: Fallback functions are not supported.', `Program ${p} consumed 1341 of 200000 compute units`, `Program ${p} failed: custom program error: 0x65`];
  app.post('/rpc', async (req, reply) => {
    const { id, method, params } = req.body as { id: number; method: string; params: unknown[] };
    const ok = (result: unknown) => reply.send({ jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string, data?: unknown) => reply.send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
    const ctx = { slot: SLOT };
    switch (method) {
      case 'getAccountInfo': {
        const [a, cfg] = params as [string, { encoding?: string; dataSlice?: { offset: number; length: number } }];
        const x = accounts.get(a);
        return ok({ context: ctx, value: x ? rpcInfo(x, cfg?.encoding ?? 'base64', cfg?.dataSlice) : null });
      }
      case 'getMultipleAccounts': {
        const [list, cfg] = params as [string[], { encoding?: string }];
        return ok({ context: ctx, value: list.map((a) => (accounts.has(a) ? rpcInfo(accounts.get(a)!, cfg?.encoding ?? 'base64') : null)) });
      }
      case 'getBalance':
        return ok({ context: ctx, value: (params[0] as string) === wallet ? 5_000_000_000 : 1_000_000_000 });
      case 'getMinimumBalanceForRentExemption':
        return ok((Number(params[0]) + 128) * 6960);
      case 'getSlot':
        return ok(SLOT);
      case 'getBlockTime':
        return ok(Math.floor(Date.now() / 1000));
      case 'getLatestBlockhash':
        return ok({ context: ctx, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } });
      case 'simulateTransaction': {
        const wire = new Uint8Array(Buffer.from(params[0] as string, 'base64'));
        const { keys } = decodeTransaction(wire);
        if (!accounts.has(keys[0]!) && keys[0] !== wallet) return ok({ context: ctx, value: { err: 'AccountNotFound', logs: [], accounts: null, unitsConsumed: 0 } });
        const no = refusal(wire);
        if (no) return ok({ context: ctx, value: { err: { InstructionError: [no.index, { Custom: 101 }] }, logs: refusedLogs(no.program), accounts: null, unitsConsumed: 1341 } });
        return ok({ context: ctx, value: { err: null, logs: [], accounts: null, unitsConsumed: 40_000 } });
      }
      case 'sendTransaction': {
        const wire = new Uint8Array(Buffer.from(params[0] as string, 'base64'));
        const bad = await verifySignatures(wire);
        if (bad) return fail(-32002, `Transaction signature verification failure: ${bad}`);
        const no = refusal(wire);
        if (no) return fail(-32002, 'Transaction simulation failed: Error processing Instruction ' + no.index + ': custom program error: 0x65', { logs: refusedLogs(no.program) });
        if (failIn !== null && --failIn === 0) {
          failIn = null;
          return fail(-32002, 'Transaction simulation failed: Blockhash not found');
        }
        const d = decodeTransaction(wire);
        const signature = getBase58Decoder().decode(d.tx.signatures[d.keys[0]!]!);
        sent.push({ signature, transaction: d.instructions, feePayer: d.keys[0]!, at: Date.now() });
        return ok(signature);
      }
      case 'getSignatureStatuses':
        return ok({ context: ctx, value: (params[0] as string[]).map(() => ({ slot: SLOT, confirmations: null, err: null, confirmationStatus: 'confirmed' })) });
      default:
        console.error(`rpc: unhandled method ${method}`);
        return fail(-32601, `the issuer harness does not emulate ${method}`);
    }
  });

  app.get('/__fixtures', async () => ({
    mode, now: NOW, wallet, secret,
    baseMint, quoteMint, gateMint, credential, schema, recovery, attester, alice, bob, stranger, feeRecipient, integrator,
    treasuries: { plain: treasuryPlain, extended: treasuryExt, liquidating: treasuryLiq },
    coins: { plain: coinPlain, extended: coinExt, liquidating: coinLiq },
    crosses: { fresh: crossFresh, bids: crossBids, over: crossOver, live: crossLive },
    greenshoes: { bids: shoeBids, over: shoeOver }, limitOrder: limitOrderA, spendDestination: SPEND_DEST,
  }));
  app.get('/__sent', async () => ({ sent }));
  app.post('/__reset', async () => {
    sent.length = 0;
    return { ok: true };
  });
  app.post('/__fail', async (req) => {
    const n = Number((req.body as { in?: number }).in);
    failIn = Number.isInteger(n) && n > 0 ? n : null;
    return { failIn };
  });
  app.post('/__mode', async (req) => {
    const m = (req.body as { mode?: string }).mode;
    if (m !== 'old' && m !== 'new') return { error: 'mode is old or new' };
    mode = m;
    await putPrograms();
    return { mode };
  });

  await app.listen({ port: PORT, host: '127.0.0.1' });
  console.log(JSON.stringify({ listening: `http://127.0.0.1:${PORT}`, rpc: `http://127.0.0.1:${PORT}/rpc`, mode, wallet }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

void address;
void TABLE;
