// GET /v1/programs: which release of cross_core and treasury the cluster runs, read from the program's own bytes. The ProgramData accounts here
// are built in memory: a block of filler with the `lddw` that loads each instruction's 8-byte discriminator, as the compiler emits it.
import Fastify from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type Address, getAddressEncoder } from '@solana/kit';
import { COMMIT_ORDER_EXT_DISCRIMINATOR, CREATE_CROSS_DISCRIMINATOR, CROSS_CORE_PROGRAM_ADDRESS, DRAW_BEGIN_DISCRIMINATOR, SET_RULES_DISCRIMINATOR } from '@opening-cross/sdk';
import { CLAIM_PARTNER_FEE_DISCRIMINATOR, CREATE_GREENSHOE_DISCRIMINATOR, CROSS_SETTLE_PROGRAM_ADDRESS, OPEN_DBC_POOL_DISCRIMINATOR } from '@opening-cross/cross-settle-client';
import { INIT_EXT_DISCRIMINATOR, NAV_REDEEM_DISCRIMINATOR, SPEND_DISCRIMINATOR, STAKE_DISCRIMINATOR, TREASURY_PROGRAM_ADDRESS, VOTE_DISCRIMINATOR } from '@opening-cross/treasury-client';
import { loadsDiscriminator, registerHolderPrograms } from '../src/routes/holder-programs.js';

const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111' as Address;
const DATA_A = '4NCYB3kRT8sCNodPNuCZo8VkwveZSHhg7R7mrRBFM1Uy' as Address;
const DATA_B = 'SysvarRent111111111111111111111111111111111' as Address;

/** Eight-byte-aligned filler with one lddw per discriminator: 0x18, regs, offset, low half, then 0 0 0 0 and the high half. */
function elf(discs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(4096 + discs.length * 64);
  out.fill(0x07, 0, 4096);
  discs.forEach((d, n) => {
    const at = 4096 + n * 64;
    out[at] = 0x18;
    out[at + 1] = 0x01;
    out.set(d.subarray(0, 4), at + 4);
    out.set(d.subarray(4, 8), at + 12);
  });
  return out;
}
const programData = (body: Uint8Array, slot = 777n): Uint8Array => {
  const out = new Uint8Array(45 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 3, true);
  view.setBigUint64(4, slot, true);
  out.set(body, 45);
  return out;
};
const programAccount = (data: Address) => {
  const out = new Uint8Array(36);
  new DataView(out.buffer).setUint32(0, 2, true);
  out.set(getAddressEncoder().encode(data), 4);
  return out;
};

const FIRST_CORE = [CREATE_CROSS_DISCRIMINATOR] as Uint8Array[];
const NEW_CORE = [...FIRST_CORE, SET_RULES_DISCRIMINATOR, COMMIT_ORDER_EXT_DISCRIMINATOR, DRAW_BEGIN_DISCRIMINATOR] as Uint8Array[];
const FIRST_TREASURY = [SPEND_DISCRIMINATOR] as Uint8Array[];
const NEW_TREASURY = [...FIRST_TREASURY, INIT_EXT_DISCRIMINATOR, VOTE_DISCRIMINATOR, NAV_REDEEM_DISCRIMINATOR, STAKE_DISCRIMINATOR] as Uint8Array[];

const DATA_C = '11111111111111111111111111111115' as Address;

async function ask(core: Uint8Array[] | null, treasury: Uint8Array[] | null, reads: { count: number } = { count: 0 }, settle: Uint8Array[] | null = null) {
  const accounts = new Map<string, { data: Uint8Array; owner: Address }>();
  if (core) {
    accounts.set(CROSS_CORE_PROGRAM_ADDRESS, { data: programAccount(DATA_A), owner: LOADER });
    accounts.set(DATA_A, { data: programData(elf(core)), owner: LOADER });
  }
  if (treasury) {
    accounts.set(TREASURY_PROGRAM_ADDRESS, { data: programAccount(DATA_B), owner: LOADER });
    accounts.set(DATA_B, { data: programData(elf(treasury), 888n), owner: LOADER });
  }
  if (settle) {
    accounts.set(CROSS_SETTLE_PROGRAM_ADDRESS, { data: programAccount(DATA_C), owner: LOADER });
    accounts.set(DATA_C, { data: programData(elf(settle), 889n), owner: LOADER });
  }
  const app = Fastify();
  registerHolderPrograms(app, {
    account: async (a) => {
      reads.count++;
      return accounts.get(a) ?? null;
    },
    network: 'devnet',
    clock: () => 1_800_000_000,
  });
  const res = await app.inject({ method: 'GET', url: '/v1/programs' });
  return { app, body: JSON.parse(res.body), status: res.statusCode };
}

