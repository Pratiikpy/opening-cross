// Builds the payment gate for the paid routes from the environment, or says it is off.
//
//   X402_ENABLED=1                      turns pay-per-call on; anything else leaves the paid routes answering 501
//   X402_ASSET                          mint buyers pay with (devnet: a test mint; mainnet: USDC)
//   X402_PAY_TO                         wallet that receives payments (its token account for X402_ASSET must exist)
//   X402_FEE_PAYER_KEYPAIR              Solana CLI keypair file of the account that sponsors the fee of each payment transaction
//   X402_SECRET_FILE                    file holding at least 32 random bytes as hex; keys the payment challenges
//   X402_RPC_URL                        optional; defaults to RPC_URL
//   X402_CONFIRM_TIMEOUT_MS             optional; how long a settlement waits for confirmation before telling the buyer to retry (default 90000)
//   X402_MPP_REALM                      optional; also accept MPP charge credentials, challenged under this realm (the API's hostname)
//   X402_ASSET_DECIMALS, X402_TOKEN_PROGRAM   with X402_MPP_REALM: the mint's decimals (default 6) and token program (default Token-2022 on devnet, Token on mainnet)
//   ATTESTATION_KEYPAIR                 optional keypair file whose key signs verification receipts and bundles (published at /v1/attestations/signer)
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { LocalFacilitator, PaymentLedger, X402Gate, createRpc, migrate as migrateLedger, networkOf } from '@opening-cross/x402';
import { keyPairFromSolanaFile } from '@opening-cross/attest';
import type { PaidOptions } from './paid.js';

export type PaidEnv = Record<string, string | undefined>;

export class PaidConfigError extends Error {
  override readonly name = 'PaidConfigError';
}

function need(env: PaidEnv, k: string): string {
  const v = env[k];
  if (!v) throw new PaidConfigError(`${k} is required when X402_ENABLED=1`);
  return v;
}

/**
 * Returns the options for `registerPaid`: `null` when pay-per-call is off (the routes then answer 501), the gate and the
 * optional attestation key when it is on. A half-configured gate is an error, never a silent "off".
 */
export async function paidFromEnv(env: PaidEnv, db: pg.Pool): Promise<{ options: PaidOptions | null; gate: { reconcile: () => Promise<unknown> } | null }> {
  const attestation = env.ATTESTATION_KEYPAIR ? await keyPairFromSolanaFile(readFileSync(env.ATTESTATION_KEYPAIR, 'utf8')) : null;
  if (env.X402_ENABLED !== '1') return { options: null, gate: null };
  const asset = need(env, 'X402_ASSET');
  const payTo = need(env, 'X402_PAY_TO');
  const secretHex = readFileSync(need(env, 'X402_SECRET_FILE'), 'utf8').trim();
  if (!/^[0-9a-fA-F]{64,}$/.test(secretHex) || secretHex.length % 2 !== 0) throw new PaidConfigError('X402_SECRET_FILE must hold at least 32 bytes as hex');
  const feePayerBytes = JSON.parse(readFileSync(need(env, 'X402_FEE_PAYER_KEYPAIR'), 'utf8')) as number[];
  const feePayer = await createKeyPairSignerFromBytes(Uint8Array.from(feePayerBytes));
  const rpcUrl = env.X402_RPC_URL ?? env.RPC_URL;
  if (!rpcUrl) throw new PaidConfigError('X402_RPC_URL or RPC_URL is required when X402_ENABLED=1');
  const rpc = createRpc(rpcUrl);
  const network = await networkOf(rpc);
  await migrateLedger(db);
  const facilitator = new LocalFacilitator({ rpc, network, signers: [feePayer], policy: { payTo: [payTo], assets: [asset] }, minFeePayerLamports: 5_000_000n, confirmTimeoutMs: Number(env.X402_CONFIRM_TIMEOUT_MS ?? 90_000) });
  const cluster = env.NETWORK === 'mainnet-beta' ? 'mainnet' : env.NETWORK === 'localnet' ? 'localnet' : 'devnet';
  const mpp = env.X402_MPP_REALM
    ? { realm: env.X402_MPP_REALM, network: cluster as 'mainnet' | 'devnet' | 'localnet', decimals: Number(env.X402_ASSET_DECIMALS ?? 6), tokenProgram: env.X402_TOKEN_PROGRAM ?? (cluster === 'mainnet' ? TOKEN_PROGRAM_ADDRESS : TOKEN_2022_PROGRAM_ADDRESS) }
    : undefined;
  const gate = new X402Gate({ facilitator, ledger: new PaymentLedger(db), network, asset, payTo, secret: Uint8Array.from(Buffer.from(secretHex, 'hex')), ...(mpp ? { mpp } : {}) });
  return {
    options: { gate, ...(env.PUBLIC_API_ORIGIN ? { publicOrigin: env.PUBLIC_API_ORIGIN } : {}), ...(attestation ? { attestation } : {}) },
    gate: { reconcile: () => gate.reconcile() },
  };
}
