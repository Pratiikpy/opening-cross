// Checks, from the chain, what the program accounts' upgrade authorities are and whether each is a Squads v4 vault whose multisig
// has a timelock long enough: at least the longest a cross may stay open plus 72 hours (ADR-0660, PRODUCT_FEATURES W2). It reads;
// it changes nothing, and it signs nothing.
//
//   node scripts/check-upgrade-timelock.mjs [--cluster devnet|mainnet-beta|<rpc url>] [--max-open-days 4] [--multisig <address>]
//
// For each program in Anchor.toml it prints the upgrade authority. With --multisig it also reads that multisig, checks that its
// vault 0 is the authority, and compares its time lock with `max-open-days` plus three days. Exit status 0 only when every
// program passes; with no multisig given, a program whose authority is a plain key fails (that is the state of devnet today).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// The two libraries are dependencies of the LiteSVM test package; resolve them from there so the script needs no install of its own.
const require = createRequire(new URL('../tests/core/package.json', import.meta.url));
const { Connection, PublicKey } = require('@solana/web3.js');
const multisig = require('@sqds/multisig');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const cluster = flag('cluster', 'devnet');
const url = cluster.startsWith('http') ? cluster : `https://api.${cluster}.solana.com`;
const maxOpenDays = Number(flag('max-open-days', '4'));
const multisigAddress = flag('multisig');
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const THREE_DAYS = 3 * 86_400;

const toml = readFileSync(fileURLToPath(new URL('../Anchor.toml', import.meta.url)), 'utf8');
const section = toml.split('[programs.devnet]')[1]?.split('[')[0] ?? '';
const programs = [...section.matchAll(/^(\w+)\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/gm)].map(([, name, id]) => ({ name, id }));
if (programs.length === 0) throw new Error('no [programs.devnet] entries in Anchor.toml');

const connection = new Connection(url, 'confirmed');
let timeLock = null;
let vault = null;
if (multisigAddress) {
  const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, new PublicKey(multisigAddress));
  timeLock = ms.timeLock;
  vault = multisig.getVaultPda({ multisigPda: new PublicKey(multisigAddress), index: 0 })[0].toBase58();
  console.log(`multisig ${multisigAddress}: threshold ${ms.threshold}, ${ms.members.length} members, time lock ${timeLock} s (${(timeLock / 86_400).toFixed(2)} days), vault 0 ${vault}`);
}
const needed = maxOpenDays * 86_400 + THREE_DAYS;
console.log(`policy: a cross may stay open ${maxOpenDays} days, so the time lock must be at least ${needed} s (${(needed / 86_400).toFixed(2)} days)`);

let failures = 0;
for (const { name, id } of programs) {
  const program = new PublicKey(id);
  const [programData] = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER);
  const info = await connection.getAccountInfo(programData);
  if (!info) {
    console.log(`${name.padEnd(17)} ${id}  NOT DEPLOYED on ${cluster}`);
    continue;
  }
  const hasAuthority = info.data[12] === 1;
  const authority = hasAuthority ? new PublicKey(info.data.subarray(13, 45)).toBase58() : null;
  let verdict;
  if (!authority) verdict = 'immutable (no upgrade authority): passes';
  else if (vault && authority === vault && timeLock !== null && timeLock >= needed) verdict = `Squads vault, time lock ${timeLock} s: passes`;
  else if (vault && authority === vault) verdict = `Squads vault but time lock ${timeLock} s is under ${needed} s: FAILS`;
  else verdict = 'a plain key or an unknown authority, no time lock: FAILS';
  if (!verdict.includes('passes')) failures += 1;
  console.log(`${name.padEnd(17)} ${id}  authority ${authority ?? 'none'}  ${verdict}`);
}
console.log(failures === 0 ? 'every deployed program passes' : `${failures} program(s) fail: hand the authority to a Squads multisig with a long enough time lock (docs/HUMAN_TASKS.md H13)`);
process.exitCode = failures === 0 ? 0 : 1;
