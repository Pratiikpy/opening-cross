// The monitor process. Required: RPC_URL. Everything else is optional (docs/CONFIGURATION.md):
//   MONITOR_INTERVAL_MS (15000)          MONITOR_CONSECUTIVE (3)     passes in a row a critical finding must persist before acting
//   MONITOR_ARM=yes                       act on a confirmed critical finding by pausing new crosses and orders; unset is a dry run
//   MONITOR_GUARDIAN_KEYPAIR              keypair file of the protocol guardian or admin (required when armed)
//   MONITOR_EXPECT_ADMIN / _GUARDIAN / _FEE_RECIPIENT    pin the protocol authorities
//   MONITOR_PROGRAM_PINS                  JSON file { "<program id>": { "sha256": "...", "upgradeAuthority": "..." | null } }; write one with --print-pins
//   MONITOR_PIN_STRICT=1                  a changed executable is critical instead of a warning
//   MONITOR_WATCH                         JSON file of watched wallets [{ address, label, role, mints?, minAtoms? }]
//   MONITOR_BACKING_URL                   base URL of an Opening Cross API; reports real-asset tokens whose backing is not verified (warning only)
//   MONITOR_WEBHOOK_URL, MONITOR_LOG_FILE where findings and decisions go besides standard output
//   MONITOR_PROGRAMS                      comma-separated program ids to pin or print (default: the five Opening Cross programs)
import { readFileSync } from 'node:fs';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { CROSS_CALENDAR_PROGRAM_ADDRESS } from '@opening-cross/cross-calendar-client';
import { CROSS_CORE_PROGRAM_ADDRESS } from '@opening-cross/cross-core-client';
import { CROSS_GATE_PROGRAM_ADDRESS } from '@opening-cross/cross-gate-client';
import { CROSS_SETTLE_PROGRAM_ADDRESS } from '@opening-cross/cross-settle-client';
import { TREASURY_PROGRAM_ADDRESS } from '@opening-cross/treasury-client';
import { Monitor } from './engine.js';
import { combine, consoleNotifier, fileNotifier, webhookNotifier } from './notify.js';
import { guardianPause } from './pause.js';
import { jsonRpc } from './rpc.js';
import { backingFeedFromApi, backingStatus } from './checks/backing.js';
import { programIntegrity, protocolAuthorities, readProgram, type ProgramPins } from './checks/protocol.js';
import { stuckCrosses } from './checks/stuck.js';
import { vaultCoversOrders } from './checks/vault.js';
import { watchedWallets, type WatchedWallet } from './checks/wallets.js';

const env = process.env;
const fail = (m: string): never => {
  console.error(m);
  process.exit(2);
};
const RPC_URL = env.RPC_URL ?? fail('RPC_URL is required');
const rpc = jsonRpc(RPC_URL);
// The five programs, from the clients' own constants: an address is never typed by hand.
const PROGRAMS = env.MONITOR_PROGRAMS ? env.MONITOR_PROGRAMS.split(',').filter(Boolean) : [CROSS_CORE_PROGRAM_ADDRESS, CROSS_GATE_PROGRAM_ADDRESS, CROSS_SETTLE_PROGRAM_ADDRESS, CROSS_CALENDAR_PROGRAM_ADDRESS, TREASURY_PROGRAM_ADDRESS];

if (process.argv.includes('--print-pins')) {
  // The values currently deployed, for an operator to review and save as the pin file. Nothing is pinned by printing them.
  const pins: Record<string, { sha256: string; upgradeAuthority: string | null }> = {};
  for (const p of PROGRAMS) {
    const s = await readProgram(rpc, p);
    if (s) pins[p] = { sha256: s.executableSha256, upgradeAuthority: s.upgradeAuthority };
    else console.error(`${p} is not an upgradeable program on this cluster`);
  }
  console.log(JSON.stringify(pins, null, 2));
  process.exit(0);
}

const consecutive = Number(env.MONITOR_CONSECUTIVE ?? 3);
const intervalMs = Number(env.MONITOR_INTERVAL_MS ?? 15_000);
if (!Number.isInteger(consecutive) || consecutive < 1) fail('MONITOR_CONSECUTIVE must be a positive integer');
if (!Number.isInteger(intervalMs) || intervalMs < 1_000) fail('MONITOR_INTERVAL_MS must be at least 1000');
const armed = env.MONITOR_ARM === 'yes';
if (env.MONITOR_ARM !== undefined && env.MONITOR_ARM !== 'yes' && env.MONITOR_ARM !== '') fail('MONITOR_ARM is either "yes" or unset');
let pause = null;
if (armed) {
  const path = env.MONITOR_GUARDIAN_KEYPAIR ?? fail('MONITOR_GUARDIAN_KEYPAIR is required when MONITOR_ARM=yes');
  pause = guardianPause(RPC_URL, await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[])));
}
const pins = env.MONITOR_PROGRAM_PINS ? (JSON.parse(readFileSync(env.MONITOR_PROGRAM_PINS, 'utf8')) as ProgramPins) : null;
const watch = env.MONITOR_WATCH ? (JSON.parse(readFileSync(env.MONITOR_WATCH, 'utf8')) as WatchedWallet[]) : [];
const notifiers = [consoleNotifier(), ...(env.MONITOR_LOG_FILE ? [fileNotifier(env.MONITOR_LOG_FILE)] : []), ...(env.MONITOR_WEBHOOK_URL ? [webhookNotifier(env.MONITOR_WEBHOOK_URL)] : [])];
const monitor = new Monitor({
  rpc,
  consecutive,
  pause,
  notifier: combine(notifiers),
  checks: [
    vaultCoversOrders(),
    protocolAuthorities({ ...(env.MONITOR_EXPECT_ADMIN ? { admin: env.MONITOR_EXPECT_ADMIN } : {}), ...(env.MONITOR_EXPECT_GUARDIAN ? { guardian: env.MONITOR_EXPECT_GUARDIAN } : {}), ...(env.MONITOR_EXPECT_FEE_RECIPIENT ? { feeRecipient: env.MONITOR_EXPECT_FEE_RECIPIENT } : {}) }),
    ...(pins ? [programIntegrity(pins, { executableSeverity: env.MONITOR_PIN_STRICT === '1' ? 'critical' : 'warning' })] : []),
    stuckCrosses(),
    ...(watch.length ? [watchedWallets(watch)] : []),
    ...(env.MONITOR_BACKING_URL ? [backingStatus(backingFeedFromApi(env.MONITOR_BACKING_URL))] : []),
  ],
});
console.log(JSON.stringify({ at: new Date().toISOString(), msg: 'opening-cross monitor', mode: armed ? 'ARMED: will pause new crosses and orders on a confirmed critical finding' : 'dry run: will only report what it would do', consecutive, intervalMs, programsPinned: pins ? Object.keys(pins).length : 0, wallets: watch.length }));
let stop = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (stop = true));
while (!stop) {
  try {
    await monitor.pass();
  } catch (e) {
    console.error(JSON.stringify({ at: new Date().toISOString(), error: e instanceof Error ? e.message : String(e) }));
  }
  await new Promise((r) => setTimeout(r, intervalMs));
}
