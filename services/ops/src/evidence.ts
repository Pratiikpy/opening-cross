// What a reviewer should see about a mint or a cross, gathered from the public API's own routes, each source alone, so one failing
// source is shown as failed and the others still arrive.
export type Evidence = Record<string, { ok: boolean; data?: unknown; error?: string }>;

export function apiEvidence(baseUrl: string, fetchImpl: typeof fetch = fetch, timeoutMs = 25_000): (s: { mint?: string; cross?: string }) => Promise<Evidence> {
  const base = baseUrl.replace(/\/$/, '');
  const get = async (path: string): Promise<Evidence[string]> => {
    try {
      const res = await fetchImpl(base + path, { signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      return { ok: true, data: JSON.parse(text) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
  return async ({ mint, cross }) => {
    const jobs: [string, string][] = [];
    if (mint) jobs.push(['safety', `/v1/tokens/${mint}/safety`], ['authenticity', `/v1/tokens/${mint}/authenticity`], ['duplicates', `/v1/tokens/${mint}/duplicates`], ['holders', `/v1/integrity/mint/${mint}/holders`], ['supply', `/v1/integrity/mint/${mint}/supply`], ['backing', `/v1/integrity/mint/${mint}/backing`]);
    if (cross) jobs.push(['cross', `/v1/crosses/${cross}`], ['proof', `/v1/crosses/${cross}/proof`], ['conflicts', `/v1/integrity/cross/${cross}/conflicts`], ['organic', `/v1/integrity/cross/${cross}/organic`], ['rating', `/v1/integrity/cross/${cross}/rating`]);
    const results = await Promise.all(jobs.map(async ([k, p]) => [k, await get(p)] as const));
    return Object.fromEntries(results);
  };
}
