// A local harness for the W4B screens (graduation by holder vote, the settle page's fixed-price tranche and MetaDAO steps, stake-bonded listing, bounties,
// the backing watchdog, auto-invest mandates, conviction locks, baskets), for the browser tests in apps/web/e2e/w4b-*.mjs. It is the W3F harness
// (services/api/test/w3f-harness.ts) with the accounts of the seven Wave 3D programs: the real API (`buildServer`, a PGlite database with the real
// migrations) over an in-memory chain, plus a small JSON-RPC endpoint the web app reads and sends through (`/rpc`).
//
// What is real: every unsigned transaction the web app gets is built by the real route and the real SDK and client builders; the web app's wallet signs it
// with a real Ed25519 key, and this harness checks every signature before it accepts the transaction, then decodes it (program, instruction, accounts,
// arguments) so a test asserts what the wallet signed.
// What is emulated: the cluster. No program runs. `W4B_MODE=new` behaves as if the seven programs and the batch 2 build of cross_settle were deployed;
// `absent` as the cluster is today (none of them on it). A sent transaction is recorded and decoded; its effects on accounts are NOT applied, so a screen
// is checked for the transaction it signs, not for the state afterwards. Those effects are what the LiteSVM suites prove.
//
//   cd services/api && W4B_PORT=8390 npx tsx test/w4b-harness.ts
//   GET  /__fixtures   addresses of everything seeded, and the disposable keys of each person
//   GET  /__sent       every transaction the web app sent, decoded
//   POST /__reset      forget the sent transactions
//   POST /__mode {"mode":"new"|"absent"}   switch the deployed programs
//   POST /__exit       end the harness
//   POST /__fail {"in":2}   refuse the 2nd transaction sent from now
import { readFileSync, readdirSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import {
  type Address,
  type Instruction,
  createKeyPairSignerFromBytes,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  none,
  some,
} from '@solana/kit';
import { AccountState, TOKEN_2022_PROGRAM_ADDRESS, getMintEncoder, getTokenEncoder } from '@solana-program/token-2022';
import * as core from '@opening-cross/cross-core-client';
import * as settleClient from '@opening-cross/cross-settle-client';
import * as treasury from '@opening-cross/treasury-client';
import * as graduate from '@opening-cross/cross-graduate-client';
import * as listingClient from '@opening-cross/cross-listing-client';
import * as backingClient from '@opening-cross/cross-backing-client';
import * as bountyClient from '@opening-cross/cross-bounty-client';
import * as mandateClient from '@opening-cross/cross-mandate-client';
import * as convictionClient from '@opening-cross/cross-conviction-client';
import * as basketClient from '@opening-cross/cross-basket-client';
import * as sdk from '@opening-cross/sdk';
import { CROSS_BODY_LEN, CROSS_CORE_PROGRAM_ADDRESS, CROSS_GRADUATE_PROGRAM_ADDRESS, CrossKind, CrossState, Disclosure, FLAG_GOVERNED_GRADUATION, SupplyMode, crossAddress, getCrossEncoder, protocolAddress } from '@opening-cross/sdk';
import { ALPHA_VAULT_PROGRAM_ADDRESS, DAMM_V2_PROGRAM_ADDRESS, DBC_PROGRAM_ADDRESS, DLMM_PROGRAM_ADDRESS, DYNAMIC_FEE_SHARING_PROGRAM_ADDRESS, FUTARCHY_PROGRAM_ADDRESS, MET_LOCK_PROGRAM_ADDRESS, PRESALE_PROGRAM_ADDRESS, RAYDIUM_DEVNET, SQUADS_PROGRAM_ADDRESS, squadsProgramConfigAddress } from '@opening-cross/adapters';
import { SPL_TOKEN_PROGRAM_ADDRESS } from '@opening-cross/token-safety';
import { buildServer } from '../src/server.js';
import { NEW_PROGRAMS, NEW_PROGRAM_KEYS } from '../src/routes/programs-support.js';
import { NEW_PROGRAM_INSTRUCTIONS } from '../src/routes/programs-catalog.js';

const PORT = Number(process.env.W4B_PORT ?? 8390);
let mode: 'new' | 'absent' = process.env.W4B_MODE === 'absent' ? 'absent' : 'new';
/** Seconds the API's clock runs ahead of the real one. */
let skew = 0;
let failIn: number | null = null;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const E6 = 1_000_000n;
const ZERO = '11111111111111111111111111111111' as Address;
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111' as Address;
const BLOCKHASH = '4NCYB3kRT8sCNodPNuCZo8VkwveZSHhg7R7mrRBFM1Uy';
const SLOT = 400_000_000;
const SPL = SPL_TOKEN_PROGRAM_ADDRESS;

type Account = { data: Uint8Array; owner: Address; lamports?: number; parsed?: { program: string; parsed: unknown } };
const accounts = new Map<string, Account>();
const key = async () => (await generateKeyPairSigner()).address;

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
function putMint(mint: Address, program: Address, decimals: number, supply: bigint, authority: Address | null, extra: { freeze?: Address; extensions?: string[] } = {}) {
  accounts.set(mint, {
    data: mintBytes(supply, decimals, authority),
    owner: program,
    parsed: { program: program === SPL ? 'spl-token' : 'spl-token-2022', parsed: { type: 'mint', info: { decimals, supply: supply.toString(), mintAuthority: authority, freezeAuthority: extra.freeze ?? null, isInitialized: true, ...(extra.extensions ? { extensions: extra.extensions.map((e) => ({ extension: e })) } : {}) } } },
  });
}
async function hold(owner: Address, mint: Address, amount: bigint, program: Address, decimals = 6) {
  const at = await treasury.associatedTokenAddress(owner, mint, program);
  accounts.set(at, { data: tokenBytes(mint, owner, amount), owner: program, parsed: { program: program === SPL ? 'spl-token' : 'spl-token-2022', parsed: { type: 'account', info: { mint, owner, tokenAmount: { amount: amount.toString(), decimals }, state: 'initialized' } } } });
  return at;
}

/** A program the way the upgradeable loader holds it: a program account naming a ProgramData account whose bytes carry the instructions it loads. */
function putProgram(programId: Address, control: Uint8Array, rest: Uint8Array[], dataAddress: Address) {
  const lddw = (d: Uint8Array) => Uint8Array.from([0x18, 0, 0, 0, d[0]!, d[1]!, d[2]!, d[3]!, 0, 0, 0, 0, d[4]!, d[5]!, d[6]!, d[7]!, 0, 0, 0, 0, 0, 0, 0, 0]);
  const elf = new Uint8Array(64 + 32 * (rest.length + 2) + 64);
  let at = 64;
  for (const d of [control, ...rest]) {
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
}
const exists = (programId: Address) => accounts.set(programId, { data: new Uint8Array(36), owner: LOADER });

// ------------------------------------------------------------------------------------------------ instruction names

type Mod = Record<string, unknown>;
const CLIENTS: { name: string; address: Address; mod: Mod }[] = [];
async function loadClients() {
  const load = async (name: string, address: Address, pkg: string) => CLIENTS.push({ name, address, mod: (await import(pkg)) as Mod });
  CLIENTS.push({ name: 'cross_core', address: core.CROSS_CORE_PROGRAM_ADDRESS, mod: core as unknown as Mod });
  CLIENTS.push({ name: 'treasury', address: treasury.TREASURY_PROGRAM_ADDRESS, mod: treasury as unknown as Mod });
  CLIENTS.push({ name: 'cross_settle', address: settleClient.CROSS_SETTLE_PROGRAM_ADDRESS, mod: settleClient as unknown as Mod });
  CLIENTS.push({ name: 'cross_graduate', address: CROSS_GRADUATE_PROGRAM_ADDRESS, mod: graduate as unknown as Mod });
  for (const k of NEW_PROGRAM_KEYS) {
    if (k === 'crossGraduate') continue;
    const p = NEW_PROGRAMS[k];
    await load(p.name, p.address, `@opening-cross/${p.name.replace(/_/g, '-')}-client`);
  }
}
const TABLE = new Map<string, { client: (typeof CLIENTS)[number]; name: string; decoder: string }>();
function buildTable() {
  for (const client of CLIENTS) {
    for (const [k, v] of Object.entries(client.mod)) {
      const m = /^([A-Z0-9_]+)_DISCRIMINATOR$/.exec(k);
      if (!m || !(v instanceof Uint8Array) || v.length !== 8) continue;
      const pascal = m[1]!.toLowerCase().replace(/(^|_)([a-z0-9])/g, (_s, _u, c: string) => c.toUpperCase());
      if (typeof client.mod[`get${pascal}InstructionDataDecoder`] !== 'function') continue; // an account's discriminator, not an instruction's
      TABLE.set(`${client.address}:${Buffer.from(v).toString('hex')}`, { client, name: m[1]!.toLowerCase(), decoder: `get${pascal}InstructionDataDecoder` });
    }
  }
}
const PROGRAM_NAME = (address: string) => CLIENTS.find((c) => c.address === address)?.name ?? address;

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
        const decoder = (hit.client.mod[hit.decoder] as () => { decode: (b: Uint8Array) => unknown })();
        args = JSON.parse(JSON.stringify(decoder.decode(data), (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v)));
      } catch (e) {
        args = { undecodable: String(e) };
      }
    }
    return { index, program: PROGRAM_NAME(ix.programAddress), programAddress: ix.programAddress, instruction: hit?.name ?? null, accounts: (ix.accounts ?? []).map((a) => ({ address: a.address, writable: (a.role & 1) === 1, signer: a.role >= 2 })), args };
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
  await loadClients();
  buildTable();
  const issuer = await person();
  const [voter, lockedVoter, attester, other, lister, sponsor, hunter, agent, arbiter] = await Promise.all(Array.from({ length: 9 }, person));
  const wallet = issuer.address;
  for (const p of [issuer, voter, lockedVoter, attester, other, lister, sponsor, hunter, agent, arbiter]) accounts.set(p.address, { data: new Uint8Array(0), owner: ZERO, lamports: 2_000_000_000 });
  const [feeRecipient, integrator, stranger] = await Promise.all(Array.from({ length: 3 }, key));

  const quoteMint = await key();
  putMint(quoteMint, SPL, 6, 10_000_000_000_000n, null);
  await hold(wallet, quoteMint, 9_000_000_000n, SPL);

  const protocolBody = core.getProtocolEncoder().encode({ admin: wallet, guardian: wallet, feeRecipient, feeBps: [30, 5, 15, 30], paused: false, bump: 255, pendingAdmin: none() });
  accounts.set(await protocolAddress(), { data: new Uint8Array(protocolBody), owner: CROSS_CORE_PROGRAM_ADDRESS });

  // ---------------------------------------------------------------------------------------- programs
  const dataAddresses = new Map<string, Address>();
  const dataAt = async (program: Address) => {
    let a = dataAddresses.get(program);
    if (!a) dataAddresses.set(program, (a = await key()));
    return a;
  };
  async function putPrograms() {
    putProgram(core.CROSS_CORE_PROGRAM_ADDRESS, core.CREATE_CROSS_DISCRIMINATOR as Uint8Array, [core.SET_RULES_DISCRIMINATOR, core.COMMIT_ORDER_EXT_DISCRIMINATOR, core.DRAW_BEGIN_DISCRIMINATOR] as Uint8Array[], await dataAt(core.CROSS_CORE_PROGRAM_ADDRESS));
    putProgram(treasury.TREASURY_PROGRAM_ADDRESS, treasury.SPEND_DISCRIMINATOR as Uint8Array, [treasury.INIT_EXT_DISCRIMINATOR, treasury.VOTE_DISCRIMINATOR, treasury.NAV_REDEEM_DISCRIMINATOR, treasury.STAKE_DISCRIMINATOR] as Uint8Array[], await dataAt(treasury.TREASURY_PROGRAM_ADDRESS));
    // cross_settle: the instructions of the first release are always in its bytes; every other one only in the batch 2 build, as on a cluster.
    const first = new Set(['bind_dbc_mint', 'open_dbc_pool', 'open_dlmm_pair', 'seed_damm_v2', 'seed_raydium_cpmm']);
    const settle = [...TABLE.values()].filter((t) => t.client.address === settleClient.CROSS_SETTLE_PROGRAM_ADDRESS);
    const discOf = (name: string) => (settleClient as unknown as Record<string, Uint8Array>)[`${name.toUpperCase()}_DISCRIMINATOR`]!;
    putProgram(settleClient.CROSS_SETTLE_PROGRAM_ADDRESS, settleClient.OPEN_DBC_POOL_DISCRIMINATOR as Uint8Array, settle.filter((t) => t.name !== 'open_dbc_pool' && (mode === 'new' || first.has(t.name))).map((t) => discOf(t.name)), await dataAt(settleClient.CROSS_SETTLE_PROGRAM_ADDRESS));
    for (const k of NEW_PROGRAM_KEYS) {
      const p = NEW_PROGRAMS[k];
      if (mode === 'absent') accounts.delete(p.address);
      else putProgram(p.address, p.control.discriminator, NEW_PROGRAM_INSTRUCTIONS[k].map(([, d]) => d).filter((d) => Buffer.compare(d, p.control.discriminator) !== 0), await dataAt(p.address));
    }
    // The external programs the batch 2 routes check for.
    for (const program of [PRESALE_PROGRAM_ADDRESS, FUTARCHY_PROGRAM_ADDRESS, SQUADS_PROGRAM_ADDRESS, ALPHA_VAULT_PROGRAM_ADDRESS, DAMM_V2_PROGRAM_ADDRESS, DBC_PROGRAM_ADDRESS, DLMM_PROGRAM_ADDRESS, DYNAMIC_FEE_SHARING_PROGRAM_ADDRESS, MET_LOCK_PROGRAM_ADDRESS, RAYDIUM_DEVNET.cpmmProgram]) exists(program);
    const config = new Uint8Array(8 + 32 + 8 + 32 + 16);
    config.set(getAddressEncoder().encode('11111111111111111111111111111117' as Address) as Uint8Array, 8 + 32 + 8);
    accounts.set(squadsProgramConfigAddress(), { data: config, owner: SQUADS_PROGRAM_ADDRESS });
  }

  // ---------------------------------------------------------------------------------------- crosses
  const putBooks = async (address: Address) => {
    const levels = () => new Uint8Array(sdk.getLevelsEncoder().encode({ cross: address, buy: new Array<bigint>(256).fill(0n), sell: new Array<bigint>(256).fill(0n), buyOrders: new Array<number>(256).fill(0), sellOrders: new Array<number>(256).fill(0), index: 0, pad: new Uint8Array(7) } as never));
    accounts.set(await sdk.bookAddress(address), { owner: CROSS_CORE_PROGRAM_ADDRESS, data: levels() });
    for (let i = 0; i < 2; i++) accounts.set(await sdk.shardAddress(address, i), { owner: CROSS_CORE_PROGRAM_ADDRESS, data: levels() });
  };
  const rulesBase = sdk.completeRules({});
  const extTail = (flags: number, totalSupply: bigint) => ({
    version: 1, rulesSet: true, createdSlot: 10n, flags, guards: { ...rulesBase.guards, haltSource: null, totalSupply }, ending: rulesBase.ending,
    draw: { epoch: 0, pendingSlot: 0n, pendingPurpose: 0, seed: new Uint8Array(32), seedEpoch: 0, seedReady: false, endBucket: 255, extPending: false, extensionUsed: false, auxMerged: 0n },
    identity: rulesBase.identity, alloc: { ...rulesBase.alloc, priorityGate: null },
    neutrality: { insiders: Array.from({ length: 8 }, () => ZERO), insiderCount: 0, insiderCliffSecs: 0, insiderVestSecs: 0, bondQuote: 0n, challengeSecs: 0 },
    neutralState: { bondHeld: 0n, slashed: 0n, openChallenges: 0, challenges: 0 },
    clearing: { classQty: [0n, 0n, 0n], tickets: 0, rho: 0, clearedTs: 0n, insiderUb: 0n },
    referral: rulesBase.referral, oracleSet: { extraFeeds: [new Uint8Array(32), new Uint8Array(32)], extraCount: 0, quorum: 0, maxSpreadBps: 0, offHoursWidenBps: 0 },
  });
  type CrossRow = { address: Address; creator: Address; state: string; open: number; close: number; price: bigint | null; matched: bigint | null; reason: number | null; base: Address; orders: number };
  const dbCrosses: CrossRow[] = [];
  type X = { creator?: Address; id: bigint; state: CrossState; stateName: string; open: number; close: number; base: Address; price?: bigint; matched?: bigint; reason?: number; flags?: number; supply?: bigint; orders?: number; openOrders?: number; sealed?: boolean };
  async function putX(x: X) {
    const creator = x.creator ?? wallet;
    const address = await crossAddress(creator, x.id);
    const body = getCrossEncoder().encode({
      creator, crossId: x.id, kind: CrossKind.Launch, supplyMode: SupplyMode.Escrow, disclosure: x.sealed ? Disclosure.Sealed : Disclosure.Open, state: x.state, baseMint: x.base, quoteMint, baseTokenProgram: SPL, quoteTokenProgram: SPL,
      baseDecimals: 6, quoteDecimals: 6, proceedsTo: wallet, minPrice: 1_000_000n, tick: 100_000n, ticks: 20, priceScale: 1_000_000n, openTs: BigInt(x.open), closeTs: BigInt(x.close), revealEndTs: BigInt(x.close), referencePrice: none(), minMatched: 0n,
      maxImbalanceBps: none(), protocolFeeBps: 30, integratorFeeBps: 0, integrator, feeRecipient, gateMint: none(), shards: 2, maxOrders: 64, dustBond: 0n, ordersTotal: x.orders ?? 0, ordersOpen: x.openOrders ?? x.orders ?? 0, mergedMask: x.state === CrossState.Live ? 0 : 3,
      clearing: x.price !== undefined ? some({ price: x.price, matched: x.matched ?? 0n, demand: x.matched ?? 0n, supply: x.matched ?? 0n, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 }) : none(),
      noPrintReason: x.reason !== undefined ? some(x.reason) : none(),
      buyerPaid: 0n, baseBought: 0n, baseSold: 0n, sellerPaid: 0n, feesAccrued: 0n, oracle: none(), calendar: none(), settler: none(), settleDeadlineTs: 0n, baseBound: true, bump: 1, quoteVaultBump: 1, baseVaultBump: 1, bookBump: 1,
    } as never);
    const ext = x.flags !== undefined;
    const data = new Uint8Array(CROSS_BODY_LEN + (ext ? sdk.CROSS_EXT_LEN : 0));
    data.set(body);
    if (ext) data.set(sdk.getCrossExtEncoder().encode(extTail(x.flags!, x.supply ?? 0n) as never), CROSS_BODY_LEN);
    accounts.set(address, { owner: CROSS_CORE_PROGRAM_ADDRESS, data });
    await putBooks(address);
    dbCrosses.push({ address, creator, state: x.stateName, open: x.open, close: x.close, price: x.price ?? null, matched: x.matched ?? null, reason: x.reason ?? null, base: x.base, orders: x.orders ?? 0 });
    return address;
  }
  /** A base token: legacy SPL, six decimals, a supply, and a mint authority or none. */
  const base = async (supply: bigint, authority: Address | null = null) => {
    const m = await key();
    putMint(m, SPL, 6, supply, authority);
    return m;
  };
  const printed = { state: CrossState.Finalized, stateName: 'Finalized', open: NOW - 9 * DAY, close: NOW - 8 * DAY, price: 1_500_000n, matched: 80n * E6 };
  const live = { state: CrossState.Live, stateName: 'Live', open: NOW - 3600, close: NOW + 3 * 3600 };
  const G = FLAG_GOVERNED_GRADUATION;
  const SUPPLY = 1_000n * E6;

  // ---------------------------------------------------------------------------------------- FIXTURES: graduation (D10, Z0)
  const putCharter = async (cross: Address, o: { rounds: number; active: boolean; passed: boolean; quorumBps?: number; minVolume?: bigint; attesterAddress?: Address | null }) => {
    accounts.set(await sdk.charterAddress(cross), {
      owner: CROSS_GRADUATE_PROGRAM_ADDRESS,
      data: new Uint8Array(graduate.getCharterEncoder().encode({ cross, creator: wallet, quorumBps: o.quorumBps ?? 4_000, windowSecs: BigInt(7 * DAY), minVolume: o.minVolume ?? 0n, volumeAttester: o.attesterAddress ? some(o.attesterAddress) : none(), rounds: o.rounds, active: o.active, passed: o.passed, bump: 1 })),
    });
  };
  const putRound = async (cross: Address, baseMint: Address, index: number, o: { closes: number; tallies: bigint[]; finalized?: boolean; passed?: boolean; winner?: number; quorumBps?: number; minVolume?: bigint; attesterAddress?: Address | null; volume?: bigint | null }) => {
    const address = await sdk.roundAddress(cross, index);
    accounts.set(address, {
      owner: CROSS_GRADUATE_PROGRAM_ADDRESS,
      data: new Uint8Array(
        graduate.getRoundEncoder().encode({
          cross, index, baseMint, baseTokenProgram: SPL, opensTs: BigInt(o.closes - 7 * DAY), closesTs: BigInt(o.closes), quorumBps: o.quorumBps ?? 4_000, minVolume: o.minVolume ?? 0n, volumeAttester: o.attesterAddress ? some(o.attesterAddress) : none(),
          tallies: o.tallies, lockedTotal: o.tallies.reduce((a, b) => a + b, 0n), volumeQuote: o.volume ?? 0n, volumeSet: o.volume !== null && o.volume !== undefined, finalized: o.finalized ?? false, passed: o.passed ?? false, winner: o.winner ?? 0, bump: 1,
        }),
      ),
    });
    return address;
  };
  const putVote = async (round: Address, who: Address, venue: number, amount: bigint) =>
    accounts.set(await sdk.voteAddress(round, who), { owner: CROSS_GRADUATE_PROGRAM_ADDRESS, data: new Uint8Array(graduate.getVoteRecordEncoder().encode({ voter: who, round, venue, amount, bump: 1 })) });
  const putOutcome = async (cross: Address, venue: number, round: number) =>
    accounts.set(await sdk.outcomeAddress(cross), { owner: CROSS_GRADUATE_PROGRAM_ADDRESS, data: new Uint8Array(graduate.getOutcomeEncoder().encode({ cross, venue, round, publishedTs: BigInt(NOW - DAY), bump: 1 })) });

  const gMints = await Promise.all(Array.from({ length: 10 }, () => base(SUPPLY)));
  const gAuthMint = await base(SUPPLY, wallet);
  let nextId = 100n;
  const id = () => nextId++;
  const gradNew = await putX({ id: id(), ...live, base: gMints[0]!, flags: G, supply: SUPPLY });
  const gradVoting = await putX({ id: id(), ...printed, base: gMints[1]!, flags: G, supply: SUPPLY });
  await putCharter(gradVoting, { rounds: 1, active: true, passed: false });
  const roundVoting = await putRound(gradVoting, gMints[1]!, 0, { closes: NOW + 4 * DAY, tallies: [100n * E6, 180n * E6, 0n, 40n * E6] });
  await putVote(roundVoting, lockedVoter.address, 1, 50n * E6);
  const gradWaiting = await putX({ id: id(), ...printed, base: gMints[2]!, flags: G, supply: SUPPLY });
  await putCharter(gradWaiting, { rounds: 1, active: true, passed: false });
  await putRound(gradWaiting, gMints[2]!, 0, { closes: NOW - 3600, tallies: [20n * E6, 450n * E6, 0n, 0n] });
  const gradPassed = await putX({ id: id(), ...printed, base: gMints[3]!, flags: G, supply: SUPPLY });
  await putCharter(gradPassed, { rounds: 1, active: false, passed: true });
  await putRound(gradPassed, gMints[3]!, 0, { closes: NOW - DAY, tallies: [20n * E6, 450n * E6, 0n, 0n], finalized: true, passed: true, winner: 1 });
  const gradDoneFutarchy = await putX({ id: id(), ...printed, base: gMints[4]!, flags: G, supply: SUPPLY });
  await putCharter(gradDoneFutarchy, { rounds: 1, active: false, passed: true });
  await putRound(gradDoneFutarchy, gMints[4]!, 0, { closes: NOW - 3 * DAY, tallies: [0n, 0n, 0n, 520n * E6], finalized: true, passed: true, winner: 3 });
  await putOutcome(gradDoneFutarchy, 3, 0);
  const gradDoneDamm = await putX({ id: id(), ...printed, base: gMints[5]!, flags: G, supply: SUPPLY });
  await putCharter(gradDoneDamm, { rounds: 2, active: false, passed: true });
  await putRound(gradDoneDamm, gMints[5]!, 0, { closes: NOW - 12 * DAY, tallies: [100n * E6, 90n * E6, 0n, 0n], finalized: true, passed: false });
  await putRound(gradDoneDamm, gMints[5]!, 1, { closes: NOW - 3 * DAY, tallies: [600n * E6, 0n, 0n, 0n], finalized: true, passed: true, winner: 0 });
  await putOutcome(gradDoneDamm, 0, 1);
  const gradFailed = await putX({ id: id(), ...printed, base: gAuthMint, flags: G, supply: SUPPLY });
  await putCharter(gradFailed, { rounds: 1, active: false, passed: false });
  const roundFailed = await putRound(gradFailed, gAuthMint, 0, { closes: NOW - 2 * DAY, tallies: [100n * E6, 60n * E6, 0n, 0n], finalized: true, passed: false });
  await putVote(roundFailed, voter.address, 0, 60n * E6);
  const gradNoCharter = await putX({ id: id(), ...printed, base: gMints[6]!, flags: G, supply: SUPPLY });
  const gradVolume = await putX({ id: id(), ...printed, base: gMints[7]!, flags: G, supply: SUPPLY });
  await putCharter(gradVolume, { rounds: 1, active: true, passed: false, minVolume: 5_000n * E6, attesterAddress: attester.address });
  await putRound(gradVolume, gMints[7]!, 0, { closes: NOW + 2 * DAY, tallies: [0n, 450n * E6, 0n, 0n], minVolume: 5_000n * E6, attesterAddress: attester.address, volume: 1_200n * E6 });
  const crossPlain = await putX({ id: id(), ...live, base: gMints[8]!, flags: 0, supply: SUPPLY });
  await hold(voter.address, gMints[1]!, 400n * E6, SPL);
  await hold(voter.address, gMints[0]!, 100n * E6, SPL);
  await hold(lockedVoter.address, gMints[1]!, 300n * E6, SPL);
  await hold(voter.address, gAuthMint, 100n * E6, SPL);
  // the creator holds the tokens the settle page moves into a pool, a tranche or a DAO
  for (const i of [1, 4, 5, 6]) await hold(wallet, gMints[i]!, 600n * E6, SPL);

  // ---------------------------------------------------------------------------------------- FIXTURES: settle (B4, X3)
  const sMint = await base(SUPPLY);
  const settleCross = await putX({ id: id(), ...printed, base: sMint });
  await hold(wallet, sMint, 800n * E6, SPL);
  const settleBlockedCross = await (async () => {
    // a Token-2022 base: MetaDAO takes legacy tokens only
    const m = await key();
    putMint(m, TOKEN_2022_PROGRAM_ADDRESS, 6, SUPPLY, null);
    await hold(wallet, m, 500n * E6, TOKEN_2022_PROGRAM_ADDRESS);
    const address = await putX({ id: id(), ...printed, base: m });
    return address;
  })();

  // ---------------------------------------------------------------------------------------- FIXTURES: stake-bonded listing (L1)
  const bondMint = await key();
  putMint(bondMint, SPL, 6, 5_000_000_000n, null);
  await hold(lister.address, bondMint, 1_000n * E6, SPL);
  const slashTo = stranger;
  const putVenue = async (creator: Address, vid: bigint, minBond: bigint) => {
    const venue = await sdk.venueAddress(creator, vid);
    accounts.set(venue, { owner: sdk.CROSS_LISTING_PROGRAM_ADDRESS, data: new Uint8Array(listingClient.getVenueEncoder().encode({ creator, id: vid, bondMint, bondTokenProgram: SPL, minBond, releaseDelaySecs: BigInt(2 * DAY), slashTo, bump: 1 })) });
    return venue;
  };
  const venueMain = await putVenue(wallet, 0n, 100n * E6);
  const venueEmpty = await putVenue(other.address, 0n, 50n * E6);
  const bondOf = await sdk.bondAddresses(venueMain, lister.address, bondMint, SPL);
  accounts.set(bondOf.bond, { owner: sdk.CROSS_LISTING_PROGRAM_ADDRESS, data: new Uint8Array(listingClient.getBondEncoder().encode({ venue: venueMain, lister: lister.address, amount: 250n * E6, encumbered: 100n * E6, bump: 1 })) });
  const lb = await Promise.all(Array.from({ length: 5 }, () => base(SUPPLY)));
  const listingRows: { listing: Address; venue: Address; lister: Address; cross: Address; amount: bigint; status: string; slashedTo: Address | null }[] = [];
  const putListed = async (crossId: bigint, mintBase: Address, x: Omit<X, 'id' | 'base' | 'creator'>, o: { releaseAfter: number; settled?: boolean; status: string }) => {
    const cross = await putX({ ...x, id: crossId, base: mintBase, creator: lister.address });
    const listing = await sdk.listingAddress(venueMain, cross);
    accounts.set(listing, { owner: sdk.CROSS_LISTING_PROGRAM_ADDRESS, data: new Uint8Array(listingClient.getListingEncoder().encode({ venue: venueMain, lister: lister.address, cross, amount: 100n * E6, releaseAfter: BigInt(o.releaseAfter), settled: o.settled ?? false, bump: 1 })) });
    listingRows.push({ listing, venue: venueMain, lister: lister.address, cross, amount: 100n * E6, status: o.status, slashedTo: o.status === 'slashed' ? slashTo : null });
    return cross;
  };
  const listLive = await putX({ id: 1n, ...live, base: lb[0]!, creator: lister.address });
  const listWaiting = await putListed(2n, lb[1]!, { ...live }, { releaseAfter: NOW + 5 * DAY, status: 'open' });
  const listRelease = await putListed(3n, lb[2]!, { ...printed }, { releaseAfter: NOW - DAY, status: 'open' });
  const listSlash = await putListed(4n, lb[3]!, { state: CrossState.NoPrint, stateName: 'NoPrint', open: NOW - 9 * DAY, close: NOW - 8 * DAY, reason: 3 }, { releaseAfter: NOW - DAY, status: 'open' });
  const listReleased = await putListed(5n, lb[4]!, { ...printed }, { releaseAfter: NOW - 5 * DAY, settled: true, status: 'released' });

  // ---------------------------------------------------------------------------------------- FIXTURES: the backing watchdog (F6)
  const putHaltState = async (mint: Address, o: { venue: 'watchdog' | 'other' | 'none'; halted?: boolean }) => {
    const a = await sdk.backingAddresses(mint);
    const watchdog = await sdk.watchdogAddress(mint);
    accounts.set(a.halt, {
      owner: CROSS_CORE_PROGRAM_ADDRESS,
      data: new Uint8Array(core.getHaltStateEncoder().encode({ baseMint: mint, authority: wallet, venueSigner: o.venue === 'watchdog' ? some(watchdog) : o.venue === 'other' ? some(other.address) : none(), halted: o.halted ?? false, reason: o.halted ? 2 : 0, corporateAction: false, sinceTs: BigInt(NOW - 3600), sinceSlot: 5n, issuerUnpaused: false, breaker: none(), lastResumeCross: none(), lastResumePrice: 0n, lastResumeTs: 0n, bump: 255 } as never)),
    });
  };
  const policyRows: { mint: Address; policy: Address; coverage: number; age: number; att: bigint | null; at: number | null }[] = [];
  const putBacking = async (mint: Address, o: { attestation?: { atoms: bigint; ageSecs: number } | null; halted?: boolean }) => {
    const a = await sdk.backingAddresses(mint);
    await putHaltState(mint, { venue: 'watchdog', halted: o.halted ?? false });
    accounts.set(a.policy, { owner: sdk.CROSS_BACKING_PROGRAM_ADDRESS, data: new Uint8Array(backingClient.getPolicyEncoder().encode({ mint, attester: attester.address, minCoverageBps: 10_000, maxAgeSecs: 3_600n, bump: 255 })) });
    if (o.attestation) accounts.set(a.attestation, { owner: sdk.CROSS_BACKING_PROGRAM_ADDRESS, data: new Uint8Array(backingClient.getAttestationEncoder().encode({ mint, backingAtoms: o.attestation.atoms, postedTs: BigInt(NOW - o.attestation.ageSecs), bump: 255 })) });
    policyRows.push({ mint, policy: a.policy, coverage: 10_000, age: 3_600, att: o.attestation?.atoms ?? null, at: o.attestation ? NOW - o.attestation.ageSecs : null });
  };
  const [bBacked, bStale, bShort, bMissing, bHalted, bNoPolicy, bNoHalt, bOther] = await Promise.all(Array.from({ length: 8 }, () => base(SUPPLY)));
  await putBacking(bBacked!, { attestation: { atoms: 1_200n * E6, ageSecs: 600 } });
  await putBacking(bStale!, { attestation: { atoms: 1_200n * E6, ageSecs: 7_200 } });
  await putBacking(bShort!, { attestation: { atoms: 500n * E6, ageSecs: 600 } });
  await putBacking(bMissing!, { attestation: null });
  await putBacking(bHalted!, { attestation: { atoms: 1_200n * E6, ageSecs: 7_200 }, halted: true });
  await putHaltState(bNoPolicy!, { venue: 'watchdog' });
  await putHaltState(bOther!, { venue: 'other' });
  const bkCross = async (mint: Address) => putX({ id: id(), ...live, base: mint });
  const backingCrosses = { backed: await bkCross(bBacked!), stale: await bkCross(bStale!), short: await bkCross(bShort!), halted: await bkCross(bHalted!), noPolicy: await bkCross(bNoPolicy!), noHalt: await bkCross(bNoHalt!), other: await bkCross(bOther!) };

  // ---------------------------------------------------------------------------------------- FIXTURES: the adversarial bounty (X10)
  const rewardMint = await key();
  putMint(rewardMint, SPL, 6, 5_000_000_000n, null);
  await hold(sponsor.address, rewardMint, 1_000n * E6, SPL);
  await hold(hunter.address, rewardMint, 0n, SPL);
  await hold(wallet, rewardMint, 800n * E6, SPL);
  const REWARDS = [10n, 20n, 30n, 0n, 50n, 60n, 70n, 80n, 90n, 100n, 110n].map((r) => r * E6);
  const bountyRows: { bounty: Address; sponsor: Address; expires: number; funded: bigint; paid: bigint; awarded: bigint; withdrawn: bigint; mask: number }[] = [];
  const putBounty = async (who: Address, bid: bigint, o: { expires: number; pool: bigint; mask?: number; funded?: bigint }) => {
    const a = await sdk.bountyAddresses(who, bid, rewardMint, SPL);
    accounts.set(a.bounty, { owner: sdk.CROSS_BOUNTY_PROGRAM_ADDRESS, data: new Uint8Array(bountyClient.getBountyEncoder().encode({ sponsor: who, id: bid, arbiter: arbiter.address, rewardMint, tokenProgram: SPL, expiresAt: BigInt(o.expires), rewards: REWARDS, paidMask: o.mask ?? 0, awarded: 0n, bump: 1 })) });
    await hold(a.bounty, rewardMint, o.pool, SPL);
    bountyRows.push({ bounty: a.bounty, sponsor: who, expires: o.expires, funded: o.funded ?? o.pool, paid: 0n, awarded: 0n, withdrawn: 0n, mask: o.mask ?? 0 });
    return a.bounty;
  };
  const bountyOpen = await putBounty(sponsor.address, 0n, { expires: NOW + 60 * DAY, pool: 500n * E6 });
  const bountyExpired = await putBounty(wallet, 0n, { expires: NOW - DAY, pool: 300n * E6, mask: 1, funded: 420n * E6 });
  const bountyCommitted = await putBounty(wallet, 1n, { expires: NOW + 40 * DAY, pool: 200n * E6 });
  const crossBroken = await putX({ id: id(), ...live, base: await base(SUPPLY), orders: 1, openOrders: 2 });
  const crossBroken3 = await putX({ id: id(), ...printed, base: await base(SUPPLY), orders: 1, openOrders: 1 });
  const crossHonest = await putX({ id: id(), ...printed, base: await base(SUPPLY) });

  // ---------------------------------------------------------------------------------------- FIXTURES: auto-invest mandates (S4, J2)
  const mandateRows: { mandate: Address; owner: Address; agent: Address; id: bigint; max: bigint; cap: bigint; committed: bigint; revoked: boolean; expires: number; allow: { kind: number; key: Address }[]; funded: bigint; orders: number }[] = [];
  const mBase = await base(SUPPLY);
  const crossMand = await putX({ id: id(), ...live, base: mBase, flags: 0, supply: SUPPLY });
  const crossMandSealed = await putX({ id: id(), ...live, base: await base(SUPPLY), flags: 0, supply: SUPPLY, sealed: true });
  const putMandate = async (owner: Address, agentKey: Address, mid: bigint, o: { vault: bigint; sol: number; committed?: bigint; revoked?: boolean; expires?: number; orders?: number }) => {
    const a = await sdk.mandateAddresses(owner, mid, quoteMint, SPL);
    const allow = [{ kind: mandateClient.AllowKind.Creator, key: wallet }, { kind: mandateClient.AllowKind.BaseMint, key: mBase }];
    const expires = o.expires ?? NOW + 20 * DAY;
    accounts.set(a.mandate, { owner: sdk.CROSS_MANDATE_PROGRAM_ADDRESS, data: new Uint8Array(mandateClient.getMandateEncoder().encode({ owner, agent: agentKey, id: mid, quoteMint, quoteTokenProgram: SPL, maxPerOrder: 100n * E6, totalCap: 500n * E6, committed: o.committed ?? 0n, maxShareBps: 500, expiresAt: BigInt(expires), revoked: o.revoked ?? false, allow, bump: 1, signerBump: 1 })) });
    accounts.set(a.vault, { owner: SPL, data: tokenBytes(quoteMint, a.signer, o.vault), parsed: { program: 'spl-token', parsed: { type: 'account', info: { mint: quoteMint, owner: a.signer, tokenAmount: { amount: o.vault.toString(), decimals: 6 }, state: 'initialized' } } } });
    accounts.set(a.signer, { data: new Uint8Array(0), owner: ZERO, lamports: o.sol });
    mandateRows.push({ mandate: a.mandate, owner, agent: agentKey, id: mid, max: 100n * E6, cap: 500n * E6, committed: o.committed ?? 0n, revoked: o.revoked ?? false, expires, allow: allow.map((x) => ({ kind: x.kind, key: x.key })), funded: o.vault + (o.committed ?? 0n), orders: o.orders ?? 0 });
    return a.mandate;
  };
  const MIN_SOL = Number(sdk.MANDATE_MIN_SIGNER_LAMPORTS);
  const mandateActive = await putMandate(wallet, agent.address, 0n, { vault: 300n * E6, sol: MIN_SOL * 3, committed: 120n * E6, orders: 2 });
  const mandateEmpty = await putMandate(wallet, agent.address, 1n, { vault: 0n, sol: 0 });
  const mandateRevoked = await putMandate(wallet, agent.address, 2n, { vault: 40n * E6, sol: MIN_SOL * 2, revoked: true });
  const mandateExpired = await putMandate(wallet, agent.address, 3n, { vault: 50n * E6, sol: MIN_SOL * 2, expires: NOW - DAY });
  const mandateOther = await putMandate(other.address, agent.address, 0n, { vault: 80n * E6, sol: MIN_SOL * 2 });
  await hold(wallet, quoteMint, 9_000n * E6, SPL);

  // ---------------------------------------------------------------------------------------- FIXTURES: conviction locks and the soulbound badge (S7)
  const cMint = await key();
  putMint(cMint, SPL, 6, 2_000n * E6, null);
  await hold(voter.address, cMint, 500n * E6, SPL);
  const lockRows: { lock: Address; amount: bigint; lockedAt: number; unlockTs: number; unlocked: boolean; badge: boolean; days: bigint | null }[] = [];
  const putLock = async (nonce: bigint, o: { amount: bigint; lockedAt: number; unlockTs: number; withdrawn?: boolean; badge?: boolean }) => {
    const a = await sdk.convictionAddresses(voter.address, cMint, nonce, SPL);
    accounts.set(a.lock, { owner: sdk.CROSS_CONVICTION_PROGRAM_ADDRESS, data: new Uint8Array(convictionClient.getLockEncoder().encode({ holder: voter.address, mint: cMint, nonce, amount: o.amount, decimals: 6, lockedAt: BigInt(o.lockedAt), unlockTs: BigInt(o.unlockTs), withdrawn: o.withdrawn ?? false, badgeClaimed: o.badge ?? false, bump: 1 })) });
    lockRows.push({ lock: a.lock, amount: o.amount, lockedAt: o.lockedAt, unlockTs: o.unlockTs, unlocked: o.withdrawn ?? false, badge: o.badge ?? false, days: o.badge ? (o.amount * BigInt(o.unlockTs - o.lockedAt)) / (86_400n * E6) : null });
    return a.lock;
  };
  const lockLocked = await putLock(0n, { amount: 200n * E6, lockedAt: NOW - 10 * DAY, unlockTs: NOW + 30 * DAY });
  const lockReady = await putLock(1n, { amount: 100n * E6, lockedAt: NOW - 91 * DAY, unlockTs: NOW - DAY });
  const lockUnlocked = await putLock(2n, { amount: 100n * E6, lockedAt: NOW - 120 * DAY, unlockTs: NOW - 30 * DAY, withdrawn: true });
  const lockClosable = await putLock(3n, { amount: 50n * E6, lockedAt: NOW - 200 * DAY, unlockTs: NOW - 100 * DAY, withdrawn: true, badge: true });
  const lockTiny = await putLock(4n, { amount: 1_000n, lockedAt: NOW - 3 * DAY, unlockTs: NOW - DAY });
  const badgeAddrs = await sdk.convictionBadgeAddresses(voter.address, cMint);
  putMint(badgeAddrs.badgeMint, TOKEN_2022_PROGRAM_ADDRESS, 0, 5_000n, null);
  await hold(voter.address, badgeAddrs.badgeMint, 5_000n, TOKEN_2022_PROGRAM_ADDRESS, 0);

  // ---------------------------------------------------------------------------------------- FIXTURES: baskets (S5)
  const [bkA, bkC, bkOk, bkNew] = await Promise.all(Array.from({ length: 4 }, key));
  const bkB = await key();
  const bkUnsafe = await key();
  putMint(bkA!, SPL, 6, 5_000_000_000n, null, { freeze: wallet });
  putMint(bkB, TOKEN_2022_PROGRAM_ADDRESS, 6, 5_000_000_000n, null);
  putMint(bkC!, SPL, 6, 5_000_000_000n, null);
  putMint(bkOk!, SPL, 6, 5_000_000_000n, null);
  putMint(bkNew!, SPL, 6, 5_000_000_000n, null);
  putMint(bkUnsafe, TOKEN_2022_PROGRAM_ADDRESS, 6, 5_000_000_000n, null, { extensions: ['transferFeeConfig'] });
  const basketRows: { basket: Address; creator: Address; shareMint: Address; components: { mint: Address; tokenProgram: Address; unitsPerShare: string }[]; minted: bigint; redeemed: bigint }[] = [];
  const putBasket = async (bid: bigint, label: string, comps: { mint: Address; tokenProgram: Address; unitsPerShare: bigint }[], vaults: bigint[], shareSupply: bigint) => {
    const [basket] = await basketClient.findBasketPda({ creator: wallet, id: bid });
    const [shareMint] = await basketClient.findShareMintPda({ basket });
    putMint(shareMint, SPL, 6, shareSupply, basket);
    accounts.set(basket, { owner: sdk.CROSS_BASKET_PROGRAM_ADDRESS, data: new Uint8Array(basketClient.getBasketEncoder().encode({ creator: wallet, id: bid, shareMint, label, components: comps, bump: 1 })) });
    for (const [i, c] of comps.entries()) await hold(basket, c.mint, vaults[i]!, c.tokenProgram);
    basketRows.push({ basket, creator: wallet, shareMint, components: comps.map((c) => ({ mint: c.mint, tokenProgram: c.tokenProgram, unitsPerShare: c.unitsPerShare.toString() })), minted: shareSupply, redeemed: 0n });
    return { basket, shareMint };
  };
  const basketMain = await putBasket(0n, 'majors', [{ mint: bkA!, tokenProgram: SPL, unitsPerShare: 2_000_000n }, { mint: bkB, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, unitsPerShare: 750_000n }, { mint: bkC!, tokenProgram: SPL, unitsPerShare: 7n }], [6_000_000n, 2_250_001n, 21n], 3_000_000n);
  const basketShort = await putBasket(1n, 'thin', [{ mint: bkOk!, tokenProgram: SPL, unitsPerShare: 1_000_000n }, { mint: bkC!, tokenProgram: SPL, unitsPerShare: 1_000_000n }], [900_000n, 5_000_000n], 3_000_000n);
  for (const m of [bkA!, bkC!, bkOk!, bkNew!]) await hold(voter.address, m, 100n * E6, SPL);
  await hold(voter.address, bkB, 100n * E6, TOKEN_2022_PROGRAM_ADDRESS);
  await hold(voter.address, basketMain.shareMint, 1_500_000n, SPL);

  await putPrograms();

  // ---------------------------------------------------------------------------------------- the database
  const pg = new PGlite();
  const dir = fileURLToPath(new URL('../../indexer/migrations/', import.meta.url));
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) await pg.exec(readFileSync(`${dir}${f}`, 'utf8'));
  for (const [i, c] of dbCrosses.entries()) {
    await pg.query(
      'INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, clearing_price, matched, no_print_reason, created_slot, updated_slot, orders_committed) VALUES ($1,$2,0,0,1,$3,$4,$5,$6,$6,30,0,$7,$8,$9,$10,$11,$11,$12)',
      [c.address, c.creator, c.base, quoteMint, c.open, c.close, c.state, c.price !== null ? c.price.toString() : null, c.matched !== null ? c.matched.toString() : null, c.reason, 300 + i, c.orders],
    );
  }
  await pg.query('INSERT INTO listing_venues (venue, creator, bond_mint, min_bond, release_delay_secs, slash_to, created_slot) VALUES ($1,$2,$3,$4,$5,$6,10), ($7,$8,$3,$9,$5,$6,11)', [venueMain, wallet, bondMint, (100n * E6).toString(), 2 * DAY, slashTo, venueEmpty, other.address, (50n * E6).toString()]);
  for (const [i, l] of listingRows.entries()) {
    await pg.query('INSERT INTO listing_listings (listing, venue, lister, cross_address, amount, status, slashed_to, created_slot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [l.listing, l.venue, l.lister, l.cross, l.amount.toString(), l.status, l.slashedTo, 20 + i]);
  }
  for (const [i, p] of policyRows.entries()) {
    await pg.query('INSERT INTO backing_policies (policy, mint, attester, min_coverage_bps, max_age_secs, created_slot) VALUES ($1,$2,$3,$4,$5,$6)', [p.policy, p.mint, attester.address, p.coverage, p.age, 30 + i]);
    if (p.att !== null && p.at !== null) await pg.query('INSERT INTO backing_attestations (mint, attester, backing_atoms, posted_ts, slot) VALUES ($1,$2,$3,$4,$5)', [p.mint, attester.address, p.att.toString(), p.at, 40 + i]);
  }
  for (const [i, b] of bountyRows.entries()) {
    await pg.query('INSERT INTO bounties (address, sponsor, arbiter, reward_mint, expires_at, rewards, funded, paid, awarded, withdrawn, paid_mask, created_slot, updated_slot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)', [b.bounty, b.sponsor, arbiter.address, rewardMint, b.expires, JSON.stringify(REWARDS.map(String)), b.funded.toString(), b.paid.toString(), b.awarded.toString(), b.withdrawn.toString(), b.mask, 50 + i]);
  }
  await pg.query("INSERT INTO bounty_payouts (bounty, seq_key, kind, invariant, cross_address, recipient, amount, evidence, slot) VALUES ($1,'a:0','invariant',0,$2,$3,$4,NULL,60), ($1,'b:0','award',NULL,NULL,$3,$5,$6,61)", [bountyExpired, crossBroken, hunter.address, (10n * E6).toString(), (110n * E6).toString(), 'ab'.repeat(32)]);
  for (const [i, m] of mandateRows.entries()) {
    await pg.query('INSERT INTO mandates (address, owner, agent, quote_mint, max_per_order, total_cap, max_share_bps, expires_at, allow, committed, revoked, funded, funded_lamports, withdrawn, orders, created_slot, updated_slot) VALUES ($1,$2,$3,$4,$5,$6,500,$7,$8,$9,$10,$11,0,0,$12,$13,$13)', [m.mandate, m.owner, m.agent, quoteMint, m.max.toString(), m.cap.toString(), m.expires, JSON.stringify(m.allow), m.committed.toString(), m.revoked, m.funded.toString(), m.orders, 70 + i]);
  }
  await pg.query('INSERT INTO mandate_orders (order_address, mandate, cross_address, escrow, slot) VALUES ($1,$2,$3,$4,80), ($5,$2,$3,$6,81)', [await key(), mandateActive, crossMand, (50n * E6).toString(), await key(), (70n * E6).toString()]);
  for (const [i, l] of lockRows.entries()) {
    await pg.query('INSERT INTO conviction_locks (lock, holder, mint, amount, locked_at, unlock_ts, unlocked, badge_claimed, token_days, created_slot, updated_slot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)', [l.lock, voter.address, cMint, l.amount.toString(), l.lockedAt, l.unlockTs, l.unlocked, l.badge, l.days === null ? null : l.days.toString(), 90 + i]);
  }
  await pg.query('INSERT INTO conviction_badges (holder, mint, badge_mint, slot) VALUES ($1,$2,$3,95)', [voter.address, cMint, badgeAddrs.badgeMint]);
  for (const [i, b] of basketRows.entries()) {
    await pg.query('INSERT INTO baskets (address, creator, share_mint, components, minted, redeemed, created_slot, updated_slot) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)', [b.basket, b.creator, b.shareMint, JSON.stringify(b.components), b.minted.toString(), b.redeemed.toString(), 100 + i]);
  }

  // ---------------------------------------------------------------------------------------- the API
  const account = async (a: Address) => {
    const x = accounts.get(a);
    return x ? { data: x.data, owner: x.owner } : null;
  };
  process.env.RPC_URL = `http://127.0.0.1:${PORT}/rpc`;
  const app = await buildServer({
    db: { query: (text: string, params?: unknown[]) => pg.query(text, params as never[]) } as never,
    network: 'devnet',
    account,
    lifetime: async () => ({ blockhash: BLOCKHASH as never, lastValidBlockHeight: 100n }),
    clock: () => Math.floor(Date.now() / 1000) + skew,
    programsTtlMs: 0,
    w2a: false,
  } as never);

  // ---------------------------------------------------------------------------------------- the JSON-RPC endpoint the web app reads and sends through
  const sent: { signature: string; transaction: ReturnType<typeof decodeTransaction>['instructions']; feePayer: string; at: number }[] = [];
  const rpcInfo = (a: Account, enc: string, slice?: { offset: number; length: number }) => {
    const data = slice ? a.data.subarray(slice.offset, slice.offset + slice.length) : a.data;
    const info = { executable: false, lamports: a.lamports ?? 2_000_000, owner: a.owner, rentEpoch: 0, space: a.data.length };
    if (enc === 'jsonParsed' && a.parsed) return { ...info, data: { program: a.parsed.program, parsed: a.parsed.parsed, space: a.data.length } };
    return { ...info, data: [Buffer.from(data).toString('base64'), 'base64'] };
  };
  app.post('/rpc', async (req, reply) => {
    const { id: rid, method, params } = req.body as { id: number; method: string; params: unknown[] };
    const ok = (result: unknown) => reply.send({ jsonrpc: '2.0', id: rid, result });
    const fail = (code: number, message: string, data?: unknown) => reply.send({ jsonrpc: '2.0', id: rid, error: { code, message, ...(data ? { data } : {}) } });
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
        return ok({ context: ctx, value: accounts.get(params[0] as string)?.lamports ?? 1_000_000_000 });
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
        if (!accounts.has(keys[0]!)) return ok({ context: ctx, value: { err: 'AccountNotFound', logs: [], accounts: null, unitsConsumed: 0 } });
        return ok({ context: ctx, value: { err: null, logs: [], accounts: null, unitsConsumed: 40_000 } });
      }
      case 'sendTransaction': {
        const wire = new Uint8Array(Buffer.from(params[0] as string, 'base64'));
        const bad = await verifySignatures(wire);
        if (bad) return fail(-32002, `Transaction signature verification failure: ${bad}`);
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
        return fail(-32601, `the W4B harness does not emulate ${method}`);
    }
  });

  const people = { issuer, voter, lockedVoter, attester, other, lister, sponsor, hunter, agent, arbiter };
  app.get('/__fixtures', async () => ({
    mode, now: NOW, wallet, secret: issuer.secret, quoteMint, people, stranger,
    graduation: { gradNew, gradVoting, gradWaiting, gradPassed, gradDoneFutarchy, gradDoneDamm, gradFailed, gradNoCharter, gradVolume, crossPlain, roundVoting, mints: gMints, authMint: gAuthMint },
    settle: { settleCross, settleBlockedCross, mint: sMint },
    listing: { venueMain, venueEmpty, bondMint, listLive, listWaiting, listRelease, listSlash, listReleased, listings: listingRows.map((l) => ({ ...l, amount: l.amount.toString() })) },
    bounty: { rewardMint, open: bountyOpen, expired: bountyExpired, committed: bountyCommitted, broken: crossBroken, broken3: crossBroken3, honest: crossHonest },
    mandate: { active: mandateActive, empty: mandateEmpty, revoked: mandateRevoked, expired: mandateExpired, other: mandateOther, cross: crossMand, sealedCross: crossMandSealed, baseMint: mBase },
    conviction: { mint: cMint, locked: lockLocked, ready: lockReady, unlocked: lockUnlocked, closable: lockClosable, tiny: lockTiny, badgeMint: badgeAddrs.badgeMint },
    basket: { main: basketMain.basket, shareMint: basketMain.shareMint, short: basketShort.basket, a: bkA, b: bkB, c: bkC, ok: bkOk, fresh: bkNew, unsafe: bkUnsafe },
    backing: { backed: bBacked, stale: bStale, short: bShort, missing: bMissing, halted: bHalted, noPolicy: bNoPolicy, noHalt: bNoHalt, other: bOther, crosses: backingCrosses },
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
  app.post('/__exit', async () => {
    setTimeout(() => process.exit(0), 50);
    return { exiting: true };
  });
  app.post('/__mode', async (req) => {
    const m = (req.body as { mode?: string }).mode;
    if (m !== 'new' && m !== 'absent') return { error: 'mode is new or absent' };
    mode = m;
    skew += 601;
    await putPrograms();
    return { mode };
  });

  await app.listen({ port: PORT, host: '127.0.0.1' });
  for (const url of ['/v1/programs']) await app.inject({ method: 'GET', url });
  console.log(JSON.stringify({ listening: `http://127.0.0.1:${PORT}`, rpc: `http://127.0.0.1:${PORT}/rpc`, mode, wallet }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
