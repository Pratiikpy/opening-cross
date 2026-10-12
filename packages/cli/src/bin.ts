#!/usr/bin/env node
import { run } from './main.js';

const ac = new AbortController();
process.once('SIGINT', () => ac.abort());
const code = await run(process.argv.slice(2), {
  io: { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) },
  env: process.env,
  signal: ac.signal,
});
// Let stdout drain before exiting: a pipe may still hold the result.
process.exitCode = code;
