// Upgrade and admin governance rehearsal (ROADMAP L3), against the immutable Squads v4 program
// dumped from mainnet. cross_core is installed as an upgradeable program whose authority is the
// deployer; the deployer then hands both the upgrade authority and the protocol admin to a 2-of-3
// Squads vault with a 7-day timelock. From then on no single key can upgrade the program or change
// fees, and an approved proposal cannot execute before the timelock.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type Address, type Instruction, type KeyPairSigner, AccountRole, address, createNoopSigner, getAddressEncoder, lamports } from '@solana/kit';
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import { CROSS_CORE_PROGRAM_ADDRESS, getAcceptAdminInstruction, getProposeAdminInstruction, getProtocolDecoder, getSetProtocolFeesInstruction, protocolAddress } from '@opening-cross/sdk';
import { World } from '../src/world.js';
import { T0 } from '../src/harness.js';

const FIX = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const SQUADS = address('SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf');
const LOADER = address('BPFLoaderUpgradeab1e11111111111111111111111');
const RENT = address('SysvarRent111111111111111111111111111111111');
const CLOCK = address('SysvarC1ock11111111111111111111111111111111');
const ELF = fileURLToPath(new URL('../../../target/deploy/cross_core.so', import.meta.url));
const SEVEN_DAYS = 7 * 24 * 3600;

const pk = (a: Address) => new PublicKey(a);
const enc = getAddressEncoder();

/** web3.js v1 instruction → kit instruction; `signers` supplies the kit signer for each signing key. */
function kit(ix: TransactionInstruction, signers: KeyPairSigner[]): Instruction {
  return {
    programAddress: address(ix.programId.toBase58()),
    data: new Uint8Array(ix.data),
    accounts: ix.keys.map((k) => {
      const a = address(k.pubkey.toBase58());
      const role = k.isSigner ? (k.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : k.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY;
      const signer = k.isSigner ? signers.find((s) => s.address === a) : undefined;
      return signer ? { address: a, role, signer } : { address: a, role };
    }),
  } as Instruction;
}

/** Installs cross_core under the upgradeable loader with `authority` as its upgrade authority. */
async function installUpgradeable(w: World, authority: Address) {
  const elf = readFileSync(ELF);
  const [programData] = PublicKey.findProgramAddressSync([pk(CROSS_CORE_PROGRAM_ADDRESS).toBuffer()], pk(LOADER));
  const pd = new Uint8Array(45 + elf.length);
  pd.set([3, 0, 0, 0], 0); // UpgradeableLoaderState::ProgramData
  pd.set([1], 12); // Some(authority)
  pd.set(enc.encode(authority), 13);
  pd.set(elf, 45);
  const prog = new Uint8Array(36);
  prog.set([2, 0, 0, 0], 0); // UpgradeableLoaderState::Program
  prog.set(programData.toBytes(), 4);
  const rent = (n: number) => lamports(w.h.svm.minimumBalanceForRentExemption(BigInt(n)));
  w.h.svm.setAccount({ address: address(programData.toBase58()), data: pd, executable: false, lamports: rent(pd.length), programAddress: LOADER, space: BigInt(pd.length) });
  w.h.svm.setAccount({ address: CROSS_CORE_PROGRAM_ADDRESS, data: prog, executable: true, lamports: rent(prog.length), programAddress: LOADER, space: BigInt(prog.length) });
  return address(programData.toBase58());
}

function upgradeAuthorityOf(w: World, programData: Address): Address | null {
  const a = w.h.svm.getAccount(programData);
  if (!a.exists) throw new Error('programdata missing');
  return a.data[12] === 1 ? (address(new PublicKey(a.data.slice(13, 45)).toBase58()) as Address) : null;
}

/** A buffer holding a program image, writable by `authority` (what `solana program write-buffer` makes). */
function writeBuffer(w: World, authority: Address): Address {
  const elf = readFileSync(ELF);
  const buf = Keypair.generate().publicKey;
  const data = new Uint8Array(37 + elf.length);
  data.set([1, 0, 0, 0], 0); // UpgradeableLoaderState::Buffer
  data.set([1], 4);
  data.set(enc.encode(authority), 5);
  data.set(elf, 37);
  w.h.svm.setAccount({ address: address(buf.toBase58()), data, executable: false, lamports: lamports(w.h.svm.minimumBalanceForRentExemption(BigInt(data.length))), programAddress: LOADER, space: BigInt(data.length) });
  return address(buf.toBase58());
}

const loaderSetAuthority = (account: Address, current: KeyPairSigner, next: Address): Instruction => ({
  programAddress: LOADER,
  data: new Uint8Array([4, 0, 0, 0]),
  accounts: [
    { address: account, role: AccountRole.WRITABLE },
    { address: current.address, role: AccountRole.READONLY_SIGNER, signer: current },
    { address: next, role: AccountRole.READONLY },
  ],
} as Instruction);

const loaderUpgrade = (programData: Address, buffer: Address, spill: Address, authority: Address) =>
  new TransactionInstruction({
    programId: pk(LOADER),
    data: Buffer.from([3, 0, 0, 0]),
    keys: [
      { pubkey: pk(programData), isSigner: false, isWritable: true },
      { pubkey: pk(CROSS_CORE_PROGRAM_ADDRESS), isSigner: false, isWritable: true },
      { pubkey: pk(buffer), isSigner: false, isWritable: true },
      { pubkey: pk(spill), isSigner: false, isWritable: true },
      { pubkey: pk(RENT), isSigner: false, isWritable: false },
      { pubkey: pk(CLOCK), isSigner: false, isWritable: false },
      { pubkey: pk(authority), isSigner: true, isWritable: false },
    ],
  });

/** kit instruction (signed by the vault) → web3 instruction for a vault transaction message. */
function web3(ix: Instruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: pk(ix.programAddress),
    data: Buffer.from(ix.data ?? []),
    keys: (ix.accounts ?? []).map((a) => ({ pubkey: pk(a.address), isSigner: a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER, isWritable: a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER })),
  });
}

