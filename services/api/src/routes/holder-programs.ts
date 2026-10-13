// Which version of each on-chain program the connected cluster runs: the first release, or the one with the Wave 2D extensions.
//
//   GET /v1/programs   -> { network?, checkedAt, programs: { crossCore, treasury } }
//        each: { address, deployedSlot, extended: true | false | null, checked: [...], note }
//
// Why it exists. The rules, classes, lockups, votes, NAV redemption and the rest are built and proved on LiteSVM and a local validator and are
// NOT deployed to devnet until the operations key is funded (docs/HUMAN_TASKS.md H27). A screen must not offer an action the deployed program
// cannot perform, and a cross or a treasury of the first release carries no mark of what the program could do instead: its extension tail is
// simply absent, which a creator who never set rules also produces. This route answers for the program, from the program's own bytes.
//
// How. An Anchor program compares the 8-byte instruction discriminator in its dispatch, and the compiler loads it with one `lddw`
// (opcode 0x18, the low four bytes in the first slot's immediate, the high four bytes in the second's). The program account names its
// ProgramData account; the instructions are searched there. The new instructions are present in the extended program and absent in the
// first release. A control instruction that every release has must be found, or the scan is not trusted and the answer is `null`
// ("unknown"), never "earlier": an unreadable program is not reported as an old one.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Address, getAddressDecoder } from '@solana/kit';
import { COMMIT_ORDER_EXT_DISCRIMINATOR, CREATE_CROSS_DISCRIMINATOR, CROSS_CORE_PROGRAM_ADDRESS, DRAW_BEGIN_DISCRIMINATOR, SET_RULES_DISCRIMINATOR } from '@opening-cross/sdk';
import { CLAIM_PARTNER_FEE_DISCRIMINATOR, CREATE_GREENSHOE_DISCRIMINATOR, CROSS_SETTLE_PROGRAM_ADDRESS, OPEN_DBC_POOL_DISCRIMINATOR } from '@opening-cross/cross-settle-client';
import { INIT_EXT_DISCRIMINATOR, NAV_REDEEM_DISCRIMINATOR, SPEND_DISCRIMINATOR, STAKE_DISCRIMINATOR, TREASURY_PROGRAM_ADDRESS, VOTE_DISCRIMINATOR } from '@opening-cross/treasury-client';

type ChainAccount = { data: Uint8Array; owner: Address };
export type ProgramsDeps = {
  account: (a: Address) => Promise<ChainAccount | null>;
  network?: string;
  clock?: () => number;
  /** How long an answer is kept, in milliseconds (default ten minutes: a program changes only when it is upgraded). */
  ttlMs?: number;
};

const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const HEADER = 45; // u32 tag, u64 slot, u8 option, 32-byte upgrade authority

/** Whether `disc` is loaded by an `lddw` anywhere in `elf`: opcode 0x18 with the low half in the first immediate and the high half in the second's. */
export function loadsDiscriminator(elf: Uint8Array, disc: Uint8Array): boolean {
  const at = (i: number, k: number) => elf[i + k]!;
  for (let i = 0; i + 16 <= elf.length; i++) {
    if (at(i, 0) !== 0x18) continue;
    let ok = true;
    for (let k = 0; k < 4 && ok; k++) ok = at(i, 4 + k) === disc[k] && at(i, 12 + k) === disc[4 + k];
    if (ok) return true;
  }
  return false;
}

export type ProgramReport = {
  address: string;
  /** The slot of the last deploy, from the ProgramData account; null when the program could not be read. */
  deployedSlot: string | null;
  /** True: the extended program. False: the first release. Null: the program could not be read or the scan is not trusted. */
  extended: boolean | null;
  checked: { instruction: string; present: boolean }[];
  note: string;
};

