// cross_basket over HTTP (S5; ADR-0652): a share token backed by fixed amounts of one to eight tokens. Minting pays ceil(units x shares / 10^6) of every component
// into the basket's vaults, redeeming pays the floor; there is no manager, fee, rebalance or pause. The program is NOT deployed to devnet until the operations
// key is funded (docs/HUMAN_TASKS.md H27, H43).
//
//   POST /v1/tx/basket-create   { creator, label, components: [{ mint, unitsPerShare }], id? }   unitsPerShare is the amount of the component behind one whole share (10^6 share atoms)
//   POST /v1/tx/basket-mint     { user, basket, shares }                                         shares in share atoms; every component is paid in, rounded up
//   POST /v1/tx/basket-redeem   { user, basket, shares }                                         shares are burned; every component is paid out, rounded down
//   GET  /v1/baskets/:address               components, vault balances, share supply, backing per share and whether each vault covers the supply
//   GET  /v1/baskets/:address/quote?shares=&side=mint|redeem   what a mint costs or a redemption pays, per component, with the rounding
//   GET  /v1/baskets?creator=&limit=        the index
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Address, createNoopSigner } from '@solana/kit';
import { BASKET_DISCRIMINATOR, CREATE_BASKET_DISCRIMINATOR, MINT_SHARES_DISCRIMINATOR, REDEEM_SHARES_DISCRIMINATOR, findBasketPda, getBasketDecoder } from '@opening-cross/cross-basket-client';
import {
  BASKET_MAX_COMPONENTS,
  BASKET_SHARE_UNIT,
  CROSS_BASKET_PROGRAM_ADDRESS,
  SPL_TOKEN_PROGRAM,
  ata,
  basketAddresses,
  basketCovers,
  basketOwed,
  buildCreateBasket,
  buildMintShares,
  buildRedeemShares,
  checkBasketComponentMint,
  checkBasketTerms,
} from '@opening-cross/sdk';
import { type Lifetime, RequestError } from '../tx.js';
import { addr, json, list, obj, only, opt, u64 } from './_inputs.js';
import { type AccountReader, type Db, type ProgramRelease, building, failIf, mintOf, mintSupply, oneTx, programRelease, readAccount, releaseNote, requireNew, tokenBalance } from './programs-support.js';

export type BasketTxDeps = {
  account: AccountReader;
  lifetime: () => Promise<Lifetime>;
  db?: Db;
  clock?: () => number;
  gate?: ProgramRelease;
};

const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));
const MAX_ID_PROBES = 64;

