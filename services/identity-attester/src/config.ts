// Settings come from the environment; the keys live in files outside the repository (docs/HUMAN_TASKS.md HI2).
import { readFileSync } from 'node:fs';
import { type Address, type KeyPairSigner, createKeyPairSignerFromBytes, isAddress } from '@solana/kit';

export type Settings = {
  signer: KeyPairSigner;
  secret: Uint8Array;
  rpcUrl: string;
  port: number;
  ttlSeconds: number;
  hourlyCap: number;
  credential: Address | null;
  schema: Address | null;
};

function need(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export async function loadSettings(env: NodeJS.ProcessEnv = process.env): Promise<Settings> {
  const keypair = JSON.parse(readFileSync(need(env, 'ATTESTER_KEYPAIR'), 'utf8')) as number[];
  if (!Array.isArray(keypair) || keypair.length !== 64) throw new Error('ATTESTER_KEYPAIR must be a Solana keypair file (a JSON array of 64 bytes)');
  const secretHex = readFileSync(need(env, 'ATTESTER_SECRET_FILE'), 'utf8').trim();
  if (!/^[0-9a-fA-F]{64,}$/.test(secretHex)) throw new Error('ATTESTER_SECRET_FILE must hold at least 32 random bytes as hex');
  const addr = (name: string): Address | null => {
    const v = env[name];
    if (!v) return null;
    if (!isAddress(v)) throw new Error(`${name} is not a Solana address`);
    return v;
  };
  const int = (name: string, dflt: number, lo: number, hi: number) => {
    const n = env[name] === undefined ? dflt : Number(env[name]);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${name} must be an integer in [${lo}, ${hi}]`);
    return n;
  };
  return {
    signer: await createKeyPairSignerFromBytes(Uint8Array.from(keypair)),
    secret: Uint8Array.from(Buffer.from(secretHex, 'hex')),
    rpcUrl: env.RPC_URL ?? 'https://api.devnet.solana.com',
    port: int('PORT', 8090, 1, 65535),
    ttlSeconds: int('ATTESTATION_TTL_SECONDS', 30 * 24 * 3600, 600, 365 * 24 * 3600),
    hourlyCap: int('ATTESTER_HOURLY_CAP', 30, 1, 10_000),
    credential: addr('SAS_CREDENTIAL'),
    schema: addr('SAS_SCHEMA'),
  };
}
