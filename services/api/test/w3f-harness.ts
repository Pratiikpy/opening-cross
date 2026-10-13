// A local harness for the W3F screens (recurring series, halts and corporate actions, the arbiter's ruling, the treasury wind-down window, pushed
// refunds), for the browser tests in apps/web/e2e/w3f-*.mjs. It is the issuer harness (services/api/test/helpers/issuer-harness.ts) with more
// accounts: the real API (`buildServer`, a PGlite database with the real migrations) over an in-memory chain, plus a small JSON-RPC endpoint the web
// app reads and sends through (`/rpc`).
//
// What is real: every unsigned transaction the web app gets is built by the real route and the real SDK and client builders; the web app's wallet
// signs it with a real Ed25519 key, and this harness checks every signature before it accepts the transaction.
// What is emulated: the cluster. No program runs. `W3F_MODE=new` behaves as if the extended programs were deployed; `old` as the first release
// (the programs answer the instructions they do not have with Anchor error 101), and GET /v1/programs reads the same program bytes the mode puts in
// place. A sent transaction is recorded and decoded; its effects on accounts are NOT applied, so a screen is checked for the transaction it signs,
// not for the state afterwards. Those effects are what the LiteSVM suites prove.
//
//   cd services/api && W3F_PORT=8290 W3F_KEY_FILE=<scratch>/w3f-key.json npx tsx test/w3f-harness.ts
//   GET  /__fixtures          addresses of everything seeded, and the disposable keys (the issuer, the arbiter, a stranger)
//   GET  /__sent              every transaction the web app sent, decoded (program, instruction, accounts, arguments)
//   POST /__reset             forget the sent transactions
//   POST /__mode {"mode":"old"|"new"}      switch the deployed programs
//   POST /__exit                           end the harness
//   POST /__arbiter {"named":true|false}   name the arbiter, or leave the registry empty (HUMAN_TASKS H28)
//   POST /__fail {"in":2}                  refuse the 2nd transaction sent from now (a half-landed action)
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
import * as sdk from '@opening-cross/sdk';
import { getCalendarEncoder } from '@opening-cross/cross-calendar-client';
import { CROSS_CALENDAR_PROGRAM_ADDRESS } from '@opening-cross/cross-calendar-client';
import { CROSS_BODY_LEN, CROSS_CORE_PROGRAM_ADDRESS, CrossKind, CrossState, Disclosure, SupplyMode, crossAddress, getCrossEncoder, protocolAddress } from '@opening-cross/sdk';
import { dlmmAddresses, greenshoeAddresses } from '@opening-cross/adapters';
import { SPL_TOKEN_PROGRAM_ADDRESS } from '@opening-cross/token-safety';
import { buildServer } from '../src/server.js';
import { registerHolderPrograms } from '../src/routes/holder-programs.js';

const PORT = Number(process.env.W3F_PORT ?? 8290);
const KEY_FILE = process.env.W3F_KEY_FILE;
let mode: 'old' | 'new' = process.env.W3F_MODE === 'old' ? 'old' : 'new';
let arbiterNamed = true;
/** Seconds the API's clock runs ahead of the real one. A mode switch moves it past the 10-minute cache of GET /v1/programs, so the new release is read at once. */
let skew = 0;
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

