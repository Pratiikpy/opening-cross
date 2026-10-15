// cross_conviction over HTTP (S7; ADR-0651): tokens locked with no early exit, and a soulbound Token-2022 badge that measures the token-days the holder kept
// locked. Unsigned transactions and reads. The program is NOT deployed to devnet until the operations key is funded (docs/HUMAN_TASKS.md H27, H43).
//
//   POST /v1/tx/conviction-lock         { holder, mint, amount, unlockTs, nonce? }     lock tokens until unlockTs (one day to four years from now)
//   POST /v1/tx/conviction-unlock       { holder, lock }                               after unlockTs: the tokens back, the vault closed
//   POST /v1/tx/conviction-claim-badge  { holder, lock }                               after unlockTs: the badge, once per lock (creates the badge mint on the first)
//   POST /v1/tx/conviction-close-lock   { holder, lock }                               after both: the lock account's rent back
//   GET  /v1/owners/:owner/conviction   the holder's locks (chain state per lock), token-days claimed, badge balance
//   GET  /v1/conviction/locks/:address  one lock
//   GET  /v1/conviction/mints/:mint     what is locked behind a token, by anyone (the index)
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Address, createNoopSigner } from '@solana/kit';
import {
  CLAIM_BADGE_DISCRIMINATOR,
  CLOSE_LOCK_DISCRIMINATOR,
  LOCK_DISCRIMINATOR,
  LOCK_TOKENS_DISCRIMINATOR,
  type Lock,
  UNLOCK_DISCRIMINATOR,
  findLockPda,
  getLockDecoder,
} from '@opening-cross/cross-conviction-client';
import {
  CONVICTION_MAX_LOCK_SECS,
  CONVICTION_MIN_LOCK_SECS,
  CROSS_CONVICTION_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM,
  ata,
  buildClaimBadge,
  buildCloseLock,
  buildLockTokens,
  buildUnlock,
  convictionAddresses,
  convictionBadgeAddresses,
  convictionTokenDays,
} from '@opening-cross/sdk';
import { type Lifetime, RequestError } from '../tx.js';
import { addr, i64, json, obj, only, opt, u64 } from './_inputs.js';
import { hasActiveTransferHook } from './meteora-tx.js';
import { type AccountReader, type Db, type ProgramRelease, building, mintOf, oneTx, programRelease, readAccount, releaseNote, requireNew, tokenBalance } from './programs-support.js';

export type ConvictionTxDeps = {
  account: AccountReader;
  lifetime: () => Promise<Lifetime>;
  db?: Db;
  clock?: () => number;
  gate?: ProgramRelease;
};

const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));
const MAX_NONCE_PROBES = 64;

