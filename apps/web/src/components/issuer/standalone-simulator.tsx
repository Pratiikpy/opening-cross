'use client';

import { useEffect, useMemo, useState } from 'react';
import { DemandSource } from '@/components/issue-wizard/demand-source';
import { Fieldset, Num, Select, SmallButton, Text } from '@/components/issue-wizard/fields';
import { RowsEditor, SimulatorPanel } from '@/components/issue-wizard/simulator-panel';
import { type FeeSchedule, protocolFees } from '@/lib/issuer-data';
import { type Draft, loadDraft, newDraft } from '@/lib/issuer-draft';
import { readMintFull } from '@/lib/issuer-chain';
import type { MintRead } from '@/lib/issuer-readiness';
import { type Row, derive, parseRows } from '@/lib/issuer-wizard';
import { apiRead } from '@/lib/issuer-data';
import { type DemandMap, demandRows } from '@/lib/issuer-board';
import { parseAtoms } from '@/lib/units';

/**
 * The simulator on its own page: no tokens to read and no wallet. The person says how many decimals each token has and how many tokens
 * already exist, and everything else works as it does inside the wizard. A saved wizard draft can be loaded into it.
 */
export function StandaloneSimulator() {
  const [d, setD] = useState<Draft>(() => ({ ...newDraft(new Date()), schedule: [{ price: '', quantity: '' }], minMatched: '' }));
  const [baseDecimals, setBaseDecimals] = useState(6);
  const [quoteDecimals, setQuoteDecimals] = useState(6);
  const [existing, setExisting] = useState('0');
  const [demand, setDemand] = useState<Row[]>([{ price: '', quantity: '' }]);
  const [escrow, setEscrow] = useState<Row[]>([{ price: '', quantity: '' }]);
  const [fees, setFees] = useState<FeeSchedule | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    let live = true;
    void protocolFees().then((f) => live && setFees(f));
    return () => {
      live = false;
    };
  }, []);

  // A draft id in the address loads its soft commits as the demand once the decimals are known.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('draft');
    if (!id || !/^[0-9a-f]{64}$/.test(id)) return;
    let live = true;
    void apiRead<DemandMap>(`/v1/issuer/drafts/${id}`).then((r) => {
      if (!live) return;
      if (!r.ok) return setNote(r.error);
      setBaseDecimals(r.data.draft.baseDecimals);
      setQuoteDecimals(r.data.draft.quoteDecimals);
      setD((x) => ({ ...x, minPrice: r.data.draft.minPrice, tick: r.data.draft.tick, ticks: r.data.draft.ticks, supplyMode: r.data.draft.supplyMode, schedule: r.data.draft.supplyMode === 'mint' ? [{ price: r.data.draft.minPrice, quantity: r.data.draft.offered }] : x.schedule }));
      const rows = demandRows(r.data, r.data.draft.baseDecimals, r.data.draft.quoteDecimals);
      if (typeof rows !== 'string') setDemand(rows);
      setNote(`Loaded the draft “${r.data.draft.title}”: its grid, its planned offer and the soft commits as demand. The offer is placed at your lowest price; edit the supply steps to shape it.`);
    });
    return () => {
      live = false;
    };
  }, []);

  const useSaved = async () => {
    const saved = loadDraft(newDraft(new Date()));
    if (!saved) return setNote('There is no saved wizard draft in this browser.');
    setD(saved);
    let msg = 'Loaded your saved wizard draft.';
    const reads: MintRead[] = [];
    for (const [addr, setter] of [[saved.baseMint, setBaseDecimals], [saved.quoteMint, setQuoteDecimals]] as const) {
      if (!addr.trim()) continue;
      const m = await readMintFull(addr.trim());
      reads.push(m);
      if (m.ok) {
        setter(m.decimals);
        if (addr === saved.baseMint && m.supply !== undefined) setExisting(String(Number(m.supply) / 10 ** m.decimals));
      }
    }
    if (reads.some((m) => !m.ok)) msg += ' A token could not be read, so its decimals are the ones below.';
    setNote(msg);
  };

  const existingAtoms = parseAtoms(existing, baseDecimals);
  const mints = useMemo(() => {
    const m = (decimals: number, supply?: bigint): MintRead => ({ ok: true, program: '', decimals, mintAuthority: null, freezeAuthority: null, extensions: [], ...(supply !== undefined && { supply }) });
    return { base: m(baseDecimals, existingAtoms ?? 0n), quote: m(quoteDecimals) };
  }, [baseDecimals, quoteDecimals, existingAtoms]);
  const v = useMemo(() => derive(d, mints.base, mints.quote), [d, mints]);
  const supplyParsed = parseRows(d.schedule, v.market);

  return (
    <div className="mt-8 space-y-8">
      <p className="rounded-lg border border-border bg-surface p-4 text-sm text-muted" data-testid="standalone-note">
        No tokens are read here: say how many decimals each has and how many exist, and enter the rest as you would in the wizard. Nothing is saved or sent.{' '}
        <SmallButton onClick={() => void useSaved()}>Load my saved wizard draft</SmallButton>
      </p>
      {note ? <p role="status" className="text-sm text-muted" data-testid="sim-note">{note}</p> : null}
      <Fieldset legend="Your setup">
        <div className="grid gap-4 sm:grid-cols-3">
          <Num label="Decimals of the token sold" value={baseDecimals} onChange={(n) => setBaseDecimals(Number.isInteger(n) && n >= 0 && n <= 18 ? n : 6)} />
          <Num label="Decimals of the payment token" value={quoteDecimals} onChange={(n) => setQuoteDecimals(Number.isInteger(n) && n >= 0 && n <= 18 ? n : 6)} />
          <Text label="Tokens that already exist" value={existing} onChange={setExisting} inputMode="decimal" error={existingAtoms === null ? 'A number with at most the token’s decimals.' : undefined} />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Select label="Supply" value={d.supplyMode} onChange={(x) => set('supplyMode', x as Draft['supplyMode'])} options={[['mint', 'Minted at settlement'], ['escrow', 'Sold from escrow']]} />
          <Select label="Kind (sets the protocol fee)" value={d.kind} onChange={(x) => set('kind', x as Draft['kind'])} options={[['launch', 'Launch'], ['reopen', 'Reopen'], ['tender', 'Tender'], ['recurring', 'Recurring']]} />
          <Num label="Integrator fee, basis points" value={d.integratorFeeBps} onChange={(n) => set('integratorFeeBps', n)} />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Text label="Lowest price per token" value={d.minPrice} onChange={(x) => set('minPrice', x)} inputMode="decimal" />
          <Text label="Step between prices" value={d.tick} onChange={(x) => set('tick', x)} inputMode="decimal" />
          <Num label="Price levels (2–256)" value={d.ticks} onChange={(n) => set('ticks', n)} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Text label="Minimum tokens traded to print (optional)" value={d.minMatched} onChange={(x) => set('minMatched', x)} inputMode="decimal" error={v.typedMinMatched === null ? 'A number of tokens, or empty.' : undefined} />
          <Text label="Maximum imbalance, % (optional)" value={d.maxImbalancePct} onChange={(x) => set('maxImbalancePct', x)} inputMode="decimal" error={v.maxImbalanceBps === 'invalid' ? 'A percentage from 0 to 100, or empty.' : undefined} />
        </div>
        {d.supplyMode === 'mint' ? (
          <RowsEditor testId="sa-schedule" title="Supply schedule" hint="What you would mint and sell at each price, as price and tokens." rows={d.schedule} setRows={(r) => set('schedule', r)} errors={supplyParsed.errors} priceLabel="Step price" qtyLabel="Step tokens" />
        ) : null}
      </Fieldset>
      <SimulatorPanel draft={d} derived={v} fees={fees} demandRows={demand} setDemandRows={setDemand} escrowRows={escrow} setEscrowRows={setEscrow} sources={<DemandSource derived={v} onLoad={setDemand} />} />
    </div>
  );
}
