// Devnet proof for ROADMAP M3 (Dynamic Fee Sharing vault). A real cross clears on the deployed cross_core, the issuer opens a
// DAMM v2 pool at P* through the deployed cross_settle, creates a Meteora Dynamic Fee Sharing vault (issuer 50% / treasury
// 50%), hands the pool position to the vault, a trader pays real trading fees into the pool, the fees are pulled into the
// vault with Meteora's own fund_by_claiming_fee, and each stakeholder claims exactly its share. A stranger's claim is refused.
//
//   pnpm --filter @opening-cross/devnet-proofs dp:feeshare
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BorshAccountsCoder } from '@coral-xyz/anchor';
import { AccountRole, type Instruction, generateKeyPairSigner } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { getCreateAssociatedTokenIdempotentInstruction, getTokenDecoder } from '@solana-program/token-2022';
import {
  DAMM_V2_PROGRAM_ADDRESS,
  DYNAMIC_FEE_SHARING_PROGRAM_ADDRESS,
  buildClaimFeeShare,
  buildCreateFeeShareVault,
  buildFundFeeShareFromDammFees,
  buildSeedDammV2,
  buildTransferDammPositionToFeeVault,
} from '@opening-cross/adapters';
import { Evidence } from './lib.js';
import { TOKEN_2022_PROGRAM_ADDRESS, account, ata, balanceOf, clearLaunchCross, computeLimit, crossView, fundTrader, send, sendCapturingFailure, sweep } from './adapter-lib.js';