export function registerConvictionTx(app: FastifyInstance, d: ConvictionTxDeps): void {
  const now = () => BigInt(d.clock?.() ?? Math.floor(Date.now() / 1000));
  const gate = d.gate ?? programRelease({ account: d.account, ...(d.clock && { clock: d.clock }) });
  const need = (name: string, discriminator: Uint8Array) => requireNew(gate, 'crossConviction', { name, discriminator });
  const tx = async (payer: Address, ixs: Parameters<typeof oneTx>[1], what: string) => oneTx(payer, ixs, await d.lifetime(), what);

  async function readLock(address: Address) {
    const { value } = await readAccount(d.account, address, { owner: CROSS_CONVICTION_PROGRAM_ADDRESS, disc: LOCK_DISCRIMINATOR as Uint8Array, decode: (b) => getLockDecoder().decode(b), what: 'conviction lock', reason: 'NO_SUCH_LOCK' });
    const expected = (await findLockPda({ holder: value.holder, mint: value.mint, nonce: value.nonce }))[0];
    if (expected !== address) throw new RequestError(404, `${address} is not a conviction lock at its own address`, { reason: 'NO_SUCH_LOCK' });
    return value;
  }
  const holderOf = (l: Lock, who: Address) => {
    if (l.holder !== who) throw new RequestError(422, `${who} is not the holder of this lock (${l.holder}).`, { reason: 'NOT_THE_HOLDER', holder: l.holder });
  };
  const stateOf = (l: Lock, t: bigint) => (l.withdrawn ? 'unlocked' : t >= l.unlockTs ? 'unlockable' : 'locked');
  const lockJson = (address: Address, vault: Address, l: Lock, t: bigint) => {
    const days = convictionTokenDays(l.amount, l.unlockTs - l.lockedAt, l.decimals);
    return {
      lock: address,
      vault,
      holder: l.holder,
      mint: l.mint,
      nonce: l.nonce,
      amount: l.amount,
      decimals: l.decimals,
      lockedAt: l.lockedAt,
      unlockTs: l.unlockTs,
      state: stateOf(l, t),
      secondsLeft: t >= l.unlockTs ? 0n : l.unlockTs - t,
      badgeClaimed: l.badgeClaimed,
      tokenDays: days,
      canClaimBadge: t >= l.unlockTs && !l.badgeClaimed && days !== null && days > 0n,
      closable: l.withdrawn && l.badgeClaimed,
    };
  };

  app.post('/v1/tx/conviction-lock', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['holder', 'mint', 'amount', 'unlockTs', 'nonce'], 'conviction-lock');
    const holder = addr(b.holder, 'holder');
    const mint = addr(b.mint, 'mint');
    const amount = u64(b.amount, 'amount');
    const unlockTs = i64(b.unlockTs, 'unlockTs');
    const release = await need('lock_tokens', LOCK_TOKENS_DISCRIMINATOR as Uint8Array);
    const m = await mintOf(d.account, mint);
    if (m.tokenProgram === TOKEN_2022_PROGRAM && hasActiveTransferHook(m.data)) {
      throw new RequestError(422, `The mint ${mint} runs a transfer hook on every transfer. The lock is built here without hook accounts, so the tokens could be locked and not returned. Refused.`, { reason: 'MINT_HAS_TRANSFER_HOOK', mint });
    }
    const have = await tokenBalance(d.account, await ata(holder, mint, m.tokenProgram));
    if (have === null) throw new RequestError(409, `${holder} has no token account for ${mint}.`, { reason: 'NO_TOKEN_ACCOUNT', mint });
    if (have < amount) throw new RequestError(422, `${holder} holds ${have} of this token; ${amount} was asked for.`, { reason: 'INSUFFICIENT_BALANCE', have, need: amount });
    let nonce = opt(b.nonce, (v) => u64(v, 'nonce'));
    if (nonce === null) {
      for (let i = 0n; i < BigInt(MAX_NONCE_PROBES) && nonce === null; i++) if (!(await d.account((await findLockPda({ holder, mint, nonce: i }))[0]))) nonce = i;
      if (nonce === null) throw new RequestError(409, `The holder already has ${MAX_NONCE_PROBES} locks of this token from nonce 0; name a nonce.`, { reason: 'NONCE_RANGE_FULL' });
    } else if (await d.account((await findLockPda({ holder, mint, nonce }))[0])) {
      throw new RequestError(409, `nonce ${nonce} is already used by this holder for this token`, { reason: 'NONCE_USED', nonce });
    }
    const t = now();
    const built = await building(() => buildLockTokens({ holder: createNoopSigner(holder), mint, tokenProgram: m.tokenProgram, nonce: nonce!, amount, unlockTs, now: t }));
    const decimals = m.data[44]!;
    return send(reply, {
      ...(await tx(holder, [built.instruction], 'lock')),
      lock: built.lock,
      vault: built.vault,
      nonce,
      amount,
      unlockTs,
      lockedFor: unlockTs - t,
      tokenDays: convictionTokenDays(amount, unlockTs - t, decimals),
      note: `Nothing moves these tokens before ${unlockTs}: not you, not the program (a lock lasts ${CONVICTION_MIN_LOCK_SECS} seconds to ${CONVICTION_MAX_LOCK_SECS} seconds). The badge counts whole token-days, rounded down.`,
      release,
    });
  });

  app.post('/v1/tx/conviction-unlock', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['holder', 'lock'], 'conviction-unlock');
    const holder = addr(b.holder, 'holder');
    const release = await need('unlock', UNLOCK_DISCRIMINATOR as Uint8Array);
    const address = addr(b.lock, 'lock');
    const l = await readLock(address);
    holderOf(l, holder);
    if (l.withdrawn) throw new RequestError(409, 'The tokens of this lock were already returned.', { reason: 'ALREADY_WITHDRAWN' });
    if (now() < l.unlockTs) throw new RequestError(409, `The lock runs until ${l.unlockTs}; nothing moves the tokens before then.`, { reason: 'STILL_LOCKED', unlockTs: l.unlockTs, secondsLeft: l.unlockTs - now() });
    const { tokenProgram } = await mintOf(d.account, l.mint);
    const a = await convictionAddresses(l.holder, l.mint, l.nonce, tokenProgram);
    const ixs = await building(() => buildUnlock({ holder: createNoopSigner(holder), mint: l.mint, tokenProgram, lock: a, createDestination: true }));
    return send(reply, { ...(await tx(holder, ixs, 'unlock')), lock: address, amount: l.amount, release });
  });

  app.post('/v1/tx/conviction-claim-badge', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['holder', 'lock'], 'conviction-claim-badge');
    const holder = addr(b.holder, 'holder');
    const release = await need('claim_badge', CLAIM_BADGE_DISCRIMINATOR as Uint8Array);
    const address = addr(b.lock, 'lock');
    const l = await readLock(address);
    holderOf(l, holder);
    if (l.badgeClaimed) throw new RequestError(409, 'The badge for this lock was already minted.', { reason: 'BADGE_ALREADY_CLAIMED' });
    if (now() < l.unlockTs) throw new RequestError(409, `The badge is minted once the lock has run, at ${l.unlockTs}.`, { reason: 'STILL_LOCKED', unlockTs: l.unlockTs, secondsLeft: l.unlockTs - now() });
    const days = convictionTokenDays(l.amount, l.unlockTs - l.lockedAt, l.decimals);
    if (days === null) throw new RequestError(422, 'The token-days of this lock overflow a 64-bit number.', { reason: 'OVERFLOW' });
    if (days === 0n) throw new RequestError(422, 'This lock is too small to earn one token-day (the badge counts whole token-days, rounded down). The tokens still come back with unlock.', { reason: 'TOO_SMALL_FOR_A_BADGE' });
    const ixs = await building(() => buildClaimBadge({ holder: createNoopSigner(holder), mint: l.mint, lock: address }));
    const badge = await convictionBadgeAddresses(holder, l.mint);
    return send(reply, { ...(await tx(holder, ixs, 'badge claim')), lock: address, tokenDays: days, badgeMint: badge.badgeMint, holderBadge: badge.holderBadge, soulbound: true, release });
  });

  app.post('/v1/tx/conviction-close-lock', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['holder', 'lock'], 'conviction-close-lock');
    const holder = addr(b.holder, 'holder');
    const release = await need('close_lock', CLOSE_LOCK_DISCRIMINATOR as Uint8Array);
    const address = addr(b.lock, 'lock');
    const l = await readLock(address);
    holderOf(l, holder);
    if (!l.withdrawn || !l.badgeClaimed) throw new RequestError(409, 'Return the tokens (unlock) and mint the badge (claim-badge) before closing the lock.', { reason: 'LOCK_STILL_NEEDED', withdrawn: l.withdrawn, badgeClaimed: l.badgeClaimed });
    return send(reply, { ...(await tx(holder, [buildCloseLock({ holder: createNoopSigner(holder), lock: address })], 'close')), lock: address, release });
  });

  app.get('/v1/conviction/locks/:address', async (req, reply) => {
    const address = addr((req.params as { address: string }).address, 'address');
    const release = await releaseNote(gate, 'crossConviction');
    if (release.deployed === false) throw new RequestError(404, `lock ${address} not found: ${release.note}`, { reason: 'PROGRAM_NOT_DEPLOYED', release });
    const l = await readLock(address);
    const { tokenProgram } = await mintOf(d.account, l.mint).catch(() => ({ tokenProgram: null }));
    const vault = tokenProgram ? (await convictionAddresses(l.holder, l.mint, l.nonce, tokenProgram)).vault : null;
    return send(reply, { ...lockJson(address, vault as Address, l, now()), release });
  });

  app.get('/v1/owners/:owner/conviction', async (req, reply) => {
    const owner = addr((req.params as { owner: string }).owner, 'owner');
    const release = await releaseNote(gate, 'crossConviction');
    const rows = d.db ? (await d.db.query(`SELECT lock, mint, amount, locked_at, unlock_ts, unlocked, badge_claimed, token_days FROM conviction_locks WHERE holder = $1 ORDER BY created_slot DESC LIMIT 200`, [owner])).rows : [];
    const t = Number(now());
    const badges = d.db ? (await d.db.query(`SELECT mint, badge_mint FROM conviction_badges WHERE holder = $1`, [owner])).rows : [];
    const balances: Record<string, string | null> = {};
    for (const x of badges) {
      const bal = await tokenBalance(d.account, await ata(owner, x.badge_mint as Address, TOKEN_2022_PROGRAM)).catch(() => null);
      balances[String(x.mint)] = bal === null ? null : bal.toString();
    }
    return send(reply, {
      owner,
      locks: rows.map((r) => ({
        lock: r.lock,
        mint: r.mint,
        amount: String(r.amount),
        lockedAt: Number(r.locked_at),
        unlockTs: Number(r.unlock_ts),
        state: r.unlocked ? 'unlocked' : t >= Number(r.unlock_ts) ? 'unlockable' : 'locked',
        badgeClaimed: r.badge_claimed,
        tokenDays: r.token_days === null ? null : String(r.token_days),
      })),
      badges: badges.map((x) => ({ mint: x.mint, badgeMint: x.badge_mint, tokenDays: balances[String(x.mint)] ?? null })),
      release,
      ...(release.deployed === false && { note: release.note }),
    });
  });

  app.get('/v1/conviction/mints/:mint', async (req, reply) => {
    const mint = addr((req.params as { mint: string }).mint, 'mint');
    const release = await releaseNote(gate, 'crossConviction');
    const row = d.db ? (await d.db.query(`SELECT count(*)::int AS locks, count(DISTINCT holder)::int AS holders, COALESCE(sum(amount) FILTER (WHERE NOT unlocked), 0) AS locked, COALESCE(sum(token_days), 0) AS token_days FROM conviction_locks WHERE mint = $1`, [mint])).rows[0] : null;
    return send(reply, { mint, locks: row?.locks ?? 0, holders: row?.holders ?? 0, locked: String(row?.locked ?? 0), tokenDaysClaimed: String(row?.token_days ?? 0), release });
  });
}
