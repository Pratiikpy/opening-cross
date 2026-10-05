// Reads live mainnet state. Run with `pnpm test:mainnet` (RPC_URL overrides the public endpoint).
import { describe, expect, it } from 'vitest';
import { type Address, createSolanaRpc } from '@solana/kit';
import { fetchMintSafety } from '../../src/index.js';

const rpc = createSolanaRpc(process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com');

// Hard-coded: stock tokens are never resolved by symbol (look-alike mints reuse the tickers).
const STOCK_MINTS: Record<string, Address> = {
  SPYx: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W' as Address,
  NVDAx: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh' as Address,
  TSLAx: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB' as Address,
  SPCXx: 'Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8' as Address,
  SPYon: 'k18WJUULWheRkSpSquYGdNNmtuE2Vbw1hpuUi92ondo' as Address,
  NVDAon: 'gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo' as Address,
  TSLAon: 'KeGv7bsfR4MheC1CkmnAVceoApjrkvBhHYjWb67ondo' as Address,
  PUSA: 'PUSAG1stksTcAoK9MjinEHUwAYRJsbovywYCk37m6hy' as Address,
  SPCX: 'SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb' as Address,
};

describe('mainnet stock mints', () => {
  it('reports issuer powers for every listed stock token', async () => {
    const asOf = BigInt(Math.floor(Date.now() / 1000));
    for (const [symbol, mint] of Object.entries(STOCK_MINTS)) {
      const r = await fetchMintSafety(rpc, mint, asOf);
      console.log(symbol, mint, `x${r.uiMultiplier}`, r.crossable ? 'crossable' : 'NOT crossable', r.risks.map((x) => `${x.code}:${x.severity}`).join(' '));
      expect(r.tokenProgram).toBe('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
      const codes = r.risks.map((x) => x.code);
      expect(codes.some((c) => c === 'PAUSE_AUTHORITY' || c === 'MINT_PAUSED')).toBe(true);
      expect(codes).not.toContain('UNKNOWN_EXTENSION');
    }
  }, 60_000);
});
