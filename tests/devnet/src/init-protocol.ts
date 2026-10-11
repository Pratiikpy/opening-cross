// Initialises the cross_core protocol singleton on any cluster, and pauses it, in one reviewed step. It is the first
// transaction of the mainnet runbook (docs/evidence/L4-verifiable-build.md) and works on devnet too.
//
//   RPC_URL=<rpc> KEYPAIR=<deployer keypair json> GUARDIAN=<address> FEE_RECIPIENT=<address> \
//     pnpm --filter @opening-cross/devnet-proofs exec tsx src/init-protocol.ts            # prints the plan, sends nothing
//   ... CONFIRM=yes ...                                                                   # sends it
//
// The protocol starts PAUSED (new crosses and orders are refused; claims and refunds never are) so nothing can be
// created on a fresh deployment until the admin unpauses it on purpose. Fees are the schedule of ADR-0010
// (30 / 5 / 15 / 30 bps). If the protocol already exists the script only reports it.
import { readFileSync } from 'node:fs';
import {
  type Address,
  type Instruction,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  fetchEncodedAccount,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, getInitProtocolInstruction, getProtocolDecoder, getSetPausedInstruction, protocolAddress } from '@opening-cross/sdk';

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

const rpc = createSolanaRpc(need('RPC_URL'));
const confirm = process.env.CONFIRM === 'yes';
const FEES: [number, number, number, number] = [30, 5, 15, 30];

async function send(ixs: Instruction[], payer: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>): Promise<string> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const tx = await signTransactionMessageWithSigners(
    pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(payer, m), (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m), (m) => appendTransactionMessageInstructions(ixs, m)),
  );
  const signature = getSignatureFromTransaction(tx);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
  for (let i = 0; i < 90; i++) {
    const st = (await rpc.getSignatureStatuses([signature]).send()).value[0];
    if (st?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return signature;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`transaction ${signature} not confirmed within 90 s`);
}

async function main() {
  const admin = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(need('KEYPAIR'), 'utf8'))));
  const guardian = address(need('GUARDIAN'));
  const feeRecipient = address(need('FEE_RECIPIENT'));
  const protocol = await protocolAddress();

  const program = await fetchEncodedAccount(rpc, CROSS_CORE_PROGRAM_ADDRESS as Address);
  if (!program.exists || !program.executable) throw new Error(`cross_core is not deployed at ${CROSS_CORE_PROGRAM_ADDRESS} on this cluster`);

  const existing = await fetchEncodedAccount(rpc, protocol);
  if (existing.exists) {
    const p = getProtocolDecoder().decode(existing.data);
    console.log(JSON.stringify({ protocol, alreadyInitialised: true, admin: p.admin, guardian: p.guardian, feeRecipient: p.feeRecipient, feeBps: p.feeBps, paused: p.paused }, null, 1));
    return;
  }

  const plan = { cluster: need('RPC_URL').replace(/\/\/[^/]*@/, '//'), protocol, admin: admin.address, guardian, feeRecipient, feeBps: FEES, startsPaused: true };
  console.log(JSON.stringify(plan, null, 1));
  if (!confirm) {
    console.log('Dry run: nothing was sent. Re-run with CONFIRM=yes to send.');
    return;
  }
  const sig1 = await send([getInitProtocolInstruction({ admin, protocol, guardian, feeRecipient, feeBps: FEES })], admin);
  const sig2 = await send([getSetPausedInstruction({ signer: admin, protocol, paused: true })], admin);
  const after = getProtocolDecoder().decode(((await fetchEncodedAccount(rpc, protocol)) as { data: Uint8Array }).data);
  console.log(JSON.stringify({ init: sig1, pause: sig2, paused: after.paused, admin: after.admin, guardian: after.guardian }, null, 1));
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
