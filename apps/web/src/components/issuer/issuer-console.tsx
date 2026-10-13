'use client';

import { type Autofill, type ListingType, type Suggestion, type TokenFacts, autofillFromToken, launchPreset, listingType, rankQuoteMints } from '@opening-cross/presets/launch';
import { isAddress } from '@solana/kit';
import type { UiWalletAccount } from '@wallet-standard/ui';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSigner } from '@/components/cross/use-signer';
import { ActionButton } from '@/components/cross/action-button';
import { GateField } from '@/components/gate/gate-field';
import { AutofillPanel } from '@/components/issue-wizard/autofill-panel';
import { Concierge } from '@/components/issue-wizard/concierge';
import { DemandSource } from '@/components/issue-wizard/demand-source';
import { FeesPanel } from '@/components/issue-wizard/fees-panel';
import { Fieldset, Num, Select, SmallButton, Text } from '@/components/issue-wizard/fields';
import { GuardsPanel } from '@/components/issue-wizard/guards-panel';
import { RulesPanel } from '@/components/issue-wizard/rules-panel';
import { useRulesVerdict } from '@/components/issue-wizard/use-rules-verdict';
import { IssuerAction } from '@/components/issuer/issuer-action';
import { ListingPicker } from '@/components/issue-wizard/listing-picker';
import { Readiness } from '@/components/issue-wizard/readiness';
import { SimulatorPanel } from '@/components/issue-wizard/simulator-panel';
import { API_URL } from '@/lib/api';
import { EMPTY_GATE, type GateFieldValue, type GateSummary } from '@/lib/gate-field';
import { type ConciergeState, concierge } from '@/lib/issuer-concierge';
import { type FeeSchedule, crossSummary, protocolFees } from '@/lib/issuer-data';
import { type Draft, clearDraft, loadDraft, newDraft, saveDraft } from '@/lib/issuer-draft';
import { checkOracle } from '@/lib/issuer-guards';
import { parseReferral } from '@/lib/issuer-growth';
import { checkIssuerForm } from '@/lib/issuer';
import { readFacts, readMintFull } from '@/lib/issuer-chain';
import { applyPreset } from '@/lib/issuer-presets';
import { useRelease } from '@/lib/issuer-programs';
import { buildRules, bidderView, rulesBodyPart, sizeStatement } from '@/lib/issuer-rules';
import { type ChainFacts, type Check, type MintRead, TOKEN_2022, SPL_TOKEN, creationCost, dustBond, evaluateReadiness, ready as allReady, sol } from '@/lib/issuer-readiness';
import { derive, okMint, ruleChecks, type Row } from '@/lib/issuer-wizard';
import type { AuthenticityVerdict, VerdictClass } from '@/lib/trust-types';
import { formatAtoms, shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';

type Identity = { verdict: VerdictClass; message: string | null };

/** Who issued this mint, from the API's identity check; null where the registry does not apply (not mainnet) or the API is down. */
async function readIdentity(mint: string): Promise<Identity | null> {
  try {
    const res = await fetch(`${API_URL}/v1/tokens/${mint}/authenticity`, { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as { comparable: boolean; verdict?: AuthenticityVerdict };
    return body.comparable && body.verdict ? { verdict: body.verdict.verdict, message: body.verdict.reasons[0]?.message ?? null } : null;
  } catch {
    return null;
  }
}

const IDENTITY_LABEL: Record<VerdictClass, string> = {
  GENUINE: "Matches the issuer's list and keys",
  FAMILY_UNLISTED: "Held by an issuer's keys, not yet on its list",
  IMPERSONATOR: 'Copies a genuine token and is not it',
  ADDRESS_LOOKALIKE: 'Address made to look like a genuine token',
  UNVERIFIED_STOCK_TOKEN: 'Tokenized stock from an issuer we cannot verify',
  UNRELATED_TOKEN: 'Not a covered issuer token',
  NOT_A_MINT: 'Not a token mint',
  UNKNOWN: 'Could not be confirmed',
};

const OPENED_KEY = 'opening-bell:issuer-draft-opened:v1';

function tokenFacts(m: Extract<MintRead, { ok: true }>): TokenFacts {
  return {
    decimals: m.decimals,
    program: m.program === TOKEN_2022 ? 'token-2022' : m.program === SPL_TOKEN ? 'token' : 'other',
    supply: m.supply ?? 0n,
    mintAuthority: m.mintAuthority,
    freezeAuthority: m.freezeAuthority,
    extensions: m.extensions,
    metadata: m.metadata ?? null,
  };
}

export function IssuerConsole() {
  const { account } = useWallet();
  return <Wizard account={account} />;
}

function Wizard({ account }: { account: UiWalletAccount | null }) {
  const [d, setD] = useState<Draft>(() => newDraft(new Date()));
  const [crossId] = useState(() => String(Math.floor(Date.now() / 1000)));
  const [loaded, setLoaded] = useState(false);
  const [restored, setRestored] = useState(false);
  const [openedAt, setOpenedAt] = useState(() => Date.now());
  const [rev, setRev] = useState(0);
  const [presetId, setPresetId] = useState<string | null>(null);
  const [presetNote, setPresetNote] = useState<string | null>(null);
  const [mints, setMints] = useState<{ base?: MintRead; quote?: MintRead }>({});
  const [identity, setIdentity] = useState<{ base?: Identity | null; quote?: Identity | null }>({});
  const [gate, setGate] = useState<GateFieldValue>(EMPTY_GATE);
  const [gateSummary, setGateSummary] = useState<GateSummary | null>(null);
  const [facts, setFacts] = useState<ChainFacts | null>(null);
  const [reading, setReading] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [fees, setFees] = useState<FeeSchedule | null>(null);
  const [quoteChoices, setQuoteChoices] = useState<{ mint: string; crosses: number }[]>([]);
  const [demandRows, setDemandRows] = useState<Row[]>([{ price: '', quantity: '' }]);
  const [escrowRows, setEscrowRows] = useState<Row[]>([{ price: '', quantity: '' }]);
  const [referral, setReferral] = useState(false);
  const [saved, setSaved] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  // A create is several transactions; if the later ones fail, the cross exists on chain without all its shards and must be finished.
  const [unfinished, setUnfinished] = useState<{ cross: string; landed: number; total: number; resume: Record<string, unknown> | null } | null>(null);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const bump = () => setRev((r) => r + 1);

  // ---- a saved draft, a referral link, a preset named in the address
  useEffect(() => {
    const restoredDraft = loadDraft(newDraft(new Date()));
    if (restoredDraft) {
      setD(restoredDraft);
      setRestored(true);
      setPresetId(restoredDraft.listingType ? (listingType(restoredDraft.listingType)?.presetId ?? null) : null);
      bump();
    }
    try {
      const t = localStorage.getItem(OPENED_KEY);
      if (restoredDraft && t && Number.isFinite(Number(t))) setOpenedAt(Number(t));
      else localStorage.setItem(OPENED_KEY, String(Date.now()));
    } catch {
      // No storage: the draft lives in this tab only.
    }
    const q = new URLSearchParams(window.location.search);
    const ref = parseReferral(window.location.search);
    if (ref) {
      setD((x) => ({ ...x, integrator: ref.wallet, integratorFeeBps: ref.feeBps }));
      setReferral(true);
      bump();
    }
    const type = q.get('type');
    const lt = type ? listingType(type) : undefined;
    if (lt) setD((x) => ({ ...x, listingType: lt.id }));
    setLoaded(true);
  }, []);

  // Save as the person types, after a short pause. Nothing leaves this browser.
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => setSaved(saveDraft(d)), 500);
    return () => clearTimeout(t);
  }, [d, loaded]);

  // ---- data from the API
  useEffect(() => {
    let live = true;
    void protocolFees().then((f) => live && setFees(f));
    void crossSummary(500).then((r) => live && r.ok && setQuoteChoices(rankQuoteMints(r.data.crosses.map((c) => c.quoteMint)).slice(0, 3)));
    return () => {
      live = false;
    };
  }, []);

  // Chain time moves on while the form is open; re-judge the window every 10 seconds.
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  // ---- the two tokens
  const baseOk = okMint(mints.base);
  const quoteOk = okMint(mints.quote);
  const v = useMemo(() => derive(d, mints.base, mints.quote), [d, mints.base, mints.quote]);
  const autofill: Autofill | null = useMemo(() => (baseOk ? autofillFromToken(tokenFacts(baseOk), account?.address ?? null) : null), [baseOk, account?.address]);

  const readBase = async () => {
    const address = d.baseMint.trim();
    setMints((m) => ({ ...m, base: undefined }));
    setIdentity((i) => ({ ...i, base: null }));
    const base = await readMintFull(address);
    setMints((m) => ({ ...m, base }));
    const id = await readIdentity(address);
    setIdentity((i) => ({ ...i, base: id }));
  };
  const readQuote = async () => {
    const address = d.quoteMint.trim();
    setMints((m) => ({ ...m, quote: undefined }));
    setIdentity((i) => ({ ...i, quote: null }));
    const quote = await readMintFull(address);
    setMints((m) => ({ ...m, quote }));
    const id = await readIdentity(address);
    setIdentity((i) => ({ ...i, quote: id }));
  };

  const refresh = useCallback(async () => {
    if (!account || !mints.base || !mints.quote) return;
    setReading(true);
    try {
      setFacts(await readFacts({ wallet: account.address, baseMint: d.baseMint.trim(), quoteMint: d.quoteMint.trim(), mints: { base: mints.base, quote: mints.quote } }));
    } finally {
      setReading(false);
    }
  }, [account, d.baseMint, d.quoteMint, mints.base, mints.quote]);

  // Read the wallet's side of the chain whenever a wallet is connected and both mints have just been checked.
  const mintsReady = Boolean(baseOk && quoteOk);
  useEffect(() => {
    if (!mintsReady || !account) {
      setFacts(null);
      return;
    }
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tied to the mint checks and the wallet, not to every keystroke in other fields
  }, [mints.base, mints.quote, account?.address]);

  // ---- the form, judged
  const minMatchedText = v.typedMinMatched === null ? d.minMatched : v.effectiveMinMatched === 0n || v.effectiveMinMatched === null || v.baseDecimals === null ? d.minMatched : formatAtoms(v.effectiveMinMatched, v.baseDecimals).replace(/,/g, '');
  const walletAddress = account?.address ?? '';
  const integrator = d.integrator.trim() || walletAddress;
  const checked =
    baseOk && quoteOk
      ? checkIssuerForm(
          {
            creator: walletAddress,
            baseMint: d.baseMint.trim(),
            quoteMint: d.quoteMint.trim(),
            baseDecimals: baseOk.decimals,
            quoteDecimals: quoteOk.decimals,
            baseTokenProgram: baseOk.program,
            quoteTokenProgram: quoteOk.program,
            disclosure: d.disclosure,
            supplyMode: d.supplyMode,
            kind: d.kind,
            minPrice: d.minPrice,
            tick: d.tick,
            ticks: d.ticks,
            openAt: new Date(d.openAt),
            closeAt: new Date(d.closeAt),
            revealMinutes: d.revealMinutes,
            minMatched: minMatchedText,
            maxImbalancePct: d.maxImbalancePct,
            integrator,
            integratorFeeBps: d.integratorFeeBps,
            maxOrders: d.maxOrders,
            shards: d.shards,
            proceedsTo: walletAddress,
            schedule: d.supplyMode === 'mint' ? d.schedule : [],
            crossId,
          },
          new Date(),
        )
      : null;
  const oracle = checkOracle(d.oracle);
  const extra: Record<string, string> = {};
  if (d.integrator.trim() && !isAddress(d.integrator.trim())) extra.integrator = 'This is not a Solana address.';
  if (d.minFloatPct.trim() !== '' && v.floatBps === null) extra.minFloatPct = 'Enter a percentage above 0 and up to 100 with at most two decimals.';
  if (d.maxFdv.trim() !== '' && v.fdvCap === null && v.quoteDecimals !== null) extra.maxFdv = `Enter an amount with at most ${v.quoteDecimals} decimal places.`;
  if (!oracle.ok) for (const [k, m] of Object.entries(oracle.errors)) extra[`oracle.${k}`] = m;
  const errors: Record<string, string | undefined> = { ...(checked && !checked.ok ? checked.errors : {}), ...extra };

  // ---- the rules step: read the form, ask the API what it thinks, measure the creation
  const crossCoreRelease = useRelease('crossCore');
  const rulesBuild = useMemo(() => buildRules(d.rules, { baseDecimals: v.baseDecimals, quoteDecimals: v.quoteDecimals, market: v.market }), [d.rules, v.baseDecimals, v.quoteDecimals, v.market]);
  const rulesLocalErrors = Object.keys(rulesBuild.errors).length > 0;
  const bodyBase = (): Record<string, unknown> => (checked?.ok ? { ...checked.body, ...(oracle.ok && oracle.body ? { oracle: oracle.body } : {}), ...(gateSummary?.gateMint ? { gateMint: gateSummary.gateMint } : {}) } : {});
  // Checking rules needs no wallet: the creator and the payout address do not change a rule's verdict, so the quote mint stands in for them until one is connected.
  const checkBody = rulesBuild.active && checked?.ok && !rulesLocalErrors && !Object.keys(extra).length && isAddress(d.quoteMint.trim()) ? { ...bodyBase(), creator: walletAddress || d.quoteMint.trim(), proceedsTo: walletAddress || d.quoteMint.trim(), integrator: integrator || d.quoteMint.trim(), ...rulesBodyPart(rulesBuild) } : null;
  const sizeBody = checkBody && account ? { ...checkBody, creator: walletAddress, proceedsTo: walletAddress, integrator: integrator || walletAddress } : null;
  const verdict = useRulesVerdict(checkBody, sizeBody);
  const rulesView = useMemo(() => bidderView(rulesBuild.json, { baseDecimals: v.baseDecimals, quoteDecimals: v.quoteDecimals, openMs: new Date(d.openAt).getTime() || null, closeMs: new Date(d.closeAt).getTime() || null }), [rulesBuild.json, v.baseDecimals, v.quoteDecimals, d.openAt, d.closeAt]);

  const rules = ruleChecks(d, v);
  const chainChecks = account
    ? evaluateReadiness({ wallet: account.address, supplyMode: d.supplyMode, baseMint: d.baseMint.trim(), quoteMint: d.quoteMint.trim(), shards: d.shards, openAt: new Date(d.openAt), closeAt: new Date(d.closeAt), form: checked }, facts, nowMs)
    : [{ id: 'wallet', label: 'Wallet', status: 'wait' as const, detail: 'Connect a wallet to check its authority over the token, its SOL for rent and fees, and its quote token balance.' }];
  const ruleChecks2: Check[] = [];
  if (rulesBuild.active) {
    const refused = verdict.check.state === 'done' && verdict.check.result.ok ? verdict.check.result.issues : [];
    ruleChecks2.push(
      rulesLocalErrors
        ? { id: 'rules-valid', label: 'Rules', status: 'fail', detail: `${Object.keys(rulesBuild.errors).length === 1 ? 'A rule field cannot' : 'Rule fields cannot'} be read yet: ${Object.values(rulesBuild.errors)[0]}` }
        : !checkBody
          ? { id: 'rules-valid', label: 'Rules', status: 'wait', detail: 'The rules are checked once both tokens are read and the grid, the window and the other fields are valid.' }
          : verdict.check.state !== 'done'
            ? { id: 'rules-valid', label: 'Rules', status: 'wait', detail: 'Checking the rules…' }
            : !verdict.check.result.ok
              ? { id: 'rules-valid', label: 'Rules', status: 'fail', detail: verdict.check.result.error }
              : refused.length > 0
                ? { id: 'rules-valid', label: 'Rules', status: 'fail', detail: `${refused.length === 1 ? 'The program would refuse this rule' : `The program would refuse ${refused.length} rules`}: ${refused[0]!.message}` }
                : { id: 'rules-valid', label: 'Rules', status: 'pass', detail: 'Every check the program makes on the rules themselves passes.' },
    );
    const sz = verdict.size.state === 'done' ? verdict.size.result : null;
    ruleChecks2.push(
      !account
        ? { id: 'rules-size', label: 'Rules fit the transaction', status: 'wait', detail: 'Connect a wallet to measure the creation transaction exactly.' }
        : sz === null
          ? { id: 'rules-size', label: 'Rules fit the transaction', status: 'wait', detail: 'Measured once the rules are accepted.' }
          : sz.ok
            ? { id: 'rules-size', label: 'Rules fit the transaction', status: 'pass', detail: sizeStatement(sz).text }
            : { id: 'rules-size', label: 'Rules fit the transaction', status: 'fail', detail: sz.error },
    );
    ruleChecks2.push(
      crossCoreRelease.loading
        ? { id: 'rules-program', label: 'The network can create a cross with rules', status: 'wait', detail: 'Asking which release of cross_core this network runs…' }
        : crossCoreRelease.release === 'extended'
          ? { id: 'rules-program', label: 'The network can create a cross with rules', status: 'pass', detail: 'The deployed cross_core has the rules extension.' }
          : crossCoreRelease.release === 'first-release'
            ? { id: 'rules-program', label: 'The network can create a cross with rules', status: 'fail', detail: 'The cross_core deployed here is the first release, which has no rules: it would refuse this creation. Rules are proved on LiteSVM and a local validator and go live when the upgrade is funded (H27). Clear the rules to create a plain cross now.' }
            : { id: 'rules-program', label: 'The network can create a cross with rules', status: 'warn', detail: 'Which release of cross_core this network runs could not be read. The creation is simulated on the cluster before your wallet is asked, and nothing is signed if the program refuses it.' },
    );
  }
  const checks = [...chainChecks, ...rules, ...ruleChecks2];
  const gateReady = !gateSummary || gateSummary.complete;
  const type = d.listingType ? listingType(d.listingType) : undefined;
  const typeBlocked = type?.availability === 'needs-partner';
  const extraErrors = Object.keys(extra).length > 0;
  const canCreate = Boolean(account && checked?.ok && !extraErrors && allReady(checks) && gateReady && !typeBlocked && (autofill?.blockers.length ?? 0) === 0);
  const cost = facts?.rent ? creationCost(facts.rent, d.shards, facts.quoteAccount?.exists ?? false) : null;
  const bond = checked?.ok ? dustBond(checked.body) : null;

  const body = (): Record<string, unknown> => ({ ...bodyBase(), ...rulesBodyPart(rulesBuild) });

  // ---- applying a type, a format, a suggestion
  const applyFormat = (id: string) => {
    const p = launchPreset(id);
    if (!p) return;
    const applied = applyPreset(p, { minPrice: d.minPrice, tick: d.tick, quoteDecimals: v.quoteDecimals }, new Date());
    setD((x) => ({ ...x, ...applied.fields }));
    setPresetId(id);
    setPresetNote(applied.stepKept ? 'The step between prices was left as it is, because the format’s step does not land exactly on your lowest price.' : 'The step between prices is now a share of your lowest price.');
    bump();
  };
  const pickListing = (t: ListingType) => {
    set('listingType', t.id);
    if (t.availability === 'available' && t.presetId) applyFormat(t.presetId);
  };
  // Suggestions fill what is still open and never overwrite a choice already made: a format or listing type the issuer picked stays.
  const applySuggestions = (list: Suggestion[]) => {
    const mode = list.find((s) => s.field === 'supplyMode');
    const lt = list.find((s) => s.field === 'listingType');
    const preset = list.find((s) => s.field === 'presetId');
    if (lt && !d.listingType && listingType(lt.value)) set('listingType', listingType(lt.value)!.id);
    if (preset && !presetId) applyFormat(preset.value);
    // A format sets the supply mode too; the token's own supply mode wins.
    if (mode) setD((x) => ({ ...x, supplyMode: mode.value as Draft['supplyMode'] }));
  };
  const suggestionName = (s: Suggestion) => (s.field === 'presetId' ? (launchPreset(s.value)?.name ?? s.value) : s.field === 'listingType' ? (listingType(s.value)?.name ?? s.value) : s.value);
  const discard = () => {
    clearDraft();
    try {
      localStorage.removeItem(OPENED_KEY);
    } catch {
      // Nothing was stored.
    }
    setD(newDraft(new Date()));
    setMints({});
    setIdentity({});
    setFacts(null);
    setPresetId(null);
    setPresetNote(null);
    setDemandRows([{ price: '', quantity: '' }]);
    setEscrowRows([{ price: '', quantity: '' }]);
    setRestored(false);
    setOpenedAt(Date.now());
    bump();
  };

  // ---- the checklist
  const conciergeState: ConciergeState = {
    listingType: d.listingType,
    typeNeedsPartner: typeBlocked,
    baseMint: { entered: d.baseMint.trim() !== '', read: mints.base ? (mints.base.ok ? 'ok' : 'failed') : 'none', blockers: autofill?.blockers.length ?? 0 },
    quoteMint: { entered: d.quoteMint.trim() !== '', read: mints.quote ? (mints.quote.ok ? 'ok' : 'failed') : 'none' },
    errors: Object.fromEntries(Object.entries(errors).filter((e): e is [string, string] => e[1] !== undefined)),
    gridFilled: d.minPrice.trim() !== '' && d.tick.trim() !== '' && (d.supplyMode === 'escrow' || d.schedule.every((s) => s.price.trim() !== '' && s.quantity.trim() !== '')),
    minMatchedSet: (v.effectiveMinMatched ?? 0n) > 0n,
    guardsBlocked: rules.some((c) => c.status === 'fail'),
    // Without a wallet the creation cannot be measured, so the step is judged on the rules themselves; with one it needs the size and the network too.
    rules: !rulesBuild.active ? 'off' : ruleChecks2.some((c) => c.status === 'fail') ? 'invalid' : ruleChecks2.filter((c) => (account ? true : c.id === 'rules-valid')).every((c) => c.status === 'pass' || (c.id === 'rules-program' && c.status === 'warn')) ? 'valid' : 'pending',
    demandEntered: demandRows.some((r) => r.quantity.trim() !== '' && r.price.trim() !== ''),
    gate: gate.preset === 'open' ? 'none' : gateSummary?.complete ? 'complete' : 'incomplete',
    walletConnected: Boolean(account),
    readiness: !account || !facts ? 'unknown' : allReady(chainChecks) ? 'ready' : 'failing',
    treasury: (presetId ? launchPreset(presetId)?.modules.treasury : undefined) ?? 'not-applicable',
  };
  const steps = concierge(conciergeState);

  if (created) {
    return (
      <div className="mt-8 space-y-4">
        <div role="status" className="rounded-[var(--radius-card)] border border-border p-6">
          <p className="font-medium">Your cross is on chain.</p>
          <p className="mt-1 break-all font-mono text-xs text-muted" data-testid="created-cross">
            {created}
          </p>
          <Link href={`/crosses/${created}`} className="mt-4 inline-flex min-h-11 items-center rounded-full bg-accent-fill px-5 py-2.5 text-sm font-medium text-on-accent">
            Open the cross page
          </Link>
        </div>
        <div id="after" className="rounded-[var(--radius-card)] border border-border p-6 text-sm">
          <p className="font-medium">What comes next</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
            <li>
              Watch it and answer questions from your <Link className="underline underline-offset-4" href="/issuer">issuer overview</Link>.
            </li>
            {conciergeState.treasury !== 'not-applicable' ? (
              <li>
                When the cross has finalized and the coin&apos;s supply is fixed, set up its <Link className="underline underline-offset-4" href={`/issuer/treasury/new${d.baseMint.trim() ? `?coin=${d.baseMint.trim()}` : ''}`}>treasury</Link>.
              </li>
            ) : null}
            <li>
              Nothing about the cross can be changed now. The price grid, window, supply and guards are fixed on chain.
            </li>
          </ul>
          <div className="mt-4">
            <SmallButton
              onClick={() => {
                discard();
                setCreated(null);
              }}
            >
              Start a new draft
            </SmallButton>
          </div>
        </div>
      </div>
    );
  }

  if (unfinished && account) {
    return <Unfinished cross={unfinished.cross} landed={unfinished.landed} total={unfinished.total} resume={unfinished.resume} account={account} onDone={() => { setCreated(unfinished.cross); setUnfinished(null); }} />;
  }

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="lg:col-start-2 lg:row-start-1">
        <div className="lg:sticky lg:top-24">
          <Concierge steps={steps} openedMs={nowMs - openedAt} saved={saved} onDiscard={discard} />
        </div>
      </div>

      <form className="min-w-0 space-y-8 lg:col-start-1 lg:row-start-1" onSubmit={(e) => e.preventDefault()}>
        {!account ? (
          <p role="status" className="rounded-[var(--radius-card)] border border-border bg-surface p-5 text-sm" data-testid="explore-note">
            <span className="font-medium">You are exploring. </span>
            Everything on this page works without a wallet: choose a type, read your token, set the grid and the guards, and run the simulator. You connect a wallet only to create the cross. Creating a cross asks for no identity check; a gate you add decides who may bid and does not verify you, and what an offering needs is a question for your own counsel.
          </p>
        ) : null}
        {restored ? (
          <p role="status" className="rounded-[var(--radius-card)] border border-border p-4 text-sm text-muted" data-testid="restored-note">
            Your earlier draft was restored from this browser. It is stored only here.
          </p>
        ) : null}

        <ListingPicker value={d.listingType} onPick={pickListing} presetId={presetId} onPreset={applyFormat} presetNote={presetNote} />

        <Fieldset legend="Tokens" id="tokens">
          <MintField
            label="Token being sold (base mint)"
            value={d.baseMint}
            onChange={(val) => {
              set('baseMint', val);
              setMints((m) => ({ ...m, base: undefined }));
              setIdentity((i) => ({ ...i, base: undefined }));
            }}
            read={mints.base}
            identity={identity.base}
            onRead={() => void readBase()}
            testId="base"
          />
          {autofill && baseOk ? <AutofillPanel autofill={autofill} onApply={applySuggestions} names={suggestionName} /> : null}
          <MintField
            label="Paid in (quote mint)"
            value={d.quoteMint}
            onChange={(val) => {
              set('quoteMint', val);
              setMints((m) => ({ ...m, quote: undefined }));
              setIdentity((i) => ({ ...i, quote: undefined }));
            }}
            read={mints.quote}
            identity={identity.quote}
            onRead={() => void readQuote()}
            testId="quote"
          />
          {quoteChoices.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted" data-testid="quote-choices">
              <span>Quote tokens other crosses on this network use:</span>
              {quoteChoices.map((q) => (
                <button
                  key={q.mint}
                  type="button"
                  onClick={() => {
                    set('quoteMint', q.mint);
                    setMints((m) => ({ ...m, quote: undefined }));
                  }}
                  className="min-h-11 rounded-full border border-border-strong px-3 py-1.5 font-mono text-xs text-ink hover:bg-surface"
                  aria-label={`Use quote token ${q.mint}, used by ${q.crosses} crosses`}
                >
                  {shortAddress(q.mint)} · {q.crosses}
                </button>
              ))}
            </div>
          ) : null}
        </Fieldset>

        <Fieldset legend="Format">
          <Select label="Bids" value={d.disclosure} onChange={(val) => set('disclosure', val as Draft['disclosure'])} options={[['sealed', 'Sealed until reveal'], ['open', 'Open book']]} hint={d.disclosure === 'sealed' ? 'Only a commitment is on chain until the reveal window. A bid that is not revealed in time is excluded and refunded in full.' : 'Orders and their prices are public as they arrive.'} />
          <Select label="Supply" value={d.supplyMode} onChange={(val) => set('supplyMode', val as Draft['supplyMode'])} options={[['mint', 'Minted at settlement from a schedule'], ['escrow', 'Sell orders from escrow']]} hint={d.supplyMode === 'mint' ? 'The token is minted at settlement, only at the clearing price, and only for the schedule below.' : 'Sellers deposit tokens into escrow and place sell orders; supply is whatever is offered.'} />
          <Select label="Kind" value={d.kind} onChange={(val) => set('kind', val as Draft['kind'])} options={[['launch', 'Launch'], ['reopen', 'Reopen'], ['tender', 'Tender'], ['recurring', 'Recurring']]} hint="Names the use of the cross and selects its protocol fee tier. It does not change how the cross clears." />
        </Fieldset>

        <Fieldset legend="Price grid" id="grid">
          <Text label="Lowest price per token" value={d.minPrice} onChange={(val) => set('minPrice', val)} error={errors.minPrice} inputMode="decimal" />
          <Text label="Step between prices" value={d.tick} onChange={(val) => set('tick', val)} error={errors.tick} inputMode="decimal" />
          <Num key={`ticks-${rev}`} label="Number of price levels (2–256)" value={d.ticks} onChange={(val) => set('ticks', val)} error={errors.ticks} />
        </Fieldset>

        <Fieldset legend="Call window (your local time)" id="window">
          <Text label="Orders open" type="datetime-local" value={d.openAt} onChange={(val) => set('openAt', val)} error={errors.openAt} />
          <Text label="Orders close" type="datetime-local" value={d.closeAt} onChange={(val) => set('closeAt', val)} error={errors.closeAt} />
          {d.disclosure === 'sealed' ? <Num key={`reveal-${rev}`} label="Reveal window (minutes)" value={d.revealMinutes} onChange={(val) => set('revealMinutes', val)} error={errors.revealMinutes} /> : null}
        </Fieldset>

        {d.supplyMode === 'mint' ? (
          <Fieldset legend="Supply schedule" id="schedule">
            {d.schedule.map((s, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-3">
                <Text label={`Step ${i + 1}: price`} value={s.price} onChange={(val) => set('schedule', d.schedule.map((x, j) => (j === i ? { ...x, price: val } : x)))} error={errors[`schedule.${i}`]} inputMode="decimal" />
                <Text label="Tokens offered" value={s.quantity} onChange={(val) => set('schedule', d.schedule.map((x, j) => (j === i ? { ...x, quantity: val } : x)))} inputMode="decimal" />
                <button type="button" className="mb-1 min-h-11 min-w-11 px-1 py-1 text-sm text-muted underline" onClick={() => set('schedule', d.schedule.filter((_, j) => j !== i))} aria-label={`Remove step ${i + 1}`}>
                  Remove
                </button>
              </div>
            ))}
            <SmallButton onClick={() => set('schedule', [...d.schedule, { price: '', quantity: '' }])}>Add a step</SmallButton>
            {errors.schedule ? <p className="text-xs text-accent-text">{errors.schedule}</p> : null}
          </Fieldset>
        ) : null}

        <GuardsPanel
          draft={d}
          set={set}
          derived={v}
          rev={rev}
          errors={errors}
          onFit={(ticks) => {
            set('ticks', ticks);
            bump();
          }}
        />

        <RulesPanel
          form={d.rules}
          setForm={(f) => set('rules', f)}
          build={rulesBuild}
          check={verdict.check}
          size={verdict.size}
          view={rulesView}
          checkable={checkBody !== null}
          walletConnected={Boolean(account)}
          hasGate={Boolean(gateSummary?.gateMint)}
          oracleOn={d.oracle.enabled}
          supplyMode={d.supplyMode}
        />

        {d.supplyMode === 'mint' ? (
          <p className="text-sm text-muted">
            Minting crosses take over the token&apos;s mint authority in the same transaction, so only the cross can create supply, and only at the clearing price. Your wallet must hold that authority now.
          </p>
        ) : null}

        <FeesPanel draft={d} set={set} fees={fees} rev={rev} errors={errors} wallet={account?.address ?? null} referral={referral} />

        <SimulatorPanel
          draft={d}
          derived={v}
          fees={fees}
          demandRows={demandRows}
          setDemandRows={setDemandRows}
          escrowRows={escrowRows}
          setEscrowRows={setEscrowRows}
          sources={<DemandSource derived={v} onLoad={setDemandRows} />}
        />

        <div id="gate" className="scroll-mt-24">
          <GateField value={gate} onChange={setGate} onSummary={setGateSummary} />
        </div>

        <Readiness checks={checks} reading={reading} canRead={mintsReady} walletConnected={Boolean(account)} onRefresh={() => void refresh()} />

        <section id="create" className="scroll-mt-24 space-y-4" aria-label="Create the cross">
          <p className="text-sm text-muted" data-testid="create-cost">
            {cost && facts?.rent ? (
              <>
                Creating this cross costs about <strong className="font-medium text-ink">{sol(cost.total)}</strong>: {sol(cost.rent)} of rent for the cross, its book, its {d.shards} shards and two vaults (the cluster&apos;s own rent for the sizes of the newest cross on chain)
                {cost.ata > 0n ? `, ${sol(cost.ata)} for your quote token account` : ''}, and {sol(cost.fees)} in network fees.
                {bond !== null && quoteOk ? ` A bond of ${formatAtoms(bond, quoteOk.decimals)} quote is also taken from your quote token account and returned at settlement.` : ''}
              </>
            ) : (
              'The cost is worked out from the cluster’s rent once a wallet is connected and both mints are checked: it is mostly rent for the cross, its book and one account per shard, plus a small bond in the quote token.'
            )}{' '}
            If a setup transaction fails part way you can finish it from this page.
          </p>
          <div className="rounded-lg border border-border bg-surface p-4 text-sm" data-testid="limits">
            <p className="font-medium">Before you sign</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
              <li>You hold your own keys. This page builds the transactions; your wallet signs and sends them.</li>
              <li>The price grid, window, supply, guards and fees are fixed on chain once the cross exists. Nothing can be edited after the call opens.</li>
              <li>The bond comes back to your wallet when the cross is finalized, and so do the proceeds, minus the fees above.</li>
              <li>If the cross does not print, every bidder is refunded in full and, in a minting cross, nothing is created.</li>
            </ul>
          </div>
          {account ? <CreateAction account={account} body={body} ruled={rulesBuild.active} disabled={!canCreate} onDone={(c) => setCreated(c)} onPartial={(c, landed, total, opening) => setUnfinished({ cross: c, landed, total, resume: opening !== null && landed < opening ? body() : null })} /> : <DisabledCreate />}
          {typeBlocked ? (
            <p role="status" className="text-sm text-accent-text">
              {type?.name} cannot be created from this page yet, so Create stays off.
            </p>
          ) : null}
        </section>

        <section id="after" className="scroll-mt-24 rounded-[var(--radius-card)] border border-border p-5 text-sm">
          <h2 className="font-medium">After the cross</h2>
          <p className="mt-1 text-muted">
            Once a cross finalizes, its coin has a fixed supply and can have a treasury: a spend allowance held by a program, released only while an attestation you name is live. Holders then see when your next update is due. You set both up from the{' '}
            <Link href="/issuer" className="underline underline-offset-4">
              issuer overview
            </Link>
            .
          </p>
        </section>
      </form>
    </div>
  );
}

