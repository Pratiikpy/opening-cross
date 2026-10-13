// Mint safety as the API serves it (GET /v1/tokens/:mint/safety, and the `safety` field of GET /v1/crosses/:address):
// what the issuer of a token can do to escrowed balances, and what the cross does about it. This file only reads and
// words that answer. It never decides crossability itself; the API applies the token-safety package's policy.

export type SafetyLevel = 'blocker' | 'halt' | 'disclosure';
export type SafetyVerdict = 'blocked' | 'halted' | 'disclosures' | 'clear';

export type SafetyRisk = {
  code: string;
  severity: 'block' | 'halt' | 'disclose';
  level: SafetyLevel;
  message: string;
  holder?: string;
};

export type SafetyReport = {
  mint: string;
  tokenProgram: string;
  decimals: number;
  supply: string;
  uiMultiplier: number;
  verdict: SafetyVerdict;
  crossable: boolean;
  summary: string;
  risks: SafetyRisk[];
  asOf: string;
  checkedAt: string;
};

const VERDICTS: readonly SafetyVerdict[] = ['blocked', 'halted', 'disclosures', 'clear'];
const LEVELS: readonly SafetyLevel[] = ['blocker', 'halt', 'disclosure'];
const SEVERITIES = ['block', 'halt', 'disclose'] as const;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checks the shape of an API answer and returns it typed, or null. A page shows nothing rather than a guess. */
export function parseSafety(v: unknown): SafetyReport | null {
  if (!isRecord(v)) return null;
  const { mint, tokenProgram, decimals, supply, uiMultiplier, verdict, crossable, summary, risks, asOf, checkedAt } = v;
  if (typeof mint !== 'string' || typeof tokenProgram !== 'string' || typeof decimals !== 'number' || typeof supply !== 'string') return null;
  if (typeof uiMultiplier !== 'number' || typeof crossable !== 'boolean' || typeof summary !== 'string') return null;
  if (!VERDICTS.includes(verdict as SafetyVerdict) || !Array.isArray(risks)) return null;
  const parsed: SafetyRisk[] = [];
  for (const r of risks) {
    if (!isRecord(r) || typeof r.code !== 'string' || typeof r.message !== 'string') return null;
    if (!SEVERITIES.includes(r.severity as (typeof SEVERITIES)[number]) || !LEVELS.includes(r.level as SafetyLevel)) return null;
    if (r.holder !== undefined && typeof r.holder !== 'string') return null;
    parsed.push({ code: r.code, severity: r.severity as SafetyRisk['severity'], level: r.level as SafetyLevel, message: r.message, ...(typeof r.holder === 'string' && { holder: r.holder }) });
  }
  return {
    mint, tokenProgram, decimals, supply, uiMultiplier, verdict: verdict as SafetyVerdict, crossable, summary, risks: parsed,
    asOf: String(asOf ?? ''), checkedAt: typeof checkedAt === 'string' ? checkedAt : '',
  };
}

/** Short names for the powers the package reports, for a heading above the API's own sentence. */
export const RISK_TITLES: Record<string, string> = {
  MINT_PAUSED: 'Transfers are paused',
  PAUSE_AUTHORITY: 'Issuer can pause transfers',
  PERMANENT_DELEGATE: 'Issuer can move any holder’s tokens',
  FREEZE_AUTHORITY: 'Issuer can freeze accounts',
  MINT_AUTHORITY: 'Issuer can mint more supply',
  SCALED_UI_MULTIPLIER: 'Displayed balances use a multiplier',
  SCALED_UI_MULTIPLIER_CHANGE_PENDING: 'Multiplier change scheduled',
  TRANSFER_HOOK: 'Transfers run issuer code',
  TRANSFER_FEE: 'Transfers carry a fee',
  DEFAULT_ACCOUNT_FROZEN: 'New accounts start frozen',
  NON_TRANSFERABLE: 'Token cannot be transferred',
  MINT_CLOSE_AUTHORITY: 'Issuer can close the mint',
  INTEREST_BEARING: 'Displayed amounts accrue interest',
  PERMISSIONED_BURN: 'Burning needs issuer approval',
  CONFIDENTIAL_TRANSFERS: 'Confidential transfers configured',
  UNKNOWN_EXTENSION: 'Unrecognised token extension',
};

export type BadgeTone = 'clear' | 'notice' | 'halt' | 'block';
export type BadgeItem = { code: string; title: string; message: string; level: SafetyLevel; levelLabel: string; holder: string | null };
export type BadgeModel = {
  tone: BadgeTone;
  /** The pill: short, and true on its own. */
  label: string;
  /** One sentence under the pill, from the API. */
  headline: string;
  items: BadgeItem[];
};

const LEVEL_LABEL: Record<SafetyLevel, string> = { blocker: 'Blocks a cross', halt: 'Halts printing', disclosure: 'Disclosed' };

/** What the badge says for a report. Word choice only: the verdict and every sentence come from the API. */
export function badgeModel(r: SafetyReport): BadgeModel {
  const n = r.risks.length;
  const base = { headline: r.summary, items: r.risks.map((x): BadgeItem => ({ code: x.code, title: RISK_TITLES[x.code] ?? x.code, message: x.message, level: x.level, levelLabel: LEVEL_LABEL[x.level], holder: x.holder ?? null })) };
  switch (r.verdict) {
    case 'blocked':
      return { tone: 'block', label: 'Token blocked', ...base };
    case 'halted':
      return { tone: 'halt', label: 'Printing halted', ...base };
    case 'disclosures':
      return { tone: 'notice', label: `${n} issuer ${n === 1 ? 'power' : 'powers'}`, ...base };
    case 'clear':
      return { tone: 'clear', label: 'No issuer powers', ...base };
  }
}

export type SafetyResult = { ok: true; data: SafetyReport } | { ok: false; error: string };

/** Reads a mint's safety from the API. Never throws; a failure is a message the page can show. */
export async function fetchSafety(apiUrl: string, mint: string, fetchImpl: typeof fetch = fetch): Promise<SafetyResult> {
  try {
    const res = await fetchImpl(`${apiUrl}/v1/tokens/${encodeURIComponent(mint)}/safety`, { cache: 'no-store' });
    const body: unknown = await res.json();
    if (!res.ok) return { ok: false, error: isRecord(body) && typeof body.error === 'string' ? body.error : `HTTP ${res.status}` };
    const data = parseSafety(body);
    return data ? { ok: true, data } : { ok: false, error: 'The API answered with a safety report this page does not understand.' };
  } catch {
    return { ok: false, error: 'The Opening Cross API could not be reached.' };
  }
}
