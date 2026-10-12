// Records the live counters the film shows, with their time, so every number on screen has a source and a date.
import { writeFileSync } from 'node:fs';
const api = process.env.API_URL ?? 'https://98-87-59-136.sslip.io';
const s = await (await fetch(`${api}/v1/stats`)).json();
writeFileSync(new URL('./src/data/live.json', import.meta.url), JSON.stringify({ fetchedAt: new Date().toISOString().slice(0, 16) + 'Z', source: `GET ${api}/v1/stats`, crossesTotal: s.crosses_total, crossesPrinted: s.crosses_printed, buyersFilled: s.buyers_filled }, null, 1));
console.log(s);
