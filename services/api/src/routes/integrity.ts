// Integrity analysis over the live protocol (PRODUCT_FEATURES F2, F3, F6, F8, F9, J3, V5).
//
//   GET  /v1/integrity/mint/:mint/holders        the largest holders, labelled with the fact behind each label, and funding clusters (F3)
//   GET  /v1/integrity/mint/:mint/supply         declared against on-chain supply, authorities, what crosses sold, circulating (F9)
//   GET  /v1/integrity/mint/:mint/backing        the backing check for a real-asset token (F6)
//   GET  /v1/integrity/backing                   the backing status of every token with a live cross, for the monitor (F6)
//   POST /v1/integrity/documents                 a signed supply declaration, team declaration or backing attestation
//   GET  /v1/integrity/cross/:address/conflicts  bidders tied to the issuer, with evidence (F8)
//   GET  /v1/integrity/cross/:address/organic    the organic-volume interval, EXPERIMENTAL (F2)
//   GET  /v1/integrity/cross/:address/rating     the open rating of a finished cross (V5)
//   GET  /v1/integrity/ratings                   the rating feed
//   GET  /v1/integrity/ratings/track-record      how the ratings fared against what happened, including when they did not beat chance (V5)
//   GET  /v1/integrity/cross/:address/brief      a cited brief built only from the facts above (J3)
//   POST /v1/integrity/verify-claims             check claims about a cross against the same facts (J3)
//
// Every figure comes from the chain, the indexed orders, or a signed document; nothing is estimated by a model. Funding tracing
// reads transaction history over RPC and is cached for good once found, so the first request for a busy cross may report that some
// wallets are still untraced; the next request continues.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Address, isAddress } from '@solana/kit';
import { verifyDocument } from '@opening-cross/attest';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, getCrossDecoder } from '@opening-cross/sdk';
import {
  BACKING_SCHEMA,
  RATING_VERSION,
  SUPPLY_SCHEMA,
  TEAM_SCHEMA,
  buildBrief,
  checkBacking,
  clusterByFunding,
  findConflicts,
  organicVolume,
  parseClaims,
  rateCross,
  readHolders,
  reconcileSupply,
  teamWallets,
  traceFunding,
  trackRecord,
  verifyClaims,
  type BackingAttestation,
  type BackingResult,
  type BriefFacts,
  type Claim,
  type ClusterResult,
  type ConflictReport,
  type Funding,
  type FundingCache,
  type HolderReport,
  type OrderFacts,
  type OrganicReport,
  type RpcLike,
  type SupplyDeclaration,
  type TeamDeclaration,
} from '@opening-cross/integrity';
import { RequestError } from '../tx.js';

/** An answer with a status the shared error handler does not map: sent as is. */
class Plain extends Error {
  constructor(readonly status: 400 | 403 | 404 | 501, message: string) {
    super(message);
  }
}
import type { ApiDeps } from '../server.js';

export type IntegrityDeps = Pick<ApiDeps, 'db' | 'account' | 'clock' | 'network'>;
export type IntegrityOptions = {
  /** JSON-RPC access for holders, mint accounts and transaction history. Without it those routes answer 501. */
  rpc?: RpcLike | null;
  /** Signers whose backing attestations count. Empty by default: choosing them is the operator's decision. */
  trustedAttesters?: ReadonlySet<string>;
  /** Funders to disregard when linking wallets (an exchange, a faucet), on top of any that have funded many wallets. */
  serviceFunders?: ReadonlySet<string>;
  /** A funder that has funded this many wallets is treated as a service. Default 25. */
  serviceFanout?: number;
  /** Most wallets whose history is read in one request. Default 24. */
  maxTrace?: number;
  /** Attestations older than this stop counting, in seconds. Default seven days. */
  backingMaxAgeSecs?: number;
};

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));
const SUPPLY_MODES = ['escrow', 'mint', 'deferred-mint'] as const;
const KINDS = ['launch', 'reopen', 'tender', 'recurring'] as const;

function address(v: unknown, field: string): Address {
  if (typeof v !== 'string' || !isAddress(v)) throw new RequestError(400, `${field} must be a base58 Solana address`);
  return v;
}
const some = <T>(o: { __option: 'Some'; value: T } | { __option: 'None' }): T | null => (o.__option === 'Some' ? o.value : null);

