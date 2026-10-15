// The gate every sentence of a model-written note must pass before it is published (J3, release bar V-A "AI summaries"). The model is trusted with wording and with nothing else: the gate
// checks the sentence against the cited facts by rules a reader can audit, and a sentence that fails is dropped, never edited.
//
//   citations    every cited key is in the fact table; at least one cited fact is actually stated in the sentence; a cite the sentence does not use is removed from the published cites.
//   numbers      every number in the sentence (digits, a percentage, a spelled-out number) equals a cited fact, or the percentage form of a cited basis-point fact. The model never
//                does arithmetic and never rounds: a figure it computed is a figure it invented.
//   claims       a sentence the claim parser reads ("cleared at 1550000", "40 orders") must agree with the fact table; a contradicted or unverifiable claim rejects it.
//   enumerations a state, kind or status word that contradicts the cited fact ("Live" for a Finalized cross) rejects it.
//   identifiers  an address-shaped token must be one of the cited values or appear in the cited facts' sources.
//   advice       no recommendation, forecast or valuation call; no accusation or verdict word. The note states what the facts are, not what to do about them.
//   injection    no instruction-shaped text, link, markup or role-play.
//
// What the gate cannot do: it cannot tell that a true, cited, number-correct sentence is misleading by omission (the abstentions list the missing facts, and the note says it is
// partial), and it cannot catch a spelled-out "one" used as a count outside the nouns listed below.
import { parseClaims, type Claim } from '@opening-cross/integrity';

export interface FactRow {
  key: string;
  /** A whole number or a text value, as a string (amounts are never floats). */
  value: string;
  /** Where a reader can check it: the account or API route. */
  source: string;
}
export type FactTable = ReadonlyMap<string, FactRow>;

export interface DraftSentence {
  text: string;
  cites: string[];
}

export type RejectionCode =
  | 'EMPTY'
  | 'TOO_LONG'
  | 'NO_CITES'
  | 'UNKNOWN_CITE'
  | 'NOTHING_STATED'
  | 'UNCITED_NUMBER'
  | 'CONTRADICTED_CLAIM'
  | 'UNVERIFIABLE_CLAIM'
  | 'CONTRADICTED_VALUE'
  | 'UNKNOWN_IDENTIFIER'
  | 'UNSAFE_FACT'
  | 'ADVICE'
  | 'VERDICT'
  | 'INSTRUCTION_TEXT';
export interface Rejection {
  code: RejectionCode;
  message: string;
}

export interface AcceptedSentence {
  text: string;
  /** The cites the sentence actually uses, each with the value and source a reader can open. */
  cites: { key: string; value: string; source: string }[];
}

export type GateResult = { ok: true; sentence: AcceptedSentence } | { ok: false; rejections: Rejection[] };

export const MAX_SENTENCE_CHARS = 420;

const SAFE_VALUE = /^(?:-?\d{1,40}|[A-Za-z0-9_.:-]{1,64})$/;
const SAFE_SOURCE = /^(?:api|chain):[A-Za-z0-9_./-]+(?: [1-9A-HJ-NP-Za-km-z]{32,44})?(?: \.[A-Za-z0-9_]+)?$/;

// ------------------------------------------------------------------------------------------------ numbers

const WORDS: Record<string, string> = {
  zero: '0', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15',
  sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90',
  hundred: '100', thousand: '1000', million: '1000000', billion: '1000000000',
};
const COUNT_NOUN = '(?:order|bidder|group|cluster|wallet|holder|cross|statement|account)';
const WORD_RE = new RegExp(`\\b(${Object.keys(WORDS).join('|')})\\b`, 'gi');
const ONE_RE = new RegExp(`\\bone (?=${COUNT_NOUN}s?\\b)`, 'gi');
const VAGUE_QUANTITY = /\b(?:half|double|triple|twice|thrice|dozens?|hundreds|thousands|millions|majority|minority|most|nearly all|almost all)\b/i;
const NUMBER_RE = /(?<![A-Za-z0-9_.])-?\d[\d,]*(?:\.\d+)?(?:%|\s?(?:percent|per cent|pct)\b)?/gi;
const BASE58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

