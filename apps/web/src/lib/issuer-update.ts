// Posting a treasury disclosure update from the browser, in the order the API verifies it: the API shapes the update and its id, the
// wallet signs the message, a Memo transaction signed by the same wallet anchors the id on chain, and the signed update with the
// anchor's signature is posted for the API to check against the chain. If any step fails nothing is half-published: the update only
// exists once the last step succeeds, and a failed step says which one and what, if anything, already landed on chain.
export type UpdateForm = { title: string; summary: string; coveredFrom: string; coveredTo: string; declaredSpent: string };

export type Prepared = {
  body: { sequence: number; [k: string]: unknown };
  id: string;
  message: string;
  memoText: string;
};

export type UpdateDeps = {
  prepare: (b: Record<string, unknown>) => Promise<{ ok: true; data: Prepared } | { ok: false; error: string }>;
  signMessage: (message: string) => Promise<string>;
  memoTx: (b: Record<string, unknown>) => Promise<{ ok: true; txs: { transaction: string; signers: string[] }[] } | { ok: false; error: string }>;
  /** Signs, sends and confirms the transactions; resolves to their signatures. */
  send: (txs: { transaction: string; signers: string[] }[], onStatus: (s: string) => void) => Promise<string[]>;
  submit: (treasury: string, b: Record<string, unknown>) => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>;
};

export type UpdateResult = { ok: true; id: string; sequence: number; memoSignature: string } | { ok: false; step: 'prepare' | 'sign' | 'anchor' | 'publish'; error: string; anchored: string | null };

/** `2026-10-01` read as the start of that day in UTC, in unix seconds; null if it is not a date. */
export function dayStart(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== text.trim() ? null : Math.floor(t / 1000);
}

/** The prepare request from the form, or the field errors. The covered span runs from the start of the first day to the end of the last, in UTC. */
export function checkUpdateForm(f: UpdateForm, quoteDecimals: number | null, parseQuote: (t: string, d: number) => bigint | null, nowSecs: number): { ok: true; body: Record<string, unknown> } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (f.title.trim() === '' || f.title.trim().length > 120) errors.title = 'Give the update a title of up to 120 characters.';
  if (f.summary.trim() === '' || f.summary.trim().length > 4000) errors.summary = 'Write what happened, in up to 4,000 characters.';
  const from = dayStart(f.coveredFrom);
  const to = dayStart(f.coveredTo);
  if (from === null) errors.coveredFrom = 'Choose the first day this update covers.';
  if (to === null) errors.coveredTo = 'Choose the last day this update covers.';
  const end = to === null ? null : to + 86_399;
  if (from !== null && end !== null && from > end) errors.coveredTo = 'The last day cannot be before the first.';
  // The span may end today: the update is signed after it, so cap at the present moment.
  const coveredTo = end === null ? null : Math.min(end, nowSecs - 1);
  if (end !== null && from !== null && coveredTo !== null && coveredTo < from) errors.coveredFrom = 'An update cannot cover days that have not started.';
  let declared: string | null = null;
  if (f.declaredSpent.trim() !== '') {
    if (quoteDecimals === null) errors.declaredSpent = 'The treasury’s token could not be read, so the amount cannot be converted.';
    else {
      const a = parseQuote(f.declaredSpent, quoteDecimals);
      if (a === null) errors.declaredSpent = `Enter an amount with at most ${quoteDecimals} decimal places, or leave it empty.`;
      else declared = a.toString();
    }
  }
  if (Object.keys(errors).length || from === null || coveredTo === null) return { ok: false, errors };
  return { ok: true, body: { title: f.title.trim(), summary: f.summary.trim(), coveredFrom: from, coveredTo, declaredSpentAtoms: declared } };
}

export async function postUpdate(treasury: string, wallet: string, request: Record<string, unknown>, d: UpdateDeps, onStatus: (s: string) => void): Promise<UpdateResult> {
  onStatus('Preparing the update…');
  const prep = await d.prepare({ ...request, authority: wallet });
  if (!prep.ok) return { ok: false, step: 'prepare', error: prep.error, anchored: null };
  const { body, id, message } = prep.data;

  onStatus('Waiting for your wallet to sign the update…');
  let signature: string;
  try {
    signature = await d.signMessage(message);
  } catch (e) {
    return { ok: false, step: 'sign', error: e instanceof Error && /reject|cancel|denied/i.test(e.message) ? 'You declined in your wallet. Nothing was published.' : `Your wallet could not sign: ${e instanceof Error ? e.message : String(e)}`, anchored: null };
  }

  onStatus('Building the anchoring transaction…');
  const memo = await d.memoTx({ treasury, payer: wallet, sequence: body.sequence, id });
  if (!memo.ok) return { ok: false, step: 'anchor', error: memo.error, anchored: null };
  let sigs: string[];
  try {
    sigs = await d.send(memo.txs, onStatus);
  } catch (e) {
    return { ok: false, step: 'anchor', error: e instanceof Error ? e.message : String(e), anchored: null };
  }
  const memoSignature = sigs[0]!;

  onStatus('Publishing the update…');
  const pub = await d.submit(treasury, { update: { id, body, signer: wallet, signature }, memoSignature });
  // The memo is on chain by now. Say so, so the issuer knows a retry needs a new anchor and a new update.
  if (!pub.ok) return { ok: false, step: 'publish', error: pub.error, anchored: memoSignature };
  return { ok: true, id, sequence: body.sequence, memoSignature };
}
