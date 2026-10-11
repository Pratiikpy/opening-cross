// Places real buy orders in the seeded open-book cross so the book crosses and the promiser has a band to sign.
// Reads the seed file written by seed.ts. Buyers are the disposable localnet wallets.
//
//   RPC_URL=http://127.0.0.1:8899 WS_URL=ws://127.0.0.1:8900 SEED=/tmp/oc-e2e.json tsx src/trust-seed.ts
import { readFileSync } from 'node:fs';
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  fetchEncodedAccount,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { OrderSide, buildPlaceOrder, getCrossDecoder } from '@opening-cross/sdk';

const rpc = createSolanaRpc(process.env.RPC_URL ?? 'http://127.0.0.1:8899');
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: createSolanaRpcSubscriptions(process.env.WS_URL ?? 'ws://127.0.0.1:8900') });
const seed = JSON.parse(readFileSync(process.env.SEED ?? '/tmp/oc-e2e.json', 'utf8')) as { crosses: { open: Address }; wallets: Record<string, { secret: number[] }> };
const signer = (k: string) => createKeyPairSignerFromBytes(Uint8Array.from(seed.wallets[k]!.secret));

async function send(ixs: Instruction[], payer: KeyPairSigner) {
  const { value: bh } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const tx = await signTransactionMessageWithSigners(pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(payer, m), (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m), (m) => appendTransactionMessageInstructions(ixs, m)));
  await sendAndConfirm(tx as Parameters<typeof sendAndConfirm>[0], { commitment: 'confirmed' });
}

// The issuer offers 1,000 tokens at 1.20 and 1,000 more at 1.50. Two buyers bid against that supply.
const orders: [string, bigint, bigint][] = [
  ['buyer', 1_550_000n, 1_200_000_000n],
  ['buyer2', 1_300_000n, 500_000_000n],
];
for (const [who, price, quantity] of orders) {
  const owner = await signer(who);
  const acct = await fetchEncodedAccount(rpc, seed.crosses.open);
  if (!acct.exists) throw new Error('open cross missing');
  const view = { address: seed.crosses.open, data: getCrossDecoder().decode(acct.data) };
  await send([await buildPlaceOrder({ cross: view, owner, nonce: BigInt(view.data.ordersTotal), side: OrderSide.Buy, price, quantity, salt: crypto.getRandomValues(new Uint8Array(32)) })], owner);
  console.log(`placed buy ${quantity} @ ${price} for ${who}`);
}
process.exit(0);
