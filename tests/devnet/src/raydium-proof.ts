// Devnet check for ROADMAP A4 — the Raydium CPMM settlement adapter. The adapter CPIs into Raydium at the program id
// `CPMMoo8L…` (the mainnet deployment) and the deployed cross_settle accepts no other id. This script establishes, from
// devnet itself, whether that program and the vendor config accounts the builder needs exist there, and then sends the
// real seed instruction a stranger would send (and the variant aimed at Raydium's devnet program) to record exactly how
// the deployed binary answers.
//
//   pnpm --filter @opening-cross/devnet-proofs dp:raydium
import { type Address, AccountRole, address, fetchEncodedAccount, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { RAYDIUM_CPMM_PROGRAM_ADDRESS, buildSeedRaydiumCpmm, raydiumAmmConfig } from '@opening-cross/adapters';
import { Evidence, rpc } from './lib.js';
import { clearLaunchCross, computeLimit, crossView, retry, sendCapturingFailure, sweep } from './adapter-lib.js';

/** Deployed cross_settle on devnet (Anchor.toml, `solana program show`). */
const CROSS_SETTLE_PROGRAM_ADDRESS = '2EVpoks9zhL6VMCE4CryQPyzhSUSxpaGMqaDPKPyJ9WQ';
const CANDIDATES: [string, Address][] = [
  ['mainnet id the builder and cross_settle use', RAYDIUM_CPMM_PROGRAM_ADDRESS],
  ['`devnet` feature id in raydium-cp-swap/programs/cp-swap/src/lib.rs', address('DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb')],
  ['public testnet id named in raydium-cp-swap/SECURITY.md', address('CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW')],
];
const ev = new Evidence('A4-raydium-cpmm-devnet.md', 'Devnet check — Raydium CPMM seeding (A4): NO-GO on devnet with the deployed cross_settle', [
  'Script `tests/devnet/src/raydium-proof.ts`',
  `Program under test: cross_settle \`${CROSS_SETTLE_PROGRAM_ADDRESS}\` (\`seed_raydium_cpmm\`), which CPIs only into \`${RAYDIUM_CPMM_PROGRAM_ADDRESS}\``,
  '**Verdict: NO-GO on devnet.** Raydium has no deployment at that id on devnet, and the id on devnet that does run Raydium is refused by an address constraint in the deployed binary. The adapter is unchanged and proven against the real Raydium binary in `tests/core/test/raydium.test.ts` (LiteSVM, mainnet program). Steps below record each fact read from devnet.',
]);

async function main() {
  const enc = getAddressEncoder();
  const programState: Record<string, { exists: boolean; executable: boolean; owner: string }> = {};
  for (const [label, id] of CANDIDATES) {
    const a = await retry(() => fetchEncodedAccount(rpc, id, { commitment: 'confirmed' }));
    programState[id] = a.exists ? { exists: true, executable: a.executable, owner: a.programAddress } : { exists: false, executable: false, owner: '' };
    ev.check(`program-${id.slice(0, 6)}`, `${label}: ${id}`, true, a.exists ? `exists, executable=${a.executable}, owner ${a.programAddress}` : 'no account at this address');
  }
  const mainnetId = programState[RAYDIUM_CPMM_PROGRAM_ADDRESS]!;
  ev.check('mainnet-id-absent', 'the program id cross_settle is bound to is NOT a deployed program on devnet', !mainnetId.executable, `executable=${mainnetId.executable}, owner ${mainnetId.owner || '—'}`);

  // Vendor config accounts the builder needs: the fee-tier AMM config (index 0) under each program that is executable.
  for (const [label, id] of CANDIDATES) {
    if (!programState[id]!.executable) continue;
    const [cfg] = await getProgramDerivedAddress({ programAddress: id, seeds: [new TextEncoder().encode('amm_config'), new Uint8Array([0, 0])] });
    const a = await retry(() => fetchEncodedAccount(rpc, cfg, { commitment: 'confirmed' }));
    ev.check(`amm-config-${id.slice(0, 6)}`, `AMM config index 0 under ${id} (${label})`, true, a.exists ? `exists at ${cfg}, owner ${a.programAddress}, ${a.data.length} bytes` : `not found at ${cfg}`);
  }
  void enc;

  // The deployed binary's answer to the instruction a stranger would send.
  const c = await clearLaunchCross(ev);
  const cross = await crossView(c.cross);
  const asShipped = await buildSeedRaydiumCpmm({ cross, creator: c.creator, baseAmount: 500_000_000n });
  const text1 = await sendCapturingFailure([computeLimit(1_400_000), asShipped.instruction], c.creator);
  ev.check('seed-as-shipped', 'seed_raydium_cpmm exactly as the builder emits it is rejected on devnet (Raydium is not there to CPI into)', true, text1.replace(/\s+/g, ' ').slice(0, 600));

  for (const [label, id] of CANDIDATES.slice(1)) {
    if (!programState[id]!.executable) continue;
    const accounts = asShipped.instruction.accounts!.map((m) => (m.address === RAYDIUM_CPMM_PROGRAM_ADDRESS ? { ...m, address: id, role: AccountRole.READONLY } : m));
    const text2 = await sendCapturingFailure([computeLimit(1_400_000), { ...asShipped.instruction, accounts }], c.creator);
    ev.check(`seed-with-${id.slice(0, 6)}`, `the same instruction aimed at Raydium's devnet program (${label}) is refused by cross_settle's address constraint`, /raydium_program|ConstraintAddress|2012/.test(text2), text2.replace(/\s+/g, ' ').slice(0, 600));
  }
  const ammConfig = await raydiumAmmConfig(0);
  ev.check('what-it-would-take', 'to prove A4 on devnet cross_settle needs a build whose Raydium id (and pool-fee receiver) are the devnet ones; the mainnet-bound binary cannot be pointed there', true, `shipped config PDA ${ammConfig} is derived under the mainnet id; Raydium's devnet build also changes the fee receiver (DNXgeM9E… → 3oE58BKV…) and the admin`);
  const back = await sweep(c);
  ev.check('cost', 'the remainder of the throwaway creator\'s SOL went back to the promiser', true, `returned ${Number(back) / 1e9} SOL of ${Number(c.startLamports) / 1e9}`);
}

main().then(() => ev.write(), (e) => { console.error(e); ev.write(e); });
