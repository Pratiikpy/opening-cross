import {
  type Address,
  type GetAccountInfoApi,
  type Rpc,
  fetchEncodedAccount,
  isSome,
} from '@solana/kit';
import {
  type Extension,
  type Mint,
  TOKEN_2022_PROGRAM_ADDRESS,
  decodeMint,
} from '@solana-program/token-2022';

export const SPL_TOKEN_PROGRAM_ADDRESS =
  'TokenkegQfeZyiNwAJsyFsP7wCcEfgJpbmsjb7RRxkq' as Address<'TokenkegQfeZyiNwAJsyFsP7wCcEfgJpbmsjb7RRxkq'>;

/**
 * `block`  — the mint cannot be used in a cross or pool at all.
 * `halt`   — usable in principle, but no cross may print while this holds.
 * `disclose` — an issuer power that must be shown to every bidder.
 */
export type Severity = 'block' | 'halt' | 'disclose';

export type RiskCode =
  | 'MINT_PAUSED'
  | 'PAUSE_AUTHORITY'
  | 'PERMANENT_DELEGATE'
  | 'FREEZE_AUTHORITY'
  | 'MINT_AUTHORITY'
  | 'SCALED_UI_MULTIPLIER'
  | 'SCALED_UI_MULTIPLIER_CHANGE_PENDING'
  | 'TRANSFER_HOOK'
  | 'TRANSFER_FEE'
  | 'DEFAULT_ACCOUNT_FROZEN'
  | 'NON_TRANSFERABLE'
  | 'MINT_CLOSE_AUTHORITY'
  | 'INTEREST_BEARING'
  | 'PERMISSIONED_BURN'
  | 'CONFIDENTIAL_TRANSFERS'
  | 'UNKNOWN_EXTENSION';

export interface Risk {
  code: RiskCode;
  severity: Severity;
  /** Plain-English sentence suitable for the Token Facts panel. */
  message: string;
  /** Authority or program holding the power, when the chain records one. */
  holder?: Address;
}

export interface MintSafetyReport {
  mint: Address;
  tokenProgram: Address;
  decimals: number;
  supply: bigint;
  /** Display multiplier in force at `asOf`; 1 when the mint has none. */
  uiMultiplier: number;
  asOf: bigint;
  risks: Risk[];
  /** False when any risk is `block` or `halt`. */
  crossable: boolean;
}

/** A scheduled multiplier change inside this window halts any cross that would settle across it. */
export const MULTIPLIER_CHANGE_HALT_WINDOW_SECONDS = 7n * 24n * 60n * 60n;

const ZERO_ADDRESS = '11111111111111111111111111111111';

function realAddress(a: Address | undefined): Address | undefined {
  return a && a !== ZERO_ADDRESS ? a : undefined;
}

function withHolder(risk: Omit<Risk, 'holder'>, holder: Address | undefined): Risk {
  return holder ? { ...risk, holder } : risk;
}

/**
 * Pure assessment of a decoded mint. `asOf` is a unix timestamp in seconds (use the
 * cluster's Clock sysvar in production so the answer matches what programs see).
 */
