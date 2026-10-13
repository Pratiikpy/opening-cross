// Has anyone changed who controls the protocol, or what the programs are?
//
// The protocol account names an admin (fee schedule, pause, calendar), a guardian (pause) and a fee recipient. Each of the five
// programs has an upgrade authority and executable bytes. All of them are expected to change only by a decision a person made
// and announced. Two ways to say what is expected: pin the values (a config the operator reviewed), and, always, notice a change
// between two passes of this process.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { CROSS_CORE_PROGRAM_ADDRESS, getProtocolDecoder, protocolAddress } from '@opening-cross/sdk';
import type { Check, Finding, Rpc, Severity } from '../types.js';

export type ProtocolExpectation = { admin?: string; guardian?: string; feeRecipient?: string };

export function protocolAuthorities(expect: ProtocolExpectation = {}): Check {
  let last: { admin: string; guardian: string; feeRecipient: string } | null = null;
  return {
    name: 'protocol-authorities',
    async run({ rpc }) {
      const acct = await rpc.getAccount(await protocolAddress());
      if (!acct || acct.owner !== CROSS_CORE_PROGRAM_ADDRESS) {
        return [{ check: 'protocol-authorities', subject: 'protocol', severity: 'critical', message: 'the protocol account is missing or not owned by cross_core', evidence: { exists: acct !== null, owner: acct?.owner ?? null } }];
      }
      const p = getProtocolDecoder().decode(acct.data);
      const now = { admin: p.admin as string, guardian: p.guardian as string, feeRecipient: p.feeRecipient as string };
      const findings: Finding[] = [];
      for (const k of ['admin', 'guardian', 'feeRecipient'] as const) {
        const want = expect[k];
        if (want !== undefined && want !== now[k]) {
          findings.push({ check: 'protocol-authorities', subject: `pin:${k}`, severity: 'critical', message: `the protocol ${k} is ${now[k]}, not the ${want} this monitor was told to expect`, evidence: { field: k, expected: want, actual: now[k] } });
        }
        if (last && last[k] !== now[k]) {
          findings.push({ check: 'protocol-authorities', subject: `change:${k}`, severity: 'critical', message: `the protocol ${k} changed from ${last[k]} to ${now[k]} since the last pass`, evidence: { field: k, before: last[k], after: now[k] } });
        }
      }
      last = now;
      return findings;
    },
  };
}

export type ProgramPin = { sha256?: string; upgradeAuthority?: string | null };
export type ProgramPins = Readonly<Record<string, ProgramPin>>;

const LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export type ProgramState = { programData: string; upgradeAuthority: string | null; executableSha256: string; bytes: number };

/** The upgrade authority and the hash of the executable bytes (trailing zero padding removed, as `solana-verify` does) of an upgradeable program. */
export async function readProgram(rpc: Rpc, program: string): Promise<ProgramState | null> {
  const acct = await rpc.getAccount(program);
  if (!acct || acct.owner !== LOADER_UPGRADEABLE || acct.data.length < 36 || new DataView(acct.data.buffer, acct.data.byteOffset).getUint32(0, true) !== 2) return null;
  const programData = base58(acct.data.subarray(4, 36));
  const pd = await rpc.getAccount(programData);
  if (!pd || pd.data.length < 45 || new DataView(pd.data.buffer, pd.data.byteOffset).getUint32(0, true) !== 3) return null;
  const hasAuthority = pd.data[12] === 1;
  const upgradeAuthority = hasAuthority ? base58(pd.data.subarray(13, 45)) : null;
  let end = pd.data.length;
  while (end > 45 && pd.data[end - 1] === 0) end--;
  return { programData, upgradeAuthority, executableSha256: bytesToHex(sha256(pd.data.subarray(45, end))), bytes: end - 45 };
}

/**
 * Compares each program with its pin. `severity` is what a changed executable is: on devnet, where the team redeploys often, a
 * warning; where a deployment is a decision, critical. A changed upgrade authority is always critical.
 */
export function programIntegrity(pins: ProgramPins, o: { executableSeverity?: Severity } = {}): Check {
  const lastSeen = new Map<string, string>();
  return {
    name: 'program-integrity',
    async run({ rpc }) {
      const findings: Finding[] = [];
      for (const [program, pin] of Object.entries(pins)) {
        const s = await readProgram(rpc, program);
        if (!s) {
          findings.push({ check: 'program-integrity', subject: program, severity: 'critical', message: `${program} is not an upgradeable program on this cluster`, evidence: { program } });
          continue;
        }
        if (pin.upgradeAuthority !== undefined && pin.upgradeAuthority !== s.upgradeAuthority) {
          findings.push({ check: 'program-integrity', subject: `${program}:authority`, severity: 'critical', message: `the upgrade authority of ${program} is ${s.upgradeAuthority ?? 'none (immutable)'}, not the ${pin.upgradeAuthority ?? 'none (immutable)'} that was pinned`, evidence: { program, expected: pin.upgradeAuthority, actual: s.upgradeAuthority } });
        }
        if (pin.sha256 !== undefined && pin.sha256 !== s.executableSha256) {
          findings.push({ check: 'program-integrity', subject: `${program}:bytes`, severity: o.executableSeverity ?? 'warning', message: `the executable of ${program} is not the pinned build (${s.executableSha256.slice(0, 12)}, pinned ${pin.sha256.slice(0, 12)})`, evidence: { program, expected: pin.sha256, actual: s.executableSha256, bytes: s.bytes } });
        }
        const before = lastSeen.get(program);
        if (before !== undefined && before !== s.executableSha256) {
          findings.push({ check: 'program-integrity', subject: `${program}:upgraded`, severity: 'info', message: `${program} was upgraded since the last pass (${before.slice(0, 12)} to ${s.executableSha256.slice(0, 12)})`, evidence: { program, before, after: s.executableSha256 } });
        }
        lastSeen.set(program, s.executableSha256);
      }
      return findings;
    },
  };
}