export function registerBasketTx(app: FastifyInstance, d: BasketTxDeps): void {
  const gate = d.gate ?? programRelease({ account: d.account, ...(d.clock && { clock: d.clock }) });
  const need = (name: string, discriminator: Uint8Array) => requireNew(gate, 'crossBasket', { name, discriminator });
  const tx = async (payer: Address, ixs: Parameters<typeof oneTx>[1], what: string) => oneTx(payer, ixs, await d.lifetime(), what);

  async function readBasket(address: Address) {
    const { value } = await readAccount(d.account, address, { owner: CROSS_BASKET_PROGRAM_ADDRESS, disc: BASKET_DISCRIMINATOR as Uint8Array, decode: (b) => getBasketDecoder().decode(b), what: 'basket', reason: 'NO_SUCH_BASKET' });
    const expected = (await findBasketPda({ creator: value.creator, id: value.id }))[0];
    if (expected !== address) throw new RequestError(404, `${address} is not a basket at its own address`, { reason: 'NO_SUCH_BASKET' });
    return value;
  }

  /** Vault balances and the share supply of a basket, read from chain. A vault that cannot be read is null, never zero. */
  async function holdings(address: Address, b: Awaited<ReturnType<typeof readBasket>>) {
    const supply = await mintSupply(d.account, b.shareMint);
    const rows = [];
    for (const c of b.components) {
      const vault = await ata(address, c.mint, c.tokenProgram);
      const balance = await tokenBalance(d.account, vault);
      rows.push({ mint: c.mint, tokenProgram: c.tokenProgram, unitsPerShare: c.unitsPerShare, vault, balance, covers: balance !== null && supply !== null ? basketCovers(balance, c.unitsPerShare, supply) : null });
    }
    return { supply, rows };
  }

  const ticket = (b: Awaited<ReturnType<typeof readBasket>>, shares: bigint, up: boolean) => b.components.map((c) => ({ mint: c.mint, tokenProgram: c.tokenProgram, unitsPerShare: c.unitsPerShare, amount: basketOwed(c.unitsPerShare, shares, up), exact: (c.unitsPerShare * shares) % BASKET_SHARE_UNIT === 0n }));

  app.post('/v1/tx/basket-create', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['creator', 'label', 'components', 'id'], 'basket-create');
    const creator = addr(b.creator, 'creator');
    if (typeof b.label !== 'string') throw new RequestError(400, 'label must be a string of at most 32 bytes');
    const parsed = list(b.components, 'components', BASKET_MAX_COMPONENTS + 8, (x, i) => {
      const c = obj(x, `components[${i}]`);
      only(c, ['mint', 'unitsPerShare'], `components[${i}]`);
      return { mint: addr(c.mint, `components[${i}].mint`), unitsPerShare: u64(c.unitsPerShare, `components[${i}].unitsPerShare`) };
    });
    const release = await need('create_basket', CREATE_BASKET_DISCRIMINATOR as Uint8Array);
    const components: { mint: Address; unitsPerShare: bigint; tokenProgram: Address }[] = [];
    const issues = checkBasketTerms(b.label, parsed.map((c) => ({ ...c, tokenProgram: SPL_TOKEN_PROGRAM })));
    failIf(issues, 'The basket cannot be created');
    for (const c of parsed) {
      const raw = await d.account(c.mint);
      if (!raw) throw new RequestError(404, `component ${c.mint} not found on chain`, { reason: 'MINT_NOT_FOUND', mint: c.mint });
      const { tokenProgram } = await mintOf(d.account, c.mint, 'component');
      failIf(checkBasketComponentMint({ owner: raw.owner, data: raw.data }, c.mint), 'A component cannot back a basket');
      components.push({ ...c, tokenProgram });
    }
    let id = opt(b.id, (v) => u64(v, 'id'));
    if (id === null) {
      for (let i = 0n; i < BigInt(MAX_ID_PROBES) && id === null; i++) if (!(await d.account((await findBasketPda({ creator, id: i }))[0]))) id = i;
      if (id === null) throw new RequestError(409, `The creator already has ${MAX_ID_PROBES} baskets from id 0; name an id.`, { reason: 'ID_RANGE_FULL' });
    } else if (await d.account((await findBasketPda({ creator, id }))[0])) {
      throw new RequestError(409, `The creator already has a basket with id ${id}.`, { reason: 'ALREADY_EXISTS', id });
    }
    const built = await building(() => buildCreateBasket({ creator: createNoopSigner(creator), id: id!, label: b.label as string, components }));
    return send(reply, {
      ...(await tx(creator, built.instructions, 'basket creation')),
      basket: built.basket,
      shareMint: built.shareMint,
      vaults: built.vaults,
      id,
      components,
      shareDecimals: 6,
      note: 'A basket never changes: no manager, fee, rebalance or pause. A component whose issuer holds a freeze authority can have the basket\'s vault frozen and stop redemptions of that component.',
      release,
    });
  });

  async function trade(reply: FastifyReply, body: unknown, side: 'mint' | 'redeem') {
    const b = obj(body);
    only(b, ['user', 'basket', 'shares'], `basket-${side}`);
    const user = addr(b.user, 'user');
    const shares = u64(b.shares, 'shares');
    const release = side === 'mint' ? await need('mint_shares', MINT_SHARES_DISCRIMINATOR as Uint8Array) : await need('redeem_shares', REDEEM_SHARES_DISCRIMINATOR as Uint8Array);
    if (shares === 0n) throw new RequestError(400, 'shares must be positive');
    const address = addr(b.basket, 'basket');
    const basket = await readBasket(address);
    const lines = ticket(basket, shares, side === 'mint');
    if (side === 'mint') {
      for (const l of lines) {
        if (l.amount === 0n) continue;
        const have = await tokenBalance(d.account, await ata(user, l.mint, l.tokenProgram));
        if (have === null || have < l.amount) throw new RequestError(422, `${user} holds ${have ?? 0n} of component ${l.mint}; this mint needs ${l.amount}.`, { reason: 'INSUFFICIENT_COMPONENT', mint: l.mint, have: have ?? 0n, need: l.amount });
      }
    } else {
      const have = await tokenBalance(d.account, await ata(user, basket.shareMint, SPL_TOKEN_PROGRAM));
      if (have === null || have < shares) throw new RequestError(422, `${user} holds ${have ?? 0n} shares; ${shares} were asked for.`, { reason: 'INSUFFICIENT_SHARES', have: have ?? 0n, need: shares });
    }
    const build = side === 'mint' ? buildMintShares : buildRedeemShares;
    const ixs = await building(() => build({ user: createNoopSigner(user), basket: address, shareMint: basket.shareMint, components: basket.components, shares }));
    return send(reply, { ...(await tx(user, ixs, `share ${side}`)), basket: address, shareMint: basket.shareMint, shares, [side === 'mint' ? 'deposits' : 'payouts']: lines, rounding: side === 'mint' ? 'up: you pay the next whole atom of a component' : 'down: you receive the whole atoms below the exact amount', release });
  }
  app.post('/v1/tx/basket-mint', async (req, reply) => trade(reply, req.body, 'mint'));
  app.post('/v1/tx/basket-redeem', async (req, reply) => trade(reply, req.body, 'redeem'));

  app.get('/v1/baskets/:address', async (req, reply) => {
    const address = addr((req.params as { address: string }).address, 'address');
    const release = await releaseNote(gate, 'crossBasket');
    if (release.deployed === false) throw new RequestError(404, `basket ${address} not found: ${release.note}`, { reason: 'PROGRAM_NOT_DEPLOYED', release });
    const basket = await readBasket(address);
    const h = await holdings(address, basket);
    return send(reply, {
      basket: address,
      creator: basket.creator,
      id: basket.id,
      label: basket.label,
      shareMint: basket.shareMint,
      shareDecimals: 6,
      shareSupply: h.supply,
      components: h.rows.map((r) => ({
        ...r,
        // The amount of the component behind one whole share right now: at least `unitsPerShare` while the vault covers the supply (a donation raises it, nothing lowers it).
        backingPerShare: r.balance !== null && h.supply !== null && h.supply > 0n ? (r.balance * BASKET_SHARE_UNIT) / h.supply : null,
      })),
      solvent: h.rows.every((r) => r.covers === true) ? true : h.rows.some((r) => r.covers === false) ? false : null,
      release,
    });
  });

  app.get('/v1/baskets/:address/quote', async (req, reply) => {
    const address = addr((req.params as { address: string }).address, 'address');
    const q = req.query as { shares?: string; side?: string };
    const shares = u64(q.shares, 'shares');
    if (q.side !== 'mint' && q.side !== 'redeem') throw new RequestError(400, 'side must be "mint" or "redeem"');
    const release = await releaseNote(gate, 'crossBasket');
    if (release.deployed === false) throw new RequestError(404, `basket ${address} not found: ${release.note}`, { reason: 'PROGRAM_NOT_DEPLOYED', release });
    const basket = await readBasket(address);
    return send(reply, { basket: address, side: q.side, shares, lines: ticket(basket, shares, q.side === 'mint'), rounding: q.side === 'mint' ? 'up' : 'down', release });
  });

  app.get('/v1/baskets', async (req, reply) => {
    const q = req.query as { creator?: string; limit?: string };
    const creator = q.creator === undefined ? null : addr(q.creator, 'creator');
    const limit = q.limit === undefined ? 50 : Math.min(200, Math.max(1, Number.parseInt(q.limit, 10) || 50));
    const release = await releaseNote(gate, 'crossBasket');
    const rows = d.db ? (await d.db.query(`SELECT address, creator, share_mint, components, minted, redeemed, created_slot FROM baskets WHERE ($1::text IS NULL OR creator = $1) ORDER BY created_slot DESC LIMIT $2`, [creator, limit])).rows : [];
    return send(reply, {
      baskets: rows.map((r) => ({ basket: r.address, creator: r.creator, shareMint: r.share_mint, components: r.components, minted: String(r.minted), redeemed: String(r.redeemed), outstanding: (BigInt(String(r.minted).split('.')[0]!) - BigInt(String(r.redeemed).split('.')[0]!)).toString(), createdSlot: String(r.created_slot) })),
      release,
      ...(release.deployed === false && { note: release.note }),
    });
  });
}