export function assessMint(
  mint: Address,
  tokenProgram: Address,
  data: Mint,
  asOf: bigint,
): MintSafetyReport {
  const risks: Risk[] = [];
  let uiMultiplier = 1;

  if (isSome(data.mintAuthority)) {
    risks.push({
      code: 'MINT_AUTHORITY',
      severity: 'disclose',
      message: 'The issuer can mint new supply at any time.',
      holder: data.mintAuthority.value,
    });
  }
  if (isSome(data.freezeAuthority)) {
    risks.push({
      code: 'FREEZE_AUTHORITY',
      severity: 'disclose',
      message: 'The issuer can freeze any holder account, including pool and escrow vaults.',
      holder: data.freezeAuthority.value,
    });
  }

  const extensions: Extension[] = isSome(data.extensions) ? data.extensions.value : [];
  for (const ext of extensions) {
    switch (ext.__kind) {
      case 'PausableConfig': {
        const holder = isSome(ext.authority) ? ext.authority.value : undefined;
        if (ext.paused) {
          risks.push(withHolder({ code: 'MINT_PAUSED', severity: 'halt', message: 'The issuer has paused all transfers of this token.' }, holder));
        } else if (holder) {
          risks.push({ code: 'PAUSE_AUTHORITY', severity: 'disclose', message: 'The issuer can pause all transfers, which would stop settlement and refunds in this token.', holder });
        }
        break;
      }
      case 'PermanentDelegate': {
        const holder = realAddress(ext.delegate);
        if (holder) {
          risks.push({ code: 'PERMANENT_DELEGATE', severity: 'disclose', message: 'The issuer can move or burn tokens from any account, including pool and escrow vaults.', holder });
        }
        break;
      }
      case 'ScaledUiAmountConfig': {
        const changeAt = ext.newMultiplierEffectiveTimestamp;
        uiMultiplier = asOf >= changeAt ? ext.newMultiplier : ext.multiplier;
        const multiplierAuthority = realAddress(ext.authority);
        if (uiMultiplier !== 1 || multiplierAuthority) {
          const changeable = multiplierAuthority ? ' The issuer can change this multiplier.' : '';
          risks.push(withHolder({ code: 'SCALED_UI_MULTIPLIER', severity: 'disclose', message: `Displayed balances are raw amounts × ${uiMultiplier}; prices must be quoted on the same basis.${changeable}` }, multiplierAuthority));
        }
        if (changeAt > asOf && ext.newMultiplier !== ext.multiplier) {
          const severity: Severity = changeAt - asOf <= MULTIPLIER_CHANGE_HALT_WINDOW_SECONDS ? 'halt' : 'disclose';
          risks.push(withHolder({ code: 'SCALED_UI_MULTIPLIER_CHANGE_PENDING', severity, message: `The display multiplier changes from ${ext.multiplier} to ${ext.newMultiplier} at unix ${changeAt}.` }, realAddress(ext.authority)));
        }
        break;
      }
      case 'TransferHook': {
        const program = realAddress(ext.programId);
        if (program) {
          risks.push({ code: 'TRANSFER_HOOK', severity: 'block', message: 'Every transfer runs an issuer-controlled program; it is not supported until that program is reviewed and allow-listed.', holder: program });
        } else if (realAddress(ext.authority)) {
          risks.push({ code: 'TRANSFER_HOOK', severity: 'disclose', message: 'No transfer hook is active, but the issuer can install one later.', holder: ext.authority });
        }
        break;
      }
      case 'TransferFeeConfig': {
        // The active fee depends on the epoch; take the higher of the two so a scheduled raise is never missed.
        const fee = Math.max(ext.newerTransferFee.transferFeeBasisPoints, ext.olderTransferFee.transferFeeBasisPoints);
        if (fee > 0) {
          risks.push(withHolder({ code: 'TRANSFER_FEE', severity: 'block', message: `Transfers are charged ${fee} bps by the issuer, which breaks exact escrow accounting.` }, realAddress(ext.transferFeeConfigAuthority)));
        } else if (realAddress(ext.transferFeeConfigAuthority)) {
          risks.push({ code: 'TRANSFER_FEE', severity: 'disclose', message: 'Transfer fee is zero today, but the issuer can raise it.', holder: ext.transferFeeConfigAuthority });
        }
        break;
      }
      case 'DefaultAccountState':
        // AccountState.Frozen === 2
        if (Number(ext.state) === 2) {
          risks.push({ code: 'DEFAULT_ACCOUNT_FROZEN', severity: 'disclose', message: 'New accounts start frozen until the issuer approves them.' });
        }
        break;
      case 'NonTransferable':
        risks.push({ code: 'NON_TRANSFERABLE', severity: 'block', message: 'This token cannot be transferred.' });
        break;
      case 'MintCloseAuthority':
        if (realAddress(ext.closeAuthority)) {
          risks.push({ code: 'MINT_CLOSE_AUTHORITY', severity: 'disclose', message: 'The issuer can close the mint once supply is zero.', holder: ext.closeAuthority });
        }
        break;
      case 'InterestBearingConfig':
        risks.push(withHolder({ code: 'INTEREST_BEARING', severity: 'disclose', message: 'Displayed amounts accrue interest; raw amounts do not change.' }, realAddress(ext.rateAuthority)));
        break;
      case 'PermissionedBurn':
        risks.push(withHolder({ code: 'PERMISSIONED_BURN', severity: 'disclose', message: 'Burning requires the issuer’s approval.' }, isSome(ext.authority) ? ext.authority.value : undefined));
        break;
      case 'ConfidentialTransferMint':
        risks.push({ code: 'CONFIDENTIAL_TRANSFERS', severity: 'disclose', message: 'Confidential transfers are configured; balances moved confidentially are not visible on chain.' });
        break;
      case 'Uninitialized':
      case 'MetadataPointer':
      case 'TokenMetadata':
      case 'GroupPointer':
      case 'GroupMemberPointer':
      case 'TokenGroup':
      case 'TokenGroupMember':
      case 'ConfidentialTransferFee':
      case 'ConfidentialMintBurn':
        break;
      default:
        risks.push({ code: 'UNKNOWN_EXTENSION', severity: 'block', message: `Unrecognised mint extension "${ext.__kind}".` });
    }
  }

  const crossable = !risks.some((r) => r.severity !== 'disclose');
  return { mint, tokenProgram, decimals: data.decimals, supply: data.supply, uiMultiplier, asOf, risks, crossable };
}

/** Fetches and assesses a mint. Throws when the account is missing or not a token mint. */
export async function fetchMintSafety(
  rpc: Rpc<GetAccountInfoApi>,
  mint: Address,
  asOf: bigint,
): Promise<MintSafetyReport> {
  const account = await fetchEncodedAccount(rpc, mint);
  if (!account.exists) throw new Error(`Mint ${mint} does not exist`);
  if (account.programAddress !== TOKEN_2022_PROGRAM_ADDRESS && account.programAddress !== SPL_TOKEN_PROGRAM_ADDRESS) {
    throw new Error(`Account ${mint} is owned by ${account.programAddress}, not a token program`);
  }
  const decoded = decodeMint(account);
  return assessMint(mint, account.programAddress, decoded.data, asOf);
}