function DisabledCreate() {
  return (
    <button type="button" disabled className="w-full rounded-full bg-accent-fill px-5 py-3 text-sm font-medium text-on-accent opacity-50">
      Create the cross
    </button>
  );
}

function CreateAction({ account, body, ruled, disabled, onDone, onPartial }: { account: UiWalletAccount; body: () => Record<string, unknown>; ruled: boolean; disabled: boolean; onDone: (cross: string) => void; onPartial: (cross: string, landed: number, total: number, openingTransactions: number | null) => void }) {
  const sign = useSigner(account);
  if (ruled) {
    return (
      <IssuerAction
        label="Create the cross with its rules"
        path="/v1/tx/create-cross-ruled"
        needs="crossCore"
        what="Creating a cross with rules"
        body={body}
        sign={sign}
        disabled={disabled}
        testId="create-ruled"
        onDone={(_s, extra) => onDone(String(extra.cross))}
        onPartial={(extra, landed, total) => onPartial(String(extra.cross), landed, total, (extra.sizes as { firstTransactions?: number } | undefined)?.firstTransactions ?? null)}
      />
    );
  }
  return <ActionButton label="Create the cross" path="/v1/tx/create-cross" disabled={disabled} body={body} sign={sign} onDone={(_s, extra) => onDone(String(extra.cross))} onPartial={(extra, landed, total) => onPartial(String(extra.cross), landed, total, null)} />;
}

