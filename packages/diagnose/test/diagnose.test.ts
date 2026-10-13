import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ANCHOR_FRAMEWORK, PROGRAMS, diagnose, diagnoseSignature, failingFrame, fromKitError, knownPrograms, lookupError } from '../src/index.js';

const DBC = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
const DAMM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const CB = 'ComputeBudget111111111111111111111111111111';
const CORE = 'F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ';
const hex = (n: number) => `0x${n.toString(16)}`;

const slippageLogs = [
  `Program ${CB} invoke [1]`,
  `Program ${CB} success`,
  `Program ${DBC} invoke [1]`,
  'Program log: Instruction: Swap2',
  'Program log: AnchorError thrown in programs/dynamic-bonding-curve/src/instructions/swap/ix_swap.rs:55. Error Code: ExceededSlippage. Error Number: 6002. Error Message: Exceeded slippage tolerance.',
  `Program ${DBC} consumed 21340 of 200000 compute units`,
  `Program ${DBC} failed: custom program error: ${hex(6002)}`,
];
const customErr = (index: number, code: number) => ({ InstructionError: [index, { Custom: code }] });

describe('a slippage failure on a bonding curve', () => {
  const d = diagnose({ err: customErr(1, 6002), logs: slippageLogs });
  it('names the program, the instruction and the error, in words', () => {
    expect(d.category).toBe('slippage');
    expect(d.where).toMatchObject({ instructionIndex: 1, callDepth: 1, instruction: 'Swap2', program: { address: DBC, label: 'Meteora Dynamic Bonding Curve' } });
    expect(d.error).toMatchObject({ source: 'program', code: 6002, name: 'ExceededSlippage', message: 'Exceeded slippage tolerance' });
    expect(d.summary).toBe('Meteora Dynamic Bonding Curve refused the transaction while running Swap2: ExceededSlippage (Exceeded slippage tolerance).');
  });
  it('checks its table against what the program itself logged', () => {
    expect(d.programLog).toMatchObject({ name: 'ExceededSlippage', number: 6002, file: 'programs/dynamic-bonding-curve/src/instructions/swap/ix_swap.rs:55' });
    expect(d.tableAgreesWithProgram).toBe(true);
    expect(d.error.table).toMatchObject({ label: 'Meteora Dynamic Bonding Curve', version: '0.2.1' });
  });
  it('tells the user what to do, and that nothing was traded but the fee was paid', () => {
    expect(d.advice.join(' ')).toMatch(/fresh quote/);
    expect(d.advice.at(-1)).toMatch(/network fee, which is still charged/);
  });
});

describe('finding the failing instruction', () => {
  it('reports the innermost program when a router calls a pool, and the top-level instruction it sits in', () => {
    const logs = [
      `Program ${CB} invoke [1]`,
      `Program ${CB} success`,
      `Program ${JUP} invoke [1]`,
      'Program log: Instruction: RouteV2',
      `Program ${DAMM} invoke [2]`,
      'Program log: Instruction: Swap',
      'Program log: AnchorError thrown in programs/cp-amm/src/instructions/swap.rs:90. Error Code: ExceededSlippage. Error Number: 6002. Error Message: Exceeded slippage tolerance.',
      `Program ${DAMM} failed: custom program error: 0x1772`,
      `Program ${JUP} failed: custom program error: 0x1772`,
    ];
    const d = diagnose({ err: customErr(1, 6002), logs });
    expect(d.where).toMatchObject({ instructionIndex: 1, callDepth: 2, instruction: 'Swap', program: { address: DAMM } });
    expect(d.error.name).toBe('ExceededSlippage');
    expect(d.tableAgreesWithProgram).toBe(true);
  });

  it('does not blame a program that succeeded earlier in the transaction', () => {
    const logs = [`Program ${DBC} invoke [1]`, 'Program log: Instruction: Swap2', `Program ${DBC} success`, `Program ${DAMM} invoke [1]`, `Program ${DAMM} failed: custom program error: 0x1772`];
    expect(failingFrame(logs)?.frame).toMatchObject({ program: DAMM, top: 1 });
  });

  it('falls back to the instruction index and the transaction\'s own program list when there are no logs', () => {
    const d = diagnose({ err: customErr(2, 6002), logs: [], instructionPrograms: [CB, CB, DAMM] });
    expect(d.where).toMatchObject({ instructionIndex: 2, program: { address: DAMM } });
    expect(d.error.name).toBe('ExceededSlippage');
    expect(d.tableAgreesWithProgram).toBeNull();
  });
});

