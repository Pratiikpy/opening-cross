// Gates: which gates exist, what each requires, why a wallet is or is not eligible for a gated cross, and the unsigned
// transaction that claims a pass. Everything is read from chain (cross_gate config and pass accounts, the SAS attestation
// account); the only thing stored off chain is an allowlist an issuer chooses to publish, and it is accepted only when its
// Merkle root equals the root on chain, so a published list can never disagree with the gate.
//
//   GET  /v1/gates/presets                       the three presets (packages/presets)
//   GET  /v1/gates                               gates found on recent crosses
//   GET  /v1/gates/:mint[?wallet=]               one gate: requirement, pass routes, and the wallet's standing
//   POST /v1/gates/allowlist-root                the root and size of a pasted list for a gate mint (no chain, no storage)
//   POST /v1/gates/:mint/allowlist               publish the list whose root is on chain, so wallets can fetch proofs
//   GET  /v1/eligibility/:cross/:wallet          exactly why the wallet can or cannot place an order in the cross
//   POST /v1/tx/claim-pass                       unsigned transaction: claim a pass by allowlist proof or SAS attestation
import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { type Address, createNoopSigner, getAddressEncoder, getProgramDerivedAddress, isAddress } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, CrossState, getCrossDecoder, gatePassAddress } from '@opening-cross/sdk';
import {
  CROSS_GATE_PROGRAM_ADDRESS,
  GATE_CONFIG_DISCRIMINATOR,
  Mode,
  PRESET_IDS,
  findConfigPda,
  getClaimPassInstruction,
  getClaimPassMerkleInstruction,
  getGateConfigDecoder,
  getPassDecoder,
  preset as jurisdictionPreset,
} from '@opening-cross/cross-gate-client';
import { GATE_PRESETS, type GatePreset } from '@opening-cross/presets/gate';
import { buildAllowlist, parseAllowlist, toHex, verifyAllowlistProof, allowlistLeaf } from '@opening-cross/presets/gate-allowlist';
import { type Lifetime, RequestError, compile } from '../tx.js';

// ---------------------------------------------------------------- dependencies

type ChainAccount = { data: Uint8Array; owner: Address };

export type AllowlistStore = {
  get(mint: Address): Promise<{ rootHex: string; addresses: Address[] } | null>;
  put(mint: Address, rootHex: string, addresses: Address[]): Promise<void>;
};

export type GateDeps = {
  db: pg.Pool;
  account: (a: Address) => Promise<ChainAccount | null>;
  lifetime: () => Promise<Lifetime>;
  /** Unix seconds; defaults to the wall clock. Tests inject one. */
  clock?: () => number;
  /** Published allowlists; defaults to a table in the API's database. Tests inject an in-memory one. */
  allowlists?: AllowlistStore;
};

/** One row per gate mint, created on first use. A list is kept only together with the root it hashes to. */
export function pgAllowlistStore(db: pg.Pool): AllowlistStore {
  let ready: Promise<unknown> | null = null;
  const init = () =>
    (ready ??= db
      .query(`CREATE TABLE IF NOT EXISTS gate_allowlists (mint text PRIMARY KEY, root text NOT NULL, addresses text[] NOT NULL, published_at timestamptz NOT NULL DEFAULT now())`)
      .catch((e) => {
        ready = null;
        throw e;
      }));
  return {
    async get(mint) {
      await init();
      const { rows } = await db.query<{ root: string; addresses: string[] }>('SELECT root, addresses FROM gate_allowlists WHERE mint = $1', [mint]);
      const r = rows[0];
      return r ? { rootHex: r.root, addresses: r.addresses as Address[] } : null;
    },
    async put(mint, rootHex, addresses) {
      await init();
      await db.query(
        `INSERT INTO gate_allowlists (mint, root, addresses) VALUES ($1, $2, $3)
         ON CONFLICT (mint) DO UPDATE SET root = EXCLUDED.root, addresses = EXCLUDED.addresses, published_at = now()`,
        [mint, rootHex, addresses],
      );
    },
  };
}