describe('GET /v1/programs', () => {
  it('reports the first release of both programs as not extended, and says what that means', async () => {
    const { body, status } = await ask(FIRST_CORE, FIRST_TREASURY);
    expect(status).toBe(200);
    expect(body.network).toBe('devnet');
    expect(body.programs.crossCore).toMatchObject({ address: CROSS_CORE_PROGRAM_ADDRESS, deployedSlot: '777', extended: false });
    expect(body.programs.treasury).toMatchObject({ address: TREASURY_PROGRAM_ADDRESS, deployedSlot: '888', extended: false });
    expect(body.programs.crossCore.note).toMatch(/first release.*H27.*InstructionFallbackNotFound/);
    expect(body.programs.crossCore.checked).toEqual([
      { instruction: 'create_cross', present: true },
      { instruction: 'set_rules', present: false },
      { instruction: 'commit_order_ext', present: false },
      { instruction: 'draw_begin', present: false },
    ]);
  });

  it('reports the extended programs as extended', async () => {
    const { body } = await ask(NEW_CORE, NEW_TREASURY);
    expect(body.programs.crossCore.extended).toBe(true);
    expect(body.programs.treasury.extended).toBe(true);
    expect(body.programs.treasury.checked.every((c: { present: boolean }) => c.present)).toBe(true);
  });

  it('answers for each program on its own: one upgraded, the other not', async () => {
    const { body } = await ask(NEW_CORE, FIRST_TREASURY);
    expect(body.programs.crossCore.extended).toBe(true);
    expect(body.programs.treasury.extended).toBe(false);
  });

  it('is not extended when only some of the new instructions are present', async () => {
    const { body } = await ask([...FIRST_CORE, SET_RULES_DISCRIMINATOR as Uint8Array], FIRST_TREASURY);
    expect(body.programs.crossCore.extended).toBe(false);
  });

  it('answers unknown, never "first release", when the program is missing or the control instruction cannot be found', async () => {
    const missing = await ask(null, FIRST_TREASURY);
    expect(missing.body.programs.crossCore.extended).toBeNull();
    expect(missing.body.programs.crossCore.note).toMatch(/No upgradeable program/);
    const noControl = await ask([SET_RULES_DISCRIMINATOR as Uint8Array], FIRST_TREASURY);
    expect(noControl.body.programs.crossCore.extended).toBeNull();
    expect(noControl.body.programs.crossCore.note).toMatch(/not trusted/);
    expect(noControl.body.programs.crossCore.deployedSlot).toBe('777');
  });

  it('answers unknown when the cluster cannot be read, and asks again next time', async () => {
    const app = Fastify();
    let fail = true;
    registerHolderPrograms(app, {
      account: async () => {
        if (fail) throw new Error('429');
        return null;
      },
    });
    const first = JSON.parse((await app.inject({ method: 'GET', url: '/v1/programs' })).body);
    expect(first.programs.crossCore.extended).toBeNull();
    expect(first.programs.crossCore.note).toMatch(/could not be read/);
    fail = false;
    const second = JSON.parse((await app.inject({ method: 'GET', url: '/v1/programs' })).body);
    expect(second.programs.crossCore.note).toMatch(/No upgradeable program/);
  });

  it('keeps a definite answer for the time to live instead of reading a megabyte per request', async () => {
    const reads = { count: 0 };
    const { app } = await ask(FIRST_CORE, FIRST_TREASURY, reads);
    const after = reads.count;
    // Core and treasury read their program and its data (4); the settle program is absent in this fixture (1), and absent again for the batch 2 instructions (1);
    // each of the seven Wave 3D programs is absent (1 each).
    expect(after).toBe(13);
    await app.inject({ method: 'GET', url: '/v1/programs' });
    expect(reads.count).toBe(after);
  });
});

describe('loadsDiscriminator', () => {
  it('finds an lddw load and nothing else', () => {
    const body = elf([SET_RULES_DISCRIMINATOR as Uint8Array]);
    expect(loadsDiscriminator(body, SET_RULES_DISCRIMINATOR as Uint8Array)).toBe(true);
    expect(loadsDiscriminator(body, VOTE_DISCRIMINATOR as Uint8Array)).toBe(false);
    // The eight bytes written side by side are not an lddw and are not counted.
    const plain = new Uint8Array(256);
    plain.set(SET_RULES_DISCRIMINATOR as Uint8Array, 64);
    expect(loadsDiscriminator(plain, SET_RULES_DISCRIMINATOR as Uint8Array)).toBe(false);
  });

  it('agrees with the real extended cross_core build when it is on disk', () => {
    const path = fileURLToPath(new URL('../../../target/deploy/cross_core.so', import.meta.url));
    if (!existsSync(path)) return;
    const so = new Uint8Array(readFileSync(path));
    for (const d of NEW_CORE) expect(loadsDiscriminator(so, d)).toBe(true);
    expect(loadsDiscriminator(so, VOTE_DISCRIMINATOR as Uint8Array)).toBe(false);
  });

  it('tells the first release of cross_settle from the one with partner fees and the greenshoe', async () => {
    const first = await ask(FIRST_CORE, FIRST_TREASURY, undefined, [OPEN_DBC_POOL_DISCRIMINATOR] as Uint8Array[]);
    expect(first.body.programs.crossSettle.extended).toBe(false);
    const next = await ask(FIRST_CORE, FIRST_TREASURY, undefined, [OPEN_DBC_POOL_DISCRIMINATOR, CLAIM_PARTNER_FEE_DISCRIMINATOR, CREATE_GREENSHOE_DISCRIMINATOR] as Uint8Array[]);
    expect(next.body.programs.crossSettle.extended).toBe(true);
  });
});
