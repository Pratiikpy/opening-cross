// Devnet proof for the Presale Vault partner-mint path (ROADMAP DP11).
//
// The base token's supply is minted by the partner (mint authority) before anything else, moved into Meteora's Presale
// Vault by the program itself, and the mint authority is then revoked. The presale must still run to the end: a buyer
// deposits, the sale closes, the buyer claims base tokens at the fixed price, the creator takes the raised quote and
// the unsold base is refunded. After the revoke nobody can mint more. Every outcome is read from chain state.
//
//   RPC_URL=<devnet rpc> pnpm --filter @opening-cross/devnet-proofs dp:presale
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  AuthorityType,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
} from '@solana/spl-token';
import BN from 'bn.js';
import { Decimal } from 'decimal.js';
import { Presale, PRESALE_PROGRAM_ID, Rounding, UnsoldTokenAction, WhitelistMode, derivePresale } from '@meteora-ag/presale';
import { Evidence, RPC, connection, expectFailure, operator, send } from './lib.js';

const ev = new Evidence('DP11-presale-vault.md', 'Devnet proof — Presale Vault partner-mint path (DP11)', [
  'Script `tests/devnet/src/presale-vault-proof.ts`',
  `Program: Meteora Presale Vault \`${PRESALE_PROGRAM_ID.toBase58()}\` (same address on devnet and mainnet)`,
]);

const SUPPLY = 2_000_000_000n; // 2,000 base tokens at 6 decimals
const PRICE = 0.1; // quote per base
const DEPOSIT = 100_000_000n; // 100 quote tokens
const SOLD = 1_000_000_000n; // = DEPOSIT / PRICE
const UNSOLD = SUPPLY - SOLD;

const balance = async (owner: PublicKey, mint: PublicKey): Promise<bigint> => {
  try {
    return (await getAccount(connection, getAssociatedTokenAddressSync(mint, owner, true), 'confirmed')).amount;
  } catch {
    return 0n;
  }
};
const chainTime = async (): Promise<number> => (await connection.getBlockTime(await connection.getSlot('confirmed'))) ?? Math.floor(Date.now() / 1000);
const waitUntil = async (ts: number) => {
  while ((await chainTime()) < ts) await new Promise((r) => setTimeout(r, 2_000));
};

async function newMint(authority: PublicKey): Promise<Keypair> {
  const mint = Keypair.generate();
  const tx = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: operator.publicKey, newAccountPubkey: mint.publicKey, lamports: await getMinimumBalanceForRentExemptMint(connection), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(mint.publicKey, 6, authority, null, TOKEN_PROGRAM_ID),
  );
  await send(tx, [operator, mint]);
  return mint;
}

