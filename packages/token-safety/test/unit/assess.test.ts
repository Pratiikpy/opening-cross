import { describe, expect, it } from 'vitest';
import { type Address, none, some } from '@solana/kit';
import type { Extension, Mint } from '@solana-program/token-2022';
import { LEVEL_OF, MULTIPLIER_CHANGE_HALT_WINDOW_SECONDS, assessMint, assessMintAccount, bySeverity, summaryOf, verdictOf } from '../../src/index.js';

const MINT = 'So11111111111111111111111111111111111111112' as Address;
const PROG = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address;
const ISSUER = 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC' as Address;
const NULL = '11111111111111111111111111111111' as Address;
const NOW = 1_800_000_000n;

function mint(extensions: Extension[] | null, auth: { mint?: boolean; freeze?: boolean } = {}): Mint {
  return {
    mintAuthority: auth.mint ? some(ISSUER) : none(),
    supply: 1_000n,
    decimals: 8,
    isInitialized: true,
    freezeAuthority: auth.freeze ? some(ISSUER) : none(),
    extensions: extensions ? some(extensions) : none(),
  };
}
const codes = (m: Mint) => assessMint(MINT, PROG, m, NOW).risks.map((r) => `${r.code}:${r.severity}`);

describe('assessMint', () => {
  it('a plain fixed-supply mint has no risks and is crossable', () => {
    const r = assessMint(MINT, PROG, mint(null), NOW);
    expect(r.risks).toEqual([]);
    expect(r.crossable).toBe(true);
    expect(r.uiMultiplier).toBe(1);
  });

  it('discloses mint and freeze authorities', () => {
    expect(codes(mint(null, { mint: true, freeze: true }))).toEqual(['MINT_AUTHORITY:disclose', 'FREEZE_AUTHORITY:disclose']);
  });

  it('halts while paused, discloses when pausable but live', () => {
    expect(codes(mint([{ __kind: 'PausableConfig', authority: some(ISSUER), paused: true }]))).toEqual(['MINT_PAUSED:halt']);
    expect(codes(mint([{ __kind: 'PausableConfig', authority: some(ISSUER), paused: false }]))).toEqual(['PAUSE_AUTHORITY:disclose']);
    expect(codes(mint([{ __kind: 'PausableConfig', authority: none(), paused: false }]))).toEqual([]);
    expect(assessMint(MINT, PROG, mint([{ __kind: 'PausableConfig', authority: some(ISSUER), paused: true }]), NOW).crossable).toBe(false);
  });

  it('discloses a permanent delegate but ignores the null address', () => {
    expect(codes(mint([{ __kind: 'PermanentDelegate', delegate: ISSUER }]))).toEqual(['PERMANENT_DELEGATE:disclose']);
    expect(codes(mint([{ __kind: 'PermanentDelegate', delegate: NULL }]))).toEqual([]);
  });

  it('applies the multiplier in force and halts near a scheduled change', () => {
    const sched = (at: bigint): Extension => ({ __kind: 'ScaledUiAmountConfig', authority: ISSUER, multiplier: 1.0039, newMultiplierEffectiveTimestamp: at, newMultiplier: 1.0057 });
    const far = assessMint(MINT, PROG, mint([sched(NOW + MULTIPLIER_CHANGE_HALT_WINDOW_SECONDS + 1n)]), NOW);
    expect(far.uiMultiplier).toBe(1.0039);
    expect(far.risks.map((r) => `${r.code}:${r.severity}`)).toEqual(['SCALED_UI_MULTIPLIER:disclose', 'SCALED_UI_MULTIPLIER_CHANGE_PENDING:disclose']);
    const near = assessMint(MINT, PROG, mint([sched(NOW + 60n)]), NOW);
    expect(near.crossable).toBe(false);
    const past = assessMint(MINT, PROG, mint([sched(NOW - 1n)]), NOW);
    expect(past.uiMultiplier).toBe(1.0057);
    expect(past.risks.map((r) => r.code)).toEqual(['SCALED_UI_MULTIPLIER']);
  });

  it('blocks an active transfer hook, discloses an installable one', () => {
    expect(codes(mint([{ __kind: 'TransferHook', authority: ISSUER, programId: ISSUER }]))).toEqual(['TRANSFER_HOOK:block']);
    expect(codes(mint([{ __kind: 'TransferHook', authority: ISSUER, programId: NULL }]))).toEqual(['TRANSFER_HOOK:disclose']);
    expect(codes(mint([{ __kind: 'TransferHook', authority: NULL, programId: NULL }]))).toEqual([]);
  });

  it('blocks a non-zero transfer fee in either epoch slot', () => {
    const fee = (older: number, newer: number): Extension => ({
      __kind: 'TransferFeeConfig', transferFeeConfigAuthority: ISSUER, withdrawWithheldAuthority: ISSUER, withheldAmount: 0n,
      olderTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: older },
      newerTransferFee: { epoch: 1n, maximumFee: 0n, transferFeeBasisPoints: newer },
    });
    expect(codes(mint([fee(0, 50)]))).toEqual(['TRANSFER_FEE:block']);
    expect(codes(mint([fee(50, 0)]))).toEqual(['TRANSFER_FEE:block']);
    expect(codes(mint([fee(0, 0)]))).toEqual(['TRANSFER_FEE:disclose']);
  });

  it('blocks non-transferable tokens', () => {
    expect(assessMint(MINT, PROG, mint([{ __kind: 'NonTransferable' }]), NOW).crossable).toBe(false);
  });

  it('ignores metadata-only extensions', () => {
    expect(codes(mint([{ __kind: 'MetadataPointer', authority: none(), metadataAddress: some(MINT) } as Extension]))).toEqual([]);
  });

  it('blocks extensions it does not recognise', () => {
    expect(codes(mint([{ __kind: 'CpiGuard', lockCpi: true } as Extension]))).toEqual(['UNKNOWN_EXTENSION:block']);
  });
});

describe('assessMintAccount and verdicts', () => {
  // SPL Mint layout: option(mintAuthority) 36, supply u64, decimals u8, isInitialized u8, option(freezeAuthority) 36.
  const splMint = (decimals: number) => {
    const b = new Uint8Array(82);
    b[44] = 0;
    new DataView(b.buffer).setUint8(44, decimals);
    b[45] = 1;
    return b;
  };
  const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;

  it('decodes a classic SPL mint from raw bytes', () => {
    const r = assessMintAccount(MINT, { data: splMint(6), owner: SPL }, NOW);
    expect(r.decimals).toBe(6);
    expect(r.risks).toEqual([]);
    expect(verdictOf(r.risks)).toBe('clear');
  });

  it('refuses an account owned by a program that is not a token program', () => {
    expect(() => assessMintAccount(MINT, { data: splMint(6), owner: ISSUER }, NOW)).toThrow(/not a token program/);
  });

  it('the worst severity decides the verdict and sorts first', () => {
    const risks = assessMint(MINT, PROG, mint([{ __kind: 'TransferHook', authority: ISSUER, programId: ISSUER }, { __kind: 'PausableConfig', authority: some(ISSUER), paused: true }], { freeze: true }), NOW).risks;
    expect(verdictOf(risks)).toBe('blocked');
    expect(bySeverity(risks).map((r) => r.severity)).toEqual(['block', 'halt', 'disclose']);
    expect(verdictOf(risks.filter((r) => r.severity === 'halt'))).toBe('halted');
    expect(verdictOf(risks.filter((r) => r.severity === 'disclose'))).toBe('disclosures');
    expect(summaryOf('blocked')).toMatch(/cannot be created/);
    expect(LEVEL_OF.disclose).toBe('disclosure');
  });
});
