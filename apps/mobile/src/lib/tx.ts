// The one path every action takes: the API builds an unsigned transaction, the wallet signs it over the Mobile Wallet
// Adapter, the app sends it to the cluster and waits for confirmation. This app never holds a key. Errors come back in
// the program's own words, never as a stack trace.
import { base64ToBytes } from './base64';
import { API_URL, RPC_URL } from './config';

/** Asks the wallet to sign these base64 transactions and returns the signed ones, in order. */
export type Signer = (transactions: string[]) => Promise<string[]>;
export type Unsigned = { transaction: string; signers: string[] };

export class ActionError extends Error {}

/** The wallet-facing errors the program gives when an order meets a rule, in the words a person needs. */
export function explainProgramError(message: string): string {
  if (/Wrong shard for this order/i.test(message)) return 'The ending period moved into its next window while the wallet was open, so the transaction named the wrong window. Nothing was placed and no funds moved. Press the button again.';
  if (/Orders can no longer be cancelled/i.test(message)) return 'The cancel cutoff has passed: this order can no longer be withdrawn. It is still refunded in full if the cross does not print.';
  if (/identity has reached its order or escrow limit/i.test(message)) return 'This wallet has reached the limit the cross sets on orders or escrow per identity.';
  if (/does not qualify for the class/i.test(message)) return 'The order does not qualify for the class it asked for. Choose the general class or meet the class condition.';
  if (/lottery order must be exactly one lot/i.test(message)) return 'A class-1 lottery order must be exactly one lot.';
  if (/Fallback functions are not supported|InstructionFallbackNotFound/i.test(message)) return 'The program deployed on this network does not have this instruction yet: the upgrade (H27) has not been funded. Nothing was changed.';
  return message;
}

/** The text of a failure, with the program's own rule errors translated. */
export function failureText(e: unknown): string {
  return e instanceof ActionError ? explainProgramError(e.message) : `Something went wrong: ${e instanceof Error ? e.message : String(e)}`;
}

type Deps = { fetchImpl?: typeof fetch; apiUrl?: string; rpcUrl?: string; sleep?: (ms: number) => Promise<void>; now?: () => number };

/** POSTs to an API transaction builder; returns the unsigned transactions in order. */
export async function build(path: string, body: unknown, d: Deps = {}): Promise<{ txs: Unsigned[]; extra: Record<string, unknown> }> {
  const f = d.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${d.apiUrl ?? API_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new ActionError('The Opening Cross API could not be reached. Nothing was signed.');
  }
  const json = (await res.json()) as Record<string, unknown> & { error?: string; transactions?: Unsigned[]; transaction?: string; signers?: string[] };
  if (!res.ok) throw new ActionError(json.error ?? `The API refused the request (HTTP ${res.status}).`);
  const txs = json.transactions ?? (json.transaction ? [{ transaction: json.transaction, signers: json.signers ?? [] }] : []);
  if (txs.length === 0) throw new ActionError('The API returned no transaction to sign.');
  return { txs, extra: json };
}

async function rpc<T>(method: string, params: unknown[], d: Deps): Promise<T> {
  const f = d.fetchImpl ?? fetch;
  const res = await f(d.rpcUrl ?? RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const json = (await res.json()) as { result?: T; error?: { message: string; data?: { logs?: string[] } } };
  if (json.error) {
    const reason = json.error.data?.logs?.find((l) => l.includes('Error Message:'))?.split('Error Message:')[1]?.trim();
    throw new ActionError(reason ? `The program refused this: ${reason}` : json.error.message);
  }
  return json.result as T;
}

/** Signs the transactions in one wallet session, then sends each and waits until it is confirmed. */
export async function signSendConfirm(txs: Unsigned[], sign: Signer, onStatus?: (s: string) => void, d: Deps = {}): Promise<string[]> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = d.now ?? Date.now;
  onStatus?.('Waiting for your wallet…');
  let signed: string[];
  try {
    signed = await sign(txs.map((t) => t.transaction));
  } catch (e) {
    throw new ActionError(e instanceof Error && /reject|cancel|declin|denied|ERROR_AUTHORIZATION_FAILED/i.test(e.message) ? 'You declined in your wallet. Nothing was sent.' : `Your wallet could not sign: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (signed.length !== txs.length) throw new ActionError(`The wallet returned ${signed.length} signed transactions for ${txs.length}. Nothing was sent.`);
  const sigs: string[] = [];
  for (const [i, tx] of signed.entries()) {
    const label = signed.length > 1 ? ` (${i + 1} of ${signed.length})` : '';
    try {
      base64ToBytes(tx);
    } catch {
      throw new ActionError('The wallet returned something that is not a transaction. Nothing was sent.');
    }
    onStatus?.(`Sending${label}…`);
    const sig = await rpc<string>('sendTransaction', [tx, { encoding: 'base64', preflightCommitment: 'confirmed' }], d);
    onStatus?.(`Confirming${label}…`);
    const deadline = now() + 90_000;
    for (;;) {
      const st = await rpc<{ value: ({ err: unknown; confirmationStatus: string } | null)[] }>('getSignatureStatuses', [[sig]], d);
      const s = st.value[0];
      if (s?.err) throw new ActionError(`The transaction failed on chain: ${JSON.stringify(s.err)}`);
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) break;
      if (now() > deadline) throw new ActionError(`Not confirmed after 90 s. Check ${sig} in an explorer before retrying.`);
      await sleep(800);
    }
    sigs.push(sig);
  }
  return sigs;
}
