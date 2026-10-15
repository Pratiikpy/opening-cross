// The error tables of the seven Wave 3D programs: every error of every IDL is in the table with its words, a failure of each program is diagnosed from real-shaped logs with the right
// category, and the program the table is generated from is the one the clients carry.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROGRAMS, diagnose, knownPrograms, lookupError } from '../src/index.js';

const PROGRAMS_3D = [
  ['cross_mandate', 'mandate', 'Opening Cross mandate'],
  ['cross_conviction', 'conviction', 'Opening Cross conviction'],
  ['cross_basket', 'basket', 'Opening Cross basket'],
  ['cross_listing', 'listing', 'Opening Cross listing'],
  ['cross_bounty', 'bounty', 'Opening Cross bounty'],
  ['cross_backing', 'backing', 'Opening Cross backing'],
  ['cross_graduate', 'graduate', 'Opening Cross graduate'],
] as const;
const idl = (program: string, short: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../cross-${short}-client/idl/${program}.json`, import.meta.url)), 'utf8')) as { address: string; errors: { code: number; name: string; msg: string }[] };

describe('the tables', () => {
  for (const [program, short, label] of PROGRAMS_3D) {
    it(`${program}: every error of the IDL is in the table, with the program id and the words`, () => {
      const i = idl(program, short);
      const t = PROGRAMS.find((p) => p.address === i.address);
      expect(t, program).toBeDefined();
      expect(t!.label).toBe(label);
      expect(Object.keys(t!.errors).map(Number).sort((a, b) => a - b)).toEqual(i.errors.map((e) => e.code).sort((a, b) => a - b));
      for (const e of i.errors) expect(lookupError(i.address, e.code), `${program} ${e.name}`).toEqual({ name: e.name, message: e.msg, source: expect.any(String) });
    });
  }

  it('lists the programs it can explain, the seven among them', () => {
    const labels = knownPrograms().map((p) => p.label);
    for (const [, , label] of PROGRAMS_3D) expect(labels).toContain(label);
  });

  it('has the new cross_settle errors the batch 2 upgrade adds', () => {
    const settle = idl('cross_settle', 'settle');
    const byName = Object.fromEntries(settle.errors.map((e) => [e.name, e.code]));
    for (const n of ['GraduationNotApproved', 'FutarchyNeedsLegacyTokens', 'PresaleNotFixedPrice']) {
      expect(byName[n], n).toBeDefined();
      expect(lookupError(settle.address, byName[n]!)?.name).toBe(n);
    }
  });
});

describe('failures of the Wave 3D programs, in words', () => {
  const MANDATE = idl('cross_mandate', 'mandate').address;
  const GRADUATE = idl('cross_graduate', 'graduate').address;
  const SETTLE = idl('cross_settle', 'settle').address;
  const code = (program: string, short: string, name: string) => idl(program, short).errors.find((e) => e.name === name)!.code;
  const run = (program: string, instruction: string, name: string, number: number, message: string) => [
    `Program ${program} invoke [1]`,
    `Program log: Instruction: ${instruction}`,
    `Program log: AnchorError thrown in programs/x/src/lib.rs:1. Error Code: ${name}. Error Number: ${number}. Error Message: ${message}.`,
    `Program ${program} failed: custom program error: 0x${number.toString(16)}`,
  ];

  it('an order over a mandate\'s share limit names the program, the instruction and the rule', () => {
    const n = code('cross_mandate', 'mandate', 'OverShareLimit');
    const d = diagnose({ err: { InstructionError: [0, { Custom: n }] }, logs: run(MANDATE, 'PlaceOrder', 'OverShareLimit', n, "Order could buy more than the share limit of the cross's supply") });
    expect(d.where).toMatchObject({ instruction: 'PlaceOrder', program: { address: MANDATE, label: 'Opening Cross mandate' } });
    expect(d.error).toMatchObject({ source: 'program', name: 'OverShareLimit', code: n });
    expect(d.tableAgreesWithProgram).toBe(true);
    expect(d.summary).toMatch(/Opening Cross mandate refused the transaction while running PlaceOrder: OverShareLimit/);
  });

  it('puts each error in the category a person can act on', () => {
    const cat = (program: string, short: string, name: string) => {
      const n = code(program, short, name);
      return diagnose({ err: { InstructionError: [0, { Custom: n }] }, logs: run(idl(program, short).address, 'X', name, n, 'm') }).category;
    };
    expect(cat('cross_mandate', 'mandate', 'Revoked')).toBe('state');
    expect(cat('cross_mandate', 'mandate', 'Expired')).toBe('state');
    expect(cat('cross_mandate', 'mandate', 'Unauthorized')).toBe('authority');
    expect(cat('cross_conviction', 'conviction', 'StillLocked')).toBe('state');
    expect(cat('cross_listing', 'listing', 'BondEncumbered')).toBe('state');
    expect(cat('cross_bounty', 'bounty', 'StillCommitted')).toBe('state');
    expect(cat('cross_bounty', 'bounty', 'AlreadyPaid')).toBe('state');
    expect(cat('cross_backing', 'backing', 'Backed')).toBe('state');
    expect(cat('cross_graduate', 'graduate', 'WindowOpen')).toBe('state');
    expect(cat('cross_graduate', 'graduate', 'NoRoundsLeft')).toBe('state');
    expect(cat('cross_basket', 'basket', 'Insolvent')).toBe('program-rule');
    expect(cat('cross_mandate', 'mandate', 'Overflow')).toBe('math');
  });

  it('a seeding refused for want of a vote says so, with advice for a state error', () => {
    const n = idl('cross_settle', 'settle').errors.find((e) => e.name === 'GraduationNotApproved')!.code;
    const d = diagnose({ err: { InstructionError: [1, { Custom: n }] }, logs: run(SETTLE, 'SeedDammV2', 'GraduationNotApproved', n, 'x') });
    expect(d.error).toMatchObject({ name: 'GraduationNotApproved', source: 'program' });
    expect(d.where.program?.address).toBe(SETTLE);
    expect(d.tableAgreesWithProgram).toBe(true);
  });

  it('does not take another program\'s error for a Wave 3D one: the same number means different things in different programs', () => {
    const revoked = code('cross_mandate', 'mandate', 'Revoked');
    expect(lookupError(MANDATE, revoked)?.name).toBe('Revoked');
    expect(lookupError(GRADUATE, revoked)?.name).not.toBe('Revoked');
  });
});
