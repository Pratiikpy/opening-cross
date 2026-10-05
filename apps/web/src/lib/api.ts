// Reads from the Opening Cross API (services/api). Every figure on the site comes from here or
// from the chain; when the API cannot be reached the page says so instead of showing a number.

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';

export type Stats = {
  network: string;
  crosses_printed: number;
  crosses_total: number;
  buyers_filled: number;
  quote_to_sellers: string;
  quote_refunded_to_buyers: string;
  crosses_no_print: number;
};

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

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export async function get<T>(path: string, revalidate = 15): Promise<Result<T>> {
  try {
    const res = await fetch(`${API_URL}${path}`, { next: { revalidate } });
    const body = (await res.json()) as T & { error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    return { ok: true, data: body };
  } catch {
    return { ok: false, error: 'The Opening Cross API could not be reached.' };
  }
}
