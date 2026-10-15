// Devnet proof for the pool routes (ROADMAP D9, Z1, K5, W9; docs/evidence/W5-1C.md).
//
// A fresh trader is funded from the devnet promiser key. For each of the three pools the devnet proofs opened (a DAMM v2 pool, a DLMM pair with one
// funded bin region, a DLMM pair with a 20-bin ladder across two bin arrays) the API's own routes are run in process against the live chain:
//
//   1. GET /v1/pools/:address               reads the pool
//   2. POST /v1/pools/swap-tx               builds an unsigned swap and says what it expects
//   3. the swap is simulated on the cluster, then sent and confirmed
//   4. the quote, the simulation and the tokens that really arrived are compared, atom for atom
//
// A swap whose minimum is one atom above the quote is sent too, and the program must refuse it. Everything the script does is recorded as JSON on stdout.
//
//   pnpm --filter @opening-cross/api exec tsx ../../packages/router/scripts/pool-proof.ts
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import {
  type Address,
  type Instruction,
  decompileTransactionMessage,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  createKeyPairSignerFromBytes,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getMintToInstruction, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { ROOT, rpc } from '../../../tests/devnet/src/lib.js';
import { ata, ataIx, freshFunder, send, show, sweepBack, tokenBalance } from '../../../tests/devnet/src/kit.js';
import { RequestError } from '../../../services/api/src/tx.js';
import { registerPools } from '../../../services/api/src/routes/pools.js';

const POOLS = {
  damm: { name: 'DAMM v2 pool (A2 proof)', pool: '5fDuBQZnim5qF8gJHQebPfqS1eLSEhHxo6hurXsmP8AU', base: 'EkisVxYv7x5pJfXUM75WiQC9AgYKy2ps5R3pyTEeovCV', quote: '7BavPghywmfMMvt7VctXpFvqKCB8kwnXDyA2iZUQzidy', quoteAuthority: '37qipRy1t7woHmDqwMngt4et8c3J6XyLDR4HNT24LDzt' },
  one: { name: 'DLMM pair (A3 proof)', pool: '9zCyWgZoDLutMeci2ntdfsYR4Dnu4TXi81RivPBY4125', base: 'AypfHSmpMQ2C1zaGRHRyoYbQBjFA8Wphc7AQrkmCLZXN', quote: 'HRYt8BVWnDkBNXJQ8CUpAkVEaQUgFeUAshGCRAk8JEGN', quoteAuthority: 'EScH6fW8JR7UWHyY25dxhigWNcpq9YyZmwyy2kajDZcC' },
  ladder: { name: 'DLMM pair with a 20-bin ladder (D5 proof)', pool: '9ND3Gwnt5v8HVduCNKBozEuXTKwpXjtV3TMQDY9GctYG', base: 'BdbY4wWxCKv1CX9xY5XSbjexeZUFQimyhPp86jgmhakt', quote: 'B8yoGNPDWTaWK86Po4V1nBGnqHTCvSKn839kAgrksQHJ', quoteAuthority: 'J8Kpv4zq41mEjzPBnK4SssyBruuU2gDXAh8x464xJHUs' },
} as const;

const log: Record<string, unknown>[] = [];
const note = (r: Record<string, unknown>) => {
  log.push(r);
  console.error(show(r));
};

async function main() {
  const { funder: trader, promiser } = await freshFunder(120_000_000n);
  const chain = (a: Address) => rpc.getAccountInfo(a, { encoding: 'base64', commitment: 'confirmed' }).send();
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof RequestError) return reply.code(err.status).type('application/json').send(show({ error: err.message, ...err.detail }));
    return reply.code(500).send({ error: String(err) });
  });
  registerPools(app, {
    account: async (a) => {
      const r = await chain(a);
      return r.value ? { data: new Uint8Array(Buffer.from(r.value.data[0], 'base64')), owner: r.value.owner } : null;
    },
    lifetime: async () => (await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()).value,
    network: 'devnet',
  });
  await app.ready();
  const get = async (url: string) => {
    const r = await app.inject({ method: 'GET', url });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  const post = async (url: string, body: unknown) => {
    const r = await app.inject({ method: 'POST', url, payload: body as never });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  const decode = (tx: string): Instruction[] => {
    const decoded = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(tx, 'base64')));
    return decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(decoded.messageBytes)).instructions as Instruction[];
  };

  // Quote tokens for the trader: the quote mints are minted by the throwaway wallets that created the proofs, whose keys are kept (git-ignored) in .keys/adapter-creators.
  for (const p of Object.values(POOLS)) {
    const authority = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(`${ROOT}.keys/adapter-creators/${p.quoteAuthority}.json`, 'utf8'))));
    await send([await ataIx(trader, trader.address, p.quote as Address), getMintToInstruction({ mint: p.quote as Address, token: await ata(trader.address, p.quote as Address), mintAuthority: authority, amount: 4_000_000_000n }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })], trader);
  }

  const balance = async (mint: string) => tokenBalance(await ata(trader.address, mint as Address));
  /** Runs a built swap: simulate, send, compare. */
  async function swap(label: string, p: (typeof POOLS)[keyof typeof POOLS], inputMint: string, outputMint: string, amountIn: bigint, extra: Record<string, unknown> = {}) {
    const built = await post('/v1/pools/swap-tx', { pool: p.pool, owner: trader.address, inputMint, amountIn: amountIn.toString(), maxSlippageBps: 50, ...extra });
    if (built.status !== 200) {
      note({ label, pool: p.pool, refused: built.status, body: built.body });
      return null;
    }
    const expected = BigInt(built.body.swap.expectedOut);
    const ixs = decode(built.body.transaction);
    const swapIx = ixs.at(-1)!;
    // The cluster's simulator runs the real program on current state and returns the output account.
    const outAccount = built.body.swap.outputAccount as Address;
    const before = await balance(outputMint);
    const blockhash = (await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()).value;
    const signed = await signTransactionMessageWithSigners(
      pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(trader, m), (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m), (m) => appendTransactionMessageInstructions(ixs, m)),
    );
    const sim = await rpc
      .simulateTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', commitment: 'confirmed', replaceRecentBlockhash: true, sigVerify: false, accounts: { addresses: [outAccount], encoding: 'base64' } })
      .send();
    let simulatedOut: bigint | null = null;
    if (!sim.value.err && sim.value.accounts?.[0]) simulatedOut = Buffer.from(sim.value.accounts[0].data[0], 'base64').readBigUInt64LE(64) - before;
    const inBefore = await balance(inputMint);
    const signature = await send(ixs, trader);
    const status = await rpc.getSignatureStatuses([signature]).send();
    const blockTime = await rpc.getBlockTime(status.value[0]!.slot).send();
    const after = await balance(outputMint);
    const inAfter = await balance(inputMint);
    const got = after - before;
    note({
      label,
      pool: p.pool,
      kind: built.body.kind,
      inputMint,
      amountIn: amountIn.toString(),
      quotedOut: expected.toString(),
      simulatedOut: simulatedOut?.toString() ?? `simulation failed: ${show(sim.value.err)}`,
      receivedOnChain: got.toString(),
      spentOnChain: (inBefore - inAfter).toString(),
      exact: got === expected,
      differenceAtoms: (got - expected).toString(),
      simulationMatchesQuote: simulatedOut === expected,
      quoteChainTime: built.body.chain.unixTimestamp,
      executedAtChainTime: blockTime?.toString() ?? null,
      secondsFromQuoteToExecution: blockTime === null ? null : Number(blockTime) - Number(built.body.chain.unixTimestamp),
      minimumAmountOut: built.body.swap.minimumAmountOut,
      slippageVsMidBps: built.body.swap.slippageVsMidBps,
      instructionProgram: swapIx.programAddress,
      signature,
    });
    return got;
  }

  const probeOnly = process.env.PROBE_ONLY === '1';
  for (const key of probeOnly ? [] : (['damm', 'one', 'ladder'] as const)) {
    const p = POOLS[key];
    const health = await get(`/v1/pools/${p.pool}`);
    note({ label: `${p.name}: health`, status: health.status, kind: health.body.kind, price: health.body.price, reserves: health.body.liquidity, depthAt100bps: health.body.depth?.find((d: { maxSlippageBps: string }) => d.maxSlippageBps === '100'), chain: health.body.chain?.source });
    // Buy base with quote, in three sizes (the last crosses bins on the ladder pair), then sell what was bought.
    const sizes = key === 'ladder' ? [20_000_000n, 150_000_000n, 450_000_000n] : [5_000_000n, 40_000_000n, 150_000_000n];
    let bought = 0n;
    for (const s of sizes) bought += (await swap(`${p.name}: buy with ${s} quote`, p, p.quote, p.base, s)) ?? 0n;
    const sellSizes = [bought / 4n, bought / 2n];
    for (const s of sellSizes) if (s > 0n) await swap(`${p.name}: sell ${s} base`, p, p.base, p.quote, s);
    if (key === 'ladder') {
      // The variable fee of a DLMM pair decays with time: wait out its decay period, so the next quote does not depend on a swap a few seconds ago.
      await new Promise((r) => setTimeout(r, 130_000));
      await swap(`${p.name}: sell ${bought / 8n} base after the volatility has decayed`, p, p.base, p.quote, bought / 8n);
    }
  }

  // Time dependence of a DLMM quote. The variable fee of a pair is a function of the time since its last swap (filter period 10 s, decay period 120 s), so the same
  // swap is worth a little different amount from one second to the next. The quote is read at the chain's own time; this probe shows that the quote tracks the
  // cluster's simulation of the same swap taken in the same second, and how the amount moves as the fee state decays.
  {
    const p = POOLS.ladder;
    const probeBuy = await swap(`${p.name}: probe buy with 30000000 quote`, p, p.quote, p.base, 30_000_000n);
    void probeBuy;
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 6; i++) {
      const built = await post('/v1/pools/swap-tx', { pool: p.pool, owner: trader.address, inputMint: p.base, amountIn: '5000000' });
      const ixs = decode(built.body.transaction);
      const blockhash = (await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()).value;
      const signed = await signTransactionMessageWithSigners(
        pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(trader, m), (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m), (m) => appendTransactionMessageInstructions(ixs, m)),
      );
      const before = await balance(p.quote);
      const sim = await rpc.simulateTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', commitment: 'confirmed', replaceRecentBlockhash: true, sigVerify: false, accounts: { addresses: [built.body.swap.outputAccount], encoding: 'base64' } }).send();
      const simOut = Buffer.from(sim.value.accounts![0]!.data[0], 'base64').readBigUInt64LE(64) - before;
      const clockNow = await get(`/v1/pools/${p.pool}`);
      rows.push({ chainTimeAtQuote: built.body.chain.unixTimestamp, chainTimeAfterSimulation: clockNow.body.chain.unixTimestamp, quote: built.body.swap.expectedOut, simulated: simOut.toString(), equal: simOut.toString() === built.body.swap.expectedOut });
      await new Promise((r) => setTimeout(r, 4_000));
    }
    note({ label: 'time-dependence probe (sell 5000000 base into the ladder pair right after a buy)', rows });
  }

  // The program enforces the minimum: a swap that asks for one atom more than the quote is refused on chain, not by the API.
  {
    const p = POOLS.damm;
    const built = await post('/v1/pools/swap-tx', { pool: p.pool, owner: trader.address, inputMint: p.quote, amountIn: '5000000' });
    const expected = BigInt(built.body.swap.expectedOut);
    const refusedByApi = await post('/v1/pools/swap-tx', { pool: p.pool, owner: trader.address, inputMint: p.quote, amountIn: '5000000', minimumAmountOut: (expected + 1n).toString() });
    const raw = decode(built.body.transaction);
    const swapIx = raw.at(-1)!;
    // Rebuild the DAMM instruction with a minimum one above the quote and send it to the simulator directly.
    const data = Buffer.from(swapIx.data!);
    data.writeBigUInt64LE(expected + 1n, 16);
    const tampered = { ...swapIx, data: new Uint8Array(data) };
    const blockhash = (await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()).value;
    const signed = await signTransactionMessageWithSigners(
      pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(trader, m), (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m), (m) => appendTransactionMessageInstructions([raw[0]!, tampered], m)),
    );
    const sim = await rpc.simulateTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', commitment: 'confirmed', replaceRecentBlockhash: true, sigVerify: false }).send();
    note({ label: 'DAMM: minimum one atom above the quote', apiRefusal: { status: refusedByApi.status, reason: refusedByApi.body.reason }, programRefusal: sim.value.err ? show(sim.value.err) : 'NOT REFUSED', logs: (sim.value.logs ?? []).filter((l) => /rror|xceed|lippage/.test(l)).slice(0, 4) });
  }

  const returned = await sweepBack(trader, promiser);
  note({ label: 'sweep', returnedLamports: returned.toString() });
  await app.close();
  console.log(JSON.stringify(log, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
}

main().catch((e) => {
  console.error(e);
  console.log(JSON.stringify(log, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
  process.exit(1);
});
