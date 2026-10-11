// Reads from the Opening Cross API (services/api). A figure shown here comes from the API or the chain; when the API
// cannot be reached the screen says so instead of showing a number.
import { API_URL } from './config';

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export async function get<T>(path: string, fetchImpl: typeof fetch = fetch, base: string = API_URL): Promise<Result<T>> {
  try {
    const res = await fetchImpl(`${base}${path}`, { headers: { accept: 'application/json' } });
    const body = (await res.json()) as T & { error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    return { ok: true, data: body };
  } catch {
    return { ok: false, error: 'The Opening Cross API could not be reached.' };
  }
}

export type CrossSummary = {
  address: string;
  state: 'Live' | 'Cleared' | 'NoPrint' | 'Finalized';
  creator: string;
  base_mint: string;
  quote_mint: string;
  open_ts: string;
  close_ts: string;
  reveal_end_ts: string;
  clearing_price: string | null;
  matched: string | null;
  orders_committed: number;
};
