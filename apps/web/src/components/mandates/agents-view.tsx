'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Pill, Section } from '@/components/issuer/treasury-ui';
import { Failed, FeatureNotice, Plain } from '@/components/w4/ui';
import { API_URL } from '@/lib/api';
import type { GuardRead, MandatesRead } from '@/lib/mandates';
import { useRead } from '@/lib/use-read';
import { shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';

const DRAFTS = [
  ['oc_draft_mandate_place_order', 'the agent signs'],
  ['oc_draft_mandate_cancel_order', 'the owner or the agent signs'],
  ['oc_draft_mandate_reveal_order', 'the owner or the agent signs'],
  ['oc_draft_mandate_revoke', 'the owner signs'],
  ['oc_draft_mandate_withdraw', 'the owner signs'],
] as const;

/** For people who run an agent: what a mandate key can and cannot sign, the guard that checks a transaction before the key signs it, and the mandates the connected wallet acts for. */
export function AgentsView() {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const mine = useRead<MandatesRead>(wallet ? `/v1/mandates?agent=${wallet}` : null);
  const [tx, setTx] = useState('');
  const [verdict, setVerdict] = useState<{ ok: true; data: GuardRead } | { ok: false; error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    setVerdict(null);
    try {
      const res = await fetch(`${API_URL}/v1/mandates/check-transaction`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transaction: tx.trim() }) });
      const body = (await res.json().catch(() => ({}))) as GuardRead & { error?: string };
      setVerdict(res.ok ? { ok: true, data: body } : { ok: false, error: body.error ?? `The API answered HTTP ${res.status}.` });
    } catch {
      setVerdict({ ok: false, error: 'The Opening Cross API could not be reached.' });
    }
    setBusy(false);
  };
  return (
    <div className="space-y-6">
      <FeatureNotice feature="mandates" what="Auto-invest mandates" />
      <Section id="model" title="What an agent key can do" intro={<p>An agent invests from a vault an owner funded, inside limits the chain enforces.</p>}>
        <ul className="list-disc space-y-2 pl-5 text-sm text-muted" data-testid="agent-rules">
          <li>It can sign three instructions of the mandate program: place a buy order, cancel an order and reveal a sealed order. Nothing else.</li>
          <li>It cannot create, fund, re-limit or empty a mandate. The owner can revoke it at once and withdraw at any time.</li>
          <li>It cannot sell, and it cannot move a token anywhere but into a cross. What an order buys goes back to the owner.</li>
          <li>Limits are checked three times: by the SDK, by the API before a transaction exists, and by the program on chain.</li>
        </ul>
        <p className="text-sm text-muted">
          The API and the MCP server hold no keys, so the protection that an agent signs nothing else is a check run where the key is. Run the guard below, or <code className="font-mono">oc_check_agent_transaction</code> over MCP, before the key signs a draft. The guard cannot see what a host does with a key outside a transaction it was shown.
        </p>
      </Section>
      <Section id="guard" title="Check a transaction before the key signs it" intro={<p>Paste a draft as base64. Nothing is signed or sent.</p>}>
        <div className="text-sm">
          <label className="block">
            <span className="text-muted">Transaction, base64</span>
            <textarea value={tx} onChange={(e) => { setTx(e.target.value); setVerdict(null); }} rows={4} spellCheck={false} className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5 font-mono text-xs" data-testid="guard-input" />
          </label>
        </div>
        <button type="button" disabled={tx.trim() === '' || busy} onClick={() => void check()} data-testid="guard-check" className="min-h-11 rounded-full bg-accent-fill px-5 py-2.5 text-sm font-medium text-on-accent hover:opacity-90 disabled:opacity-50">
          {busy ? 'Checking…' : 'Check the transaction'}
        </button>
        {verdict && !verdict.ok ? <Failed testId="guard-error">{verdict.error}</Failed> : null}
        {verdict && verdict.ok ? (
          <div className={`rounded-[var(--radius-card)] border p-4 text-sm ${verdict.data.ok ? 'border-positive' : 'border-accent'}`} data-testid="guard-verdict" data-ok={verdict.data.ok ? 'true' : 'false'}>
            <p className="flex items-center gap-2 font-medium">
              <Pill tone={verdict.data.ok ? 'ok' : 'block'}>{verdict.data.ok ? 'Safe to sign' : 'Do not sign'}</Pill>
            </p>
            {verdict.data.instructions.length > 0 ? (
              <ul className="mt-2 space-y-1 text-muted">
                {verdict.data.instructions.map((i, n) => (
                  <li key={n}>
                    {n + 1}. {i.name ?? 'not an allowed instruction'} <span className="font-mono text-xs">({shortAddress(i.program)})</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {verdict.data.issues.map((i) => (
              <p key={`${i.field}-${i.code}`} className="mt-2 text-accent-text">
                {i.message}
              </p>
            ))}
            <p className="mt-2 text-xs text-muted">{verdict.data.note}</p>
          </div>
        ) : null}
      </Section>
      <Section id="mcp" title="Over MCP" intro={<p>The MCP server drafts unsigned transactions and holds no key. There is no tool that creates, funds, re-limits or empties a mandate for an agent.</p>}>
        <ul className="space-y-1 text-sm" data-testid="mcp-tools">
          {DRAFTS.map(([name, who]) => (
            <li key={name}>
              <code className="font-mono">{name}</code> <span className="text-muted">({who})</span>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted">
          Reads: <code className="font-mono">oc_get_mandate</code>, <code className="font-mono">oc_list_mandates</code>, <code className="font-mono">oc_get_mandate_activity</code>. See the <Link href="/developers" className="underline underline-offset-4">developer pages</Link>.
        </p>
      </Section>
      <Section id="acting" title="Mandates this wallet acts for" intro={<p>Where the connected wallet is the agent.</p>}>
        {!wallet ? <Plain testId="connect-hint">Connect the agent’s wallet to see its mandates.</Plain> : null}
        {mine.phase === 'ok' && mine.data.mandates.length === 0 ? <Plain testId="no-agent-mandates">This wallet is the agent of no mandate.</Plain> : null}
        {mine.phase === 'ok' && mine.data.mandates.length > 0 ? (
          <ul className="space-y-2 text-sm" data-testid="agent-mandates">
            {mine.data.mandates.map((m) => (
              <li key={m.mandate}>
                <Link href={`/mandates/${m.mandate}`} className="font-mono underline underline-offset-4">
                  {shortAddress(m.mandate)}
                </Link>{' '}
                · {m.status} · for owner {shortAddress(m.owner)}
              </li>
            ))}
          </ul>
        ) : null}
      </Section>
    </div>
  );
}
