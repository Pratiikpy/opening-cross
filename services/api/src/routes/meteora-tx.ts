// Meteora's programs around a cross's market, as unsigned transactions (ADR-0701): the Alpha Vault, Met Lock vesting escrows and the Dynamic Fee
// Sharing vault. The instructions come from `@opening-cross/adapters`; these routes check the chain first and refuse with a reason.
//
// Nothing here is a cross_settle instruction, so the release check is whether the external program exists on the cluster (409 EXTERNAL_PROGRAM_MISSING
// otherwise). The programs' instruction layouts were taken from their published IDLs; their accounts are decoded here from the same IDLs.
//
// Alpha Vault (DAMM v2 pools; keyed by the cross whose pool it binds, because DAMM v2 records only the vault derived from the pool creator)
//   POST /v1/tx/alpha-vault-init                { cross, funder?, mode, maxBuyingCap | maxDepositingCap + individualDepositingCap, startVestingPoint, endVestingPoint, depositingPoint?, escrowFee?, whitelistMode? }
//   POST /v1/tx/alpha-vault-deposit             { cross, owner, amount, payer? }
//   POST /v1/tx/alpha-vault-fill                { cross, cranker, maxAmount? }
//   POST /v1/tx/alpha-vault-claim               { cross, owner }
//   POST /v1/tx/alpha-vault-withdraw-remaining  { cross, owner }
//   GET  /v1/crosses/:address/alpha-vault?owner=
// Met Lock
//   POST /v1/tx/metlock-create                  { sender, base, mint, recipient, schedule: { total, start, cliffSeconds, frequency, periods, cliffUnlockBps? }, cancelMode?, updateRecipientMode? }
//   POST /v1/tx/metlock-claim                   { recipient, escrow, maxAmount? }
//   GET  /v1/metlock/escrows/:escrow
// Dynamic Fee Sharing (the quote token of a cross's pool, split among two to five recipients)
//   POST /v1/tx/fee-share-create                { payer, base, cross | mint, recipients: [{ address, share }], owner? }
//   POST /v1/tx/fee-share-fund                  { funder, base, cross | mint, amount }
//   POST /v1/tx/fee-share-claim                 { user, base, cross | mint, index }
//   POST /v1/tx/fee-share-transfer-position     { cross, owner, base }       hands the cross's DAMM v2 position to the vault (one way)
//   POST /v1/tx/fee-share-fund-from-damm        { cross, signer, base }      pulls the position's fees into the vault; the signer is a recipient
//   GET  /v1/fee-share/:base/:mint
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Address, type Instruction, createNoopSigner, getAddressDecoder } from '@solana/kit';
import { getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, CrossState, ata, readRuledCross, type CrossView } from '@opening-cross/sdk';
import { CROSS_GATE_PROGRAM_ADDRESS } from '@opening-cross/cross-gate-client';
import { type Lifetime, RequestError, compile } from '../tx.js';
import { addr, int, json, list, obj, only, opt, u64 } from './_inputs.js';
import { HEAVY_UNITS, computeUnits, fits, requireProgram } from './program-gate.js';
import { registerMeteoraExtras } from './settle-meteora-extra-tx.js';

type ChainAccount = { data: Uint8Array; owner: Address };
export type MeteoraTxDeps = {
  account: (a: Address) => Promise<ChainAccount | null>;
  lifetime: () => Promise<Lifetime>;
  /** Unix seconds; defaults to the wall clock. Tests inject one. */
  clock?: () => number;
};

const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));
const starts = (data: Uint8Array, prefix: ArrayLike<number>) => data.length >= prefix.length && Array.from(prefix).every((b, i) => data[i] === b);
const adapters = () => import('@opening-cross/adapters');
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;
const ZERO = '11111111111111111111111111111111' as Address;

// ---------------------------------------------------------------------------------------------------------------------------- account layouts
// Every offset below is from the program's IDL (idls/alpha_vault.json, idls/met_lock.json, the dynamic-fee-sharing SDK's IDL); each account is C-repr or
// bytemuck, so there is no padding beyond the fields the IDL lists. The tests build accounts with these offsets and the devnet vault of
// docs/evidence/D7-fee-sharing-vault-devnet.md was decoded with them (docs/evidence/W3E-meteora-routes.md).
const ALPHA_VAULT_DISC = [211, 8, 232, 43, 2, 152, 117, 119];
const ESCROW_DISC = [244, 119, 183, 4, 73, 116, 135, 195]; // Met Lock's VestingEscrow
const ALPHA_ESCROW_DISC = [31, 213, 123, 187, 186, 22, 218, 155]; // Alpha Vault's Escrow (idls/alpha_vault.json)
const FEE_VAULT_DISC = [192, 178, 69, 232, 58, 149, 157, 132];

const pk = (d: Uint8Array, at: number): Address => getAddressDecoder().decode(d.subarray(at, at + 32));
const u64at = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset).getBigUint64(at, true);

export function decodeAlphaVault(d: Uint8Array) {
  if (d.length < 8 + 352 || !starts(d, ALPHA_VAULT_DISC)) return null;
  const o = 8;
  return {
    pool: pk(d, o), tokenVault: pk(d, o + 32), tokenOutVault: pk(d, o + 64), quoteMint: pk(d, o + 96), baseMint: pk(d, o + 128), base: pk(d, o + 160), owner: pk(d, o + 192),
    maxBuyingCap: u64at(d, o + 224), totalDeposit: u64at(d, o + 232), totalEscrow: u64at(d, o + 240), swappedAmount: u64at(d, o + 248), boughtToken: u64at(d, o + 256),
    totalRefund: u64at(d, o + 264), totalClaimedToken: u64at(d, o + 272), startVestingPoint: u64at(d, o + 280), endVestingPoint: u64at(d, o + 288),
    poolType: d[o + 297]!, vaultMode: d[o + 298]!, maxDepositingCap: u64at(d, o + 304), individualDepositingCap: u64at(d, o + 312), depositingPoint: u64at(d, o + 320),
    escrowFee: u64at(d, o + 328), totalEscrowFee: u64at(d, o + 336), whitelistMode: d[o + 344]!, activationType: d[o + 345]!,
  };
}

export function decodeVestingEscrow(d: Uint8Array) {
  if (d.length < 8 + 240 || !starts(d, ESCROW_DISC)) return null;
  const o = 8;
  return {
    recipient: pk(d, o), tokenMint: pk(d, o + 32), creator: pk(d, o + 64), base: pk(d, o + 96),
    updateRecipientMode: d[o + 129]!, cancelMode: d[o + 130]!, tokenProgramFlag: d[o + 131]!,
    cliffTime: u64at(d, o + 136), frequency: u64at(d, o + 144), cliffUnlockAmount: u64at(d, o + 152), amountPerPeriod: u64at(d, o + 160), numberOfPeriod: u64at(d, o + 168),
    totalClaimedAmount: u64at(d, o + 176), vestingStartTime: u64at(d, o + 184), cancelledAt: u64at(d, o + 192),
  };
}

