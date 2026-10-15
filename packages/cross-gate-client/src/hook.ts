// Transfers of a mint whose transfer hook is cross_gate. Token-2022 calls the hook with the accounts the mint's
// extra-account-meta list names, and a client that builds the transfer must pass them. Every gate starts with a list of
// three (the gate config, the receiver's pass, the sender's lock). A gate that turns on compliance rules rewrites it to six
// with `update_hook_metas`, adding the sender's terms, the sender's affiliate volume and the receiver's terms (ADR-0900).
// The version is a property of the mint, so a client reads it (`detectHookListVersion`) rather than assuming it.
import { AccountRole, type Address, type Instruction, type ReadonlyUint8Array } from '@solana/kit';
import { findConfigPda, findExtraMetasPda } from './generated/index.js';
import { CROSS_GATE_PROGRAM_ADDRESS } from './generated/programs/index.js';
import { findLockAddress, findPassAddress, findTermsAddress, findVolumeAddress } from './pdas.js';

/** `1`: the list every gate starts with (3 extra accounts). `2`: the list of a gate with rules (6 extra accounts). */
export type HookListVersion = 1 | 2;

export type HookAccount = { address: Address; role: AccountRole };

/** Extra accounts in each list version. */
export const HOOK_LIST_LENGTH: Record<HookListVersion, number> = { 1: 3, 2: 6 };

/**
 * The version of a mint's extra-account-meta list, from the list account's data: an 8-byte hook discriminator, a `u32`
 * length, then a `u32` count of entries. Throws for any count this client does not know, so a new list layout is an error
 * and not a transfer with the wrong accounts.
 */
export function detectHookListVersion(extraMetasData: ReadonlyUint8Array): HookListVersion {
  if (extraMetasData.length < 16) throw new Error('not an extra-account-meta list');
  const count = new DataView(extraMetasData.buffer, extraMetasData.byteOffset, extraMetasData.byteLength).getUint32(12, true);
  const version = (Object.entries(HOOK_LIST_LENGTH).find(([, n]) => n === count)?.[0] ?? null) as string | null;
  if (version === null) throw new Error(`unknown extra-account-meta list of ${count} accounts`);
  return Number(version) as HookListVersion;
}

/**
 * The extra accounts a transfer must carry, in list order, then the hook program and the list itself. The order is the one
 * Token-2022 itself appends after the four accounts of a `TransferChecked`.
 */
export async function resolveHookAccounts(i: { mint: Address; sourceOwner: Address; destinationOwner: Address; listVersion: HookListVersion }): Promise<HookAccount[]> {
  const [config] = await findConfigPda({ mint: i.mint });
  const [destinationPass] = await findPassAddress(i.mint, i.destinationOwner);
  const [sourceLock] = await findLockAddress(i.mint, i.sourceOwner);
  const out: HookAccount[] = [
    { address: config, role: AccountRole.READONLY },
    { address: destinationPass, role: AccountRole.READONLY },
    { address: sourceLock, role: AccountRole.READONLY },
  ];
  if (i.listVersion === 2) {
    const [sourceTerms] = await findTermsAddress(i.mint, i.sourceOwner);
    const [sourceVolume] = await findVolumeAddress(i.mint, i.sourceOwner);
    const [destinationTerms] = await findTermsAddress(i.mint, i.destinationOwner);
    out.push(
      { address: sourceTerms, role: AccountRole.READONLY },
      { address: sourceVolume, role: AccountRole.WRITABLE },
      { address: destinationTerms, role: AccountRole.READONLY },
    );
  }
  const [extraMetas] = await findExtraMetasPda({ mint: i.mint });
  out.push({ address: CROSS_GATE_PROGRAM_ADDRESS, role: AccountRole.READONLY }, { address: extraMetas, role: AccountRole.READONLY });
  return out;
}

/**
 * A Token-2022 `TransferChecked` (built with whichever token library the caller uses) with the hook's accounts attached.
 * `sourceOwner` and `destinationOwner` are the wallets that own the source and destination token accounts, not the
 * token accounts themselves.
 */
export async function withHookAccounts(
  transfer: Instruction,
  i: { mint: Address; sourceOwner: Address; destinationOwner: Address; listVersion: HookListVersion },
): Promise<Instruction> {
  const extras = await resolveHookAccounts(i);
  return { ...transfer, accounts: [...(transfer.accounts ?? []), ...extras] } as Instruction;
}