function Unfinished({ cross, landed, total, resume, account, onDone }: { cross: string; landed: number; total: number; resume: Record<string, unknown> | null; account: UiWalletAccount; onDone: () => void }) {
  const sign = useSigner(account);
  if (resume) {
    // The cross does not exist yet: its first transaction (your quote account, the handover of the mint authority) landed and the creation did not.
    // The same request builds the same transactions for the same cross number, so the ones that landed are skipped, not sent twice.
    return (
      <div role="alert" className="mt-8 rounded-[var(--radius-card)] border border-border p-6" data-testid="unfinished-creation">
        <p className="font-medium">The cross was not created: its opening stopped part way.</p>
        <p className="mt-1 text-sm text-muted">
          {landed} of {total} transactions landed, and the one that creates the cross with its rules did not. Nothing can trade. Sending the rest creates it; the transactions that already landed are not sent again. The cross will be <span className="break-all font-mono">{cross}</span>.
        </p>
        <div className="mt-4">
          <IssuerAction label="Create the cross with its rules" path="/v1/tx/create-cross-ruled" needs="crossCore" what="Creating a cross with rules" body={() => resume} sign={sign} skip={landed} testId="resume-creation" onDone={onDone} />
        </div>
      </div>
    );
  }
  return (
    <div role="alert" className="mt-8 rounded-[var(--radius-card)] border border-border p-6">
      <p className="font-medium">Your cross exists but its setup stopped part way.</p>
      <p className="mt-1 text-sm text-muted">
        {landed} of {total} setup transactions landed. Nothing is lost and nothing can trade yet; finishing it sends only the missing ones. The cross is <span className="break-all font-mono">{cross}</span>.
      </p>
      <div className="mt-4">
        <ActionButton label="Finish setting up the cross" path="/v1/tx/init-shards" body={() => ({ cross, payer: account.address })} sign={sign} onDone={onDone} />
      </div>
    </div>
  );
}