async function setup() {
  const w = await World.create();
  w.h.svm.addProgramFromFile(SQUADS, `${FIX}squads_v4.so`);
  const cfg = JSON.parse(readFileSync(`${FIX}squads_program_config.json`, 'utf8'));
  const cfgData = Buffer.from(cfg.account.data[0], cfg.account.data[1]);
  w.h.svm.setAccount({ address: address(cfg.pubkey), data: new Uint8Array(cfgData), executable: false, lamports: lamports(BigInt(cfg.account.lamports)), programAddress: SQUADS, space: BigInt(cfgData.length) });
  const programData = await installUpgradeable(w, w.admin.address);

  const members = [await w.h.wallet(), await w.h.wallet(), await w.h.wallet()];
  const createKey = await w.h.wallet();
  const [msPda] = multisig.getMultisigPda({ createKey: pk(createKey.address) });
  const [vaultPda] = multisig.getVaultPda({ multisigPda: msPda, index: 0 });
  const vault = address(vaultPda.toBase58());
  w.h.svm.airdrop(vault, lamports(5_000_000_000n));
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountInfo({ data: cfgData } as never)[0];
  await w.h.send(
    [
      kit(
        multisig.instructions.multisigCreateV2({
          treasury: programConfig.treasury,
          creator: pk(members[0]!.address),
          multisigPda: msPda,
          configAuthority: null,
          threshold: 2,
          members: members.map((m) => ({ key: pk(m.address), permissions: multisig.types.Permissions.all() })),
          timeLock: SEVEN_DAYS,
          createKey: pk(createKey.address),
          rentCollector: null,
        }),
        [members[0]!, createKey],
      ),
    ],
    members[0]!,
  );

  // A Connection-shaped reader over LiteSVM, for the SDK helpers that fetch accounts.
  const connection = {
    getAccountInfo: async (key: PublicKey) => {
      const a = w.h.svm.getAccount(address(key.toBase58()));
      return a.exists ? { data: Buffer.from(a.data), owner: new PublicKey(a.programAddress), lamports: Number(a.lamports), executable: a.executable } : null;
    },
  };

  let index = 0n;
  /** Proposes `ixs` for the vault to sign, with the given approvals; returns an executor. */
  async function propose(ixs: TransactionInstruction[], approvers: KeyPairSigner[]) {
    index += 1n;
    const transactionIndex = index;
    const { value: bh } = { value: w.h.svm.latestBlockhash() };
    const message = new TransactionMessage({ payerKey: vaultPda, recentBlockhash: bh, instructions: ixs });
    await w.h.send([kit(multisig.instructions.vaultTransactionCreate({ multisigPda: msPda, transactionIndex, creator: pk(members[0]!.address), vaultIndex: 0, ephemeralSigners: 0, transactionMessage: message }), [members[0]!]), kit(multisig.instructions.proposalCreate({ multisigPda: msPda, creator: pk(members[0]!.address), transactionIndex }), [members[0]!])], members[0]!);
    for (const m of approvers) await w.h.send([kit(multisig.instructions.proposalApprove({ multisigPda: msPda, transactionIndex, member: pk(m.address) }), [m])], m);
    return async (executor: KeyPairSigner) => {
      const { instruction } = await multisig.instructions.vaultTransactionExecute({ connection: connection as never, multisigPda: msPda, transactionIndex, member: pk(executor.address) });
      return w.h.send([kit(instruction, [executor])], executor);
    };
  }
  return { w, programData, members, vault, propose };
}