export function decodeFeeVault(d: Uint8Array) {
  if (d.length < 8 + 640 || !starts(d, FEE_VAULT_DISC)) return null;
  const o = 8;
  const v = new DataView(d.buffer, d.byteOffset);
  const users = [];
  for (let i = 0; i < 5; i++) {
    const at = o + 240 + i * 80;
    const address = pk(d, at);
    const share = v.getUint32(at + 32, true);
    if (address === ZERO && share === 0) continue;
    users.push({ index: i, address, share, feeClaimed: u64at(d, at + 40) });
  }
  return { owner: pk(d, o), tokenMint: pk(d, o + 32), tokenVault: pk(d, o + 64), totalShare: v.getUint32(o + 112, true), totalFundedFee: u64at(d, o + 120), base: pk(d, o + 144), users };
}

/** The program a Token-2022 mint's transfer hook runs (extension type 14), or null when it has no hook or the hook program is unset. */
export function transferHookProgram(mint: Uint8Array): Address | null {
  if (mint.length <= 166 || mint[165] !== 1) return null;
  const v = new DataView(mint.buffer, mint.byteOffset);
  for (let at = 166; at + 4 <= mint.length; ) {
    const type = v.getUint16(at, true);
    const len = v.getUint16(at + 2, true);
    if (type === 0 && len === 0) break;
    if (type === 14 && len >= 64 && at + 4 + 64 <= mint.length) return mint.subarray(at + 36, at + 68).some((b) => b !== 0) ? pk(mint, at + 36) : null;
    at += 4 + len;
  }
  return null;
}

/** Whether a Token-2022 mint carries an active transfer hook (extension type 14 with a non-zero program id). Met Lock is built without hook accounts. */
export function hasActiveTransferHook(mint: Uint8Array): boolean {
  return transferHookProgram(mint) !== null;
}

