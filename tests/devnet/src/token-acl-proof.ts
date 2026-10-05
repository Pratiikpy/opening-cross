// Devnet proof DP8: identity gating that survives outside a hooked curve, using Token ACL
// (sRFC-37) with cross_gate as the gate program.
//
// A Token-2022 mint is created with Default Account State = Frozen, its freeze authority is
// delegated to Token ACL, and permissionless thaw/freeze are routed to cross_gate, which
// answers from the same passes the transfer hook uses.
//
//   pnpm --filter @opening-cross/devnet-proofs dp:acl
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  AccountState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeDefaultAccountStateInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getMintLen,
} from '@solana/spl-token';
import { createInitializeInstruction, createUpdateFieldInstruction, pack, type TokenMetadata } from '@solana/spl-token-metadata';
import { type Address, createNoopSigner, fetchEncodedAccount } from '@solana/kit';
import {
  TOKEN_ACL_PROGRAM_ADDRESS,
  createFreezePermissionlessInstructionWithExtraMetas,
  createThawPermissionlessInstructionWithExtraMetas,
  findMintConfigPda,
  getCreateConfigInstruction as getAclCreateConfigInstruction,
  getTogglePermissionlessInstructionsInstruction,
} from '@solana/token-acl-sdk';
import {
  CROSS_GATE_PROGRAM_ADDRESS,
  Mode,
  findConfigPda,
  findFreezeMetasPda,
  findThawMetasPda,
  getCanThawPermissionlessInstruction,
  getCreateConfigInstruction,
  getGrantPassInstruction,
  getInitGateMetasInstruction,
  getRevokePassInstruction,
} from '@opening-cross/cross-gate-client';
import { Evidence, connection, expectFailure, kitAddr, operator, rpc, send, toLegacy } from './lib.js';

const GATE = new PublicKey(CROSS_GATE_PROGRAM_ADDRESS);
const ACL = new PublicKey(TOKEN_ACL_PROGRAM_ADDRESS);
const alice = Keypair.generate(); // will hold a pass
const bob = Keypair.generate(); // never gets a pass
const op = createNoopSigner(kitAddr(operator.publicKey));
const ev = new Evidence('DP8-token-acl.md', 'Devnet proof DP8 — Token ACL gating with cross_gate', [
  'Script `tests/devnet/src/token-acl-proof.ts`',
  `Programs: Token ACL \`${ACL.toBase58()}\`, cross_gate \`${GATE.toBase58()}\``,
]);

const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
const passPda = (mint: PublicKey, owner: PublicKey): Address =>
  kitAddr(PublicKey.findProgramAddressSync([Buffer.from('pass'), mint.toBuffer(), owner.toBuffer()], GATE)[0]);
const retriever = (a: Address) => fetchEncodedAccount(rpc, a, { commitment: 'confirmed' });
const frozen = async (account: PublicKey) => (await getAccount(connection, account, 'confirmed', TOKEN_2022_PROGRAM_ID)).isFrozen;

async function thaw(mint: PublicKey, owner: PublicKey, caller: Keypair): Promise<Transaction> {
  const ix = await createThawPermissionlessInstructionWithExtraMetas(createNoopSigner(kitAddr(caller.publicKey)), kitAddr(ata(mint, owner)), kitAddr(mint), kitAddr(owner), TOKEN_ACL_PROGRAM_ADDRESS, retriever);
  return new Transaction().add(toLegacy(ix));
}
async function freeze(mint: PublicKey, owner: PublicKey, caller: Keypair): Promise<Transaction> {
  const ix = await createFreezePermissionlessInstructionWithExtraMetas(createNoopSigner(kitAddr(caller.publicKey)), kitAddr(ata(mint, owner)), kitAddr(mint), kitAddr(owner), TOKEN_ACL_PROGRAM_ADDRESS, retriever);
  return new Transaction().add(toLegacy(ix));
}

