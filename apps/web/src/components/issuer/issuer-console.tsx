'use client';

import type { UiWalletAccount } from '@wallet-standard/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ActionButton } from '@/components/cross/action-button';
import { useSigner } from '@/components/cross/use-signer';
import { type IssuerForm, checkIssuerForm } from '@/lib/issuer';
import { RPC_URL } from '@/lib/tx';
import { useWallet } from '@/lib/wallet';

type MintInfo = { decimals: number; program: string };

/** Reads a mint's decimals and owning token program from chain (classic SPL or Token-2022). */
async function readMint(address: string): Promise<MintInfo | string> {
  try {
    const res = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [address, { encoding: 'jsonParsed', commitment: 'confirmed' }] }) });
    const v = ((await res.json()) as { result?: { value: { owner: string; data: { parsed?: { type: string; info: { decimals: number } } } } | null } }).result?.value;
    if (!v) return 'No account exists at this address.';
    if (v.data.parsed?.type !== 'mint') return 'This address is not a token mint.';
    return { decimals: v.data.parsed.info.decimals, program: v.owner };
  } catch {
    return 'The network could not be reached to read this mint.';
  }
}

const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function IssuerConsole() {
  const { account } = useWallet();
  if (!account) return <p className="mt-10 rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted">Connect the wallet that will own this cross to continue.</p>;
  return <Form account={account} />;
}

function Form({ account }: { account: UiWalletAccount }) {
  const sign = useSigner(account);
  const inHour = new Date(Date.now() + 60 * 60_000);
  const [f, setF] = useState({
    baseMint: '', quoteMint: '', disclosure: 'sealed' as 'sealed' | 'open', supplyMode: 'mint' as 'escrow' | 'mint', kind: 'launch' as IssuerForm['kind'],
    minPrice: '1.00', tick: '0.05', ticks: 40, openAt: toLocalInput(inHour), closeAt: toLocalInput(new Date(inHour.getTime() + 2 * 3600_000)), revealMinutes: 30,
    minMatched: '', maxImbalancePct: '', integratorFeeBps: 0, maxOrders: 1000, shards: 4, crossId: String(Math.floor(Date.now() / 1000)),
    schedule: [{ price: '1.20', quantity: '' }],
  });
  const [mints, setMints] = useState<{ base?: MintInfo | string; quote?: MintInfo | string }>({});
  const [created, setCreated] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  const baseInfo = typeof mints.base === 'object' ? mints.base : null;
  const quoteInfo = typeof mints.quote === 'object' ? mints.quote : null;
  const checked =
    baseInfo && quoteInfo
      ? checkIssuerForm(
          {
            ...f,
            creator: account.address,
            integrator: account.address,
            proceedsTo: account.address,
            baseDecimals: baseInfo.decimals,
            quoteDecimals: quoteInfo.decimals,
            baseTokenProgram: baseInfo.program,
            quoteTokenProgram: quoteInfo.program,
            openAt: new Date(f.openAt),
            closeAt: new Date(f.closeAt),
            schedule: f.supplyMode === 'mint' ? f.schedule : [],
          },
          new Date(),
        )
      : null;
  const err = (k: string) => (checked && !checked.ok ? checked.errors[k] : undefined);

  if (created) {
    return (
      <div role="status" className="mt-10 rounded-[var(--radius-card)] border border-border p-6">
        <p className="font-medium">Your cross is on chain.</p>
        <p className="mt-1 break-all font-mono text-xs text-muted">{created}</p>
        <Link href={`/crosses/${created}`} className="mt-4 inline-block rounded-full bg-accent-fill px-5 py-2.5 text-sm font-medium text-on-accent">
          Open the cross page
        </Link>
      </div>
    );
  }

  return (
    <form className="mt-10 space-y-8" onSubmit={(e) => e.preventDefault()}>
      <Fieldset legend="Tokens">
        <MintField label="Token being sold (base mint)" value={f.baseMint} onChange={(v) => set('baseMint', v)} info={mints.base} onRead={async () => { const base = await readMint(f.baseMint); setMints((m) => ({ ...m, base })); }} />
        <MintField label="Paid in (quote mint)" value={f.quoteMint} onChange={(v) => set('quoteMint', v)} info={mints.quote} onRead={async () => { const quote = await readMint(f.quoteMint); setMints((m) => ({ ...m, quote })); }} />
      </Fieldset>

      <Fieldset legend="Format">
        <Select label="Bids" value={f.disclosure} onChange={(v) => set('disclosure', v as 'sealed' | 'open')} options={[['sealed', 'Sealed until reveal'], ['open', 'Open book']]} />
        <Select label="Supply" value={f.supplyMode} onChange={(v) => set('supplyMode', v as 'escrow' | 'mint')} options={[['mint', 'Minted at settlement from a schedule'], ['escrow', 'Sell orders from escrow']]} />
        <Select label="Kind" value={f.kind} onChange={(v) => set('kind', v as IssuerForm['kind'])} options={[['launch', 'Launch'], ['reopen', 'Reopen'], ['tender', 'Tender'], ['recurring', 'Recurring']]} />
      </Fieldset>

      <Fieldset legend="Price grid">
        <Text label="Lowest price per token" value={f.minPrice} onChange={(v) => set('minPrice', v)} error={err('minPrice')} />
        <Text label="Step between prices" value={f.tick} onChange={(v) => set('tick', v)} error={err('tick')} />
        <Num label="Number of price levels (2–256)" value={f.ticks} onChange={(v) => set('ticks', v)} error={err('ticks')} />
      </Fieldset>

      <Fieldset legend="Call window (your local time)">
        <Text label="Orders open" type="datetime-local" value={f.openAt} onChange={(v) => set('openAt', v)} error={err('openAt')} />
        <Text label="Orders close" type="datetime-local" value={f.closeAt} onChange={(v) => set('closeAt', v)} error={err('closeAt')} />
        {f.disclosure === 'sealed' ? <Num label="Reveal window (minutes)" value={f.revealMinutes} onChange={(v) => set('revealMinutes', v)} error={err('revealMinutes')} /> : null}
      </Fieldset>

      {f.supplyMode === 'mint' ? (
        <Fieldset legend="Supply schedule">
          {f.schedule.map((s, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-3">
              <Text label={`Step ${i + 1}: price`} value={s.price} onChange={(v) => set('schedule', f.schedule.map((x, j) => (j === i ? { ...x, price: v } : x)))} error={err(`schedule.${i}`)} />
              <Text label="Tokens offered" value={s.quantity} onChange={(v) => set('schedule', f.schedule.map((x, j) => (j === i ? { ...x, quantity: v } : x)))} />
              <button type="button" className="mb-1 text-sm text-muted underline" onClick={() => set('schedule', f.schedule.filter((_, j) => j !== i))} aria-label={`Remove step ${i + 1}`}>
                Remove
              </button>
            </div>
          ))}
          <button type="button" className="text-sm text-accent-text underline" onClick={() => set('schedule', [...f.schedule, { price: '', quantity: '' }])}>
            Add a step
          </button>
          {err('schedule') ? <p className="text-xs text-accent-text">{err('schedule')}</p> : null}
        </Fieldset>
      ) : null}

      <Fieldset legend="Guards">
        <Text label="Minimum tokens traded to print (optional)" value={f.minMatched} onChange={(v) => set('minMatched', v)} error={err('minMatched')} />
        <Text label="Maximum imbalance, % (optional)" value={f.maxImbalancePct} onChange={(v) => set('maxImbalancePct', v)} error={err('maxImbalancePct')} />
        <Num label="Maximum orders" value={f.maxOrders} onChange={(v) => set('maxOrders', v)} error={err('maxOrders')} />
      </Fieldset>

      {f.supplyMode === 'mint' ? (
        <p className="text-sm text-muted">
          Minting crosses take over the token&apos;s mint authority in the same transaction, so only the cross can create supply, and only at the
          clearing price. Your wallet must hold that authority now.
        </p>
      ) : null}
      {!baseInfo || !quoteInfo ? <p className="text-sm text-muted">Check both mints to continue.</p> : null}
      <ActionButton
        label="Create the cross"
        path="/v1/tx/create-cross"
        disabled={!checked?.ok}
        body={() => (checked?.ok ? checked.body : {})}
        sign={sign}
        onDone={(_s, extra) => setCreated(String(extra.cross))}
      />
    </form>
  );
}

