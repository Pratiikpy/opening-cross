'use client';

import type { UiWalletAccount } from '@wallet-standard/ui';
import Link from 'next/link';
import { useId, useState } from 'react';
import { ActionButton } from '@/components/cross/action-button';
import { useSigner } from '@/components/cross/use-signer';
import { API_URL } from '@/lib/api';
import { type IssuerForm, checkIssuerForm } from '@/lib/issuer';
import type { AuthenticityVerdict, VerdictClass } from '@/lib/trust-types';
import { RPC_URL } from '@/lib/tx';
import { useWallet } from '@/lib/wallet';

type MintInfo = { decimals: number; program: string };
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
  if (!account)
    return (
      <p role="status" className="mt-10 rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted">
        Connect the wallet that will own this cross to continue. Use Connect wallet at the top right; the form opens once a wallet is connected.
      </p>
    );
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
  const [identity, setIdentity] = useState<{ base?: Identity | null; quote?: Identity | null }>({});
  const [created, setCreated] = useState<string | null>(null);
  // A create is several transactions; if the later ones fail, the cross exists on chain without all its shards and must be finished.
  const [unfinished, setUnfinished] = useState<{ cross: string; landed: number; total: number } | null>(null);
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
        <p className="mt-1 break-all font-mono text-xs text-muted" data-testid="created-cross">{created}</p>
        <Link href={`/crosses/${created}`} className="mt-4 inline-block rounded-full bg-accent-fill px-5 py-2.5 text-sm font-medium text-on-accent">
          Open the cross page
        </Link>
      </div>
    );
  }

  if (unfinished) {
    return (
      <div role="alert" className="mt-10 rounded-[var(--radius-card)] border border-border p-6">
        <p className="font-medium">Your cross exists but its setup stopped part way.</p>
        <p className="mt-1 text-sm text-muted">
          {unfinished.landed} of {unfinished.total} setup transactions landed. Nothing is lost and nothing can trade yet; finishing it sends only the missing
          ones. The cross is <span className="break-all font-mono">{unfinished.cross}</span>.
        </p>
        <div className="mt-4">
          <ActionButton label="Finish setting up the cross" path="/v1/tx/init-shards" body={() => ({ cross: unfinished.cross, payer: account.address })} sign={sign} onDone={() => { setCreated(unfinished.cross); setUnfinished(null); }} />
        </div>
      </div>
    );
  }

  return (
    <form className="mt-10 space-y-8" onSubmit={(e) => e.preventDefault()}>
      <Fieldset legend="Tokens">
        <MintField label="Token being sold (base mint)" value={f.baseMint} onChange={(v) => { set('baseMint', v); setMints((m) => ({ ...m, base: undefined })); setIdentity((i) => ({ ...i, base: undefined })); }} info={mints.base} identity={identity.base} onRead={async () => { const base = await readMint(f.baseMint); setMints((m) => ({ ...m, base })); setIdentity((i) => ({ ...i, base: null })); const id = await readIdentity(f.baseMint); setIdentity((i) => ({ ...i, base: id })); }} />
        <MintField label="Paid in (quote mint)" value={f.quoteMint} onChange={(v) => { set('quoteMint', v); setMints((m) => ({ ...m, quote: undefined })); setIdentity((i) => ({ ...i, quote: undefined })); }} info={mints.quote} identity={identity.quote} onRead={async () => { const quote = await readMint(f.quoteMint); setMints((m) => ({ ...m, quote })); setIdentity((i) => ({ ...i, quote: null })); const id = await readIdentity(f.quoteMint); setIdentity((i) => ({ ...i, quote: id })); }} />
      </Fieldset>

      <Fieldset legend="Format">
        <Select label="Bids" value={f.disclosure} onChange={(v) => set('disclosure', v as 'sealed' | 'open')} options={[['sealed', 'Sealed until reveal'], ['open', 'Open book']]} hint={f.disclosure === 'sealed' ? 'Only a commitment is on chain until the reveal window. A bid that is not revealed in time is excluded and refunded in full.' : 'Orders and their prices are public as they arrive.'} />
        <Select label="Supply" value={f.supplyMode} onChange={(v) => set('supplyMode', v as 'escrow' | 'mint')} options={[['mint', 'Minted at settlement from a schedule'], ['escrow', 'Sell orders from escrow']]} hint={f.supplyMode === 'mint' ? 'The token is minted at settlement, only at the clearing price, and only for the schedule below.' : 'Sellers deposit tokens into escrow and place sell orders; supply is whatever is offered.'} />
        <Select label="Kind" value={f.kind} onChange={(v) => set('kind', v as IssuerForm['kind'])} options={[['launch', 'Launch'], ['reopen', 'Reopen'], ['tender', 'Tender'], ['recurring', 'Recurring']]} hint="Names the use of the cross and selects its protocol fee tier. It does not change how the cross clears." />
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
        <Text label="Minimum tokens traded to print (optional)" value={f.minMatched} onChange={(v) => set('minMatched', v)} error={err('minMatched')} hint="If fewer tokens than this would trade, the cross does not print and everyone is refunded." />
        <Text label="Maximum imbalance, % (optional)" value={f.maxImbalancePct} onChange={(v) => set('maxImbalancePct', v)} error={err('maxImbalancePct')} hint="If the unmatched quantity at the clearing price is larger than this share of the tokens traded, the cross does not print." />
        <Num label="Maximum orders" value={f.maxOrders} onChange={(v) => set('maxOrders', v)} error={err('maxOrders')} hint="The call stops accepting orders at this count." />
      </Fieldset>

      {f.supplyMode === 'mint' ? (
        <p className="text-sm text-muted">
          Minting crosses take over the token&apos;s mint authority in the same transaction, so only the cross can create supply, and only at the
          clearing price. Your wallet must hold that authority now.
        </p>
      ) : null}
      {!baseInfo || !quoteInfo ? <p className="text-sm text-muted">Check both mints to continue.</p> : null}
      <p className="text-sm text-muted" data-testid="create-cost">
        Creating a cross costs about 0.17 SOL in rent (the cross, its book and its {f.shards} shards; measured on devnet) plus network fees, and a small
        bond in the quote token (about 0.003 of one token at the defaults, growing with Maximum orders), so the wallet needs both. If a setup transaction fails part way you can
        finish it from this page.
      </p>
      <ActionButton
        label="Create the cross"
        path="/v1/tx/create-cross"
        disabled={!checked?.ok}
        body={() => (checked?.ok ? checked.body : {})}
        sign={sign}
        onDone={(_s, extra) => setCreated(String(extra.cross))}
        onPartial={(extra, landed, total) => setUnfinished({ cross: String(extra.cross), landed, total })}
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

function Text({ label, value, onChange, onBlur, error, hint, type = 'text', inputMode }: { label: string; value: string; onChange: (v: string) => void; onBlur?: () => void; error?: string | undefined; hint?: string; type?: string; inputMode?: 'numeric' | 'decimal' }) {
  const errorId = useId();
  const hintId = useId();
  return (
    <div className="text-sm">
      <label className="block">
        <span className="text-muted">{label}</span>
        <input
          type={type}
          value={value}
          inputMode={inputMode}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : hint ? hintId : undefined}
          className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5 font-mono"
        />
      </label>
      {error ? (
        <span id={errorId} className="mt-1 block text-xs text-accent-text">
          {error}
        </span>
      ) : hint ? (
        <span id={hintId} className="mt-1 block text-xs text-muted">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** A whole-number field. It keeps what the person typed (an empty box stays empty) and reports NaN until the text is a number. */
function Num({ label, value, onChange, error, hint }: { label: string; value: number; onChange: (v: number) => void; error?: string | undefined; hint?: string }) {
  const [text, setText] = useState(String(value));
  return (
    <Text
      label={label}
      value={text}
      inputMode="numeric"
      onChange={(v) => {
        setText(v);
        onChange(v.trim() === '' ? Number.NaN : Number(v));
      }}
      error={error}
      {...(hint ? { hint } : {})}
    />
  );
}

function Select({ label, value, onChange, options, hint }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][]; hint?: string }) {
  const hintId = useId();
  return (
    <div className="text-sm">
      <label className="block">
        <span className="text-muted">{label}</span>
        <select value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={hint ? hintId : undefined} className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5">
          {options.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      {hint ? (
        <span id={hintId} className="mt-1 block text-xs text-muted">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

function MintField({ label, value, onChange, info, identity, onRead }: { label: string; value: string; onChange: (v: string) => void; info: MintInfo | string | undefined; identity?: Identity | null | undefined; onRead: () => void }) {
  return (
    <div>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Text label={label} value={value} onChange={onChange} onBlur={() => value.trim() && onRead()} />
        </div>
        <button type="button" onClick={onRead} disabled={!value} className="mb-0.5 rounded-full border border-border-strong px-4 py-2.5 text-sm disabled:opacity-50">
          Check mint
        </button>
      </div>
      {typeof info === 'string' ? <p className="mt-1 text-xs text-accent-text">{info}</p> : info ? <p className="mt-1 text-xs text-muted">{info.decimals} decimals</p> : null}
      {identity ? (
        <p className={`mt-1 text-xs ${identity.verdict === 'GENUINE' ? 'text-positive' : identity.verdict === 'IMPERSONATOR' || identity.verdict === 'ADDRESS_LOOKALIKE' ? 'text-accent-text' : 'text-muted'}`} data-testid="mint-identity">
          {IDENTITY_LABEL[identity.verdict]}
          {identity.verdict !== 'GENUINE' && identity.message ? `: ${identity.message}` : ''}
        </p>
      ) : null}
    </div>
  );
}