async function main() {
  console.log(`operator ${operator.publicKey.toBase58()}\nalice ${alice.publicKey.toBase58()}\nbob ${bob.publicKey.toBase58()}`);
  await send(
    new Transaction().add(
      SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: alice.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
      SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: bob.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
    ),
    [operator],
  );

  // 1. Mint: accounts start frozen; metadata advertises the gate so wallets can auto-thaw.
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  const metadata: TokenMetadata = {
    mint,
    name: 'Opening Cross Gated Proof',
    symbol: 'OCG',
    uri: 'https://github.com/Pratiikpy/opening-cross',
    additionalMetadata: [['token_acl', GATE.toBase58()]],
  };
  const space = getMintLen([ExtensionType.DefaultAccountState, ExtensionType.MetadataPointer]);
  const lamports = await connection.getMinimumBalanceForRentExemption(space + 4 + pack(metadata).length + 64);
  const createSig = await send(
    new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: operator.publicKey, newAccountPubkey: mint, space, lamports, programId: TOKEN_2022_PROGRAM_ID }),
      createInitializeDefaultAccountStateInstruction(mint, AccountState.Frozen, TOKEN_2022_PROGRAM_ID),
      createInitializeMetadataPointerInstruction(mint, operator.publicKey, mint, TOKEN_2022_PROGRAM_ID),
      createInitializeMintInstruction(mint, 6, operator.publicKey, operator.publicKey, TOKEN_2022_PROGRAM_ID),
      createInitializeInstruction({ programId: TOKEN_2022_PROGRAM_ID, metadata: mint, updateAuthority: operator.publicKey, mint, mintAuthority: operator.publicKey, name: metadata.name, symbol: metadata.symbol, uri: metadata.uri }),
      createUpdateFieldInstruction({ programId: TOKEN_2022_PROGRAM_ID, metadata: mint, updateAuthority: operator.publicKey, field: 'token_acl', value: GATE.toBase58() }),
    ),
    [operator, mintKp],
  );
  ev.check('mint', 'Token-2022 mint created with Default Account State = Frozen and token_acl metadata', true, `mint ${mint.toBase58()}`, createSig);

  // 2. Token ACL takes the freeze authority; permissionless thaw and freeze enabled.
  const [mintConfig] = await findMintConfigPda({ mint: kitAddr(mint) });
  const aclSig = await send(
    new Transaction().add(
      toLegacy(getAclCreateConfigInstruction({ payer: kitAddr(operator.publicKey), authority: op, mint: kitAddr(mint), mintConfig, gatingProgram: kitAddr(GATE) })),
      toLegacy(getTogglePermissionlessInstructionsInstruction({ authority: op, mintConfig, thawEnabled: true, freezeEnabled: true })),
    ),
    [operator],
  );
  const mintInfo = await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
  ev.check('acl-config', 'freeze authority delegated to Token ACL MintConfig; gate = cross_gate; permissionless thaw/freeze on', mintInfo.freezeAuthority?.toBase58() === mintConfig && (await connection.getAccountInfo(new PublicKey(mintConfig)))?.owner.equals(ACL) === true, `MintConfig ${mintConfig}; freezeAuthority ${mintInfo.freezeAuthority?.toBase58()}`, aclSig);

  // 3. cross_gate config (allowlist), Token ACL meta lists, pass for Alice only.
  const [gateConfig] = await findConfigPda({ mint: kitAddr(mint) });
  const [thawMetas] = await findThawMetasPda({ mint: kitAddr(mint) });
  const [freezeMetas] = await findFreezeMetasPda({ mint: kitAddr(mint) });
  const gateSig = await send(
    new Transaction().add(
      toLegacy(getCreateConfigInstruction({ payer: op, mintAuthority: op, mint: kitAddr(mint), config: gateConfig, authority: kitAddr(operator.publicKey), mode: Mode.Allowlist })),
      toLegacy(getInitGateMetasInstruction({ payer: op, authority: op, mint: kitAddr(mint), config: gateConfig, thawMetas, freezeMetas })),
      toLegacy(getGrantPassInstruction({ authority: op, config: gateConfig, pass: passPda(mint, alice.publicKey), owner: kitAddr(alice.publicKey) })),
      createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, ata(mint, alice.publicKey), alice.publicKey, mint, TOKEN_2022_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, ata(mint, bob.publicKey), bob.publicKey, mint, TOKEN_2022_PROGRAM_ID),
    ),
    [operator],
  );
  ev.check('gate-config', 'cross_gate configured in allowlist mode; Alice holds a pass, Bob does not; both accounts start frozen', (await frozen(ata(mint, alice.publicKey))) && (await frozen(ata(mint, bob.publicKey))), `gate config ${gateConfig}`, gateSig);

  // 4. Alice thaws her own account without the issuer.
  const aliceThaw = await send(await thaw(mint, alice.publicKey, alice), [alice]);
  ev.check('DP8a', 'wallet with a pass thaws its account permissionlessly via Token ACL → cross_gate', !(await frozen(ata(mint, alice.publicKey))), 'Alice account now Initialized', aliceThaw);

  // 5. Bob cannot.
  const bobThaw = await expectFailure(await thaw(mint, bob.publicKey, bob), [bob], 'RecipientNotAllowed');
  ev.check('DP8b', 'wallet without a pass cannot thaw', await frozen(ata(mint, bob.publicKey)), bobThaw);

  // 6. Tokens flow to Alice but not to Bob.
  const mintSig = await send(new Transaction().add(createMintToInstruction(mint, ata(mint, alice.publicKey), operator.publicKey, 1_000_000_000n, [], TOKEN_2022_PROGRAM_ID)), [operator]);
  ev.check('mint-to', 'issuer mints to the thawed allowed account', true, '1,000 tokens to Alice', mintSig);
  const toBob = await expectFailure(new Transaction().add(createTransferCheckedInstruction(ata(mint, alice.publicKey), mint, ata(mint, bob.publicKey), alice.publicKey, 1_000_000n, 6, [], TOKEN_2022_PROGRAM_ID)), [alice], 'Account is frozen');
  ev.check('DP8c', 'transfer to a wallet without a pass fails (destination frozen)', true, toBob);

  // 7. Nobody can freeze Alice while she holds a pass.
  const freezeAlice = await expectFailure(await freeze(mint, alice.publicKey, bob), [bob], 'OwnerAllowed');
  ev.check('DP8d', 'permissionless freeze of a wallet that holds a pass is refused', !(await frozen(ata(mint, alice.publicKey))), freezeAlice);

  // 8. Revoke Alice's pass: anyone may now freeze her account.
  const revokeSig = await send(new Transaction().add(toLegacy(getRevokePassInstruction({ authority: op, config: gateConfig, pass: passPda(mint, alice.publicKey) }))), [operator]);
  ev.check('revoke', 'Alice pass revoked', true, 'pass account closed', revokeSig);
  const freezeSig = await send(await freeze(mint, alice.publicKey, bob), [bob]);
  ev.check('DP8e', 'after revocation any caller freezes the account via Token ACL → cross_gate', await frozen(ata(mint, alice.publicKey)), 'Alice account Frozen', freezeSig);

  // 9. The gate refuses to answer anyone but Token ACL (fake flag account).
  const fakeFlag = Keypair.generate().publicKey;
  const direct = new Transaction().add(
    toLegacy(getCanThawPermissionlessInstruction({ caller: kitAddr(bob.publicKey), tokenAccount: kitAddr(ata(mint, bob.publicKey)), mint: kitAddr(mint), owner: kitAddr(bob.publicKey), flag: kitAddr(fakeFlag), extraMetas: thawMetas, config: gateConfig, pass: passPda(mint, bob.publicKey) })),
  );
  const directRefused = await expectFailure(direct, [bob], 'NotCalledByTokenAcl');
  ev.check('DP8f', 'calling the gate directly (not through Token ACL) is refused', true, directRefused);
}

main().then(() => ev.write(), (e) => { console.error(e); ev.write(e); });
