// CLI: init | attest <wallet> | status <wallet> | sync | serve.   Configuration comes from the environment (see config.ts
// and RUNBOOK.md). Output carries addresses and outcomes only.
import { Attester } from './attester.js';
import { kycCredentialName, loadPolicy, loadProvider, loadSecret, loadSigner } from './kyc-config.js';
import { rpcChainPort } from './rpc-port.js';
import { SasService } from './sas.js';
import { buildKycServer } from './kyc-server.js';

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [cmd, arg] = argv;
  if (!cmd || !['init', 'attest', 'status', 'sync', 'serve'].includes(cmd)) {
    console.error('usage: cli <init | attest <wallet> | status <wallet> | sync | serve>');
    return 64;
  }
  const rpcUrl = env.RPC_URL;
  if (!rpcUrl) throw new Error('RPC_URL is required');
  const signer = await loadSigner(env);
  const port = rpcChainPort(rpcUrl, signer);
  const sas = new SasService(port, signer, kycCredentialName(env));

  if (cmd === 'init') {
    const r = await sas.init();
    console.log(json({ credentialAuthority: signer.address, ...r.addresses, created: r.created }));
    return 0;
  }
  const attester = new Attester({ provider: loadProvider(env), sas, policy: loadPolicy(env), secret: loadSecret(env), syncDelayMs: Number(env.ATTESTER_SYNC_DELAY_MS ?? 250), log: (l) => console.error(l) });
  if (cmd === 'attest') {
    if (!arg) throw new Error('attest needs a wallet address');
    const out = await attester.attest(arg);
    console.log(json(out));
    return out.status === 'attested' ? 0 : out.status === 'ineligible' ? 3 : 4;
  }
  if (cmd === 'status') {
    if (!arg) throw new Error('status needs a wallet address');
    console.log(json(await attester.onChain(arg)));
    return 0;
  }
  if (cmd === 'sync') {
    const r = await attester.sync();
    console.log(json(r));
    return r.errors.length ? 1 : 0;
  }
  const host = env.HOST ?? '127.0.0.1';
  const token = env.ATTESTER_API_TOKEN ?? null;
  if (token !== null && token.length < 24) throw new Error('ATTESTER_API_TOKEN must be at least 24 characters');
  // Wallet-signed requests let a holder's browser ask for its own attestation without the operator's API in between.
  const walletSigned = ['1', 'true', 'yes'].includes((env.ATTESTER_WALLET_SIGNED ?? '').toLowerCase());
  if (!token && !walletSigned && !['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('ATTESTER_API_TOKEN or ATTESTER_WALLET_SIGNED=1 is required when HOST is not a loopback address');
  const app = await buildKycServer(attester, {
    authToken: token,
    challengeSecret: walletSigned ? loadSecret(env) : null,
    trustProxy: env.ATTESTER_TRUST_PROXY === '1',
    corsOrigin: env.ATTESTER_CORS_ORIGIN ?? null,
  });
  const port_ = Number(env.PORT ?? 8787);
  await app.listen({ host, port: port_ });
  console.error(`identity attester listening on ${host}:${port_} (provider ${attester.provider.name})`);
  // A sync loop runs inside the server so revocations do not depend on a separate scheduler.
  const every = Number(env.ATTESTER_SYNC_INTERVAL_SECS ?? 900);
  if (every > 0) {
    const tick = async () => {
      try {
        const r = await attester.sync();
        console.error(`sync: ${r.checked} checked, ${r.closed} closed, ${r.refreshed} refreshed, ${r.errors.length} errors`);
      } catch (e) {
        console.error(`sync failed: ${(e as Error).message}`);
      }
    };
    setInterval(() => void tick(), every * 1000).unref();
  }
  return await new Promise<number>(() => undefined);
}

main(process.argv.slice(2), process.env).then(
  (code) => process.exit(code),
  (e: Error) => {
    console.error(`error: ${e.message}`);
    process.exit(1);
  },
);