describe('a table that has gone stale', () => {
  it('trusts the program\'s own log and says the IDL is behind', () => {
    const logs = [
      `Program ${DBC} invoke [1]`,
      'Program log: Instruction: Swap2',
      'Program log: AnchorError thrown in x.rs:1. Error Code: SomethingNewer. Error Number: 6002. Error Message: A rule added after the IDL was cut.',
      `Program ${DBC} failed: custom program error: 0x1772`,
    ];
    const d = diagnose({ err: customErr(0, 6002), logs });
    expect(d.tableAgreesWithProgram).toBe(false);
    expect(d.advice[0]).toMatch(/newer than the IDL.*trust the program's own log/);
    expect(d.programLog?.name).toBe('SomethingNewer');
  });
});

describe('swap shortfalls that are not named slippage', () => {
  it('treats the names real swap programs use for "output below your minimum" as slippage', () => {
    for (const name of ['TooLittleOutputReceived', 'MinReturnNotReached', 'InsufficientOutAmount', 'ExceededAmountSlippageTolerance']) {
      const logs = ['Program FakeSwap1111111111111111111111111111111111 invoke [1]', `Program log: AnchorError thrown in swap.rs:9. Error Code: ${name}. Error Number: 6001. Error Message: short.`, 'Program FakeSwap1111111111111111111111111111111111 failed: custom program error: 0x1771'];
      expect(diagnose({ err: customErr(0, 6001), logs }).category, name).toBe('slippage');
    }
  });
});

describe('errors that are not a program\'s own', () => {
  it('maps Anchor framework codes for any Anchor program', () => {
    const logs = ['Program 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin invoke [1]', 'Program log: AnchorError caused by account: pool. Error Code: ConstraintMut. Error Number: 2000. Error Message: A mut constraint was violated.', 'Program 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin failed: custom program error: 0x7d0'];
    const d = diagnose({ err: customErr(0, 2000), logs });
    expect(d.error).toMatchObject({ source: 'anchor-framework', name: 'ConstraintMut', message: 'A mut constraint was violated' });
    expect(d.programLog).toMatchObject({ account: 'pool', number: 2000 });
    expect(d.where.program?.label).toBe('an unlisted program');
    expect(d.summary).toContain('program 9xQeWvG8…');
  });

  it('uses the program\'s own log for a program it has no table for', () => {
    const logs = [`Program ${'Fake1111111111111111111111111111111111111111'} invoke [1]`, 'Program log: AnchorError thrown in a.rs:3. Error Code: NonceAlreadyExists. Error Number: 6000. Error Message: Nonce already exists.', `Program ${'Fake1111111111111111111111111111111111111111'} failed: custom program error: 0x1770`];
    const d = diagnose({ err: customErr(0, 6000), logs });
    expect(d.error).toMatchObject({ source: 'program-log', name: 'NonceAlreadyExists', message: 'Nonce already exists' });
    expect(d.category).toBe('state');
  });

  it('says plainly when a code is in no table and the program logged nothing', () => {
    const d = diagnose({ err: customErr(0, 6999), logs: [`Program ${JUP} invoke [1]`, `Program ${JUP} failed: custom program error: 0x1b57`] });
    expect(d.error).toMatchObject({ source: 'unmapped', code: 6999, name: null });
    expect(d.category).toBe('unknown');
    expect(d.advice[0]).toMatch(/not in any table/);
  });

  it('explains the token program\'s own errors', () => {
    const d = diagnose({ err: customErr(3, 1), logs: ['Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1]', 'Program log: Instruction: Transfer', 'Program log: Error: insufficient funds', 'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x1'] });
    expect(d.error).toMatchObject({ source: 'program', name: 'InsufficientFunds' });
    expect(d.category).toBe('balance');
    expect(d.where.instruction).toBe('Transfer');
  });

  it('explains a protocol error of this repository', () => {
    const logs = [`Program ${CORE} invoke [1]`, `Program ${CORE} failed: custom program error: 0x1770`];
    const d = diagnose({ err: customErr(0, 6000), logs });
    expect(d.error).toMatchObject({ name: 'Paused', message: 'Protocol is paused for new crosses and orders' });
    expect(d.category).toBe('state');
  });
});

describe('runtime and transaction level failures', () => {
  it('compute budget, from the error and from the log', () => {
    const a = diagnose({ err: { InstructionError: [0, 'ComputationalBudgetExceeded'] }, logs: [] });
    expect(a).toMatchObject({ category: 'compute', error: { source: 'runtime', name: 'ComputationalBudgetExceeded' } });
    expect(a.advice[0]).toMatch(/15% above/);
    const b = diagnose({ err: { InstructionError: [1, 'ProgramFailedToComplete'] }, logs: [`Program ${DBC} invoke [1]`, `Program ${DBC} failed: Computational budget exceeded`] });
    expect(b.category).toBe('compute');
    expect(b.where.program?.address).toBe(DBC);
  });

  it('a stale blockhash, a landed duplicate and an empty fee payer', () => {
    expect(diagnose({ err: 'BlockhashNotFound' })).toMatchObject({ category: 'blockhash', error: { source: 'transaction' } });
    expect(diagnose({ err: 'AlreadyProcessed' }).category).toBe('state');
    expect(diagnose({ err: 'InsufficientFundsForFee' }).category).toBe('balance');
    expect(diagnose({ err: 'AccountNotFound' }).advice.join(' ')).toMatch(/airdrop/);
  });

  it('a named runtime error with no code', () => {
    const d = diagnose({ err: { InstructionError: [0, 'MissingRequiredSignature'] }, logs: [] });
    expect(d).toMatchObject({ category: 'authority', error: { name: 'MissingRequiredSignature' } });
  });

  it('never throws on input it does not understand', () => {
    for (const err of [null, undefined, 42, 'Whatever', {}, { InstructionError: 'nope' }, { InstructionError: [0] }, { Other: 1 }]) {
      const d = diagnose({ err, logs: ['garbage', '', 'Program failed: ', 'Program x invoke [zzz]'] });
      expect(d.summary.length).toBeGreaterThan(0);
      expect(d.advice.length).toBeGreaterThan(0);
    }
    expect(diagnose({ err: null, logs: null }).error.source).toBe('unmapped');
  });
});

describe('the tables', () => {
  it('hold every error of every IDL they were generated from', () => {
    for (const [file, address] of [['idls/dynamic_bonding_curve.json', DBC], ['idls/cp_amm.json', DAMM], ['packages/cross-core-client/idl/cross_core.json', CORE]] as const) {
      const idl = JSON.parse(readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8')) as { errors: { code: number; name: string; msg: string }[] };
      const t = PROGRAMS.find((p) => p.address === address)!;
      expect(Object.keys(t.errors)).toHaveLength(idl.errors.length);
      for (const e of idl.errors) expect(t.errors[e.code]).toEqual([e.name, e.msg]);
    }
  });

  it('carry Anchor\'s framework errors with their stated numbers', () => {
    expect(Object.keys(ANCHOR_FRAMEWORK).length).toBeGreaterThanOrEqual(60);
    expect(ANCHOR_FRAMEWORK[100]![0]).toBe('InstructionMissing');
    expect(ANCHOR_FRAMEWORK[101]![1]).toBe('The instruction discriminator did not match any instruction, and no fallback function is defined');
    expect(ANCHOR_FRAMEWORK[2006]![0]).toBe('ConstraintSeeds');
    expect(ANCHOR_FRAMEWORK[3012]![0]).toBe('AccountNotInitialized');
  });

  it('can be queried', () => {
    expect(lookupError(DBC, 6002)).toMatchObject({ name: 'ExceededSlippage' });
    expect(lookupError(DBC, 2003)).toMatchObject({ name: 'ConstraintRaw', source: 'anchor-framework' });
    expect(lookupError(DBC, 6999)).toBeNull();
    expect(knownPrograms().map((p) => p.name)).toEqual(expect.arrayContaining(['dynamic_bonding_curve', 'cp_amm', 'lb_clmm', 'raydium_cp_swap', 'cross_core', 'spl_token']));
  });
});

describe('looking a signature up', () => {
  const rpc = (result: unknown) => ({ call: async () => result }) as never;
  it('explains a failed transaction from the chain\'s own record', async () => {
    const tx = { slot: 9, meta: { err: customErr(1, 6002), logMessages: slippageLogs, fee: 5_000 }, transaction: { message: { accountKeys: [CB, DBC], instructions: [{ programIdIndex: 0 }, { programIdIndex: 1 }] } } };
    const r = await diagnoseSignature(rpc(tx), 'sig');
    expect(r).toMatchObject({ status: 'failed', slot: 9, fee: 5_000 });
    expect(r.status === 'failed' && r.diagnosis.error.name).toBe('ExceededSlippage');
  });
  it('says so when the transaction succeeded or is not found', async () => {
    expect(await diagnoseSignature(rpc({ slot: 3, meta: { err: null }, transaction: { message: { accountKeys: [], instructions: [] } } }), 's')).toEqual({ status: 'succeeded', slot: 3 });
    expect(await diagnoseSignature(rpc(null), 's')).toEqual({ status: 'not-found' });
  });
});

describe('errors thrown by @solana/kit', () => {
  it('reads the logs and the instruction error out of a failed preflight', () => {
    const e = { context: { logs: slippageLogs }, cause: { context: { index: 1, code: 6002 } } };
    const got = fromKitError(e)!;
    expect(got.err).toEqual(customErr(1, 6002));
    expect(diagnose(got).error.name).toBe('ExceededSlippage');
    expect(fromKitError(new Error('x'))).toBeNull();
    expect(fromKitError(null)).toBeNull();
  });
});
