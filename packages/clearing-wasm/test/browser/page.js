// Runs in the browser: loads the compiled modules with `fetch`, the way a web app would, and checks every conformance vector.
import { loadClearing, loadClearingV2 } from './index.js';

const get = async (url) => (await fetch(url)).arrayBuffer();
const getJson = async (url) => (await fetch(url)).json();
const rows = document.getElementById('rows');
const status = document.getElementById('status');
const report = [];

function row(name, total, matching, first) {
  report.push({ name, total, matching, first });
  const tr = document.createElement('tr');
  const cells = [name, String(total), String(matching), first ?? 'none'];
  cells.forEach((text, i) => {
    const td = document.createElement('td');
    td.textContent = text;
    if (i === 2) td.className = matching === total ? 'ok' : 'bad';
    tr.appendChild(td);
  });
  rows.appendChild(tr);
}
const big = (v) => (v === null || v === undefined ? v : BigInt(v));

try {
  const [v1wasm, v2wasm, v1vec, v2vec] = await Promise.all([get('./clearing.wasm'), get('./clearing-v2.wasm'), getJson('./v1.json'), getJson('./v2.json')]);
  const base = await loadClearing(v1wasm);
  const full = await loadClearingV2(v2wasm);

  const grid = (g) => ({ min: BigInt(g.min), tick: BigInt(g.tick), ticks: g.ticks });
  let ok = 0;
  let first = null;
  for (const c of v1vec.cases) {
    const p = base.preview({ grid: grid(c.grid), orders: c.orders.map((o) => ({ side: o.side, price: BigInt(o.price), quantity: BigInt(o.quantity) })), reference: big(c.reference), minMatched: BigInt(c.guards.minMatched), maxImbalanceBps: c.guards.maxImbalanceBps });
    const same = p.printed === c.expect.printed && (p.printed ? [String(p.price), String(p.matched), p.rationed ?? 'none'].join() === [c.expect.price, c.expect.matched, c.expect.rationed].join() && p.fills.map(String).join() === c.expect.fills.join() : p.reason === c.expect.noPrintReason);
    if (same) ok++; else first ??= c.name;
  }
  row('v1: base rule (v1 module)', v1vec.cases.length, ok, first);

  ok = 0;
  first = null;
  for (const c of v2vec.cases) {
    const p = full.preview({
      grid: grid(c.grid),
      orders: c.orders.map((o) => ({ side: o.side, price: BigInt(o.price), quantity: BigInt(o.quantity), class: o.class, insider: o.insider })),
      reference: big(c.reference),
      minMatched: BigInt(c.guards.minMatched),
      maxImbalanceBps: c.guards.maxImbalanceBps,
      rules: { supplyCap: big(c.rules.supplyCap), minRaiseQuote: BigInt(c.rules.minRaiseQuote), priceScale: BigInt(c.rules.priceScale), totalSupply: BigInt(c.rules.totalSupply), minFloatBps: c.rules.minFloatBps, maxFdvX100: BigInt(c.rules.maxFdvX100), anchorPrice: BigInt(c.rules.anchorPrice), moveBps: c.rules.moveBps, reserveBps: c.rules.reserveBps, lotteryUnit: BigInt(c.rules.lotteryUnit), rho: c.rules.rho },
    });
    const e = c.expect;
    let same = p.printed === e.printed;
    if (same && !p.printed) same = p.reason === e.noPrintReason && (p.reason === 'NoCross' || String(p.wouldClearAt) === e.wouldClearAt);
    if (same && p.printed) same = [String(p.price), String(p.matched), p.rationed ?? 'none', String(p.insiderUpperBound)].join() === [e.price, e.matched, e.rationed, e.insiderUpperBound].join() && p.fills.map(String).join() === e.fills.join();
    if (same) ok++; else first ??= c.name;
  }
  row('v2: caps, guards, classes, lottery, insiders (v2 module)', v2vec.cases.length, ok, first);

  ok = 0;
  first = null;
  for (const c of v1vec.cases) {
    const p = full.preview({ grid: grid(c.grid), orders: c.orders.map((o) => ({ side: o.side, price: BigInt(o.price), quantity: BigInt(o.quantity) })), reference: big(c.reference), minMatched: BigInt(c.guards.minMatched), maxImbalanceBps: c.guards.maxImbalanceBps });
    const same = p.printed === c.expect.printed && (p.printed ? [String(p.price), String(p.matched), p.rationed ?? 'none'].join() === [c.expect.price, c.expect.matched, c.expect.rationed].join() && p.fills.map(String).join() === c.expect.fills.join() : p.reason === c.expect.noPrintReason);
    if (same) ok++; else first ??= c.name;
  }
  row('v1 vectors through the v2 module, no v2 rules', v1vec.cases.length, ok, first);

  const all = report.every((r) => r.total === r.matching);
  status.textContent = all ? 'Every vector matches the program.' : 'Some vectors do not match the program.';
  window.__result = { done: true, ok: all, report };
} catch (e) {
  status.textContent = `The module could not be run: ${e}`;
  window.__result = { done: true, ok: false, error: String(e) };
}