/** The text forms of a fact's value that a sentence may use. A percentage form exists only for basis points. */
function renderings(row: FactRow): { plain: Set<string>; percent: Set<string> } {
  const plain = new Set<string>();
  const percent = new Set<string>();
  if (!/^-?\d+$/.test(row.value)) return { plain, percent };
  const v = BigInt(row.value);
  plain.add(v.toString());
  if (/bps/i.test(row.key)) {
    const whole = v / 100n;
    const frac = (v < 0n ? -v : v) % 100n;
    const s = frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(2, '0').replace(/0$/, '')}`;
    percent.add(s);
  }
  return { plain, percent };
}

function numbersIn(text: string): { token: string; percent: boolean }[] {
  const out: { token: string; percent: boolean }[] = [];
  const clean = text.replace(BASE58, ' ').replace(/version[- ]0/gi, ' ');
  for (const m of clean.matchAll(NUMBER_RE)) {
    const raw = m[0];
    const percent = /(?:%|percent|per cent|pct)$/i.test(raw);
    out.push({ token: raw.replace(/\s?(?:%|percent|per cent|pct)$/i, '').replace(/,/g, '').replace(/[.,]$/, ''), percent });
  }
  for (const m of clean.matchAll(WORD_RE)) out.push({ token: WORDS[m[1]!.toLowerCase()]!, percent: false });
  for (const _ of clean.matchAll(ONE_RE)) out.push({ token: '1', percent: false });
  return out;
}

// ------------------------------------------------------------------------------------------- enumerations

/** Words that name the value of an enumerated fact. A sentence naming a different one than the fact holds contradicts it. */
const ENUMS: Record<string, readonly string[]> = {
  'cross.state': ['Live', 'Finalized', 'Settled', 'Cancelled', 'Failed', 'Revealing', 'Closed'],
  'cross.kind': ['launch', 'reopen', 'tender', 'recurring'],
  'backing.status': ['verified', 'stale', 'undercollateralised', 'unverifiable'],
};

// ------------------------------------------------------------------------------------------------- text rules

const ADVICE = [
  /\byou (?:should|could|might want to|ought to|must)\b/i,
  /\b(?:should|must|ought to) (?:buy|sell|hold|invest|avoid|bid|enter|exit|short|ape)\b/i,
  /\b(?:i|we) (?:recommend|suggest|advise|would)\b/i,
  /\brecommend(?:s|ed|ation)?\b/i,
  /\b(?:buy|sell|hold|accumulate|short|ape (?:in|into)|bid on|invest in|avoid)\s+(?:this|the|it|now|more|before|after)\b/i,
  /\b(?:worth|good|bad|great|poor|solid|smart|risky)\s+(?:buying|selling|investing|investment|buy|bet|opportunity|entry)\b/i,
  /\bprice target\b/i,
  /\b(?:guarantee[sd]?|certain to|sure to|bound to|will (?:definitely|certainly))\b/i,
  /\bwill (?:likely |probably |surely )?(?:go up|go down|pump|moon|rise|fall|crash|dump|double|rally|increase|decrease|grow|outperform|underperform|succeed|fail)\b/i,
  /\b(?:to the moon|financial advice|not advice|dyor)\b/i,
  /\b(?:undervalued|overvalued|bullish|bearish|upside|downside potential|alpha)\b/i,
  /\bsafe to (?:buy|invest|bid|trade)\b/i,
  /\bconsider (?:buying|selling|investing|holding|bidding|entering|exiting|accumulating|shorting)\b/i,
  /\binvest(?:ing|ed|ment)? (?:in|into)\b/i,
  /\baccumulat(?:e|ing|ion)\b/i,
  /\bon (?:weakness|strength)\b|\bbuy the dip\b/i,
  /\b(?:sell|buy|hold) (?:before|after|at|on|when|if|into)\b/i,
];
const VERDICT = /\b(?:scam|scammer|fraud(?:ulent)?|rug(?:ged| ?pull)?|ponzi|honeypot|legit(?:imate)?|trustworthy|untrustworthy|safe|unsafe|risky|dangerous|suspicious|shady|sketchy|alarming|concerning|worrying|healthy|impressive|promising|strong|weak|manipulat(?:ed|ion|ive)|wash trad(?:ed|ing)|insider)\b/i;
const INJECTION = [
  /\bignore (?:all |any |the )?(?:previous|prior|above|earlier)\b/i,
  /\bdisregard\b/i,
  /\b(?:system|developer) (?:prompt|message|instructions?)\b/i,
  /\byou are (?:now|a|an)\b/i,
  /\bas an ai\b/i,
  /\bnew instructions?\b/i,
  /\boverride\b/i,
  /\bjailbreak\b/i,
  /<\/?[a-z][^>]*>/i,
  /\bhttps?:\/\//i,
  /\bwww\./i,
  /\[[^\]]*\]\([^)]*\)/,
  /```/,
  /\b(?:pretend|roleplay|role-play|act as)\b/i,
  /\b(?:reveal|print|repeat|output) (?:your|the) (?:prompt|instructions)\b/i,
];