// ---------------------------------------------------------------- small helpers

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? Buffer.from(x).toString('hex') : x));
const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));

function addr(v: unknown, field: string): Address {
  if (typeof v !== 'string' || !isAddress(v)) throw new RequestError(400, `${field} must be a base58 Solana address`);
  return v;
}
function obj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new RequestError(400, 'request body must be a JSON object');
  return v as Record<string, unknown>;
}

const SAS_PROGRAM_ADDRESS = '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG' as Address;
const enc = getAddressEncoder();
const utf8 = new TextEncoder();

/** The attestation account for a wallet under a credential and schema: SAS seeds `["attestation", credential, schema, nonce]`, nonce = wallet. */
export async function attestationAddress(credential: Address, schema: Address, wallet: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: SAS_PROGRAM_ADDRESS, seeds: [utf8.encode('attestation'), enc.encode(credential), enc.encode(schema), enc.encode(wallet)] }))[0];
}

export type AttestationState = { state: 'missing' } | { state: 'foreign' } | { state: 'expired'; expiry: bigint } | { state: 'live'; expiry: bigint };

/**
 * Reads SAS attestation bytes the way the program does (crates/sas-attestation): discriminator 2, nonce, credential, schema, a length-prefixed
 * data field, signer, then the i64 expiry (0 never expires). Missing, closed, foreign or malformed accounts are not attestations.
 */
export function readAttestation(acct: ChainAccount | null, credential: Address, schema: Address, wallet: Address, now: bigint): AttestationState {
  if (!acct || acct.data.length === 0) return { state: 'missing' };
  if (acct.owner !== SAS_PROGRAM_ADDRESS) return { state: 'foreign' };
  const d = acct.data;
  if (d[0] !== 2 || d.length < 101) return { state: 'foreign' };
  const key = (at: number) => d.subarray(at, at + 32);
  const same = (at: number, a: Address) => Buffer.compare(key(at), enc.encode(a) as Uint8Array) === 0;
  if (!same(1, wallet) || !same(33, credential) || !same(65, schema)) return { state: 'foreign' };
  const len = new DataView(d.buffer, d.byteOffset).getUint32(97, true);
  const at = 101 + len + 32;
  if (d.length < at + 8) return { state: 'foreign' };
  const expiry = new DataView(d.buffer, d.byteOffset).getBigInt64(at, true);
  return expiry === 0n || expiry > now ? { state: 'live', expiry } : { state: 'expired', expiry };
}

// ---------------------------------------------------------------- reasons

export type ReasonCode =
  | 'CROSS_HAS_NO_GATE'
  | 'HAS_PASS'
  | 'GATE_CONFIG_MISSING'
  | 'NOT_ON_ALLOWLIST'
  | 'ALLOWLIST_NOT_PUBLISHED'
  | 'NO_ATTESTATION'
  | 'ATTESTATION_EXPIRED'
  | 'AUTHORITY_GRANT_ONLY'
  | 'CLAIMABLE_BY_ALLOWLIST'
  | 'CLAIMABLE_BY_ATTESTATION'
  | 'PASS_BACKING_LAPSED';

export type Reason = {
  code: ReasonCode;
  /** The rule this is about, in the program's terms. */
  rule: string;
  message: string;
  /** What would satisfy the rule; null when nothing the wallet can do will. */
  fix: string | null;
};

export type Standing = {
  hasPass: boolean;
  pass: Address;
  allowlist: { configured: boolean; published: boolean; listed: boolean | null };
  sas: { configured: boolean; credential: Address | null; schema: Address | null; attestation: Address | null; state: AttestationState['state'] | null; expiry: bigint | null };
  claim: { route: 'allowlist' | 'attestation'; endpoint: string; body: { mint: Address; owner: Address; route: string } } | null;
  reasons: Reason[];
};