async function report(d: ProgramsDeps, address: Address, control: [string, Uint8Array], needs: [string, Uint8Array][], what: string): Promise<ProgramReport> {
  const unknown = (note: string, deployedSlot: string | null = null): ProgramReport => ({ address, deployedSlot, extended: null, checked: [], note });
  let program: ChainAccount | null;
  try {
    program = await d.account(address);
  } catch {
    return unknown('The program account could not be read just now.');
  }
  if (!program || program.owner !== LOADER || program.data.length < 36) return unknown('No upgradeable program is deployed at this address on this cluster.');
  const dataAddress = getAddressDecoder().decode(program.data.subarray(4, 36));
  let data: ChainAccount | null;
  try {
    data = await d.account(dataAddress);
  } catch {
    return unknown('The program data could not be read just now.');
  }
  if (!data || data.data.length < HEADER + 64) return unknown('The program data account is missing or too short to hold a program.');
  const slot = new DataView(data.data.buffer, data.data.byteOffset).getBigUint64(4, true).toString();
  const elf = data.data.subarray(HEADER);
  if (!loadsDiscriminator(elf, control[1])) return unknown(`The scan could not find ${control[0]}, which every release has, so it is not trusted: whether ${what} is deployed is not known.`, slot);
  const checked = [{ instruction: control[0], present: true }, ...needs.map(([instruction, disc]) => ({ instruction, present: loadsDiscriminator(elf, disc) }))];
  const extended = needs.every((_n, i) => checked[i + 1]!.present);
  return {
    address,
    deployedSlot: slot,
    extended,
    checked,
    note: extended ? `The deployed program has the ${what}.` : `The deployed program is the first release: it does not have the ${what} yet (docs/HUMAN_TASKS.md H27). An action that needs it is refused by the program with InstructionFallbackNotFound.`,
  };
}

export function registerHolderPrograms(app: FastifyInstance, d: ProgramsDeps): void {
  const now = () => (d.clock ? d.clock() * 1000 : Date.now());
  const ttl = d.ttlMs ?? 600_000;
  type Body = { network?: string; checkedAt: number; programs: { crossCore: ProgramReport; treasury: ProgramReport; crossSettle: ProgramReport } };
  let kept: { at: number; body: Body } | null = null;
  let inflight: Promise<Body> | null = null;

  async function read() {
    const [crossCore, treasury, crossSettle] = await Promise.all([
      report(d, CROSS_CORE_PROGRAM_ADDRESS, ['create_cross', CREATE_CROSS_DISCRIMINATOR as Uint8Array], [['set_rules', SET_RULES_DISCRIMINATOR as Uint8Array], ['commit_order_ext', COMMIT_ORDER_EXT_DISCRIMINATOR as Uint8Array], ['draw_begin', DRAW_BEGIN_DISCRIMINATOR as Uint8Array]], 'rules extension (ending, classes, lockups, draw)'),
      report(d, TREASURY_PROGRAM_ADDRESS, ['spend', SPEND_DISCRIMINATOR as Uint8Array], [['init_ext', INIT_EXT_DISCRIMINATOR as Uint8Array], ['vote', VOTE_DISCRIMINATOR as Uint8Array], ['nav_redeem', NAV_REDEEM_DISCRIMINATOR as Uint8Array], ['stake', STAKE_DISCRIMINATOR as Uint8Array]], 'treasury extension (votes, NAV redemption, distributions)'),
      report(d, CROSS_SETTLE_PROGRAM_ADDRESS, ['open_dbc_pool', OPEN_DBC_POOL_DISCRIMINATOR as Uint8Array], [['claim_partner_fee', CLAIM_PARTNER_FEE_DISCRIMINATOR as Uint8Array], ['create_greenshoe', CREATE_GREENSHOE_DISCRIMINATOR as Uint8Array]], 'settlement extension (partner fees, greenshoe)'),
    ]);
    return { ...(d.network && { network: d.network }), checkedAt: Math.floor(now() / 1000), programs: { crossCore, treasury, crossSettle } };
  }

  app.get('/v1/programs', async (_req, reply: FastifyReply) => {
    // A definite answer is kept for the TTL; an unknown one is asked again at once, so a busy endpoint does not pin "unknown" for ten minutes.
    if (kept && now() - kept.at < ttl) return reply.code(200).type('application/json').send(kept.body);
    inflight ??= read().finally(() => {
      inflight = null;
    });
    const body = await inflight;
    if (body.programs.crossCore.extended !== null && body.programs.treasury.extended !== null) kept = { at: now(), body };
    return reply.code(200).type('application/json').send(body);
  });
}
