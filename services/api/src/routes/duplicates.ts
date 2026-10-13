// Duplicate and look-alike tickers among arbitrary tokens (PRODUCT_FEATURES F7).
//
//   GET /v1/tokens/:mint/duplicates
//     Reads the token's own declared name and symbol, then compares them with every other token listed on this deployment (the
//     base token of each cross) and with the issuers' own lists in the authenticity registry. Reports tokens that share the
//     ticker, that read the same once look-alike characters are folded, or that sit one character away, and tokens that share the
//     name. A match is a warning, not a verdict that either token is false. It does not compare images.
//   200 { mint, name, symbol, comparedWith, duplicates: [{ mint, source, symbol, name, relation, severity, why }], summary, limits }
//   400 bad address  404 no such mint  422 not a token mint
//
// Names and symbols are third-party text. They are returned as data; a consumer that shows them to an agent wraps them.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { type Address, isAddress } from '@solana/kit';
import { BUNDLED_REGISTRY, type KnownToken, type MintObservation, duplicateSummary, findDuplicates, observeVia } from '@opening-cross/authenticity';
import { RequestError } from '../tx.js';
import type { ApiDeps } from '../server.js';

export type DuplicatesDeps = Pick<ApiDeps, 'db' | 'account'>;
export type DuplicatesOptions = {
  /** Reads one mint's declared name and symbol. Default: the authenticity package over the API's account reader. */
  observe?: (mint: string) => Promise<Pick<MintObservation, 'exists' | 'isMint' | 'name' | 'symbol'>>;
  /** Most unlabelled listed tokens read from chain in one request; the rest are reported as unchecked and read on later requests. */
  maxFreshReads?: number;
  /** Most listed tokens compared. */
  maxListed?: number;
};

const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(JSON.stringify(v));

export function registerTokenDuplicates(app: FastifyInstance, d: DuplicatesDeps, opts: DuplicatesOptions = {}): void {
  const maxFresh = opts.maxFreshReads ?? 40;
  const maxListed = opts.maxListed ?? 400;
  const observe = opts.observe ?? ((mint: string) => observeVia(async (a) => d.account(a as Address), mint));
  const issuerLists: KnownToken[] = BUNDLED_REGISTRY.mints.map((m) => ({ mint: m.mint, name: m.name, symbol: m.symbol, source: `issuer list (${m.family})` }));

  async function labelsOf(mints: readonly string[]): Promise<{ known: KnownToken[]; unlabelled: number; unchecked: number }> {
    if (mints.length === 0) return { known: [], unlabelled: 0, unchecked: 0 };
    const cached = new Map((await d.db.query<{ mint: string; name: string | null; symbol: string | null; exists: boolean }>('SELECT mint, name, symbol, exists FROM token_labels WHERE mint = ANY($1::text[])', [mints])).rows.map((r) => [r.mint, r]));
    const missing = mints.filter((m) => !cached.has(m));
    const fresh = missing.slice(0, maxFresh);
    for (const m of fresh) {
      const o = await observe(m).catch(() => null);
      if (!o) continue; // a read that failed is tried again next time
      await d.db.query('INSERT INTO token_labels (mint, name, symbol, exists) VALUES ($1,$2,$3,$4) ON CONFLICT (mint) DO UPDATE SET name = EXCLUDED.name, symbol = EXCLUDED.symbol, exists = EXCLUDED.exists, observed_at = now()', [m, o.name, o.symbol, o.exists && o.isMint]);
      cached.set(m, { mint: m, name: o.name, symbol: o.symbol, exists: o.exists && o.isMint });
    }
    const known: KnownToken[] = [];
    let unlabelled = 0;
    for (const [mint, r] of cached) {
      if (r.symbol === null && r.name === null) unlabelled++;
      else known.push({ mint, name: r.name, symbol: r.symbol, source: 'listed on a cross' });
    }
    return { known, unlabelled, unchecked: missing.length - fresh.length };
  }

  app.get('/v1/tokens/:mint/duplicates', async (req, reply) => {
    const mint = (req.params as { mint: string }).mint;
    if (!isAddress(mint)) throw new RequestError(400, 'mint must be a base58 Solana address');
    const me = await observe(mint);
    if (!me.exists) throw new RequestError(404, `mint ${mint} was not found on chain`);
    if (!me.isMint) throw new RequestError(422, `${mint} is not a token mint`);
    const listed = (await d.db.query<{ base_mint: string }>(`SELECT DISTINCT base_mint FROM crosses WHERE base_mint <> '' AND base_mint <> $1 ORDER BY base_mint LIMIT $2`, [mint, maxListed])).rows.map((r) => r.base_mint);
    const { known, unlabelled, unchecked } = await labelsOf(listed);
    const duplicates = findDuplicates({ mint, name: me.name, symbol: me.symbol }, [...known, ...issuerLists]);
    return send(reply, {
      mint,
      name: me.name,
      symbol: me.symbol,
      comparedWith: { listedOnCrosses: known.length, issuerListed: issuerLists.length, listedWithoutLabel: unlabelled, listedNotYetChecked: unchecked },
      duplicates,
      summary: me.symbol === null && me.name === null ? { verdict: 'unknown', worst: null, count: 0 } : duplicateSummary(duplicates),
      limits: [
        'A match is a warning to read before buying or listing, not a verdict that either token is false: two honest tokens can share a ticker.',
        'Only names and symbols are compared. Images are not: no image is fetched or compared.',
        'Compared with the tokens listed on this deployment and the issuers\' own lists only, not with every token on the chain.',
        ...(unchecked > 0 ? [`${unchecked} listed token(s) have not been read yet; ask again to include them.`] : []),
      ],
    });
  });
}