// ---------------------------------------------------------------- registration

export function registerGate(app: FastifyInstance, d: GateDeps) {
  const now = () => BigInt(d.clock ? d.clock() : Math.floor(Date.now() / 1000));
  const store = d.allowlists ?? pgAllowlistStore(d.db);

  async function readConfig(mint: Address) {
    const [configAddress] = await findConfigPda({ mint });
    const acct = await d.account(configAddress);
    if (!acct || acct.owner !== CROSS_GATE_PROGRAM_ADDRESS || acct.data.length < 8 || !(GATE_CONFIG_DISCRIMINATOR as Uint8Array).every((b, i) => acct.data[i] === b)) return null;
    return { address: configAddress, config: getGateConfigDecoder().decode(acct.data) };
  }

  async function hasPass(mint: Address, owner: Address) {
    const pass = await gatePassAddress(mint, owner);
    const acct = await d.account(pass);
    if (!acct || acct.owner !== CROSS_GATE_PROGRAM_ADDRESS || acct.data.length === 0) return { pass, held: false };
    try {
      const p = getPassDecoder().decode(acct.data);
      return { pass, held: p.mint === mint && p.owner === owner };
    } catch {
      return { pass, held: false };
    }
  }

  /** The published list, only if it still hashes to the root the chain holds. */
  async function publishedList(mint: Address, chainRoot: Uint8Array | null) {
    if (!chainRoot) return null;
    const stored = await store.get(mint);
    if (!stored || stored.rootHex !== toHex(chainRoot)) return null;
    const tree = buildAllowlist(mint, stored.addresses);
    return tree.rootHex === stored.rootHex ? tree : null;
  }

  async function standing(mint: Address, wallet: Address, cfg: NonNullable<Awaited<ReturnType<typeof readConfig>>>): Promise<Standing> {
    const { config } = cfg;
    const chainRoot = config.allowlistRoot.__option === 'Some' ? (config.allowlistRoot.value as Uint8Array) : null;
    const sasReq = config.sas.__option === 'Some' ? config.sas.value : null;
    const [{ pass, held }, tree, att] = await Promise.all([
      hasPass(mint, wallet),
      publishedList(mint, chainRoot),
      sasReq
        ? (async () => {
            const a = await attestationAddress(sasReq.credential, sasReq.schema, wallet);
            return { address: a, state: readAttestation(await d.account(a), sasReq.credential, sasReq.schema, wallet, now()) };
          })()
        : Promise.resolve(null),
    ]);

    const listed = tree ? tree.has(wallet) : null;
    const reasons: Reason[] = [];
    let claim: Standing['claim'] = null;

    if (held) {
      reasons.push({ code: 'HAS_PASS', rule: 'cross_core requires a cross_gate pass for the gate mint', message: 'This wallet holds a pass for the gate.', fix: null });
      if (sasReq && att && att.state.state !== 'live') {
        reasons.push({
          code: 'PASS_BACKING_LAPSED',
          rule: 'revoke_unattested: any pass on a gate that requires SAS, when its owner has no live attestation',
          message: `This gate requires a SAS attestation and this wallet has no live one (${att.state.state === 'expired' ? 'its attestation expired' : 'none is on chain'}). The program lets anyone revoke such a pass (revoke_unattested), whatever route it was claimed by; until someone does, it still admits the wallet.`,
          fix: 'Get a live attestation from the gate credential before the pass is revoked.',
        });
      }
    } else {
      // Every route the gate offers, and where this wallet stands on each.
      if (chainRoot) {
        if (!tree) {
          reasons.push({
            code: 'ALLOWLIST_NOT_PUBLISHED',
            rule: 'claim_pass_merkle: a proof against the allowlist root on chain',
            message: 'The gate has an allowlist, but its issuer has not published the list, so no proof can be built for this wallet.',
            fix: 'Ask the issuer to publish the allowlist, then claim. If the wallet is not on the list, the issuer has to add it and set a new root.',
          });
        } else if (!listed) {
          reasons.push({
            code: 'NOT_ON_ALLOWLIST',
            rule: 'claim_pass_merkle: a proof against the allowlist root on chain',
            message: 'This wallet is not on the gate\'s published allowlist.',
            fix: 'Only the issuer can add it: they publish a new list and set its root with set_allowlist_root.',
          });
        } else {
          claim = { route: 'allowlist', endpoint: '/v1/tx/claim-pass', body: { mint, owner: wallet, route: 'allowlist' } };
          reasons.push({ code: 'CLAIMABLE_BY_ALLOWLIST', rule: 'claim_pass_merkle: a proof against the allowlist root on chain', message: 'This wallet is on the allowlist and has not claimed its pass yet.', fix: 'Claim the pass (one transaction), then place the order.' });
        }
      }
      if (sasReq && att) {
        const s = att.state;
        if (s.state === 'live') {
          claim ??= { route: 'attestation', endpoint: '/v1/tx/claim-pass', body: { mint, owner: wallet, route: 'attestation' } };
          reasons.push({ code: 'CLAIMABLE_BY_ATTESTATION', rule: 'claim_pass: a live SAS attestation under the gate\'s credential and schema', message: 'This wallet has a live attestation and has not claimed its pass yet.', fix: 'Claim the pass (one transaction), then place the order.' });
        } else if (s.state === 'expired') {
          reasons.push({
            code: 'ATTESTATION_EXPIRED',
            rule: 'claim_pass: a live SAS attestation under the gate\'s credential and schema',
            message: `This wallet's attestation under the gate's credential expired at unix time ${s.expiry}.`,
            fix: 'The credential holder has to issue a new attestation for this wallet.',
          });
        } else {
          reasons.push({
            code: 'NO_ATTESTATION',
            rule: 'claim_pass: a live SAS attestation under the gate\'s credential and schema',
            message: s.state === 'foreign' ? 'The account where this wallet\'s attestation should be is not a valid attestation for it.' : 'This wallet has no attestation under the gate\'s credential and schema.',
            fix: `Obtain an attestation with nonce ${wallet} from credential ${sasReq!.credential} (schema ${sasReq!.schema}). Only the credential holder can issue it.`,
          });
        }
      }
      if (!chainRoot && !sasReq) {
        reasons.push({
          code: 'AUTHORITY_GRANT_ONLY',
          rule: 'grant_pass: only the gate authority',
          message: 'This gate has no allowlist and no attestation requirement, so the only way to a pass is the gate authority granting one.',
          fix: `Ask the gate authority (${config.authority}) to grant the wallet a pass.`,
        });
      }
    }

    return {
      hasPass: held,
      pass,
      allowlist: { configured: chainRoot !== null, published: tree !== null, listed },
      sas: {
        configured: sasReq !== null,
        credential: sasReq?.credential ?? null,
        schema: sasReq?.schema ?? null,
        attestation: att?.address ?? null,
        state: att?.state.state ?? null,
        expiry: att && 'expiry' in att.state ? att.state.expiry : null,
      },
      claim,
      reasons,
    };
  }

  const describeConfig = (mint: Address, cfg: NonNullable<Awaited<ReturnType<typeof readConfig>>>) => {
    const { config, address } = cfg;
    const root = config.allowlistRoot.__option === 'Some' ? toHex(config.allowlistRoot.value as Uint8Array) : null;
    const sas = config.sas.__option === 'Some' ? config.sas.value : null;
    const routes: { kind: 'allowlist' | 'attestation' | 'authority'; detail: string }[] = [];
    if (root) routes.push({ kind: 'allowlist', detail: 'Merkle proof against the allowlist root (claim_pass_merkle)' });
    if (sas) routes.push({ kind: 'attestation', detail: 'a live SAS attestation under the credential and schema (claim_pass)' });
    routes.push({ kind: 'authority', detail: 'a pass granted by the gate authority (grant_pass)' });
    return {
      mint,
      config: address,
      authority: config.authority,
      mode: config.mode === Mode.Allowlist ? 'Allowlist' : 'Open',
      allowlistRoot: root,
      sas: sas ? { credential: sas.credential, schema: sas.schema } : null,
      routes,
    };
  };

  // ---- presets
  //   `presets`: the three ways a gate admits a wallet (no jurisdiction rule in them).
  //   `jurisdictionPresets`: rule templates for the offering types the specification names (ADR-0903), as the rules a gate takes (`set_rules`), with the plain-language notes and
  //   primary sources next to each. `?restricted=KP,IR` is the list of countries counsel has told the issuer to exclude (the templates apply it as a deny list, or remove it from an allow list);
  //   `?quoteUnit=` is the atoms of one whole quote unit, to express caps (default 1000000). Templates, not legal advice: every one says `requiresCounsel`.
  app.get('/v1/gates/presets', async (req, reply) => {
    const q = req.query as { restricted?: string; quoteUnit?: string };
    const restricted = (q.restricted ?? '').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
    for (const c of restricted) if (!/^[A-Z]{2}$/.test(c)) throw new RequestError(400, `restricted must be a comma separated list of ISO 3166-1 alpha-2 codes; ${JSON.stringify(c)} is not one`);
    if (q.quoteUnit !== undefined && !/^[1-9][0-9]{0,18}$/.test(q.quoteUnit)) throw new RequestError(400, 'quoteUnit must be a positive integer (atoms of one whole quote unit)');
    const params = { restrictedCountries: restricted, ...(q.quoteUnit !== undefined && { quoteUnit: BigInt(q.quoteUnit) }) };
    return send(reply, {
      presets: GATE_PRESETS satisfies readonly GatePreset[],
      note: '`presets` carry no jurisdiction rules. `jurisdictionPresets` are templates for counsel to approve for the actual offering, never legal clearance.',
      jurisdictionPresets: PRESET_IDS.map((id) => jurisdictionPreset(id, params)),
      restrictedCountries: restricted,
    });
  });

  // ---- discovery: gates found on recent crosses. A cross's gate mint never changes, so each cross is read once.
  const gateOfCross = new Map<string, Address | null>();
  app.get('/v1/gates', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = q.limit === undefined ? 60 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RequestError(400, 'limit must be an integer in [1, 200]');
    const { rows } = await d.db.query<{ address: string }>('SELECT address FROM crosses ORDER BY created_slot DESC LIMIT $1', [limit]);
    const unseen = rows.map((r) => r.address as Address).filter((a) => !gateOfCross.has(a));
    for (let i = 0; i < unseen.length; i += 4) {
      await Promise.all(
        unseen.slice(i, i + 4).map(async (a) => {
          const acct = await d.account(a);
          if (!acct || acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !(CROSS_DISCRIMINATOR as Uint8Array).every((b, j) => acct.data[j] === b)) return;
          const c = getCrossDecoder().decode(acct.data);
          gateOfCross.set(a, c.gateMint.__option === 'Some' ? c.gateMint.value : null);
        }),
      );
    }
    const byMint = new Map<Address, Address[]>();
    for (const r of rows) {
      const g = gateOfCross.get(r.address);
      if (g) byMint.set(g, [...(byMint.get(g) ?? []), r.address as Address]);
    }
    const gates = [];
    for (const [mint, crosses] of byMint) {
      const cfg = await readConfig(mint);
      gates.push(cfg ? { ...describeConfig(mint, cfg), crosses } : { mint, config: null, crosses, error: 'The gate config for this mint is not on chain.' });
    }
    return send(reply, { scannedCrosses: rows.length, gates });
  });

  app.get('/v1/gates/:mint', async (req, reply) => {
    const mint = addr((req.params as { mint: string }).mint, 'mint');
    const wallet = (req.query as { wallet?: string }).wallet;
    const cfg = await readConfig(mint);
    if (!cfg) throw new RequestError(404, `no cross_gate config for mint ${mint} on chain`);
    return send(reply, { ...describeConfig(mint, cfg), ...(wallet !== undefined && { wallet: addr(wallet, 'wallet'), standing: await standing(mint, wallet as Address, cfg) }) });
  });

  // ---- allowlist: preview the root, publish the list
  const BIG = { bodyLimit: 4 * 1024 * 1024 };
  const MAX_LIST = 50_000;
  function parseList(b: Record<string, unknown>) {
    const raw = b.addresses;
    if (typeof raw !== 'string' && !(Array.isArray(raw) && raw.every((x) => typeof x === 'string'))) throw new RequestError(400, 'addresses must be a string or an array of strings');
    const parsed = parseAllowlist(raw as string | string[]);
    if (parsed.addresses.length > MAX_LIST) throw new RequestError(400, `an allowlist may hold at most ${MAX_LIST} addresses`);
    return parsed;
  }
  app.post('/v1/gates/allowlist-root', BIG, async (req, reply) => {
    const b = obj(req.body);
    const mint = addr(b.mint, 'mint');
    const parsed = parseList(b);
    if (parsed.addresses.length === 0) throw new RequestError(400, 'the list holds no valid address', { invalid: parsed.invalid.slice(0, 20) });
    const tree = buildAllowlist(mint, parsed.addresses);
    return send(reply, { mint, root: tree.rootHex, count: tree.count, duplicates: parsed.duplicates.length, invalid: parsed.invalid.slice(0, 20), invalidCount: parsed.invalid.length });
  });

  app.post('/v1/gates/:mint/allowlist', BIG, async (req, reply) => {
    const mint = addr((req.params as { mint: string }).mint, 'mint');
    const parsed = parseList(obj(req.body));
    if (parsed.invalid.length > 0) throw new RequestError(400, `${parsed.invalid.length} entries are not Solana addresses; nothing was published`, { invalid: parsed.invalid.slice(0, 20) });
    if (parsed.addresses.length === 0) throw new RequestError(400, 'the list holds no address');
    const cfg = await readConfig(mint);
    if (!cfg) throw new RequestError(404, `no cross_gate config for mint ${mint} on chain`);
    if (cfg.config.allowlistRoot.__option !== 'Some') throw new RequestError(409, 'this gate has no allowlist root on chain; set it with set_allowlist_root first');
    const tree = buildAllowlist(mint, parsed.addresses);
    const chainRoot = toHex(cfg.config.allowlistRoot.value as Uint8Array);
    if (tree.rootHex !== chainRoot) throw new RequestError(409, 'this list does not hash to the allowlist root on chain, so it was not published', { listRoot: tree.rootHex, chainRoot });
    await store.put(mint, tree.rootHex, parsed.addresses);
    return send(reply, { mint, root: tree.rootHex, count: tree.count, published: true });
  });

  // ---- eligibility for a cross
  app.get('/v1/eligibility/:cross/:wallet', async (req, reply) => {
    const p = req.params as { cross: string; wallet: string };
    const crossAddress = addr(p.cross, 'cross');
    const wallet = addr(p.wallet, 'wallet');
    const acct = await d.account(crossAddress);
    if (!acct) throw new RequestError(404, `cross ${crossAddress} not found on chain`);
    if (acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !(CROSS_DISCRIMINATOR as Uint8Array).every((b, i) => acct.data[i] === b)) throw new RequestError(404, `${crossAddress} is not an Opening Cross account`);
    const cross = getCrossDecoder().decode(acct.data);
    const state = ['Live', 'Cleared', 'NoPrint', 'Finalized'][cross.state] as string;
    const base = { cross: crossAddress, wallet, crossState: state, acceptingOrders: cross.state === CrossState.Live };
    if (cross.gateMint.__option !== 'Some') {
      return send(reply, { ...base, gated: false, gateMint: null, eligible: true, canClaim: false, reasons: [{ code: 'CROSS_HAS_NO_GATE', rule: 'the cross was created without a gate mint', message: 'This cross has no gate: any wallet may place an order.', fix: null } satisfies Reason] });
    }
    const mint = cross.gateMint.value;
    const cfg = await readConfig(mint);
    if (!cfg) {
      return send(reply, {
        ...base,
        gated: true,
        gateMint: mint,
        eligible: false,
        canClaim: false,
        reasons: [{ code: 'GATE_CONFIG_MISSING', rule: 'cross_core reads passes issued by the cross_gate program for the gate mint', message: `The cross names gate mint ${mint}, but no cross_gate config exists for it, so no pass can be issued.`, fix: null } satisfies Reason],
      });
    }
    const s = await standing(mint, wallet, cfg);
    return send(reply, { ...base, gated: true, gateMint: mint, eligible: s.hasPass, canClaim: s.claim !== null, pass: s.pass, claim: s.claim, allowlist: s.allowlist, sas: s.sas, reasons: s.reasons });
  });

  // ---- claim a pass
  app.post('/v1/tx/claim-pass', async (req, reply) => {
    const b = obj(req.body);
    const mint = addr(b.mint, 'mint');
    const owner = addr(b.owner, 'owner');
    const payer = b.payer === undefined || b.payer === null ? owner : addr(b.payer, 'payer');
    const route = b.route;
    if (route !== undefined && route !== 'allowlist' && route !== 'attestation') throw new RequestError(400, 'route must be "allowlist" or "attestation"');
    const cfg = await readConfig(mint);
    if (!cfg) throw new RequestError(404, `no cross_gate config for mint ${mint} on chain`);
    const s = await standing(mint, owner, cfg);
    if (s.hasPass) throw new RequestError(409, 'this wallet already holds a pass for the gate', { reasons: s.reasons });
    const chosen = route ?? s.claim?.route;
    const canClaim = s.claim !== null && (route === undefined || route === s.claim.route || (route === 'attestation' && s.sas.state === 'live') || (route === 'allowlist' && s.allowlist.listed === true));
    if (!chosen || !canClaim) throw new RequestError(422, 'this wallet cannot claim a pass for the gate right now', { reasons: s.reasons });

    const lt = await d.lifetime();
    const config = cfg.address;
    const payerSigner = createNoopSigner(payer);
    if (chosen === 'allowlist') {
      const chainRoot = cfg.config.allowlistRoot.__option === 'Some' ? (cfg.config.allowlistRoot.value as Uint8Array) : null;
      const tree = await publishedList(mint, chainRoot);
      const proof = tree?.proofFor(owner);
      if (!tree || !proof || !chainRoot || !verifyAllowlistProof(proof, chainRoot, allowlistLeaf(mint, owner))) throw new RequestError(422, 'no valid allowlist proof for this wallet', { reasons: s.reasons });
      const ix = getClaimPassMerkleInstruction({ payer: payerSigner, owner, config, pass: s.pass, proof });
      return send(reply, { ...compile(payer, [ix], lt), route: 'allowlist', pass: s.pass, proofLength: proof.length });
    }
    if (!s.sas.attestation) throw new RequestError(422, 'this gate takes no attestations', { reasons: s.reasons });
    const ix = getClaimPassInstruction({ payer: payerSigner, owner, config, attestation: s.sas.attestation, pass: s.pass });
    return send(reply, { ...compile(payer, [ix], lt), route: 'attestation', pass: s.pass, attestation: s.sas.attestation });
  });

  return { readConfig, standing, attestationAddress };
}
