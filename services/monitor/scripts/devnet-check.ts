// The checks against the live devnet deployment, read only: nothing is sent, whatever they find. Run twice over the same Monitor so
// the change detection has something to compare, then once more with a wrong pin to show a finding being raised and held back by
// the persistence rule.
//   RPC_URL=https://api.devnet.solana.com tsx scripts/devnet-check.ts
import { CROSS_CALENDAR_PROGRAM_ADDRESS } from '@opening-cross/cross-calendar-client';
import { CROSS_CORE_PROGRAM_ADDRESS } from '@opening-cross/cross-core-client';
import { CROSS_GATE_PROGRAM_ADDRESS } from '@opening-cross/cross-gate-client';
import { CROSS_SETTLE_PROGRAM_ADDRESS } from '@opening-cross/cross-settle-client';
import { TREASURY_PROGRAM_ADDRESS } from '@opening-cross/treasury-client';
import { Monitor, type Notifier, jsonRpc, programIntegrity, protocolAuthorities, readProgram, stuckCrosses, vaultCoversOrders, type ProgramPins } from '../src/index.js';

const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const rpc = jsonRpc(RPC);
const programs = [CROSS_CORE_PROGRAM_ADDRESS, CROSS_GATE_PROGRAM_ADDRESS, CROSS_SETTLE_PROGRAM_ADDRESS, CROSS_CALENDAR_PROGRAM_ADDRESS, TREASURY_PROGRAM_ADDRESS];

const pins: Record<string, { sha256: string; upgradeAuthority: string | null }> = {};
for (const p of programs) {
  const s = await readProgram(rpc, p);
  console.log(JSON.stringify({ program: p, upgradeAuthority: s?.upgradeAuthority, sha256: s?.executableSha256, bytes: s?.bytes }));
  if (s) pins[p] = { sha256: s.executableSha256, upgradeAuthority: s.upgradeAuthority };
}

const events: unknown[] = [];
const notifier: Notifier = { notify: async (e) => void events.push(e.body) };
const m = new Monitor({ rpc, notifier, pause: null, consecutive: 3, checks: [vaultCoversOrders(), protocolAuthorities(), programIntegrity(pins as ProgramPins), stuckCrosses()] });
for (let i = 1; i <= 2; i++) {
  const r = await m.pass();
  console.log(JSON.stringify({ pass: i, findings: r.findings.map((f) => `${f.severity}: ${f.message}`), checkErrors: r.checkErrors, decision: r.decision?.kind ?? null }));
}

// A wrong pin: the authority is raised as critical on every pass, and acted on (here: would-pause, because nothing is armed) only on the third.
const wrong = new Monitor({ rpc, notifier, pause: null, consecutive: 3, checks: [protocolAuthorities({ admin: '11111111111111111111111111111111' })] });
for (let i = 1; i <= 3; i++) {
  const r = await wrong.pass();
  console.log(JSON.stringify({ wrongPin: i, findings: r.findings.map((f) => `${f.severity}: ${f.message}`), decision: r.decision?.kind ?? null }));
}