function Fieldset({ legend, children }: { legend: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-4 rounded-[var(--radius-card)] border border-border p-5">
      <legend className="px-1 font-medium">{legend}</legend>
      {children}
    </fieldset>
  );
}

function Text({ label, value, onChange, error, type = 'text' }: { label: string; value: string; onChange: (v: string) => void; error?: string | undefined; type?: string }) {
  return (
    <label className="block text-sm">
      <span className="text-muted">{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={Boolean(error)} className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5 font-mono" />
      {error ? <span className="mt-1 block text-xs text-accent-text">{error}</span> : null}
    </label>
  );
}

function Num({ label, value, onChange, error }: { label: string; value: number; onChange: (v: number) => void; error?: string | undefined }) {
  return <Text label={label} value={String(value)} onChange={(v) => onChange(Number(v))} error={error} />;
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <label className="block text-sm">
      <span className="text-muted">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5">
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function MintField({ label, value, onChange, info, onRead }: { label: string; value: string; onChange: (v: string) => void; info: MintInfo | string | undefined; onRead: () => void }) {
  return (
    <div>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Text label={label} value={value} onChange={onChange} />
        </div>
        <button type="button" onClick={onRead} disabled={!value} className="mb-0.5 rounded-full border border-border-strong px-4 py-2.5 text-sm disabled:opacity-50">
          Check mint
        </button>
      </div>
      {typeof info === 'string' ? <p className="mt-1 text-xs text-accent-text">{info}</p> : info ? <p className="mt-1 text-xs text-muted">{info.decimals} decimals</p> : null}
    </div>
  );
}