async function person() {
  const pair = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey));
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  const secret = [...pkcs8.slice(-32), ...raw];
  return { secret, address: (await createKeyPairSignerFromBytes(Uint8Array.from(secret))).address };
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
  const [coinRedeeming, coinSwept, coinNoWindow, coinFirst, coinLapsing, coinGrace, mintHalted, mintFlagged, mintClear, mintNoHalt, calendar] = await Promise.all(Array.from({ length: 11 }, key));
  // Two more disposable people besides the issuer: the arbiter the protocol names, and a stranger who holds no power.
  const arbiter = await person();
  const stranger2 = await person();
  // Both have SOL, so a simulation of their transactions answers like the cluster's would (it refuses a fee payer that does not exist).
  for (const p of [arbiter, stranger2]) accounts.set(p.address, { data: new Uint8Array(0), owner: ZERO, lamports: 2_000_000_000 });

  putMint(baseMint!, SPL_TOKEN_PROGRAM_ADDRESS, 6, 0n, wallet);
  putMint(quoteMint!, SPL_TOKEN_PROGRAM_ADDRESS, 6, 10_000_000_000_000n, null);
  const extraCoins = [coinRedeeming!, coinSwept!, coinNoWindow!, coinFirst!, coinLapsing!, coinGrace!];
  for (const c of [coinPlain!, coinExt!, coinLiq!, ...extraCoins]) putMint(c, TOKEN_2022_PROGRAM_ADDRESS, 6, 1_000_000_000n, null);
  for (const m of [mintHalted!, mintFlagged!, mintClear!, mintNoHalt!]) putMint(m, SPL_TOKEN_PROGRAM_ADDRESS, 6, 0n, wallet);
  await hold(wallet, quoteMint!, 5_000_000_000n, SPL_TOKEN_PROGRAM_ADDRESS);
  await hold(wallet, baseMint!, 9_000_000n, SPL_TOKEN_PROGRAM_ADDRESS);
  for (const c of [coinPlain!, coinExt!, coinLiq!, ...extraCoins]) await hold(wallet, c, 200_000_000n, TOKEN_2022_PROGRAM_ADDRESS);
  for (const c of [coinPlain!, coinExt!]) {
    await hold(alice!, c, 400_000_000n, TOKEN_2022_PROGRAM_ADDRESS);
    await hold(bob!, c, 300_000_000n, TOKEN_2022_PROGRAM_ADDRESS);
  }
  await hold(wallet, quoteMint!, 5_000_000_000n, SPL_TOKEN_PROGRAM_ADDRESS);

  // protocol
  const protocolBody = core.getProtocolEncoder().encode({ admin: wallet, guardian: wallet, feeRecipient: feeRecipient!, feeBps: [30, 5, 15, 30], paused: false, bump: 255, pendingAdmin: none() });
  accounts.set(await protocolAddress(), { data: new Uint8Array(protocolBody), owner: CROSS_CORE_PROGRAM_ADDRESS });
  await putPrograms();
  const registry = await core.arbiterRegistryAddress();
  const putArbiter = () => {
    if (arbiterNamed) accounts.set(registry, { data: new Uint8Array(core.getArbiterRegistryEncoder().encode({ arbiter: arbiter.address, bump: 255 })), owner: CROSS_CORE_PROGRAM_ADDRESS });
    else accounts.delete(registry);
  };
  putArbiter();

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
      lapsedSince: o.state === treasury.TreasuryState.Liquidating ? some(o.lapsedSince ?? BigInt(NOW - 220 * DAY)) : o.lapsedSince !== undefined ? some(o.lapsedSince) : none(), state: o.state ?? treasury.TreasuryState.Active, snapshotVault: 10_000_000_000n, snapshotSupply: 1_000_000_000n, bump: 255, vaultBump: 255,
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

  // The wind-down, in every state a person can find it in.
  const liq = treasury.TreasuryState.Liquidating;
  const treasuryRedeeming = await putTreasury(coinRedeeming!, { state: liq, ext: ext({ windStart: BigInt(NOW - 20 * DAY), assignRequired: false }) });
  const treasurySwept = await putTreasury(coinSwept!, { state: liq, ext: ext({ windStart: BigInt(NOW - 250 * DAY), swept: true, assignRequired: false }) });
  const treasuryNoWindow = await putTreasury(coinNoWindow!, { state: liq, ext: ext({ windowSecs: 0n, windStart: 0n, assignRequired: false }) });
  const treasuryFirst = await putTreasury(coinFirst!, { state: liq });
  const treasuryLapsing = await putTreasury(coinLapsing!, { lapsedSince: BigInt(NOW - DAY), ext: ext({ assignRequired: false }) });
  const treasuryGrace = await putTreasury(coinGrace!, { lapsedSince: BigInt(NOW - 10 * DAY), ext: ext({ assignRequired: false }) });

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
  // An empty book and its shards, so the cross page and its proof can be read like any other cross's.
  const putBooks = async (address: Address) => {
    const levels = () => new Uint8Array(sdk.getLevelsEncoder().encode({ cross: address, buy: new Array<bigint>(256).fill(0n), sell: new Array<bigint>(256).fill(0n), buyOrders: new Array<number>(256).fill(0), sellOrders: new Array<number>(256).fill(0), index: 0, pad: new Uint8Array(7) } as never));
    accounts.set(await sdk.bookAddress(address), { owner: CROSS_CORE_PROGRAM_ADDRESS, data: levels() });
    for (let i = 0; i < 2; i++) accounts.set(await sdk.shardAddress(address, i), { owner: CROSS_CORE_PROGRAM_ADDRESS, data: levels() });
  };
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
    await putBooks(address);
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

  // ------------------------------------------------------------------------------------------------ W3F accounts
  const SPL = SPL_TOKEN_PROGRAM_ADDRESS;
  const E6 = 1_000_000n;
  const dbCrosses: { address: Address; creator: Address; state: string; open: number; close: number; price: bigint | null; matched: bigint | null; reason: number | null; base: Address; orders?: number | undefined }[] = [];
  const rulesBase = sdk.completeRules({});
  const extTail = (over: Record<string, unknown> = {}) => ({
    version: 1, rulesSet: true, createdSlot: 10n, flags: 0, guards: { ...rulesBase.guards, haltSource: null }, ending: rulesBase.ending,
    draw: { epoch: 0, pendingSlot: 0n, pendingPurpose: 0, seed: new Uint8Array(32), seedEpoch: 0, seedReady: false, endBucket: 255, extPending: false, extensionUsed: false, auxMerged: 0n },
    identity: rulesBase.identity, alloc: { ...rulesBase.alloc, priorityGate: null },
    neutrality: { insiders: Array.from({ length: 8 }, () => ZERO), insiderCount: 0, insiderCliffSecs: 0, insiderVestSecs: 0, bondQuote: 0n, challengeSecs: 0 },
    neutralState: { bondHeld: 0n, slashed: 0n, openChallenges: 0, challenges: 0 },
    clearing: { classQty: [0n, 0n, 0n], tickets: 0, rho: 0, clearedTs: 0n, insiderUb: 0n },
    referral: rulesBase.referral, oracleSet: { extraFeeds: [new Uint8Array(32), new Uint8Array(32)], extraCount: 0, quorum: 0, maxSpreadBps: 0, offHoursWidenBps: 0 }, ...over,
  });
  type X = { creator?: Address; id: bigint; state: CrossState; stateName: string; open: number; close: number; base?: Address; price?: bigint; matched?: bigint; reason?: number; ext?: ReturnType<typeof extTail>; orders?: number };
  async function putX(x: X) {
    const creator = x.creator ?? wallet;
    const base = x.base ?? baseMint!;
    const address = await crossAddress(creator, x.id);
    const body = getCrossEncoder().encode({
      creator, crossId: x.id, kind: CrossKind.Launch, supplyMode: SupplyMode.Escrow, disclosure: Disclosure.Open, state: x.state, baseMint: base, quoteMint: quoteMint!, baseTokenProgram: SPL, quoteTokenProgram: SPL,
      baseDecimals: 6, quoteDecimals: 6, proceedsTo: wallet, minPrice: 1_000_000n, tick: 100_000n, ticks: 20, priceScale: 1_000_000n, openTs: BigInt(x.open), closeTs: BigInt(x.close), revealEndTs: BigInt(x.close), referencePrice: none(), minMatched: 0n,
      maxImbalanceBps: none(), protocolFeeBps: 30, integratorFeeBps: 0, integrator: integrator!, feeRecipient: feeRecipient!, gateMint: none(), shards: 2, maxOrders: 64, dustBond: 0n, ordersTotal: x.orders ?? 0, ordersOpen: x.orders ?? 0, mergedMask: x.state === CrossState.Live ? 0 : 3,
      clearing: x.price !== undefined ? some({ price: x.price, matched: x.matched ?? 0n, demand: x.matched ?? 0n, supply: x.matched ?? 0n, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 }) : none(),
      noPrintReason: x.reason !== undefined ? some(x.reason) : none(),
      buyerPaid: 0n, baseBought: 0n, baseSold: 0n, sellerPaid: 0n, feesAccrued: 0n, oracle: none(), calendar: none(), settler: none(), settleDeadlineTs: 0n, baseBound: true, bump: 1, quoteVaultBump: 1, baseVaultBump: 1, bookBump: 1,
    } as never);
    const data = new Uint8Array(CROSS_BODY_LEN + (x.ext ? sdk.CROSS_EXT_LEN : 0));
    data.set(body);
    if (x.ext) data.set(sdk.getCrossExtEncoder().encode(x.ext as never), CROSS_BODY_LEN);
    accounts.set(address, { owner: CROSS_CORE_PROGRAM_ADDRESS, data });
    await putBooks(address);
    dbCrosses.push({ address, creator, state: x.stateName, open: x.open, close: x.close, price: x.price ?? null, matched: x.matched ?? null, reason: x.reason ?? null, base, orders: x.orders });
    return address;
  }

  // ---- a calendar with two sessions ahead (for the series that follows it)
  const sessionA = NOW + 6 * 3600;
  accounts.set(calendar!, { owner: CROSS_CALENDAR_PROGRAM_ADDRESS, data: new Uint8Array(getCalendarEncoder().encode({ admin: wallet, id: 1n, timelockSecs: 3600n, sessions: [{ startTs: BigInt(sessionA), endTs: BigInt(sessionA + 6 * 3600) }, { startTs: BigInt(sessionA + DAY), endTs: BigInt(sessionA + DAY + 6 * 3600) }], feeds: [], pending: none(), pendingAdmin: none(), bump: 255 } as never)) });

  // ---- series
  const seriesRows: { address: Address; authority: Address; crosses: { idx: number; cross: Address; close: number }[] }[] = [];
  type SeriesCross = { state: CrossState; stateName: string; price?: bigint; matched?: bigint; reason?: number };
  async function putSeries(id: bigint, o: { config?: Record<string, unknown>; next?: bigint; active?: boolean; price?: bigint; crosses?: SeriesCross[]; quote?: bigint; base?: bigint } = {}) {
    const address = await core.seriesAddress(wallet, id);
    const config = {
      kind: core.CrossKind.Recurring, disclosure: core.Disclosure.Open, priceScale: 1_000_000n, grid: { relative: true, minPrice: 0n, tick: 0n, ticks: 41, tickBps: 100, center: 1_500_000n },
      startTs: BigInt(NOW - 3 * DAY + 10 * 3600), intervalSecs: BigInt(DAY), calendar: none(), callSecs: 7200n, revealSecs: 0n, minMatched: 0n, maxImbalanceBps: none(), integratorFeeBps: 0, integrator: integrator!, gateMint: none(),
      shards: 4, maxOrders: 10_000, proceedsTo: wallet, oracle: none(), maxCrosses: 0n, rules: sdk.paddedRules({}), ...o.config,
    };
    const spawned: { idx: number; cross: Address; close: number }[] = [];
    let last: Address | null = null;
    const list = o.crosses ?? [];
    for (const [i, c] of list.entries()) {
      const close = NOW - (list.length - i) * DAY - 14 * 3600;
      const cross = await putX({ creator: address, id: BigInt(i), state: c.state, stateName: c.stateName, open: close - 7200, close, ...(c.price !== undefined ? { price: c.price, matched: c.matched ?? 40n * E6 } : {}), ...(c.reason !== undefined ? { reason: c.reason } : {}) });
      spawned.push({ idx: i, cross, close });
      last = cross;
    }
    accounts.set(address, {
      owner: CROSS_CORE_PROGRAM_ADDRESS,
      data: new Uint8Array(core.getSeriesEncoder().encode({ authority: wallet, seriesId: id, baseMint: baseMint!, quoteMint: quoteMint!, baseTokenProgram: SPL, quoteTokenProgram: SPL, config, nextIndex: o.next ?? BigInt(spawned.length), lastCross: last ? some(last) : none(), lastCloseTs: BigInt(spawned.at(-1)?.close ?? 0), lastPrice: o.price ?? 0n, active: o.active ?? true, bump: 255 } as never)),
    });
    await hold(address, quoteMint!, o.quote ?? 0n, SPL);
    await hold(address, baseMint!, o.base ?? 0n, SPL);
    seriesRows.push({ address, authority: wallet, crosses: spawned });
    return address;
  }
  // NoPrintReason 6 is BelowMinimumRaise and 10 is Halted (the order of the program's enum, see packages/cross-core-client).
  const seriesDue = await putSeries(1n, { crosses: [{ state: CrossState.NoPrint, stateName: 'NoPrint', reason: 10 }, { state: CrossState.Finalized, stateName: 'Finalized', price: 1_500_000n }, { state: CrossState.Finalized, stateName: 'Finalized', price: 1_620_000n }], price: 1_620_000n, quote: 50n * E6, base: 7n * E6 });
  const seriesEarly = await putSeries(2n, { config: { startTs: BigInt(NOW + 10 * DAY), intervalSecs: BigInt(7 * DAY) }, next: 0n });
  const seriesPaused = await putSeries(3n, { active: false, crosses: [{ state: CrossState.Finalized, stateName: 'Finalized', price: 1_400_000n }], price: 1_400_000n });
  const seriesBusy = await putSeries(4n, { crosses: [{ state: CrossState.Live, stateName: 'Live' }] });
  const seriesDone = await putSeries(5n, { config: { maxCrosses: 2n }, crosses: [{ state: CrossState.Finalized, stateName: 'Finalized', price: 1_300_000n }, { state: CrossState.NoPrint, stateName: 'NoPrint', reason: 6 }] });
  const seriesCalendar = await putSeries(6n, { config: { startTs: 0n, intervalSecs: 0n, calendar: some(calendar!) }, next: 0n });

  // ---- halt states and a lender print feed
  const firstCross = dbCrosses[0]!.address;
  const putHalt = async (mint: Address, o: { halted?: boolean; reason?: number; corporate?: boolean; since?: number; unpaused?: boolean; venue?: Address | null; breaker?: boolean; resume?: boolean } = {}) => {
    const a = await core.haltStateAddress(mint);
    accounts.set(a, {
      owner: CROSS_CORE_PROGRAM_ADDRESS,
      data: new Uint8Array(core.getHaltStateEncoder().encode({ baseMint: mint, authority: wallet, venueSigner: o.venue ? some(o.venue) : none(), halted: o.halted ?? false, reason: o.reason ?? 0, corporateAction: o.corporate ?? false, sinceTs: BigInt(o.since ?? 0), sinceSlot: 1n, issuerUnpaused: o.unpaused ?? false, breaker: o.breaker ? some({ feedId: new Uint8Array(32).fill(0xab), windowSlots: 150, moveBps: 1000, lastPrice: 0n, lastExponent: 0, lastSlot: 0n, lastPublishTs: 0n }) : none(), lastResumeCross: o.resume ? some(firstCross) : none(), lastResumePrice: o.resume ? 1_500_000n : 0n, lastResumeTs: o.resume ? BigInt(NOW - 3 * DAY) : 0n, bump: 255 } as never)),
    });
    return a;
  };
  const haltVenue = await putHalt(mintHalted!, { halted: true, reason: 2, since: NOW - 2 * 3600, venue: stranger2.address, breaker: true });
  const haltFlag = await putHalt(mintFlagged!, { corporate: true, venue: stranger2.address });
  const haltClear = await putHalt(mintClear!, { resume: true });
  const printFeed = await core.printFeedAddress(mintClear!);
  accounts.set(printFeed, { owner: CROSS_CORE_PROGRAM_ADDRESS, data: new Uint8Array(core.getPrintFeedEncoder().encode({ baseMint: mintClear!, quoteMint: quoteMint!, authority: wallet, publishers: [wallet, ZERO, ZERO, ZERO], publisherCount: 1, minMatched: 5n * E6, price: 1_500_000n, priceScale: 1_000_000n, matched: 9n * E6, cross: firstCross, ts: BigInt(NOW - 3 * DAY), slot: 5n, prints: 2n, bump: 255 } as never)) });

  // ---- a cleared cross with a bond and three challenges (open, open, upheld), and two crosses that honour a halt
  const challengeCross = await putX({
    id: 20n, state: CrossState.Cleared, stateName: 'Cleared', open: NOW - 5 * DAY, close: NOW - 4 * DAY, price: 1_400_000n, matched: 80n * E6,
    ext: extTail({
      neutrality: { insiders: [alice!, ...Array.from({ length: 7 }, () => ZERO)], insiderCount: 1, insiderCliffSecs: 7 * DAY, insiderVestSecs: 90 * DAY, bondQuote: 100n * E6, challengeSecs: 3 * DAY },
      neutralState: { bondHeld: 100n * E6, slashed: 0n, openChallenges: 2, challenges: 3 },
      clearing: { classQty: [0n, 0n, 0n], tickets: 0, rho: 0, clearedTs: BigInt(NOW - 4 * DAY), insiderUb: 0n },
    }),
  });
  const challenges = [
    { id: 0, challenger: bob!, subject: stranger!, status: 0, slash: 0n, filed: NOW - 16 * DAY, evidence: 7 },
    { id: 1, challenger: alice!, subject: gateMint!, status: 0, slash: 0n, filed: NOW - 2 * DAY, evidence: 9 },
    { id: 2, challenger: stranger!, subject: integrator!, status: 1, slash: 40n * E6, filed: NOW - 3 * DAY, evidence: 11 },
  ];
  for (const c of challenges) {
    accounts.set(await sdk.challengeAddress(challengeCross, c.id), { owner: CROSS_CORE_PROGRAM_ADDRESS, data: new Uint8Array(sdk.getChallengeEncoder().encode({ cross: challengeCross, id: c.id, challenger: c.challenger, subject: c.subject, evidence: new Uint8Array(32).fill(c.evidence), deposit: 10_000_000n, filedTs: BigInt(c.filed), status: c.status, slashed: c.slash, bump: 255 } as never)) });
  }
  const haltedCross = await putX({ id: 21n, state: CrossState.Live, stateName: 'Live', open: NOW - 3600, close: NOW + 3 * 3600, base: mintHalted!, ext: extTail({ guards: { ...rulesBase.guards, haltSource: wallet } }) });
  const haltedNoPrint = await putX({ id: 22n, state: CrossState.NoPrint, stateName: 'NoPrint', open: NOW - 2 * DAY, close: NOW - DAY, base: mintHalted!, reason: 10, ext: extTail({ guards: { ...rulesBase.guards, haltSource: wallet } }) });

  // ---- a cross that did not print, with fourteen open orders (two refund batches) and one already paid out
  const refundCross = await putX({ id: 30n, state: CrossState.NoPrint, stateName: 'NoPrint', open: NOW - 2 * DAY, close: NOW - DAY, reason: 6, orders: 14 });
  const refundOrders: { owner: Address; nonce: bigint; address: Address }[] = [];
  for (let i = 0; i < 14; i++) {
    const owner = await key();
    const nonce = BigInt(i + 1);
    const orderAddr = await sdk.orderAddress(refundCross, owner, nonce);
    accounts.set(orderAddr, { owner: CROSS_CORE_PROGRAM_ADDRESS, data: new Uint8Array(sdk.getOrderEncoder().encode({ cross: refundCross, owner, nonce, index: i, side: sdk.OrderSide.Buy, state: 1, commitment: new Uint8Array(32), price: 1_500_000n, quantity: 10n * E6, escrow: 15n * E6, bump: 255 } as never)) });
    refundOrders.push({ owner, nonce, address: orderAddr });
  }

  // the database
  const pg = new PGlite();
  const dir = fileURLToPath(new URL('../../indexer/migrations/', import.meta.url));
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


  // ---- W3F rows of the index
  for (const [i, c] of dbCrosses.entries()) {
    await pg.query(
      "INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, clearing_price, matched, no_print_reason, created_slot, updated_slot, orders_committed) VALUES ($1,$2,0,0,1,$3,$4,$5,$6,$6,30,0,$7,$8,$9,$10,$11,$11,$12)",
      [c.address, c.creator, c.base, quoteMint, c.open, c.close, c.state, c.price !== null ? c.price.toString() : null, c.matched !== null ? c.matched.toString() : null, c.reason, 300 + i, c.orders ?? 0],
    );
  }
  for (const s of seriesRows) {
    await pg.query('INSERT INTO series (address, authority, created_slot) VALUES ($1,$2,$3)', [s.address, s.authority, 250]);
    for (const c of s.crosses) await pg.query('INSERT INTO series_crosses (series, idx, cross_address, close_ts, slot) VALUES ($1,$2,$3,$4,$5)', [s.address, c.idx, c.cross, c.close, 260 + c.idx]);
  }
  await pg.query("INSERT INTO calendars (address, admin, calendar_id, timelock_secs, sessions, feeds, first_slot, read_slot) VALUES ($1,$2,1,3600,$3,'[]',240,240)", [calendar, wallet, JSON.stringify([{ startTs: String(sessionA), endTs: String(sessionA + 6 * 3600) }, { startTs: String(sessionA + DAY), endTs: String(sessionA + DAY + 6 * 3600) }])]);
  await pg.query('INSERT INTO halt_states (base_mint, halted, reason, changed_slot, changes) VALUES ($1,true,2,400,3), ($2,false,4,401,1), ($3,false,0,402,2)', [mintHalted, mintFlagged, mintClear]);
  await pg.query("INSERT INTO print_feed_prints (base_mint, cross_address, price, matched, slot) VALUES ($1,$2,1500000,9000000,5), ($1,$3,1400000,6000000,4)", [mintClear, firstCross, dbCrosses[1]!.address]);
  for (const c of challenges) {
    await pg.query("INSERT INTO cross_challenges (cross_address, id, challenger, subject, evidence, status, slash, filed_slot, resolved_slot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [challengeCross, c.id, c.challenger, c.subject, Buffer.alloc(32, c.evidence).toString('hex'), c.status === 0 ? 'Open' : 'Upheld', c.slash > 0n ? c.slash.toString() : null, 500 + c.id, c.status === 0 ? null : 510]);
  }
  for (const [i, o] of refundOrders.entries()) {
    await pg.query("INSERT INTO orders (cross_address, idx, address, owner, side, escrow, sealed, price, quantity, status, created_slot, updated_slot) VALUES ($1,$2,$3,$4,0,15000000,false,1500000,10000000,'revealed',600,600)", [refundCross, i, o.address, o.owner]);
  }
  await pg.query("INSERT INTO orders (cross_address, idx, address, owner, side, escrow, sealed, price, quantity, status, fill, quote_out, base_out, fee, created_slot, updated_slot) VALUES ($1,14,$2,$3,0,15000000,false,1500000,10000000,'claimed',0,15000000,0,0,600,601)", [refundCross, await key(), await key()]);

  // ---- the API
  const app = await buildServer({
    db: { query: (text: string, params?: unknown[]) => pg.query(text, params as never[]) } as never,
    network: 'devnet',
    account: async (a: Address) => {
      const x = accounts.get(a);
      return x ? { data: x.data, owner: x.owner } : null;
    },
    lifetime: async () => ({ blockhash: BLOCKHASH as never, lastValidBlockHeight: 100n }),
    clock: () => Math.floor(Date.now() / 1000) + skew,
    w2a: false,
  } as never);
  try {
    registerHolderPrograms(app, { account: async (a) => { const x = accounts.get(a); return x ? { data: x.data, owner: x.owner } : null; }, network: 'devnet', ttlMs: 0 });
  } catch {
    // server.ts already registers GET /v1/programs
  }

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
    arbiter: { address: arbiter.address, secret: arbiter.secret }, strangerWallet: { address: stranger2.address, secret: stranger2.secret },
    series: { due: seriesDue, early: seriesEarly, paused: seriesPaused, busy: seriesBusy, done: seriesDone, calendar: seriesCalendar }, calendar,
    halts: { venue: haltVenue, flag: haltFlag, clear: haltClear, printFeed }, mints: { halted: mintHalted, flagged: mintFlagged, clear: mintClear, noHalt: mintNoHalt },
    challengeCross, haltedCross, haltedNoPrint, refundCross, refundOrders: refundOrders.map((o) => ({ ...o, nonce: o.nonce.toString() })),
    windDown: { redeeming: treasuryRedeeming, swept: treasurySwept, noWindow: treasuryNoWindow, first: treasuryFirst, lapsing: treasuryLapsing, grace: treasuryGrace },
    windCoins: { redeeming: coinRedeeming, swept: coinSwept, noWindow: coinNoWindow, first: coinFirst, lapsing: coinLapsing, grace: coinGrace },
    sessionStart: sessionA,
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
  // The harness ends itself on request, so a run never has to kill a process.
  app.post('/__exit', async () => {
    setTimeout(() => process.exit(0), 50);
    return { exiting: true };
  });
  app.post('/__arbiter', async (req) => {
    arbiterNamed = (req.body as { named?: boolean }).named !== false;
    putArbiter();
    return { arbiterNamed };
  });
  app.post('/__mode', async (req) => {
    const m = (req.body as { mode?: string }).mode;
    if (m !== 'old' && m !== 'new') return { error: 'mode is old or new' };
    mode = m;
    skew += 601;
    await putPrograms();
    return { mode };
  });

  await app.listen({ port: PORT, host: '127.0.0.1' });
  // The first reads compile the address derivations; ask for them once now so a page never meets a cold route (the calendar route gives up on a slow read).
  for (const url of [`/v1/calendar/${calendar}`, '/v1/calendar', '/v1/programs', '/v1/series']) await app.inject({ method: 'GET', url });
  console.log(JSON.stringify({ listening: `http://127.0.0.1:${PORT}`, rpc: `http://127.0.0.1:${PORT}/rpc`, mode, wallet }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

void address;
void TABLE;