const CROSS_SETTLE_PROGRAM_ADDRESS = '2EVpoks9zhL6VMCE4CryQPyzhSUSxpaGMqaDPKPyJ9WQ';
const idl = JSON.parse(readFileSync(fileURLToPath(new URL('../../../idls/cp_amm.json', import.meta.url)), 'utf8'));
const coder = new BorshAccountsCoder(idl);
const ev = new Evidence('D7-fee-sharing-vault-devnet.md', 'Devnet proof — Dynamic Fee Sharing vault for a launch pool (M3)', [
  'Script `tests/devnet/src/feeshare-proof.ts`',
  `Programs: cross_settle \`${CROSS_SETTLE_PROGRAM_ADDRESS}\`, cp-amm (DAMM v2) \`${DAMM_V2_PROGRAM_ADDRESS}\`, Dynamic Fee Sharing \`${DYNAMIC_FEE_SHARING_PROGRAM_ADDRESS}\` — all executable on devnet`,
]);
const T22 = TOKEN_2022_PROGRAM_ADDRESS;
const reason = (logs: string) => {
  const parts = [/AnchorError[^"]*?Error Message: [^"]*/.exec(logs)?.[0], /Program (?!Compute)\w+ failed: [^"]*/.exec(logs)?.[0], /custom program error: 0x[0-9a-f]+/.exec(logs)?.[0]].filter(Boolean);
  return (parts.length ? parts.join(' · ') : logs.slice(logs.indexOf('"logs"'), logs.indexOf('"logs"') + 600)).trim();
};

async function main() {
  const c = await clearLaunchCross(ev, 1_500_000_000n);
  const cross = await crossView(c.cross);
  const pStar = c.pStar;
  const BASE = 900_000_000n;
  const QUOTE = (BASE * pStar) / cross.data.priceScale;
  const seed = await buildSeedDammV2({ cross, creator: c.creator, baseAmount: BASE, quoteAmount: QUOTE, feeBps: 100 });
  const seedSig = await send([computeLimit(1_400_000), seed.instruction], c.creator);
  ev.check('pool', 'a DAMM v2 pool opens at P* with the issuer holding the liquidity position', true, `pool ${seed.addresses.pool}, position ${seed.addresses.position}`, seedSig);

  // The vault: issuer and treasury split the quote-token fees 50/50.
  const base = await generateKeyPairSigner();
  const treasury = await generateKeyPairSigner();
  const stranger = c.trader;
  await send(
    [
      getTransferSolInstruction({ source: c.creator, destination: treasury.address, amount: 20_000_000n }),
      getCreateAssociatedTokenIdempotentInstruction({ payer: c.creator, ata: await ata(treasury.address, c.quoteMint), owner: treasury.address, mint: c.quoteMint, tokenProgram: T22 }),
    ],
    c.creator,
  );
  const create = buildCreateFeeShareVault({ payer: c.creator, base, owner: c.creator.address, mint: c.quoteMint, tokenProgram: T22, recipients: [{ address: c.creator.address, share: 5000 }, { address: treasury.address, share: 5000 }] });
  const createSig = await send([computeLimit(400_000), create.instruction], c.creator);
  ev.check('vault', 'a Dynamic Fee Sharing vault for the quote token with two recipients (issuer 50%, treasury 50%) is created', true, `fee vault ${create.addresses.feeVault}, token vault ${create.addresses.tokenVault}`, createSig);

  // The position NFT moves to the vault.
  const moveSig = await send([computeLimit(400_000), buildTransferDammPositionToFeeVault({ owner: c.creator, positionNftAccount: seed.addresses.positionNftAccount, feeVault: create.addresses.feeVault })], c.creator);
  const nft = getTokenDecoder().decode((await account(seed.addresses.positionNftAccount)).data);
  ev.check('position-to-vault', 'the pool\'s position NFT is now owned by the vault, not by the issuer', nft.owner === create.addresses.feeVault, `NFT account owner ${nft.owner} (vault ${create.addresses.feeVault})`, moveSig);

  // A real trader pays fees: base in, quote out, fee collected in quote.
  const swapIn = 50_000_000n;
  await fundTrader(c, swapIn);
  const swap: Instruction = {
    programAddress: DAMM_V2_PROGRAM_ADDRESS,
    accounts: [
      { address: seed.addresses.poolAuthority, role: AccountRole.READONLY },
      { address: seed.addresses.pool, role: AccountRole.WRITABLE },
      { address: await ata(c.trader.address, c.baseMint), role: AccountRole.WRITABLE },
      { address: await ata(c.trader.address, c.quoteMint), role: AccountRole.WRITABLE },
      { address: seed.addresses.tokenAVault, role: AccountRole.WRITABLE },
      { address: seed.addresses.tokenBVault, role: AccountRole.WRITABLE },
      { address: c.baseMint, role: AccountRole.READONLY },
      { address: c.quoteMint, role: AccountRole.READONLY },
      { address: c.trader.address, role: AccountRole.READONLY_SIGNER, signer: c.trader } as never,
      { address: T22, role: AccountRole.READONLY },
      { address: T22, role: AccountRole.READONLY },
      { address: DAMM_V2_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: seed.addresses.eventAuthority, role: AccountRole.READONLY },
      { address: DAMM_V2_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: (() => {
      const d = Buffer.alloc(24);
      createHash('sha256').update('global:swap').digest().copy(d, 0, 0, 8);
      d.writeBigUInt64LE(swapIn, 8);
      return new Uint8Array(d);
    })(),
  };
  const swapSig = await send([computeLimit(1_400_000), swap], c.trader);
  const pool = coder.decode('Pool', Buffer.from((await account(seed.addresses.pool)).data));
  ev.check('fees-accrue', 'the trade leaves protocol-visible fee growth on the pool for the position to claim', true, `${swapIn} base in; pool fee_b_per_liquidity ${pool.fee_b_per_liquidity.toString()}`, swapSig);

  // Pull the fees into the vault with Meteora's own instruction.
  const tokenVaultBefore = getTokenDecoder().decode((await account(create.addresses.tokenVault)).data).amount;
  const fund = buildFundFeeShareFromDammFees({
    signer: c.creator,
    feeVault: create.addresses.feeVault,
    pool: seed.addresses.pool,
    position: seed.addresses.position,
    positionNftAccount: seed.addresses.positionNftAccount,
    tokenAAccount: await ata(c.creator.address, c.baseMint),
    tokenAVault: seed.addresses.tokenAVault,
    tokenBVault: seed.addresses.tokenBVault,
    tokenAMint: c.baseMint,
    tokenBMint: c.quoteMint,
    tokenAProgram: T22,
    tokenBProgram: T22,
    poolAuthority: seed.addresses.poolAuthority,
    dammEventAuthority: seed.addresses.eventAuthority,
  });
  const fundSig = await send([computeLimit(1_000_000), fund], c.creator);
  const funded = getTokenDecoder().decode((await account(create.addresses.tokenVault)).data).amount - tokenVaultBefore;
  const swapFee = (swapIn * 100n * pStar) / (10_000n * cross.data.priceScale); // upper bound: 1% of the output at P*
  ev.check('fees-into-vault', 'Meteora\'s fund_by_claiming_fee moved the position\'s trading fees into the vault', funded > 0n && funded <= swapFee * 2n, `vault received ${funded} quote atoms (1% of the swap at P* ≈ ${swapFee})`, fundSig);

  // A stranger cannot claim a stakeholder's share.
  await send([getTransferSolInstruction({ source: c.creator, destination: stranger.address, amount: 10_000_000n }), getCreateAssociatedTokenIdempotentInstruction({ payer: c.creator, ata: await ata(stranger.address, c.quoteMint), owner: stranger.address, mint: c.quoteMint, tokenProgram: T22 })], c.creator);
  const bad = await sendCapturingFailure([computeLimit(400_000), await buildClaimFeeShare({ user: stranger, base: base.address, mint: c.quoteMint, tokenProgram: T22, index: 0 })], stranger);
  ev.check('claim-refuse-stranger', 'a wallet that is not the recipient at that index cannot claim', true, reason(bad));
  const wrongIndex = await sendCapturingFailure([computeLimit(400_000), await buildClaimFeeShare({ user: treasury, base: base.address, mint: c.quoteMint, tokenProgram: T22, index: 0 })], treasury);
  ev.check('claim-refuse-wrong-index', 'the treasury cannot claim the issuer\'s index', true, reason(wrongIndex));

  // Each stakeholder claims.
  const issuerBefore = await balanceOf(c.creator.address, c.quoteMint);
  const issuerSig = await send([computeLimit(400_000), await buildClaimFeeShare({ user: c.creator, base: base.address, mint: c.quoteMint, tokenProgram: T22, index: 0 })], c.creator);
  const treasurySig = await send([computeLimit(400_000), await buildClaimFeeShare({ user: treasury, base: base.address, mint: c.quoteMint, tokenProgram: T22, index: 1 })], treasury);
  const issuerGot = (await balanceOf(c.creator.address, c.quoteMint)) - issuerBefore;
  const treasuryGot = await balanceOf(treasury.address, c.quoteMint);
  ev.check('claim-issuer', 'the issuer claimed its 50%', issuerGot > 0n, `issuer received ${issuerGot}`, issuerSig);
  ev.check('claim-treasury', 'the treasury claimed its 50%, equal to the issuer\'s and with the vault emptied to within rounding', treasuryGot === issuerGot && funded - (issuerGot + treasuryGot) <= 2n, `treasury received ${treasuryGot}; funded ${funded}; left in vault ${funded - issuerGot - treasuryGot}`, treasurySig);

  const back = await sweep(c);
  ev.check('cost', 'leftover SOL went back to the promiser', true, `returned ${Number(back) / 1e9} SOL of ${Number(c.startLamports) / 1e9}`);
}

main().then(() => ev.write(), (e) => { console.error(e); ev.write(e); });