export function registerMeteoraTx(app: FastifyInstance, d: MeteoraTxDeps): void {
  const now = () => BigInt(d.clock?.() ?? Math.floor(Date.now() / 1000));

  async function readCross(a: Address): Promise<CrossView> {
    const acct = await d.account(a);
    if (!acct) throw new RequestError(404, `cross ${a} not found on chain`);
    if (acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !starts(acct.data, CROSS_DISCRIMINATOR)) throw new RequestError(404, `${a} is not an Opening Cross account`);
    return readRuledCross(a, acct.data);
  }
  const marketOf = (c: CrossView) => {
    if (c.data.state === CrossState.Live || c.data.clearing.__option !== 'Some') throw new RequestError(409, 'The cross has not printed a price, so it has no market.', { reason: c.data.state === CrossState.Live ? 'LIVE' : 'NOT_CLEARED' });
    if (!c.data.baseBound || c.data.baseMint === ZERO) throw new RequestError(409, 'The cross has no base mint yet.', { reason: 'NO_BASE_MINT' });
  };
  const mintProgram = async (mint: Address, role = 'mint') => {
    const a = await d.account(mint);
    if (!a) throw new RequestError(404, `no account exists at the ${role} ${mint}`, { reason: 'MINT_NOT_FOUND' });
    if (a.owner !== TOKEN_PROGRAM && a.owner !== TOKEN_2022_PROGRAM_ADDRESS) throw new RequestError(422, `${mint} is not a token mint (it is owned by ${a.owner}).`, { reason: 'NOT_A_TOKEN_MINT' });
    return { tokenProgram: a.owner, data: a.data };
  };
  const tokenBalance = async (owner: Address, mint: Address, tokenProgram: Address, role: string, need: bigint) => {
    const account = await ata(owner, mint, tokenProgram);
    const a = await d.account(account);
    if (!a || a.data.length < 72) throw new RequestError(409, `${owner} has no ${role} token account (${account}); create it and fund it first.`, { reason: `NO_${role.toUpperCase()}_ACCOUNT`, account });
    const have = u64at(a.data, 64);
    if (have < need) throw new RequestError(422, `${owner} holds ${have} of the ${role} token; ${need} is needed.`, { reason: `INSUFFICIENT_${role.toUpperCase()}`, have, need, account });
  };
  /**
   * The accounts a transfer of the cross's base token needs when it carries the cross_gate hook, or null when it has none. A hook this protocol does not know the accounts of
   * is refused: a transfer built without them would fail, or worse, be built wrong.
   */
  const gateHook = async (baseMint: Address, sourceOwner: Address, destinationOwner: Address) => {
    const { tokenProgram, data } = await mintProgram(baseMint, 'base mint');
    if (tokenProgram !== TOKEN_2022_PROGRAM_ADDRESS) return null;
    const program = transferHookProgram(data);
    if (!program) return null;
    if (program !== CROSS_GATE_PROGRAM_ADDRESS) throw new RequestError(422, `The base mint ${baseMint} runs the transfer hook ${program}, whose accounts this API does not know; only cross_gate (${CROSS_GATE_PROGRAM_ADDRESS}) is built.`, { reason: 'UNKNOWN_TRANSFER_HOOK', program });
    const a = await adapters();
    return a.gateHookAccounts(baseMint, sourceOwner, destinationOwner);
  };
  const owns = async (tokenAccount: Address) => {
    const a = await d.account(tokenAccount);
    return a && a.data.length >= 64 ? pk(a.data, 32) : null;
  };

  // ------------------------------------------------------------------------------------------------------------------------------ Alpha Vault
  type AlphaVenue = 'damm' | 'dlmm';
  /** The vault a cross's market can have, for one venue: DAMM v2 binds a vault to its pool, DLMM to its pair (pool types 2 and 0), both derived from the cross creator. */
  async function alphaOf(cross: CrossView, venue: AlphaVenue = 'damm') {
    const a = await adapters();
    marketOf(cross);
    const addrs = await a.dammAddresses(cross.address, cross.data.baseMint, cross.data.quoteMint);
    const pair = a.dlmmAddresses(cross.data.baseMint, cross.data.quoteMint);
    const pool = venue === 'damm' ? addrs.pool : pair.lbPair;
    const { vault } = a.alphaVaultAddresses(cross.data.creator, pool);
    return { a, addrs, pair, pool, vault, venue };
  }
  /** The cross's Alpha Vault on whichever venue has one (DAMM v2 first), or null. */
  async function findVault(cross: CrossView) {
    for (const venue of ['damm', 'dlmm'] as const) {
      const o = await alphaOf(cross, venue);
      const acct = await d.account(o.vault);
      const state = acct && acct.owner === o.a.ALPHA_VAULT_PROGRAM_ADDRESS ? decodeAlphaVault(acct.data) : null;
      if (state) return { ...o, state };
    }
    return null;
  }
  async function vaultOf(cross: CrossView) {
    const found = await findVault(cross);
    if (!found) {
      const o = await alphaOf(cross);
      throw new RequestError(404, `The cross has no Alpha Vault (looked at ${o.vault} for its DAMM v2 pool and at the DLMM pair's): create it with alpha-vault-init, after opening the market with alphaVault true.`, { reason: 'NO_ALPHA_VAULT', vault: o.vault });
    }
    return found;
  }
  const escrowDeposit = async (escrow: Address) => {
    const acct = await d.account(escrow);
    return acct && starts(acct.data, ALPHA_ESCROW_DISC) && acct.data.length >= 8 + 80 ? u64at(acct.data, 72) : null;
  };
  const sized = (payer: Address, ixs: Instruction[], what: string) => {
    const all = [computeUnits(HEAVY_UNITS), ...ixs];
    return { ixs: all, bytes: fits(payer, all, what) };
  };
  const transaction = async (payer: Address, ixs: Instruction[], extra: Record<string, unknown>) => ({ ...compile(payer, ixs, await d.lifetime()), ...extra });

  app.post('/v1/tx/alpha-vault-init', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'funder', 'mode', 'venue', 'maxBuyingCap', 'maxDepositingCap', 'individualDepositingCap', 'startVestingPoint', 'endVestingPoint', 'depositingPoint', 'escrowFee', 'whitelistMode'], 'alpha-vault-init');
    if (b.venue !== undefined && b.venue !== 'damm' && b.venue !== 'dlmm') throw new RequestError(400, 'venue must be "damm" (the default) or "dlmm"');
    const venue: AlphaVenue = b.venue === 'dlmm' ? 'dlmm' : 'damm';
    const cross = await readCross(addr(b.cross, 'cross'));
    const funder = opt(b.funder, (v) => addr(v, 'funder')) ?? cross.data.creator;
    if (b.mode !== 'prorata' && b.mode !== 'fcfs') throw new RequestError(400, 'mode must be "prorata" or "fcfs"');
    const startVestingPoint = u64(b.startVestingPoint, 'startVestingPoint');
    const endVestingPoint = u64(b.endVestingPoint, 'endVestingPoint');
    const depositingPoint = opt(b.depositingPoint, (v) => u64(v, 'depositingPoint'));
    const escrowFee = opt(b.escrowFee, (v) => u64(v, 'escrowFee'));
    const whitelistMode = opt(b.whitelistMode, (v) => int(v, 'whitelistMode', 2));
    const caps = b.mode === 'prorata' ? { mode: 'prorata' as const, maxBuyingCap: u64(b.maxBuyingCap, 'maxBuyingCap') } : { mode: 'fcfs' as const, maxDepositingCap: u64(b.maxDepositingCap, 'maxDepositingCap'), individualDepositingCap: u64(b.individualDepositingCap, 'individualDepositingCap') };
    if (b.mode === 'prorata' && (b.maxDepositingCap !== undefined || b.individualDepositingCap !== undefined)) throw new RequestError(400, 'a pro-rata vault takes maxBuyingCap, not the first-come caps');
    if (b.mode === 'fcfs' && b.maxBuyingCap !== undefined) throw new RequestError(400, 'a first-come vault takes maxDepositingCap and individualDepositingCap, not maxBuyingCap');
    if (startVestingPoint > endVestingPoint) throw new RequestError(422, 'Vesting cannot start after it ends.', { reason: 'VESTING_ORDER' });
    const { a, pool: poolAddress, vault } = await alphaOf(cross, venue);
    await requireProgram(d.account, a.ALPHA_VAULT_PROGRAM_ADDRESS, 'Meteora Alpha Vault');
    const pool = await d.account(poolAddress);
    const venueProgram = venue === 'damm' ? a.DAMM_V2_PROGRAM_ADDRESS : a.DLMM_PROGRAM_ADDRESS;
    if (!pool || pool.owner !== venueProgram) throw new RequestError(409, venue === 'damm' ? `The cross has no DAMM v2 pool at ${poolAddress}: seed it with alphaVault true first; the vault binds to that pool.` : `The cross has no DLMM pair at ${poolAddress}: open it with a batch start and alphaVault true first; the vault binds to that pair.`, { reason: 'NO_POOL', pool: poolAddress, venue });
    if (await d.account(vault)) throw new RequestError(409, `The cross has an Alpha Vault already at ${vault}.`, { reason: 'VAULT_EXISTS', vault });
    const built = await a.buildInitializeAlphaVault({
      funder: createNoopSigner(funder),
      base: createNoopSigner(cross.data.creator),
      pool: poolAddress,
      poolType: venue === 'damm' ? a.AlphaPoolType.DammV2 : a.AlphaPoolType.Dlmm,
      baseMint: cross.data.baseMint,
      baseTokenProgram: cross.data.baseTokenProgram,
      quoteMint: cross.data.quoteMint,
      quoteTokenProgram: cross.data.quoteTokenProgram,
      startVestingPoint,
      endVestingPoint,
      ...(depositingPoint !== null && { depositingPoint }),
      ...(escrowFee !== null && { escrowFee }),
      ...(whitelistMode !== null && { whitelistMode }),
      ...caps,
    });
    const { ixs, bytes } = sized(funder, built.instructions, 'Alpha Vault creation');
    return send(reply, await transaction(funder, ixs, { bytes, vault: built.vault, pool: poolAddress, venue, tokenVault: built.tokenVault, tokenOutVault: built.tokenOutVault, note: `The cross creator signs as the vault base: ${venue === 'damm' ? 'DAMM v2' : 'DLMM'} records only the vault derived from the account that created the ${venue === 'damm' ? 'pool' : 'pair'}.` }));
  });

  app.post('/v1/tx/alpha-vault-deposit', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'owner', 'amount', 'payer'], 'alpha-vault-deposit');
    const cross = await readCross(addr(b.cross, 'cross'));
    const owner = addr(b.owner, 'owner');
    const payer = opt(b.payer, (v) => addr(v, 'payer')) ?? owner;
    const amount = u64(b.amount, 'amount');
    if (amount === 0n) throw new RequestError(400, 'amount must be above zero');
    const { a, pool, vault, state } = await vaultOf(cross);
    if (state.maxDepositingCap > 0n && state.totalDeposit + amount > state.maxDepositingCap) {
      throw new RequestError(422, `The vault takes ${state.maxDepositingCap - state.totalDeposit} more; ${amount} was asked.`, { reason: 'OVER_CAP', room: state.maxDepositingCap > state.totalDeposit ? state.maxDepositingCap - state.totalDeposit : 0n });
    }
    const escrow = a.alphaEscrowAddress(vault, owner);
    // A first-come vault also caps each wallet. The program would clamp a deposit to the room left; this route says so instead of charging less than was asked.
    if (state.vaultMode === 1 && state.individualDepositingCap > 0n) {
      const have = (await escrowDeposit(escrow)) ?? 0n;
      if (have + amount > state.individualDepositingCap) {
        throw new RequestError(422, `One wallet may deposit ${state.individualDepositingCap} in this vault; ${owner} has ${have} in, so ${state.individualDepositingCap > have ? state.individualDepositingCap - have : 0n} more is the most.`, { reason: 'OVER_WALLET_CAP', room: state.individualDepositingCap > have ? state.individualDepositingCap - have : 0n, deposited: have });
      }
    }
    await tokenBalance(owner, cross.data.quoteMint, cross.data.quoteTokenProgram, 'quote', amount);
    const withEscrow = !(await d.account(escrow));
    const ixs = await a.buildAlphaDeposit({ vault, pool, owner: createNoopSigner(owner), ...(payer !== owner && { payer: createNoopSigner(payer) }), quoteMint: cross.data.quoteMint, quoteTokenProgram: cross.data.quoteTokenProgram, amount, tokenVault: state.tokenVault, withEscrow });
    const sizedTx = sized(payer, ixs, 'Alpha Vault deposit');
    return send(reply, await transaction(payer, sizedTx.ixs, { bytes: sizedTx.bytes, vault, escrow, opensEscrow: withEscrow, escrowFeeLamports: withEscrow ? state.escrowFee : 0n }));
  });

  app.post('/v1/tx/alpha-vault-fill', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'cranker', 'maxAmount'], 'alpha-vault-fill');
    const cross = await readCross(addr(b.cross, 'cross'));
    const cranker = addr(b.cranker, 'cranker');
    const { a, addrs, pair, pool: poolAddress, venue, vault, state } = await vaultOf(cross);
    const cap = state.maxBuyingCap > 0n && state.maxBuyingCap < state.totalDeposit ? state.maxBuyingCap : state.totalDeposit;
    const left = cap > state.swappedAmount ? cap - state.swappedAmount : 0n;
    const maxAmount = opt(b.maxAmount, (v) => u64(v, 'maxAmount')) ?? left;
    if (left === 0n) throw new RequestError(409, state.totalDeposit === 0n ? 'Nobody has deposited, so there is nothing to buy with.' : 'The vault has bought with everything it may spend.', { reason: 'NOTHING_TO_FILL', totalDeposit: state.totalDeposit, swappedAmount: state.swappedAmount });
    if (maxAmount === 0n || maxAmount > left) throw new RequestError(422, `The vault can still spend ${left}; ${maxAmount} was asked.`, { reason: 'OVER_FILL', left });
    let ix: Instruction;
    if (venue === 'damm') {
      ix = a.buildAlphaFillDammV2({
        vault,
        cranker: createNoopSigner(cranker),
        maxAmount,
        tokenVault: state.tokenVault,
        tokenOutVault: state.tokenOutVault,
        pool: { address: addrs.pool, authority: addrs.poolAuthority, tokenAVault: addrs.tokenAVault, tokenBVault: addrs.tokenBVault, tokenAMint: cross.data.baseMint, tokenBMint: cross.data.quoteMint, tokenAProgram: cross.data.baseTokenProgram, tokenBProgram: cross.data.quoteTokenProgram, eventAuthority: addrs.eventAuthority, programAddress: a.DAMM_V2_PROGRAM_ADDRESS },
      });
    } else {
      // The vault buys base from the bins above the active bin, so DLMM needs the bin arrays from the active bin upward; they must exist (the ladder created them).
      const pairAccount = await d.account(poolAddress);
      if (!pairAccount || pairAccount.owner !== a.DLMM_PROGRAM_ADDRESS || pairAccount.data.length < 80) throw new RequestError(409, `The DLMM pair ${poolAddress} does not exist.`, { reason: 'NO_POOL', pool: poolAddress });
      const activeId = new DataView(pairAccount.data.buffer, pairAccount.data.byteOffset).getInt32(76, true);
      const first = a.binArrayIndex(activeId);
      const arrays: Address[] = [];
      for (let i = first; i < first + 4; i++) {
        const at = a.binArrayAddress(poolAddress, i);
        if (await d.account(at)) arrays.push(at);
        else break;
      }
      if (arrays.length === 0) throw new RequestError(409, 'The pair has no bin array at its active bin, so no base is for sale: lay the conviction ladder first.', { reason: 'NO_LIQUIDITY', activeId });
      const hook = await gateHook(cross.data.baseMint, pair.lbPair, vault);
      ix = a.buildAlphaFillDlmm({ vault, cranker: createNoopSigner(cranker), maxAmount, tokenVault: state.tokenVault, tokenOutVault: state.tokenOutVault, pair: a.dlmmPairFor(cross.data.baseMint, cross.data.quoteMint, cross.data.baseTokenProgram, cross.data.quoteTokenProgram), binArrays: arrays, ...(hook && { hookAccounts: hook.map((x) => x.address), hooks: [{ side: 'x' as const, length: hook.length }] }) });
    }
    const sizedTx = sized(cranker, [ix], 'Alpha Vault fill');
    return send(reply, await transaction(cranker, sizedTx.ixs, { bytes: sizedTx.bytes, vault, venue, maxAmount, left }));
  });

  app.post('/v1/tx/alpha-vault-claim', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'owner'], 'alpha-vault-claim');
    const cross = await readCross(addr(b.cross, 'cross'));
    const owner = addr(b.owner, 'owner');
    const { a, vault, state } = await vaultOf(cross);
    if (!(await d.account(a.alphaEscrowAddress(vault, owner)))) throw new RequestError(404, `${owner} has no escrow in this vault: it never deposited.`, { reason: 'NO_ESCROW' });
    if (state.boughtToken === 0n) throw new RequestError(409, 'The vault has not bought base tokens yet; nothing can be claimed.', { reason: 'NOTHING_BOUGHT' });
    if (state.activationType === 1 && now() < state.startVestingPoint) throw new RequestError(409, `Claims open at ${state.startVestingPoint}.`, { reason: 'NOT_VESTING_YET', startVestingPoint: state.startVestingPoint });
    const ixs = await a.buildAlphaClaim({ vault, owner: createNoopSigner(owner), baseMint: cross.data.baseMint, baseTokenProgram: cross.data.baseTokenProgram, tokenOutVault: state.tokenOutVault });
    const sizedTx = sized(owner, ixs, 'Alpha Vault claim');
    return send(reply, await transaction(owner, sizedTx.ixs, { bytes: sizedTx.bytes, vault }));
  });

  app.post('/v1/tx/alpha-vault-withdraw-remaining', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'owner'], 'alpha-vault-withdraw-remaining');
    const cross = await readCross(addr(b.cross, 'cross'));
    const owner = addr(b.owner, 'owner');
    const { a, pool, vault, state } = await vaultOf(cross);
    if (!(await d.account(a.alphaEscrowAddress(vault, owner)))) throw new RequestError(404, `${owner} has no escrow in this vault: it never deposited.`, { reason: 'NO_ESCROW' });
    // `total_refund` counts what has been taken back so far, so it is zero before the first refund. A vault that spent less than it was given has quote to return; one that spent
    // everything has none (unless refunds were already paid, which only an oversubscribed vault does).
    const escrowAccount = await d.account(a.alphaEscrowAddress(vault, owner));
    if (state.swappedAmount === 0n || (state.totalDeposit <= state.swappedAmount && state.totalRefund === 0n)) throw new RequestError(409, state.swappedAmount === 0n ? 'The vault has not bought yet, so nothing is refundable yet.' : 'The vault was not oversubscribed: there is no quote to take back.', { reason: 'NOTHING_TO_WITHDRAW', totalRefund: state.totalRefund });
    if (escrowAccount && escrowAccount.data.length > 96 && escrowAccount.data[96] === 1) throw new RequestError(409, `${owner} has taken back the quote that did not fit already.`, { reason: 'ALREADY_REFUNDED' });
    const ix = await a.buildAlphaWithdrawRemaining({ vault, pool, owner: createNoopSigner(owner), quoteMint: cross.data.quoteMint, quoteTokenProgram: cross.data.quoteTokenProgram, tokenVault: state.tokenVault });
    const sizedTx = sized(owner, [ix], 'Alpha Vault refund');
    return send(reply, await transaction(owner, sizedTx.ixs, { bytes: sizedTx.bytes, vault, totalRefund: state.totalRefund }));
  });

  app.post('/v1/tx/alpha-vault-withdraw', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'owner', 'amount'], 'alpha-vault-withdraw');
    const cross = await readCross(addr(b.cross, 'cross'));
    const owner = addr(b.owner, 'owner');
    const { a, pool, vault, state } = await vaultOf(cross);
    if (state.vaultMode === 1) throw new RequestError(422, 'A first-come vault does not let a depositor take a deposit back: the program refuses it (VaultModeIsIncorrect).', { reason: 'FCFS_NO_WITHDRAW' });
    const have = await escrowDeposit(a.alphaEscrowAddress(vault, owner));
    if (have === null) throw new RequestError(404, `${owner} has no escrow in this vault: it never deposited.`, { reason: 'NO_ESCROW' });
    if (state.swappedAmount > 0n) throw new RequestError(409, 'The vault has started buying, so the window for taking a deposit back is over; if the vault was oversubscribed, alpha-vault-withdraw-remaining returns what it did not use.', { reason: 'WINDOW_CLOSED', swappedAmount: state.swappedAmount });
    if (have === 0n) throw new RequestError(409, 'The escrow holds no deposit; close it with alpha-vault-close-escrow.', { reason: 'NOTHING_TO_WITHDRAW' });
    const amount = opt(b.amount, (v) => u64(v, 'amount')) ?? have;
    if (amount === 0n) throw new RequestError(400, 'amount must be above zero');
    if (amount > have) throw new RequestError(422, `The escrow holds ${have}; ${amount} was asked. (The program would give back all ${have} and say nothing; this route asks you to name what you mean.)`, { reason: 'OVER_WITHDRAW', deposited: have });
    const ix = await a.buildAlphaWithdraw({ vault, pool, owner: createNoopSigner(owner), quoteMint: cross.data.quoteMint, quoteTokenProgram: cross.data.quoteTokenProgram, tokenVault: state.tokenVault, amount });
    const sizedTx = sized(owner, [ix], 'Alpha Vault withdrawal');
    return send(reply, await transaction(owner, sizedTx.ixs, { bytes: sizedTx.bytes, vault, amount, leavesInEscrow: have - amount, note: amount === have ? 'This empties the escrow; alpha-vault-close-escrow then returns its rent.' : 'Part stays in the vault.' }));
  });

  app.post('/v1/tx/alpha-vault-close-escrow', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'owner', 'rentReceiver'], 'alpha-vault-close-escrow');
    const cross = await readCross(addr(b.cross, 'cross'));
    const owner = addr(b.owner, 'owner');
    const rentReceiver = opt(b.rentReceiver, (v) => addr(v, 'rentReceiver')) ?? owner;
    const { a, vault, state } = await vaultOf(cross);
    const have = await escrowDeposit(a.alphaEscrowAddress(vault, owner));
    if (have === null) throw new RequestError(404, `${owner} has no escrow in this vault.`, { reason: 'NO_ESCROW' });
    if (have > 0n && state.swappedAmount === 0n) throw new RequestError(409, `The escrow still holds ${have}; take it back with alpha-vault-withdraw first.`, { reason: 'HOLDS_DEPOSIT', deposited: have });
    const ix = a.buildAlphaCloseEscrow({ vault, owner: createNoopSigner(owner), rentReceiver });
    const sizedTx = sized(owner, [ix], 'Alpha Vault escrow close');
    return send(reply, await transaction(owner, sizedTx.ixs, { bytes: sizedTx.bytes, vault, rentReceiver, note: have > 0n ? 'The vault has bought; the program closes the escrow only once its claim has been taken, and says so if it has not.' : 'The escrow is empty.' }));
  });

  app.get('/v1/crosses/:address/alpha-vault', async (req, reply) => {
    const cross = await readCross(addr((req.params as { address: string }).address, 'address'));
    const owner = (req.query as { owner?: string }).owner;
    if (owner !== undefined) addr(owner, 'owner');
    if (cross.data.state === CrossState.Live || !cross.data.baseBound || cross.data.baseMint === ZERO || cross.data.clearing.__option !== 'Some') return send(reply, { cross: cross.address, vault: null, state: null, note: 'The cross has no market (it is live, did not print a price, or has no base token bound), so no Alpha Vault can exist for it.' });
    const found = await findVault(cross);
    if (!found) return send(reply, { cross: cross.address, vault: (await alphaOf(cross)).vault, state: null, note: 'No Alpha Vault has been created for this cross.' });
    const { a, vault, venue, state } = found;
    const escrow = owner ? a.alphaEscrowAddress(vault, owner as Address) : null;
    const deposited = escrow ? await escrowDeposit(escrow) : null;
    return send(reply, { cross: cross.address, vault, venue, state, mode: state.vaultMode === 1 ? 'fcfs' : 'prorata', ...(escrow && { escrow, hasEscrow: !!(await d.account(escrow)), deposited: deposited ?? 0n }) });
  });

  // ------------------------------------------------------------------------------------------------------------------------------ Met Lock
  app.post('/v1/tx/metlock-create', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['sender', 'base', 'mint', 'recipient', 'schedule', 'cancelMode', 'updateRecipientMode'], 'metlock-create');
    const sender = addr(b.sender, 'sender');
    const base = addr(b.base, 'base');
    const mint = addr(b.mint, 'mint');
    const recipient = addr(b.recipient, 'recipient');
    const s = obj(b.schedule, 'schedule');
    only(s, ['total', 'start', 'cliffSeconds', 'frequency', 'periods', 'cliffUnlockBps'], 'schedule');
    const cancelMode = b.cancelMode === undefined ? 0 : int(b.cancelMode, 'cancelMode', 3);
    const updateRecipientMode = b.updateRecipientMode === undefined ? 0 : int(b.updateRecipientMode, 'updateRecipientMode', 3);
    const a = await adapters();
    let schedule;
    try {
      schedule = a.metLockSchedule({ total: u64(s.total, 'schedule.total'), start: u64(s.start, 'schedule.start'), cliffSeconds: u64(s.cliffSeconds ?? '0', 'schedule.cliffSeconds'), frequency: u64(s.frequency ?? '1', 'schedule.frequency'), periods: u64(s.periods, 'schedule.periods'), ...(s.cliffUnlockBps !== undefined && { cliffUnlockBps: int(s.cliffUnlockBps, 'schedule.cliffUnlockBps', 10_000) }) });
    } catch (e) {
      if (e instanceof RequestError) throw e;
      throw new RequestError(422, (e as Error).message, { reason: 'SCHEDULE_INVALID' });
    }
    if (base === sender) throw new RequestError(400, 'base must be a fresh keypair, not the sender: it makes the escrow address unique and signs once.');
    await requireProgram(d.account, a.MET_LOCK_PROGRAM_ADDRESS, 'Meteora Met Lock');
    const { tokenProgram, data } = await mintProgram(mint);
    if (tokenProgram === TOKEN_2022_PROGRAM_ADDRESS && hasActiveTransferHook(data)) {
      throw new RequestError(422, `The mint ${mint} runs a transfer hook on every transfer. Met Lock is built here without hook accounts, so a transfer into the escrow, or a claim out of it, could fail and leave the tokens locked. Refused.`, { reason: 'MINT_HAS_TRANSFER_HOOK', mint });
    }
    const escrow = a.metLockAddresses(base, mint, tokenProgram).escrow;
    if (await d.account(escrow)) throw new RequestError(409, `An escrow exists at ${escrow} already: use a fresh base keypair.`, { reason: 'ESCROW_EXISTS', escrow });
    await tokenBalance(sender, mint, tokenProgram, 'token', schedule.cliffUnlockAmount + schedule.amountPerPeriod * schedule.numberOfPeriod);
    const built = await a.buildCreateVestingEscrow({ sender: createNoopSigner(sender), base: createNoopSigner(base), mint, tokenProgram, recipient, schedule, cancelMode, updateRecipientMode });
    const { ixs, bytes } = sized(sender, built.instructions, 'Met Lock escrow creation');
    const locked = schedule.cliffUnlockAmount + schedule.amountPerPeriod * schedule.numberOfPeriod;
    return send(reply, await transaction(sender, ixs, { bytes, escrow, locked, schedule, endsAt: schedule.cliffTime + schedule.frequency * schedule.numberOfPeriod, cancelMode, updateRecipientMode }));
  });

  async function escrowOf(address: Address) {
    const acct = await d.account(address);
    const a = await adapters();
    const state = acct && acct.owner === a.MET_LOCK_PROGRAM_ADDRESS ? decodeVestingEscrow(acct.data) : null;
    if (!state) throw new RequestError(404, `no Met Lock escrow at ${address}`, { reason: 'NO_ESCROW' });
    const schedule = { vestingStartTime: state.vestingStartTime, cliffTime: state.cliffTime, frequency: state.frequency, cliffUnlockAmount: state.cliffUnlockAmount, amountPerPeriod: state.amountPerPeriod, numberOfPeriod: state.numberOfPeriod };
    const total = state.cliffUnlockAmount + state.amountPerPeriod * state.numberOfPeriod;
    const vested = state.cancelledAt > 0n ? a.metLockVested(schedule, state.cancelledAt) : a.metLockVested(schedule, now());
    const claimable = vested > state.totalClaimedAmount ? vested - state.totalClaimedAmount : 0n;
    return { a, state, schedule, total, vested, claimable };
  }

  app.post('/v1/tx/metlock-claim', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['recipient', 'escrow', 'maxAmount'], 'metlock-claim');
    const recipient = addr(b.recipient, 'recipient');
    const escrow = addr(b.escrow, 'escrow');
    const maxAmount = opt(b.maxAmount, (v) => u64(v, 'maxAmount'));
    const { a, state, claimable } = await escrowOf(escrow);
    if (recipient !== state.recipient) throw new RequestError(422, `Only the escrow's recipient, ${state.recipient}, can claim.`, { reason: 'NOT_THE_RECIPIENT' });
    if (claimable === 0n) throw new RequestError(409, state.cancelledAt > 0n ? 'The escrow was cancelled; everything vested has been claimed.' : 'Nothing has vested beyond what has been claimed.', { reason: 'NOTHING_VESTED', firstUnlockAt: state.cliffTime });
    const { tokenProgram } = await mintProgram(state.tokenMint, 'escrow mint');
    const ixs = await a.buildClaimVested({ recipient: createNoopSigner(recipient), escrow, mint: state.tokenMint, tokenProgram, ...(maxAmount !== null && { maxAmount }) });
    const sizedTx = sized(recipient, ixs, 'Met Lock claim');
    return send(reply, await transaction(recipient, sizedTx.ixs, { bytes: sizedTx.bytes, claimable, willPay: maxAmount !== null && maxAmount < claimable ? maxAmount : claimable }));
  });

  app.get('/v1/metlock/escrows/:escrow', async (req, reply) => {
    const { state, total, vested, claimable } = await escrowOf(addr((req.params as { escrow: string }).escrow, 'escrow'));
    return send(reply, { escrow: (req.params as { escrow: string }).escrow, ...state, total, vested, claimable, cancelled: state.cancelledAt > 0n, asOf: now() });
  });

  // ------------------------------------------------------------------------------------------------------------------------------ Dynamic Fee Sharing
  async function vaultToken(b: Record<string, unknown>) {
    const base = addr(b.base, 'base');
    if (b.cross !== undefined && b.mint !== undefined) throw new RequestError(400, 'name the cross or the mint, not both');
    if (b.cross === undefined && b.mint === undefined) throw new RequestError(400, 'cross or mint is required: the vault splits one token');
    let mint: Address, tokenProgram: Address, cross: CrossView | null = null;
    if (b.cross !== undefined) {
      cross = await readCross(addr(b.cross, 'cross'));
      mint = cross.data.quoteMint;
      tokenProgram = cross.data.quoteTokenProgram;
    } else {
      mint = addr(b.mint, 'mint');
      tokenProgram = (await mintProgram(mint)).tokenProgram;
    }
    const a = await adapters();
    await requireProgram(d.account, a.DYNAMIC_FEE_SHARING_PROGRAM_ADDRESS, 'Meteora Dynamic Fee Sharing');
    return { a, base, mint, tokenProgram, cross, addresses: a.feeShareAddresses(base, mint) };
  }
  async function feeVaultOf(addresses: { feeVault: Address }, a: Awaited<ReturnType<typeof adapters>>) {
    const acct = await d.account(addresses.feeVault);
    const state = acct && acct.owner === a.DYNAMIC_FEE_SHARING_PROGRAM_ADDRESS ? decodeFeeVault(acct.data) : null;
    if (!state) throw new RequestError(404, `There is no fee-sharing vault at ${addresses.feeVault}: create it with fee-share-create first.`, { reason: 'NO_FEE_VAULT', feeVault: addresses.feeVault });
    return state;
  }

  app.post('/v1/tx/fee-share-create', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['payer', 'base', 'owner', 'cross', 'mint', 'recipients'], 'fee-share-create');
    const payer = addr(b.payer, 'payer');
    const owner = opt(b.owner, (v) => addr(v, 'owner')) ?? payer;
    const recipients = list(b.recipients, 'recipients', 5, (x, i) => {
      const r = obj(x, `recipients[${i}]`);
      only(r, ['address', 'share'], `recipients[${i}]`);
      return { address: addr(r.address, `recipients[${i}].address`), share: int(r.share, `recipients[${i}].share`, 0xffff_ffff, 1) };
    });
    const a0 = await adapters();
    const t = await vaultToken(b);
    if (t.base === payer) throw new RequestError(400, 'base must be a fresh keypair, not the payer: it makes the vault address unique and signs once.');
    if (recipients.length < a0.MIN_FEE_SHARE_RECIPIENTS) throw new RequestError(400, `recipients must name ${a0.MIN_FEE_SHARE_RECIPIENTS} to ${a0.MAX_FEE_SHARE_RECIPIENTS} wallets: the vault program refuses fewer than two (ExceededUser)`);
    if (new Set(recipients.map((r) => r.address)).size !== recipients.length) throw new RequestError(400, 'a recipient is listed once');
    if (await d.account(t.addresses.feeVault)) throw new RequestError(409, `A vault exists at ${t.addresses.feeVault} already: use a fresh base keypair.`, { reason: 'VAULT_EXISTS', feeVault: t.addresses.feeVault });
    const built = t.a.buildCreateFeeShareVault({ payer: createNoopSigner(payer), base: createNoopSigner(t.base), owner, mint: t.mint, tokenProgram: t.tokenProgram, recipients });
    const { ixs, bytes } = sized(payer, [built.instruction], 'fee-sharing vault creation');
    const total = recipients.reduce((n, r) => n + r.share, 0);
    return send(reply, await transaction(payer, ixs, { bytes, ...built.addresses, recipients: recipients.map((r, index) => ({ index, ...r, percent: Number((BigInt(r.share) * 1_000_000n) / BigInt(total)) / 10_000 })) }));
  });

  app.post('/v1/tx/fee-share-fund', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['funder', 'base', 'cross', 'mint', 'amount'], 'fee-share-fund');
    const funder = addr(b.funder, 'funder');
    const amount = u64(b.amount, 'amount');
    if (amount === 0n) throw new RequestError(400, 'amount must be above zero');
    const t = await vaultToken(b);
    await feeVaultOf(t.addresses, t.a);
    await tokenBalance(funder, t.mint, t.tokenProgram, 'token', amount);
    const ix = await t.a.buildFundFeeShareVault({ funder: createNoopSigner(funder), base: t.base, mint: t.mint, tokenProgram: t.tokenProgram, maxAmount: amount });
    const { ixs, bytes } = sized(funder, [ix], 'fee-sharing vault funding');
    return send(reply, await transaction(funder, ixs, { bytes, feeVault: t.addresses.feeVault }));
  });

  app.post('/v1/tx/fee-share-claim', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['user', 'base', 'cross', 'mint', 'index'], 'fee-share-claim');
    const user = addr(b.user, 'user');
    const index = int(b.index, 'index', 4);
    const t = await vaultToken(b);
    const vault = await feeVaultOf(t.addresses, t.a);
    const entry = vault.users.find((u) => u.index === index);
    if (!entry || entry.address !== user) throw new RequestError(422, entry ? `Index ${index} belongs to ${entry.address}, not ${user}.` : `The vault has no recipient at index ${index}.`, { reason: 'NOT_THE_RECIPIENT', index, recipients: vault.users });
    const ix = await t.a.buildClaimFeeShare({ user: createNoopSigner(user), base: t.base, mint: t.mint, tokenProgram: t.tokenProgram, index });
    const ensure = getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(user), ata: await ata(user, t.mint, t.tokenProgram), owner: user, mint: t.mint, tokenProgram: t.tokenProgram }) as Instruction;
    const { ixs, bytes } = sized(user, [ensure, ix], 'fee-sharing claim');
    return send(reply, await transaction(user, ixs, { bytes, feeVault: t.addresses.feeVault, claimedSoFar: entry.feeClaimed }));
  });

  async function positionContext(b: Record<string, unknown>) {
    const cross = await readCross(addr(b.cross, 'cross'));
    marketOf(cross);
    const base = addr(b.base, 'base');
    const a = await adapters();
    await requireProgram(d.account, a.DYNAMIC_FEE_SHARING_PROGRAM_ADDRESS, 'Meteora Dynamic Fee Sharing');
    await requireProgram(d.account, a.DAMM_V2_PROGRAM_ADDRESS, 'Meteora DAMM v2');
    const damm = await a.dammAddresses(cross.address, cross.data.baseMint, cross.data.quoteMint);
    const pool = await d.account(damm.pool);
    if (!pool || pool.owner !== a.DAMM_V2_PROGRAM_ADDRESS) throw new RequestError(409, `The cross has no DAMM v2 pool at ${damm.pool}.`, { reason: 'NO_POOL', pool: damm.pool });
    const addresses = a.feeShareAddresses(base, cross.data.quoteMint);
    const vault = await feeVaultOf(addresses, a);
    // DAMM v2 collects the pool's fees in its token B, the cross's quote mint: a vault of any other token cannot receive them.
    if (vault.tokenMint !== cross.data.quoteMint) throw new RequestError(422, `The vault splits ${vault.tokenMint}; this pool's fees are in ${cross.data.quoteMint}.`, { reason: 'VAULT_TOKEN_MISMATCH' });
    return { cross, base, a, damm, addresses, vault };
  }

  app.post('/v1/tx/fee-share-transfer-position', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'owner', 'base'], 'fee-share-transfer-position');
    const owner = addr(b.owner, 'owner');
    const t = await positionContext(b);
    if (owner !== t.cross.data.creator) throw new RequestError(422, `Only the cross's creator, ${t.cross.data.creator}, owns its position.`, { reason: 'NOT_THE_CREATOR' });
    const holder = await owns(t.damm.positionNftAccount);
    if (holder === t.addresses.feeVault) throw new RequestError(409, 'The position belongs to the vault already.', { reason: 'ALREADY_IN_VAULT' });
    if (holder !== owner) throw new RequestError(409, holder === null ? 'The position NFT account does not exist.' : `The position NFT is held by ${holder}, not by ${owner}.`, { reason: 'NOT_THE_HOLDER', holder });
    const ix = t.a.buildTransferDammPositionToFeeVault({ owner: createNoopSigner(owner), positionNftAccount: t.damm.positionNftAccount, feeVault: t.addresses.feeVault });
    const { ixs, bytes } = sized(owner, [ix], 'position hand-over');
    return send(reply, await transaction(owner, ixs, { bytes, feeVault: t.addresses.feeVault, position: t.damm.position, recipients: t.vault.users, warning: 'One way: the issuer cannot take the position back. From now on the position\'s fees can only be claimed into the vault, and only these recipients can pull and claim them. The issuer\'s liquidity lock, if any, is unaffected.' }));
  });

  app.post('/v1/tx/fee-share-fund-from-damm', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'signer', 'base'], 'fee-share-fund-from-damm');
    const signer = addr(b.signer, 'signer');
    const t = await positionContext(b);
    const holder = await owns(t.damm.positionNftAccount);
    if (holder !== t.addresses.feeVault) throw new RequestError(409, 'The position is not in the vault yet: send fee-share-transfer-position first.', { reason: 'POSITION_NOT_IN_VAULT', holder });
    if (!t.vault.users.some((u) => u.address === signer)) throw new RequestError(422, `${signer} is not one of the vault's recipients; only a recipient can pull the position's fees in.`, { reason: 'NOT_A_RECIPIENT', recipients: t.vault.users.map((u) => u.address) });
    const c = t.cross.data;
    const tokenAAccount = await ata(signer, c.baseMint, c.baseTokenProgram);
    const ensure = getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(signer), ata: tokenAAccount, owner: signer, mint: c.baseMint, tokenProgram: c.baseTokenProgram }) as Instruction;
    const ix = t.a.buildFundFeeShareFromDammFees({
      signer: createNoopSigner(signer),
      feeVault: t.addresses.feeVault,
      pool: t.damm.pool,
      position: t.damm.position,
      positionNftAccount: t.damm.positionNftAccount,
      tokenAAccount,
      tokenAVault: t.damm.tokenAVault,
      tokenBVault: t.damm.tokenBVault,
      tokenAMint: c.baseMint,
      tokenBMint: c.quoteMint,
      tokenAProgram: c.baseTokenProgram,
      tokenBProgram: c.quoteTokenProgram,
      poolAuthority: t.damm.poolAuthority,
      dammEventAuthority: t.damm.eventAuthority,
    });
    const { ixs, bytes } = sized(signer, [ensure, ix], 'fee pull');
    return send(reply, await transaction(signer, ixs, { bytes, feeVault: t.addresses.feeVault, tokenAAccount }));
  });

  app.get('/v1/fee-share/:base/:mint', async (req, reply) => {
    const p = req.params as { base: string; mint: string };
    const base = addr(p.base, 'base');
    const mint = addr(p.mint, 'mint');
    const a = await adapters();
    const addresses = a.feeShareAddresses(base, mint);
    const acct = await d.account(addresses.feeVault);
    const state = acct && acct.owner === a.DYNAMIC_FEE_SHARING_PROGRAM_ADDRESS ? decodeFeeVault(acct.data) : null;
    if (!state) return send(reply, { base, mint, feeVault: addresses.feeVault, vault: null, note: 'No fee-sharing vault exists for this base and token.' });
    // What each recipient could claim right now, from the vault's accumulator alone (ADR-0912): the figure a real claim pays to the atom.
    const full = a.decodeFeeShareVault(acct!.data);
    return send(reply, { base, mint, feeVault: addresses.feeVault, tokenVault: addresses.tokenVault, vault: state, shares: state.users.map((u) => ({ ...u, percent: state.totalShare > 0 ? Number((BigInt(u.share) * 1_000_000n) / BigInt(state.totalShare)) / 10_000 : 0, claimable: full ? a.feeShareClaimable(full, u.index) : null })) });
  });
  // DAMM v2 reward slots, the conviction ladder and its rebalance, the buyer's side of the tranche and the calibrated curve (ADR-0911 to 0916).
  registerMeteoraExtras(app, { account: d.account, now, send, adapters, readCross, marketOf, mintProgram, tokenBalance, owns, gateHook, sized, transaction });
}

/**
 * A server with only these routes and the API's error mapping, for tests and tools that exercise them against a chain without the database
 * (tests/core runs every route against the real Meteora binaries on LiteSVM through it). `extra` registers other route sets on the same server.
 */
export async function buildMeteoraTxApp(d: MeteoraTxDeps, extra?: (app: FastifyInstance) => void | Promise<void>) {
  const { default: Fastify } = await import('fastify');
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof RequestError) return send(reply, { error: err.message, ...err.detail }, err.status);
    const e = err as { statusCode?: number; message?: string };
    return send(reply, { error: e.message ?? 'internal error' }, e.statusCode && e.statusCode < 500 ? e.statusCode : 500);
  });
  registerMeteoraTx(app, d);
  if (extra) await extra(app);
  await app.ready();
  return app;
}