function MintField({ label, value, onChange, read, identity, onRead, testId }: { label: string; value: string; onChange: (v: string) => void; read: MintRead | undefined; identity?: Identity | null | undefined; onRead: () => void; testId: string }) {
  return (
    <div data-testid={`mint-${testId}`}>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Text label={label} value={value} onChange={onChange} onBlur={() => value.trim() && !read && onRead()} />
        </div>
        <button type="button" onClick={onRead} disabled={!value.trim()} className="mb-0.5 min-h-11 rounded-full border border-border-strong px-4 py-2.5 text-sm disabled:opacity-50">
          Check mint
        </button>
      </div>
      {read && !read.ok ? <p className="mt-1 text-xs text-accent-text">{read.reason}</p> : read ? <p className="mt-1 text-xs text-muted">{read.decimals} decimals</p> : null}
      {identity ? (
        <p className={`mt-1 text-xs ${identity.verdict === 'GENUINE' ? 'text-positive' : identity.verdict === 'IMPERSONATOR' || identity.verdict === 'ADDRESS_LOOKALIKE' ? 'text-accent-text' : 'text-muted'}`} data-testid="mint-identity">
          {IDENTITY_LABEL[identity.verdict]}
          {identity.verdict !== 'GENUINE' && identity.message ? `: ${identity.message}` : ''}
        </p>
      ) : null}
    </div>
  );
}