export function gateSentence(s: DraftSentence, table: FactTable): GateResult {
  const rej: Rejection[] = [];
  const text = (s.text ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return { ok: false, rejections: [{ code: 'EMPTY', message: 'the sentence is empty' }] };
  if (text.length > MAX_SENTENCE_CHARS) rej.push({ code: 'TOO_LONG', message: `the sentence is ${text.length} characters; the limit is ${MAX_SENTENCE_CHARS}` });
  const cites = Array.isArray(s.cites) ? s.cites.filter((c): c is string => typeof c === 'string') : [];
  if (cites.length === 0) rej.push({ code: 'NO_CITES', message: 'the sentence cites no fact' });
  const unknown = cites.filter((c) => !table.has(c));
  if (unknown.length) rej.push({ code: 'UNKNOWN_CITE', message: `these cited keys are not in the fact table: ${unknown.join(', ')}` });

  for (const re of ADVICE) if (re.test(text)) rej.push({ code: 'ADVICE', message: `the sentence reads as advice or a forecast (${re.source.slice(0, 40)}); the note states facts only` });
  const verdict = VERDICT.exec(text);
  if (verdict) rej.push({ code: 'VERDICT', message: `the word "${verdict[0]}" is a verdict; state the measured fact and let the reader judge` });
  for (const re of INJECTION) if (re.test(text)) rej.push({ code: 'INSTRUCTION_TEXT', message: 'the sentence contains instruction-shaped text, a link or markup' });
  if (VAGUE_QUANTITY.test(text)) rej.push({ code: 'UNCITED_NUMBER', message: 'a quantity word such as "most", "half" or "double" is a number the facts do not state; use the cited figure' });

  const known = cites.filter((c) => table.has(c)).map((c) => table.get(c)!);
  for (const row of known) {
    const why = rowProblem(row);
    if (why) rej.push({ code: 'UNSAFE_FACT', message: `the cited fact ${row.key.slice(0, 40)} cannot be quoted: ${why}` });
  }
  // Which cited facts does the sentence actually state?
  const used = new Set<string>();
  const nums = numbersIn(text);
  const allowedPlain = new Set<string>();
  const allowedPercent = new Set<string>();
  for (const row of known) {
    const r = renderings(row);
    r.plain.forEach((x) => allowedPlain.add(x));
    r.percent.forEach((x) => allowedPercent.add(x));
    if (/^-?\d+$/.test(row.value)) {
      if (nums.some((n) => (n.percent ? r.percent.has(n.token) : r.plain.has(n.token)))) used.add(row.key);
    } else if (text.toLowerCase().includes(row.value.toLowerCase())) used.add(row.key);
  }
  for (const n of nums) {
    const ok = n.percent ? allowedPercent.has(n.token) : allowedPlain.has(n.token);
    if (!ok) rej.push({ code: 'UNCITED_NUMBER', message: `the number ${n.percent ? `${n.token}%` : n.token} is not the value of any fact the sentence cites` });
  }
  if (known.length > 0 && used.size === 0) rej.push({ code: 'NOTHING_STATED', message: 'the sentence states none of the values it cites, so the citation supports nothing in it' });

  // Address-shaped tokens must come from the cited facts.
  const allowedIds = new Set<string>();
  for (const row of known) {
    allowedIds.add(row.value);
    for (const m of row.source.matchAll(BASE58)) allowedIds.add(m[0]);
  }
  for (const m of text.matchAll(BASE58)) if (!allowedIds.has(m[0])) rej.push({ code: 'UNKNOWN_IDENTIFIER', message: `the identifier ${m[0].slice(0, 8)}... is not in any cited fact` });

  // Enumerated facts: naming another member of the set contradicts the fact.
  for (const row of known) {
    const domain = ENUMS[row.key];
    if (!domain || /^-?\d+$/.test(row.value)) continue;
    for (const w of domain) {
      if (w.toLowerCase() === row.value.toLowerCase()) continue;
      if (new RegExp(`\\b${w}\\b`, row.key === 'cross.kind' ? 'i' : '').test(text)) rej.push({ code: 'CONTRADICTED_VALUE', message: `the sentence says "${w}" but ${row.key} is ${row.value}` });
    }
  }

  // Claims the parser can read are checked against the whole table.
  for (const claim of parseClaims(text).claims) {
    const fact = table.get(claim.metric);
    if (!fact) {
      rej.push({ code: 'UNVERIFIABLE_CLAIM', message: `the claim "${claim.text ?? ''}" is about ${claim.metric}, which has no fact in this table` });
      continue;
    }
    const verdict2 = compare(claim, fact.value);
    if (verdict2 === 'contradicted') rej.push({ code: 'CONTRADICTED_CLAIM', message: `the claim ${claim.metric} ${claim.op} ${claim.value} is contradicted: the fact is ${fact.value}` });
  }

  if (rej.length) return { ok: false, rejections: dedupe(rej) };
  return { ok: true, sentence: { text, cites: [...used].map((k) => ({ key: k, value: table.get(k)!.value, source: table.get(k)!.source })) } };
}

function compare(c: Claim, actual: string): 'supported' | 'contradicted' {
  if (!/^-?\d+$/.test(actual) || !/^-?\d+$/.test(c.value)) return c.op === '=' && actual === c.value ? 'supported' : 'contradicted';
  const a = BigInt(actual);
  const w = BigInt(c.value);
  return { '=': a === w, '<=': a <= w, '>=': a >= w, '<': a < w, '>': a > w }[c.op] ? 'supported' : 'contradicted';
}
const dedupe = (r: Rejection[]): Rejection[] => {
  const seen = new Set<string>();
  return r.filter((x) => (seen.has(`${x.code}|${x.message}`) ? false : (seen.add(`${x.code}|${x.message}`), true)));
};

export interface GatedDraft {
  accepted: AcceptedSentence[];
  rejected: { text: string; cites: string[]; rejections: Rejection[] }[];
}

/** Gates a whole draft. Order is kept; a duplicate sentence is dropped. */
export function gateDraft(draft: readonly DraftSentence[], table: FactTable): GatedDraft {
  const accepted: AcceptedSentence[] = [];
  const rejected: GatedDraft['rejected'] = [];
  const seen = new Set<string>();
  for (const s of draft) {
    const r = gateSentence(s, table);
    if (r.ok) {
      if (seen.has(r.sentence.text)) continue;
      seen.add(r.sentence.text);
      accepted.push(r.sentence);
    } else rejected.push({ text: String(s?.text ?? ''), cites: Array.isArray(s?.cites) ? s.cites.map(String) : [], rejections: r.rejections });
  }
  return { accepted, rejected };
}


/** Why a fact row may not reach the model or be quoted in a published sentence, or null when it is safe. */
export function rowProblem(row: FactRow): string | null {
  if (!/^[A-Za-z][A-Za-z0-9_.]{0,63}$/.test(row.key)) return 'the key is not a plain identifier';
  if (!SAFE_VALUE.test(row.value)) return 'the value is not an integer or a plain token';
  if (!SAFE_SOURCE.test(row.source)) return 'the source is not a plain reference';
  return null;
}

/**
 * Only integers, plain tokens (an enumeration word or an address) and source references of the two forms the protocol produces (`api:/route` and `chain:program.Account ADDRESS .field`)
 * may enter the table the model reads. Free text in a fact would be a channel for an attacker to put words in front of the model and, if the sentence quoted it, past a gate that
 * can only deny patterns; no fact the protocol produces needs free text, so a row that carries any is dropped and reported.
 */
export function sanitizeTable(table: FactTable): { table: FactTable; dropped: { key: string; why: string }[] } {
  const out = new Map<string, FactRow>();
  const dropped: { key: string; why: string }[] = [];
  for (const [key, row] of table) {
    const why = rowProblem({ ...row, key });
    if (why) dropped.push({ key: key.slice(0, 40), why });
    else out.set(key, row);
  }
  return { table: out, dropped };
}