describe.skipIf(!existsSync(`${FIX}squads_v4.so`))('upgrade and admin governance (Squads v4, 2-of-3, 7-day timelock)', () => {
  it('hands upgrade authority and protocol admin to the vault; afterwards no single key controls either', async () => {
    const { w, programData, members, vault, propose } = await setup();
    const protocol = await protocolAddress();
    // The program runs as an upgradeable program.
    await w.newCross();

    // Handover by the deployer: upgrade authority now, admin proposed (takes effect on acceptance).
    await w.h.send([loaderSetAuthority(programData, w.admin, vault), getProposeAdminInstruction({ admin: w.admin, protocol, newAdmin: vault })], w.admin);
    expect(upgradeAuthorityOf(w, programData)).toBe(vault);

    // The vault accepts the admin role through a multisig proposal, after the timelock.
    const accept = await propose([web3(getAcceptAdminInstruction({ newAdmin: createNoopSigner(vault), protocol }))], [members[0]!, members[1]!]);
    expect(String(await accept(members[0]!).catch((e) => e))).toMatch(/TimeLockNotReleased|0x1781|6017/);
    w.h.setTime(T0 + BigInt(SEVEN_DAYS) + 1n);
    await accept(members[0]!);
    const p = getProtocolDecoder().decode((w.h.svm.getAccount(protocol) as { data: Uint8Array }).data);
    expect(p.admin).toBe(vault);

    // The old admin key can no longer change fees or upgrade.
    expect(await w.h.fail([getSetProtocolFeesInstruction({ admin: w.admin, protocol, feeRecipient: w.admin.address, feeBps: [100, 100, 100, 100] })], w.admin)).toMatch(/Unauthorized|ConstraintHasOne/);
    const buf1 = writeBuffer(w, w.admin.address);
    expect(await w.h.fail([kit(loaderUpgrade(programData, buf1, w.admin.address, w.admin.address), [w.admin])], w.admin)).toMatch(/Incorrect authority|IncorrectAuthority|incorrect authority/i);
  });

  it('an upgrade needs two approvals and the timelock; then it lands', async () => {
    const { w, programData, members, vault, propose } = await setup();
    await w.h.send([loaderSetAuthority(programData, w.admin, vault)], w.admin);
    const buffer = writeBuffer(w, vault);

    // One approval is not enough.
    const lonely = await propose([loaderUpgrade(programData, buffer, vault, vault)], [members[0]!]);
    w.h.setTime(T0 + BigInt(SEVEN_DAYS) + 1n);
    expect(String(await lonely(members[0]!).catch((e) => e))).toMatch(/InvalidProposalStatus|0x177|60/);

    // Two approvals, timelock elapsed: the upgrade executes and the buffer is consumed.
    const upgrade = await propose([loaderUpgrade(programData, buffer, vault, vault)], [members[1]!, members[2]!]);
    w.h.setTime(T0 + 2n * BigInt(SEVEN_DAYS) + 2n);
    await upgrade(members[2]!);
    expect(w.h.svm.getAccount(buffer).exists).toBe(false);
    expect(upgradeAuthorityOf(w, programData)).toBe(vault);
    // The upgraded program still runs.
    w.h.setTime(T0);
    await w.newCross();
  });
});