export function registerIntegrity(app: FastifyInstance, d: IntegrityDeps, opts: IntegrityOptions = {}): void {
  const now = () => d.clock?.() ?? Math.floor(Date.now() / 1000);
  const trusted = opts.trustedAttesters ?? new Set<string>();
  const services = opts.serviceFunders ?? new Set<string>();
  const maxTrace = opts.maxTrace ?? 24;
  const rpc = (): RpcLike => {
    if (!opts.rpc) throw new Plain(501, 'This deployment has no RPC configured for integrity analysis; the analysis that reads only indexed data is available.');
    return opts.rpc;
  };
  const cluster = d.network ?? 'unknown';
  type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  const guarded = (h: Handler): Handler => async (req, reply) => {
    try {
      return await h(req, reply);
    } catch (e) {
      if (e instanceof Plain) return send(reply, { error: e.message }, e.status);
      throw e;
    }
  };
  const get = (path: string, h: Handler) => app.get(path, guarded(h));
  const post = (path: string, h: Handler) => app.post(path, guarded(h));

  const cache: FundingCache = {
    async get(wallet) {
      const { rows } = await d.db.query<{ funder: string | null; lamports: string | null; signature: string | null; block_time: string | null; unknown: string | null }>('SELECT funder, lamports::text, signature, block_time::text, unknown FROM funding_cache WHERE wallet = $1', [wallet]);
      const r = rows[0];
      if (!r) return null;
      return { wallet, funder: r.funder, lamports: r.lamports === null ? null : BigInt(r.lamports), signature: r.signature, blockTime: r.block_time === null ? null : Number(r.block_time), ...(r.unknown ? { unknown: r.unknown as NonNullable<Funding['unknown']> } : {}) };
    },
    async set(f) {
      await d.db.query('INSERT INTO funding_cache (wallet, funder, lamports, signature, block_time, unknown) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (wallet) DO NOTHING', [f.wallet, f.funder, f.lamports?.toString() ?? null, f.signature, f.blockTime, f.unknown ?? null]);
    },
  };

  /** Funding for each wallet: cached ones at once, the rest traced (a few at a time) up to the per-request budget. */
  async function fundings(wallets: readonly string[], budget = maxTrace): Promise<{ map: Map<string, Funding>; untraced: string[]; traced: number }> {
    const map = new Map<string, Funding>();
    const todo: string[] = [];
    for (const w of wallets) {
      const hit = await cache.get(w);
      if (hit) map.set(w, hit);
      else todo.push(w);
    }
    const batch = todo.slice(0, budget);
    let next = 0;
    let traced = 0;
    const worker = async () => {
      while (next < batch.length) {
        const w = batch[next++]!;
        try {
          map.set(w, await traceFunding(rpc(), w, { cache }));
          traced += 1;
        } catch (e) {
          if (e instanceof RequestError) throw e;
          // A failed read leaves the wallet untraced; it is tried again on the next request.
        }
      }
    };
    if (batch.length) await Promise.all([worker(), worker(), worker()]);
    return { map, untraced: wallets.filter((w) => !map.has(w)), traced };
  }

  async function fanoutOf(funders: readonly string[]): Promise<Map<string, number>> {
    if (funders.length === 0) return new Map();
    const { rows } = await d.db.query<{ funder: string; n: string }>('SELECT funder, count(*)::text AS n FROM funding_cache WHERE funder = ANY($1::text[]) GROUP BY funder', [funders]);
    return new Map(rows.map((r) => [r.funder, Number(r.n)]));
  }

  async function latestDoc<T>(mint: string, schema: string): Promise<T | null> {
    const { rows } = await d.db.query<{ doc: T }>('SELECT doc FROM integrity_documents WHERE mint = $1 AND schema = $2 ORDER BY as_of DESC, received_at DESC LIMIT 1', [mint, schema]);
    return rows[0]?.doc ?? null;
  }

  async function mintFacts(mint: string) {
    const r = await rpc().call<{ value: { owner: string; data: { parsed?: { type?: string; info?: { supply: string; decimals: number; mintAuthority: string | null; freezeAuthority: string | null } } } } | null }>('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const info = r.value?.data?.parsed;
    if (!r.value) throw new RequestError(404, 'no account exists at that address');
    if (info?.type !== 'mint' || !info.info) throw new RequestError(422, 'that address is not a token mint');
    return { supply: BigInt(info.info.supply), decimals: info.info.decimals, mintAuthority: info.info.mintAuthority, freezeAuthority: info.info.freezeAuthority };
  }

  /** Addresses tied to the issuer of a token: its mint authority, and who created or is paid by the crosses selling it. */
  async function issuerAddresses(mint: string, mintAuthority: string | null): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    if (mintAuthority) out[mintAuthority] = 'the mint authority of the token';
    const { rows } = await d.db.query<{ creator: string }>('SELECT DISTINCT creator FROM crosses WHERE base_mint = $1', [mint]);
    for (const r of rows) out[r.creator] ??= 'created a cross selling this token';
    return out;
  }

  // ----------------------------------------------------------------------------------------------------- a cross
  interface Loaded {
    address: string;
    state: string;
    c: ReturnType<ReturnType<typeof getCrossDecoder>['decode']>;
    orders: { owner: string; side: 'buy' | 'sell'; weight: bigint | null }[];
  }
  async function loadCross(addr: Address): Promise<Loaded> {
    const row = (await d.db.query<{ state: string }>('SELECT state FROM crosses WHERE address = $1', [addr])).rows[0];
    if (!row) throw new RequestError(404, 'no such cross is indexed');
    const acct = await d.account(addr);
    if (!acct || acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !CROSS_DISCRIMINATOR.every((b, i) => acct.data[i] === b)) throw new RequestError(404, 'the cross account was not found on chain');
    const c = getCrossDecoder().decode(acct.data);
    const { rows } = await d.db.query<{ owner: string; side: number; quantity: string | null; fill: string | null; status: string }>('SELECT owner, side, quantity::text, fill::text, status FROM orders WHERE cross_address = $1 AND status <> \'cancelled\' ORDER BY idx', [addr]);
    return {
      address: addr,
      state: row.state,
      c,
      orders: rows.map((o) => ({ owner: o.owner, side: o.side === 0 ? 'buy' : 'sell', weight: o.fill !== null ? BigInt(o.fill) : o.quantity !== null ? BigInt(o.quantity) : null })),
    };
  }

  interface Analysis {
    loaded: Loaded;
    conflicts: ConflictReport;
    clusters: ClusterResult;
    organic: OrganicReport;
    fundings: Map<string, Funding>;
    untraced: string[];
    tracedNow: number;
  }
  const memo = new Map<string, { at: number; value: Analysis }>();
  async function analyse(addr: Address, budget?: number): Promise<Analysis> {
    const hit = memo.get(addr);
    if (hit && now() - hit.at < 30) return hit.value;
    const loaded = await loadCross(addr);
    const c = loaded.c;
    const parties = [c.creator, c.proceedsTo, ...(some(c.settler) ? [some(c.settler)!] : [])];
    const owners = [...new Set(loaded.orders.map((o) => o.owner))];
    const f = await fundings([...new Set([...parties, ...owners])], budget);
    const team = await teamWallets(await latestDoc<TeamDeclaration>(c.baseMint, TEAM_SCHEMA), c.baseMint);
    const conflicts = findConflicts({
      parties: { address: addr, creator: c.creator, proceedsTo: c.proceedsTo, integrator: c.integrator, feeRecipient: c.feeRecipient, settler: some(c.settler) },
      orders: loaded.orders satisfies OrderFacts[],
      fundings: f.map,
      declaredTeam: team,
      serviceFunders: services,
    });
    const participants = [...f.map.values()].filter((x) => owners.includes(x.wallet));
    const fan = await fanoutOf([...new Set(participants.map((x) => x.funder).filter((x): x is string => !!x))]);
    const clusters = clusterByFunding(participants, { serviceFunders: services, fanout: fan, ...(opts.serviceFanout ? { serviceFanout: opts.serviceFanout } : {}) });
    // An owner whose funding was not traced yet counts as unknown, not independent.
    for (const w of owners) if (!f.map.has(w)) clusters.unknownFunder.push(w);
    const organic = organicVolume(loaded.orders, conflicts, clusters, f.map);
    const value: Analysis = { loaded, conflicts, clusters, organic, fundings: f.map, untraced: f.untraced.filter((w) => owners.includes(w)), tracedNow: f.traced };
    memo.set(addr, { at: now(), value });
    return value;
  }

  const crossOut = (l: Loaded) => ({ address: l.address, state: l.state, kind: KINDS[l.c.kind], supplyMode: SUPPLY_MODES[l.c.supplyMode], baseMint: l.c.baseMint, quoteMint: l.c.quoteMint, creator: l.c.creator, orders: l.orders.length });
  const trace = (a: Analysis) => ({ walletsWithFunding: a.fundings.size, untraced: a.untraced.length, tracedThisRequest: a.tracedNow, note: a.untraced.length ? 'Some wallets are not traced yet and count as unknown, not independent; ask again to continue.' : 'Every bidder was traced.' });

  get('/v1/integrity/cross/:address/conflicts', async (req, reply) => {
    const a = await analyse(address((req.params as { address: string }).address, 'address'));
    return send(reply, { schema: 'opening-cross/conflicts/v1', network: cluster, ...a.conflicts, cross: crossOut(a.loaded), funding: trace(a) });
  });

  get('/v1/integrity/cross/:address/organic', async (req, reply) => {
    const a = await analyse(address((req.params as { address: string }).address, 'address'));
    return send(reply, {
      schema: 'opening-cross/organic-volume/v0',
      status: 'experimental',
      network: cluster,
      cross: crossOut(a.loaded),
      meaning: 'lowerBps is the share of volume from bidders shown independent; upperBps is the share not shown to be inorganic. The truth is between them. Neither is a verdict on any bidder.',
      ...a.organic,
      clusters: a.clusters.clusters,
      ignoredServices: a.clusters.ignoredServices,
      funding: trace(a),
    });
  });

  // ------------------------------------------------------------------------------------------------------ a mint
  async function holdersOf(mint: string, mintAuthority: string | null): Promise<HolderReport> {
    const issuer = await issuerAddresses(mint, mintAuthority);
    const team = await teamWallets(await latestDoc<TeamDeclaration>(mint, TEAM_SCHEMA), mint);
    return readHolders(rpc(), mint, { issuer, team: Object.fromEntries(team) });
  }

  get('/v1/integrity/mint/:mint/holders', async (req, reply) => {
    const mint = address((req.params as { mint: string }).mint, 'mint');
    const facts = await mintFacts(mint);
    const report = await holdersOf(mint, facts.mintAuthority);
    const wallets = [...new Set(report.holders.filter((h) => h.label.kind === 'wallet' || h.label.kind === 'program-account').map((h) => h.owner))];
    const f = await fundings(wallets);
    const holdings = new Map<string, number>();
    for (const h of report.holders) holdings.set(h.owner, (holdings.get(h.owner) ?? 0) + h.shareBps);
    const participants = [...f.map.values()];
    const fan = await fanoutOf([...new Set(participants.map((x) => x.funder).filter((x): x is string => !!x))]);
    const clusters = clusterByFunding(participants, { serviceFunders: services, fanout: fan, holdings, ...(opts.serviceFanout ? { serviceFanout: opts.serviceFanout } : {}) });
    return send(reply, {
      schema: 'opening-cross/holders/v1',
      network: cluster,
      ...report,
      mintAuthority: facts.mintAuthority,
      freezeAuthority: facts.freezeAuthority,
      funding: { clusters: clusters.clusters, ignoredServices: clusters.ignoredServices, untraced: f.untraced, tracedThisRequest: f.traced, note: 'A cluster is a set of wallets whose first SOL came from the same wallet, or from one another. It is evidence of common control, not proof, and a wallet in no cluster is not proven independent.' },
    });
  });

  get('/v1/integrity/mint/:mint/supply', async (req, reply) => {
    const mint = address((req.params as { mint: string }).mint, 'mint');
    const chain = await mintFacts(mint);
    const holders = await holdersOf(mint, chain.mintAuthority).catch(() => null);
    const declaration = await latestDoc<SupplyDeclaration>(mint, SUPPLY_SCHEMA);
    const { rows } = await d.db.query<{ address: string; supply_mode: number; state: string }>('SELECT address, supply_mode, state FROM crosses WHERE base_mint = $1 AND state = \'Finalized\'', [mint]);
    const sold = [];
    for (const r of rows) {
      const acct = await d.account(r.address as Address);
      if (!acct || acct.owner !== CROSS_CORE_PROGRAM_ADDRESS) continue;
      sold.push({ cross: r.address, kind: SUPPLY_MODES[r.supply_mode]!, baseSold: getCrossDecoder().decode(acct.data).baseSold, state: r.state });
    }
    const issuerSet = await issuerAddresses(mint, chain.mintAuthority);
    const report = await reconcileSupply({ mint, chain, declaration, expectedSigner: declaration && (declaration.signer in issuerSet ? declaration.signer : null), holders, crosses: sold });
    return send(reply, { schema: 'opening-cross/supply-truth/v1', network: cluster, ...report, declaration: declaration ? { id: declaration.id, signer: declaration.signer, asOf: declaration.body.asOf, policy: declaration.body.policy } : null, crossesCounted: sold.length });
  });

  async function backingOf(mint: string, supply: bigint): Promise<BackingResult> {
    const doc = await latestDoc<BackingAttestation>(mint, BACKING_SCHEMA);
    return checkBacking(mint, supply, doc, { trustedAttesters: trusted, now: now(), ...(opts.backingMaxAgeSecs ? { maxAgeSecs: opts.backingMaxAgeSecs } : {}) });
  }

  get('/v1/integrity/mint/:mint/backing', async (req, reply) => {
    const mint = address((req.params as { mint: string }).mint, 'mint');
    const chain = await mintFacts(mint);
    return send(reply, { schema: 'opening-cross/backing/v1', network: cluster, ...(await backingOf(mint, chain.supply)), trustedAttesters: [...trusted] });
  });

  get('/v1/integrity/backing', async (_req, reply) => {
    // Only tokens that have published an attestation, or that a live cross sells and an attester has been asked about, are in scope: a
    // token that makes no backing claim is not "unverifiable", it simply claims nothing.
    const { rows } = await d.db.query<{ mint: string; live: boolean }>(
      `SELECT m.mint, EXISTS (SELECT 1 FROM crosses c WHERE c.base_mint = m.mint AND c.state = 'Live') AS live
         FROM (SELECT DISTINCT mint FROM integrity_documents WHERE schema = $1) m`,
      [BACKING_SCHEMA],
    );
    const out = [];
    for (const r of rows) {
      const supply = (await mintFacts(r.mint).catch(() => null))?.supply;
      if (supply === undefined) continue;
      out.push({ ...(await backingOf(r.mint, supply)), liveCross: r.live });
    }
    return send(reply, { schema: 'opening-cross/backing-feed/v1', network: cluster, tokens: out });
  });

  // ------------------------------------------------------------------------------------------------ documents
  post('/v1/integrity/documents', async (req, reply) => {
    const doc = req.body as { body?: Record<string, unknown>; id?: string; signer?: string; signature?: string } | null;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || typeof doc.body !== 'object' || doc.body === null) throw new RequestError(400, 'request body must be a signed document { body, id, signer, signature }');
    const schema = doc.body.schema;
    if (schema !== SUPPLY_SCHEMA && schema !== TEAM_SCHEMA && schema !== BACKING_SCHEMA) throw new RequestError(400, `schema must be one of ${SUPPLY_SCHEMA}, ${TEAM_SCHEMA}, ${BACKING_SCHEMA}`);
    const mint = address(doc.body.mint, 'body.mint');
    const asOf = doc.body.asOf;
    if (typeof asOf !== 'number' || !Number.isInteger(asOf) || asOf > now() + 300) throw new RequestError(400, 'body.asOf must be a unix time in seconds, not in the future');
    const check = await verifyDocument(doc as never).catch(() => ({ ok: false as const, reason: 'MALFORMED' as const }));
    if (!check.ok) throw new RequestError(400, `the document does not verify (${check.reason})`);
    const signer = doc.signer as string;
    if (schema === BACKING_SCHEMA) {
      if (!trusted.has(signer)) throw new Plain(403, 'that signer is not a trusted backing attester on this deployment');
      if (typeof doc.body.reserveAtoms !== 'string' || !/^\d+$/.test(doc.body.reserveAtoms)) throw new RequestError(400, 'body.reserveAtoms must be a decimal string');
    } else {
      if (schema === SUPPLY_SCHEMA && (typeof doc.body.totalSupply !== 'string' || !/^\d+$/.test(doc.body.totalSupply) || (doc.body.policy !== 'fixed' && doc.body.policy !== 'mintable'))) throw new RequestError(400, 'body.totalSupply must be a decimal string and body.policy "fixed" or "mintable"');
      if (schema === TEAM_SCHEMA && (!Array.isArray(doc.body.wallets) || !doc.body.wallets.every((w) => typeof w === 'string' && isAddress(w)))) throw new RequestError(400, 'body.wallets must be a list of base58 addresses');
      const facts = await mintFacts(mint);
      const issuer = await issuerAddresses(mint, facts.mintAuthority);
      if (!(signer in issuer)) throw new Plain(403, 'only the mint authority of the token, or the creator of a cross selling it, can sign this');
    }
    await d.db.query('INSERT INTO integrity_documents (id, schema, mint, signer, as_of, doc) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING', [doc.id, schema, mint, signer, asOf, JSON.stringify(doc)]);
    return send(reply, { stored: true, id: doc.id, schema, mint, signer }, 201);
  });

  // ------------------------------------------------------------------------------------------------ rating, brief
  async function rating(a: Analysis) {
    const c = a.loaded.c;
    const printed = a.loaded.state === 'Finalized' || a.loaded.state === 'Cleared' ? true : a.loaded.state === 'NoPrint' ? false : null;
    const clr = some(c.clearing);
    const mint = opts.rpc ? await mintFacts(c.baseMint).catch(() => null) : null;
    const holders = opts.rpc && mint ? await holdersOf(c.baseMint, mint.mintAuthority).catch(() => null) : null;
    const backingDoc = await latestDoc<BackingAttestation>(c.baseMint, BACKING_SCHEMA);
    const backing: BackingResult | null = backingDoc && mint ? await backingOf(c.baseMint, mint.supply) : null;
    const r = rateCross({
      printed,
      clearing: clr ? { matched: clr.matched, demand: clr.demand, supply: clr.supply } : null,
      organic: a.organic,
      conflicts: a.conflicts,
      holders,
      ...(mint ? { mintAuthority: mint.mintAuthority } : {}),
      backing,
    });
    return { rating: r, holders, mint, backing, clearing: clr };
  }

  async function snapshot(addr: string, r: ReturnType<typeof rateCross>) {
    if (r.status !== 'rated' && r.status !== 'abstained') return;
    await d.db.query('INSERT INTO rating_snapshots (cross_address, version, score, status, body) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (cross_address, version) DO NOTHING', [addr, RATING_VERSION, r.score, r.status, JSON.stringify(r)]);
  }

  get('/v1/integrity/cross/:address/rating', async (req, reply) => {
    const addr = address((req.params as { address: string }).address, 'address');
    const a = await analyse(addr);
    const { rating: r } = await rating(a);
    if (a.loaded.state === 'Finalized' && a.untraced.length === 0) await snapshot(addr, r);
    return send(reply, { schema: 'opening-cross/rating/v0', network: cluster, cross: crossOut(a.loaded), ...r, notFitted: 'The weights are ours and were not fitted to outcomes. Read /v1/integrity/ratings/track-record before relying on a rating.', funding: trace(a) });
  });

  get('/v1/integrity/ratings', async (req, reply) => {
    const limit = Math.min(200, Math.max(1, Number((req.query as { limit?: string }).limit ?? 50) || 50));
    const { rows } = await d.db.query<{ cross_address: string; score: number | null; status: string; rated_at: Date; body: unknown }>('SELECT cross_address, score, status, rated_at, body FROM rating_snapshots WHERE version = $1 ORDER BY rated_at DESC LIMIT $2', [RATING_VERSION, limit]);
    return send(reply, { schema: 'opening-cross/rating-feed/v0', network: cluster, version: RATING_VERSION, ratings: rows.map((r) => ({ cross: r.cross_address, score: r.score, status: r.status, ratedAt: r.rated_at.toISOString(), components: (r.body as { components?: unknown }).components })), note: 'Ratings appear here once a finished cross has been rated with every bidder traced.' });
  });

  get('/v1/integrity/ratings/track-record', async (_req, reply) => {
    const { rows } = await d.db.query<{ cross_address: string; score: number; outcome_bps: number }>('SELECT s.cross_address, s.score, o.outcome_bps FROM rating_snapshots s JOIN rating_outcomes o USING (cross_address) WHERE s.version = $1 AND s.status = \'rated\' AND s.score IS NOT NULL', [RATING_VERSION]);
    const rated = (await d.db.query<{ n: string }>('SELECT count(*)::text AS n FROM rating_snapshots WHERE version = $1 AND status = \'rated\'', [RATING_VERSION])).rows[0]!.n;
    const record = trackRecord(rows.map((r) => ({ cross: r.cross_address, score: r.score, outcomeBps: r.outcome_bps })));
    return send(reply, { schema: 'opening-cross/rating-track-record/v0', network: cluster, version: RATING_VERSION, ratedCrosses: Number(rated), withOutcome: rows.length, ...record, how: 'A rating is scored by whether a score at or above the median called the direction of the later return correctly, against always guessing the commoner direction, and by its rank correlation with the return. It is published whether or not it beats chance.' });
  });

  async function briefFacts(addr: Address): Promise<{ facts: BriefFacts; analysis: Analysis }> {
    const a = await analyse(addr);
    const r = await rating(a);
    const c = a.loaded.c;
    const supply = r.mint ? await reconcileSupply({ mint: c.baseMint, chain: r.mint, declaration: await latestDoc<SupplyDeclaration>(c.baseMint, SUPPLY_SCHEMA), holders: r.holders }) : null;
    const reason = some(c.noPrintReason);
    const facts: BriefFacts = {
      cross: { address: addr, kind: KINDS[c.kind]!, state: a.loaded.state, baseMint: c.baseMint, quoteMint: c.quoteMint, creator: c.creator, ordersTotal: c.ordersTotal, protocolFeeBps: c.protocolFeeBps, clearing: r.clearing ? { price: r.clearing.price, matched: r.clearing.matched, demand: r.clearing.demand, supply: r.clearing.supply } : null, noPrintReason: reason === null ? null : String(reason) },
      conflicts: a.conflicts,
      organic: a.organic,
      holders: r.holders,
      supply,
      backing: r.backing,
      rating: r.rating,
    };
    return { facts, analysis: a };
  }

  get('/v1/integrity/cross/:address/brief', async (req, reply) => {
    const { facts, analysis } = await briefFacts(address((req.params as { address: string }).address, 'address'));
    return send(reply, { schema: 'opening-cross/brief/v1', network: cluster, ...buildBrief(facts), funding: trace(analysis), note: 'Every sentence is a template filled from the cited facts. No language model wrote or checked it.' });
  });

  post('/v1/integrity/verify-claims', async (req, reply) => {
    const body = req.body as { cross?: unknown; text?: unknown; claims?: unknown } | null;
    if (!body || typeof body !== 'object') throw new RequestError(400, 'request body must be { cross, text } or { cross, claims }');
    const addr = address(body.cross, 'cross');
    let claims: Claim[] = [];
    let unparsed: string[] = [];
    if (typeof body.text === 'string') {
      if (body.text.length > 8_000) throw new RequestError(400, 'text is limited to 8,000 characters');
      ({ claims, unparsed } = parseClaims(body.text));
    } else if (Array.isArray(body.claims)) {
      if (body.claims.length > 100) throw new RequestError(400, 'at most 100 claims per request');
      claims = body.claims.map((c: Partial<Claim>, i) => {
        if (typeof c?.metric !== 'string' || typeof c.value !== 'string' || !['=', '<=', '>=', '<', '>'].includes(c.op as string)) throw new RequestError(400, `claims[${i}] needs metric, op (=, <=, >=, <, >) and value (a string)`);
        return { id: c.id ?? `c${i + 1}`, metric: c.metric, op: c.op as Claim['op'], value: c.value };
      });
    } else throw new RequestError(400, 'give either text or claims');
    const { facts, analysis } = await briefFacts(addr);
    return send(reply, { schema: 'opening-cross/claim-check/v1', network: cluster, cross: addr, results: verifyClaims(claims, facts), unparsed, funding: trace(analysis), note: 'unverifiable means the fact is not available here, not that the claim is false. Sentences this checker cannot read are returned in unparsed.' });
  });
}
