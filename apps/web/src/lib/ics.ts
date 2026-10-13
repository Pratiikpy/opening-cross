// A minimal RFC 5545 (iCalendar) writer for one event per cross: its call window. Generated in the browser from the
// cross's real open and close times; nothing is sent anywhere.

const CRLF = '\r\n';
const encoder = new TextEncoder();

/** Escapes a TEXT value (RFC 5545 section 3.3.11): backslash, semicolon, comma and line breaks. */
export function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

/** Folds a content line at 75 octets (RFC 5545 section 3.1): continuation lines start with one space, and a multi-byte
 * character is never split. */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    if (bytes + n > limit) {
      out.push(cur);
      cur = '';
      bytes = 0;
      limit = 74; // the leading space of a continuation line counts as one octet
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join(`${CRLF} `);
}

/** `20261013T015212Z`: a UTC date-time in iCalendar's basic format. */
export function icsUtc(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

export type CrossEvent = {
  /** The cross account address: the stable identity of the event, so re-importing updates instead of duplicating. */
  address: string;
  openTs: number;
  closeTs: number;
  /** Absolute URL of the cross page. */
  url: string;
};

/** The .ics text for one cross: an event from `openTs` to `closeTs`, with the cross's URL. `now` stamps DTSTAMP. */
export function crossIcs(e: CrossEvent, now: number = Math.floor(Date.now() / 1000)): string {
  if (!Number.isSafeInteger(e.openTs) || !Number.isSafeInteger(e.closeTs) || e.closeTs <= e.openTs) throw new RangeError('a cross window must close after it opens');
  const short = `${e.address.slice(0, 4)}…${e.address.slice(-4)}`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Opening Bell//Opening Cross calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${e.address}@opening-cross`,
    `DTSTAMP:${icsUtc(now)}`,
    `DTSTART:${icsUtc(e.openTs)}`,
    `DTEND:${icsUtc(e.closeTs)}`,
    `SUMMARY:${escapeText(`Opening Cross ${short}: orders open`)}`,
    `DESCRIPTION:${escapeText(`Orders for this opening cross are accepted from the start of this event until it ends; everyone who trades pays one clearing price. Devnet only. ${e.url}`)}`,
    `URL:${e.url}`,
    'TRANSP:TRANSPARENT',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join(CRLF) + CRLF;
}