async function main() {
  console.log(`RPC ${RPC}\noperator ${operator.publicKey.toBase58()}`);
  const buyer = Keypair.generate();
  await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: buyer.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })), [operator]);

  // 1. The partner holds the mint authority of the base token; a quote token is funded to the buyer.
  const base = await newMint(operator.publicKey);
  const quote = await newMint(operator.publicKey);
  const creatorBase = getAssociatedTokenAddressSync(base.publicKey, operator.publicKey);
  const buyerQuote = getAssociatedTokenAddressSync(quote.publicKey, buyer.publicKey);
  const buyerBase = getAssociatedTokenAddressSync(base.publicKey, buyer.publicKey);
  const creatorQuote = getAssociatedTokenAddressSync(quote.publicKey, operator.publicKey);
  await send(
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, creatorBase, operator.publicKey, base.publicKey),
      createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, buyerQuote, buyer.publicKey, quote.publicKey),
      createMintToInstruction(quote.publicKey, buyerQuote, operator.publicKey, 1_000_000_000n),
    ),
    [operator],
  );

  // 2. Partner mint: the presale supply, once, into the creator's account.
  const mintSig = await send(new Transaction().add(createMintToInstruction(base.publicKey, creatorBase, operator.publicKey, SUPPLY)), [operator]);
  const afterMint = await getMint(connection, base.publicKey, 'confirmed');
  ev.check('partner-mint', 'the partner authority mints exactly the presale supply to the creator account', afterMint.supply === SUPPLY && (await balance(operator.publicKey, base.publicKey)) === SUPPLY && afterMint.mintAuthority?.equals(operator.publicKey) === true, `supply ${afterMint.supply}, creator holds ${await balance(operator.publicKey, base.publicKey)}, mint authority ${afterMint.mintAuthority?.toBase58()}`, mintSig);

  // 3. Create the fixed-price presale: the program moves the supply from the creator into its base vault.
  const start = (await chainTime()) + 20;
  const end = start + 75;
  const presaleKey = Keypair.generate();
  const createTx = await Presale.createFixedPricePresale(
    connection,
    PRESALE_PROGRAM_ID,
    {
      baseMintPubkey: base.publicKey,
      quoteMintPubkey: quote.publicKey,
      basePubkey: presaleKey.publicKey,
      creatorPubkey: operator.publicKey,
      feePayerPubkey: operator.publicKey,
      presaleArgs: {
        presaleMaximumCap: new BN((SUPPLY / 10n).toString()),
        presaleMinimumCap: new BN('50000000'),
        presaleStartTime: new BN(start),
        presaleEndTime: new BN(end),
        whitelistMode: WhitelistMode.Permissionless,
        unsoldTokenAction: UnsoldTokenAction.Refund,
        disableEarlierPresaleEndOnceCapReached: false,
      },
      presaleRegistries: [{ buyerMinimumDepositCap: new BN('1000000'), buyerMaximumDepositCap: new BN((SUPPLY / 10n).toString()), presaleSupply: new BN(SUPPLY.toString()), depositFeeBps: new BN(0) }],
      lockedVestingArgs: { immediateReleaseBps: new BN(10_000), immediateReleaseTimestamp: new BN(end), lockDuration: new BN(0), vestDuration: new BN(0) },
    },
    { price: new Decimal(PRICE), rounding: Rounding.Down, disableWithdraw: false },
  );
  const createSig = await send(createTx, [operator, presaleKey]);
  const presaleAddress = derivePresale(base.publicKey, quote.publicKey, presaleKey.publicKey, PRESALE_PROGRAM_ID);
  let presale = await Presale.create(connection, presaleAddress, PRESALE_PROGRAM_ID);
  const vaultBase = (await getMint(connection, base.publicKey, 'confirmed')).supply === SUPPLY ? await vaultBalance(presale, base.publicKey) : -1n;
  ev.check('supply-in-vault', 'the presale program took the whole supply into its base vault; the creator holds none', vaultBase === SUPPLY && (await balance(operator.publicKey, base.publicKey)) === 0n, `vault ${vaultBase}, creator ${await balance(operator.publicKey, base.publicKey)}`, createSig);

  // 4. Revoke the partner mint authority. Supply is now fixed and the presale is untouched.
  const revokeSig = await send(new Transaction().add(createSetAuthorityInstruction(base.publicKey, operator.publicKey, AuthorityType.MintTokens, null)), [operator]);
  const afterRevoke = await getMint(connection, base.publicKey, 'confirmed');
  ev.check('revoke', 'mint authority revoked; supply unchanged', afterRevoke.mintAuthority === null && afterRevoke.supply === SUPPLY, `mint authority ${afterRevoke.mintAuthority}, supply ${afterRevoke.supply}`, revokeSig);
  // SPL Token error 0x5 is FixedSupply: the mint has no authority left.
  const refusal = await expectFailure(new Transaction().add(createMintToInstruction(base.publicKey, creatorBase, operator.publicKey, 1n)), [operator], '0x5');
  ev.check('no-more-mint', 'nobody can mint more after the revoke (SPL Token FixedSupply, error 0x5)', true, refusal.slice(0, 200));

  // 5. The sale runs: deposit after the start, nothing claimable before the end.
  await waitUntil(start + 2);
  await presale.refetchState();
  const depSig = await send(await presale.deposit({ owner: buyer.publicKey, amount: new BN(DEPOSIT.toString()) }), [buyer]);
  const quoteVault = await vaultBalance(presale, quote.publicKey);
  ev.check('deposit', 'a buyer deposits quote into the presale after the revoke', quoteVault === DEPOSIT && (await balance(buyer.publicKey, quote.publicKey)) === 1_000_000_000n - DEPOSIT, `quote vault ${quoteVault}, buyer quote ${await balance(buyer.publicKey, quote.publicKey)}`, depSig);
  const early = await expectFailure(await presale.claim({ owner: buyer.publicKey, registryIndex: new BN(0) }), [buyer], '0x1781');
  ev.check('no-early-claim', 'a claim before the sale ends is refused: PresaleNotOpenForClaim (6017)', true, early.slice(0, 220));

  // 6. After the end: claim, creator withdraw, unsold refund.
  await waitUntil(end + 3);
  await presale.refetchState();
  const claimSig = await send(await presale.claim({ owner: buyer.publicKey, registryIndex: new BN(0) }), [buyer]);
  const got = await balance(buyer.publicKey, base.publicKey);
  ev.check('claim', 'the buyer claims base tokens at the fixed price from the supply minted before the revoke', got === SOLD, `claimed ${got} base atoms for ${DEPOSIT} quote atoms at ${PRICE} (expected ${SOLD})`, claimSig);

  await presale.refetchState();
  const withdrawSig = await send(await presale.creatorWithdraw({ creator: operator.publicKey }), [operator]);
  ev.check('creator-withdraw', 'the creator withdraws the raised quote', (await balance(operator.publicKey, quote.publicKey)) === DEPOSIT, `creator quote ${await balance(operator.publicKey, quote.publicKey)} (expected ${DEPOSIT})`, withdrawSig);

  await presale.refetchState();
  const unsoldSig = await send(await presale.performUnsoldBaseTokenAction(operator.publicKey), [operator]);
  // Public RPC nodes lag each other by a slot or two: read until the state the transaction produced is visible.
  let refunded = 0n;
  let supply = 0n;
  for (let i = 0; i < 20 && refunded !== UNSOLD; i++) {
    refunded = await balance(operator.publicKey, base.publicKey);
    supply = (await getMint(connection, base.publicKey, 'confirmed')).supply;
    if (refunded !== UNSOLD) await new Promise((r) => setTimeout(r, 1_500));
  }
  ev.check('unsold-refund', 'the unsold base is refunded to the creator, and total supply is still the original', refunded === UNSOLD && supply === SUPPLY, `refunded ${refunded} (expected ${UNSOLD}); supply ${supply} (expected ${SUPPLY}); sold ${got} + refunded = ${got + refunded}`, unsoldSig);
  void buyerBase;
  void creatorQuote;
}

/** Balance of a presale vault token account, found through the presale account's own vault addresses. */
async function vaultBalance(presale: Presale, mint: PublicKey): Promise<bigint> {
  const acct = presale.getParsedPresale().getPresaleAccount() as unknown as { baseTokenVault: PublicKey; quoteTokenVault: PublicKey; baseMint: PublicKey };
  const vault = acct.baseMint.equals(mint) ? acct.baseTokenVault : acct.quoteTokenVault;
  return (await getAccount(connection, vault, 'confirmed')).amount;
}

main().then(() => ev.write(), (e) => { console.error(e); ev.write(e); });