describe('admin handover edge cases', () => {
  it('only the proposed key can accept; a proposal can be withdrawn; guardian rotation is admin-only', async () => {
    const { getSetGuardianInstruction } = await import('@opening-cross/sdk');
    const w = await World.create();
    const protocol = await protocolAddress();
    const next = await w.h.wallet();
    const stranger = await w.h.wallet();
    expect(await w.h.fail([getAcceptAdminInstruction({ newAdmin: next, protocol })], next)).toMatch(/Unauthorized/); // nothing proposed
    expect(await w.h.fail([getProposeAdminInstruction({ admin: stranger, protocol, newAdmin: stranger.address })], stranger)).toMatch(/Unauthorized|ConstraintHasOne/);
    await w.h.send([getProposeAdminInstruction({ admin: w.admin, protocol, newAdmin: next.address })], w.admin);
    expect(await w.h.fail([getAcceptAdminInstruction({ newAdmin: stranger, protocol })], stranger)).toMatch(/Unauthorized/);
    await w.h.send([getProposeAdminInstruction({ admin: w.admin, protocol, newAdmin: null })], w.admin); // withdrawn
    expect(await w.h.fail([getAcceptAdminInstruction({ newAdmin: next, protocol })], next)).toMatch(/Unauthorized/);
    await w.h.send([getProposeAdminInstruction({ admin: w.admin, protocol, newAdmin: next.address })], w.admin);
    await w.h.send([getAcceptAdminInstruction({ newAdmin: next, protocol })], next);
    const p = getProtocolDecoder().decode((w.h.svm.getAccount(protocol) as { data: Uint8Array }).data);
    expect(p.admin).toBe(next.address);
    expect(p.pendingAdmin).toEqual({ __option: 'None' });
    expect(await w.h.fail([getSetGuardianInstruction({ admin: w.admin, protocol, guardian: stranger.address })], w.admin)).toMatch(/Unauthorized|ConstraintHasOne/);
    await w.h.send([getSetGuardianInstruction({ admin: next, protocol, guardian: stranger.address })], next);
  });
});

describe('protocol account migration', () => {
  it('upgrades a protocol account written by the previous layout, admin-only and idempotent', async () => {
    const { getMigrateProtocolInstruction, getSetGuardianInstruction } = await import('@opening-cross/sdk');
    const w = await World.create();
    const protocol = await protocolAddress();
    // Rewrite the account as the earlier 114-byte layout (no `pending_admin`).
    const now = w.h.svm.getAccount(protocol);
    if (!now.exists) throw new Error('protocol missing');
    const old = new Uint8Array(now.data.slice(0, 114));
    w.h.svm.setAccount({ ...now, data: old, space: 114n });
    expect(await w.h.fail([getSetGuardianInstruction({ admin: w.admin, protocol, guardian: w.admin.address })], w.admin)).toMatch(/AccountDidNotDeserialize|Failed to deserialize/);
    const stranger = await w.h.wallet();
    expect(await w.h.fail([getMigrateProtocolInstruction({ admin: stranger, protocol })], stranger)).toMatch(/Unauthorized/);
    await w.h.send([getMigrateProtocolInstruction({ admin: w.admin, protocol })], w.admin);
    await w.h.send([getMigrateProtocolInstruction({ admin: w.admin, protocol })], w.admin); // idempotent
    const p = getProtocolDecoder().decode((w.h.svm.getAccount(protocol) as { data: Uint8Array }).data);
    expect(p.admin).toBe(w.admin.address);
    expect(p.pendingAdmin).toEqual({ __option: 'None' });
    await w.h.send([getSetGuardianInstruction({ admin: w.admin, protocol, guardian: stranger.address })], w.admin);
    await w.newCross(); // the migrated protocol serves new crosses
  });
});
