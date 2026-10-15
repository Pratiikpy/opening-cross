// Request builders and strict response parsers for each endpoint, per the field tables of the v5.6 reference.
import { APASS_STATUS, CHAINS, type Chain } from './types.js';
import { type Obj, ShapeError, bool, nat, obj, oneOf, optionalStr, str, strArray } from './validate.js';

// ---- request helpers

export function chain(v: string): Chain {
  const c = String(v).toLowerCase();
  if (!(CHAINS as readonly string[]).includes(c)) throw new RangeError(`chain must be one of ${CHAINS.join(', ')}`);
  return c as Chain;
}

export function nonEmpty(v: string, field: string): string {
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > 256 || /[\r\n]/.test(v)) throw new RangeError(`${field} must be a non-empty single-line string`);
  return v;
}

const CUSTOMER_ID = /^[A-Za-z0-9]{12,}$/;
const customerId = (v: string) => {
  if (!CUSTOMER_ID.test(v)) throw new RangeError('customerId must be at least 12 characters, A-Z a-z 0-9 only');
  return v;
};

export const poolBody = (c: Chain, contractAddress: string) => ({ chain: chain(c), contract_address: nonEmpty(contractAddress, 'contract_address') });

export type GenerateApassInput = {
  customerId: string;
  /** Unix seconds. */
  expirationTime: number;
  wallet: { address: string; chain: Chain };
  kycSource?: string;
  kycId?: string;
  subTier?: number;
  subGroup?: string;
  override?: boolean;
  identityDataList?: { idType: 'ID_CARD' | 'PASSPORT' | 'DRIVER_LICENSE' | 'HK_MACAO_TAIWAN_PASS' | 'RESIDENCE_PERMIT'; fullName: string; issuingCountryISO2: string; idNumber?: string; validUntil?: string }[];
};

export function generateApassBody(i: GenerateApassInput): Obj {
  if (!Number.isSafeInteger(i.expirationTime) || i.expirationTime <= 0) throw new RangeError('expirationTime must be Unix seconds');
  if (i.subTier !== undefined && (!Number.isInteger(i.subTier) || i.subTier < 1 || i.subTier > 99)) throw new RangeError('subTier must be 1 to 99');
  if (i.subGroup !== undefined && !/^[A-Za-z]{2}$/.test(i.subGroup)) throw new RangeError('subGroup must be 2 letters');
  return {
    customerId: customerId(i.customerId),
    expirationTime: i.expirationTime,
    wallet: { address: nonEmpty(i.wallet.address, 'wallet.address'), chain: chain(i.wallet.chain) },
    ...(i.kycSource ? { kycSource: i.kycSource } : {}),
    ...(i.kycId ? { kycId: i.kycId } : {}),
    ...(i.subTier !== undefined ? { subTier: i.subTier } : {}),
    ...(i.subGroup ? { subGroup: i.subGroup } : {}),
    ...(i.override !== undefined ? { override: i.override } : {}),
    ...(i.identityDataList ? { identityDataList: i.identityDataList.map((d) => ({ ...d, issuingCountryISO2: validIso2(d.issuingCountryISO2) })) } : {}),
  };
}

function validIso2(v: string): string {
  if (!/^[A-Za-z]{2}$/.test(v)) throw new RangeError('issuingCountryISO2 must be an ISO 3166-1 alpha-2 code');
  return v.toUpperCase();
}

export function updateStatusBody(i: { chain: Chain; address: string; status: 'activate' | 'freeze'; customerId?: string; cvRecordId?: string; blacklistReason?: string }): Obj {
  return {
    status: i.status === 'activate' ? '1' : '2',
    wallet: { chain: chain(i.chain), address: nonEmpty(i.address, 'address') },
    ...(i.customerId ? { customerId: customerId(i.customerId) } : {}),
    ...(i.cvRecordId ? { cvRecordId: i.cvRecordId } : {}),
    ...(i.blacklistReason ? { blacklistReason: i.blacklistReason } : {}),
  };
}

export type ApassListFilter = { customerId?: string; chain?: Chain; walletAddress?: string; status?: 'active' | 'frozen'; page?: number; pageSize?: number; createdFrom?: string; createdTo?: string };

export function apassListBody(f: ApassListFilter): Obj {
  const pageSize = f.pageSize ?? 20;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new RangeError('pageSize must be 1 to 100');
  const page = f.page ?? 1;
  if (!Number.isInteger(page) || page < 1) throw new RangeError('page must be 1 or more');
  return {
    page,
    pageSize,
    ...(f.customerId ? { customerId: f.customerId } : {}),
    ...(f.chain ? { chain: chain(f.chain) } : {}),
    ...(f.walletAddress ? { walletAddress: nonEmpty(f.walletAddress, 'walletAddress') } : {}),
    ...(f.status ? { status: APASS_STATUS[f.status] } : {}),
    ...(f.createdFrom ? { createdFrom: f.createdFrom } : {}),
    ...(f.createdTo ? { createdTo: f.createdTo } : {}),
  };
}

export function faucetBody(i: { chain: Chain; symbol: string; depositAddress: string; amount: string }): Obj {
  if (!/^\d+(\.\d+)?$/.test(i.amount)) throw new RangeError('amount must be a decimal string');
  return { chain: chain(i.chain), symbol: nonEmpty(i.symbol, 'symbol'), depositAddress: nonEmpty(i.depositAddress, 'depositAddress'), amount: i.amount };
}

// ---- responses

export type GenerateApassResult = {
  customerId: string;
  cvRecordId: string;
  tier: string;
  wallet: { operate: string; address: string; chain: string; txHash: string; apassAddress: string };
};

export function parseGenerateApass(data: unknown): GenerateApassResult {
  const d = obj(data, 'data');
  const w = obj(d.wallet, 'data.wallet');
  return {
    customerId: str(d.customerId, 'data.customerId', { nonEmpty: true }),
    cvRecordId: str(d.cvRecordId, 'data.cvRecordId', { nonEmpty: true }),
    tier: str(d.tier, 'data.tier', { nonEmpty: true }),
    wallet: {
      operate: optionalStr(w.operate, 'data.wallet.operate'),
      address: str(w.address, 'data.wallet.address', { nonEmpty: true }),
      chain: str(w.chain, 'data.wallet.chain', { nonEmpty: true }),
      txHash: str(w.txHash, 'data.wallet.txHash', { nonEmpty: true }),
      apassAddress: optionalStr(w.apassAddress, 'data.wallet.apassAddress'),
    },
  };
}

export function parseTxHash(data: unknown): { txHash: string } {
  return { txHash: str(obj(data, 'data').txHash, 'data.txHash', { nonEmpty: true }) };
}

export type ApassRecord = {
  cvRecordId: string;
  /** The tier as a number (the API sends it as a string such as "26"). */
  tier: number;
  subTier: number;
  /** 1 active, 2 frozen. */
  status: 1 | 2;
  /** Unix seconds. */
  expirationTime: number;
  group: string;
  subGroup: string;
  currentKycHash: string;
  /** ISO 3166-1 alpha-2, upper case, de-duplicated. Empty when the pass carries no country tag. */
  countries: string[];
};

function countries(v: unknown, path: string): string[] {
  // The reference says the field is an empty array when no tag exists; an absent field reads as that. Anything else must be valid.
  if (v === undefined || v === null) return [];
  const raw = strArray(v, path, 300);
  const out: string[] = [];
  for (const c of raw) {
    if (!/^[A-Za-z]{2}$/.test(c)) throw new ShapeError(path, 'ISO 3166-1 alpha-2 codes', c);
    const u = c.toUpperCase();
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

function status(v: unknown, path: string): 1 | 2 {
  return oneOf(typeof v === 'string' && /^[12]$/.test(v) ? Number(v) : v, [1, 2] as const, path);
}

function apassFields(d: Obj, path: string) {
  const tierText = str(d.tier, `${path}.tier`, { nonEmpty: true, max: 8 });
  if (!/^\d{1,3}$/.test(tierText)) throw new ShapeError(`${path}.tier`, 'numeric tier', tierText);
  return {
    tier: Number(tierText),
    subTier: d.subTier === undefined || d.subTier === null ? 0 : nat(d.subTier, `${path}.subTier`),
    status: status(d.status, `${path}.status`),
    expirationTime: nat(d.expirationTime, `${path}.expirationTime`),
    group: optionalStr(d.group, `${path}.group`),
    subGroup: optionalStr(d.subGroup, `${path}.subGroup`),
    countries: countries(d.countries, `${path}.countries`),
  };
}

export function parseApass(data: unknown): ApassRecord {
  const d = obj(data, 'data');
  return { cvRecordId: str(d.cvRecordId, 'data.cvRecordId', { nonEmpty: true }), currentKycHash: optionalStr(d.currentKycHash, 'data.currentKycHash'), ...apassFields(d, 'data') };
}

export type ApassListItem = Omit<ApassRecord, 'currentKycHash'> & { customerId: string; chain: string; walletAddress: string; apassAddress: string; txHash: string; registeredAt: string };
export type ApassList = { total: number; page: number; pageSize: number; items: ApassListItem[] };

export function parseApassList(data: unknown): ApassList {
  const d = obj(data, 'data');
  if (!Array.isArray(d.items)) throw new ShapeError('data.items', 'array', d.items);
  if (d.items.length > 100) throw new ShapeError('data.items', 'at most 100 items', d.items);
  return {
    total: nat(d.total, 'data.total'),
    page: nat(d.page, 'data.page'),
    pageSize: nat(d.pageSize, 'data.pageSize'),
    items: d.items.map((raw, i) => {
      const it = obj(raw, `data.items[${i}]`);
      const path = `data.items[${i}]`;
      return {
        cvRecordId: optionalStr(it.cvRecordId, `${path}.cvRecordId`),
        customerId: str(it.customerId, `${path}.customerId`, { nonEmpty: true }),
        chain: str(it.chain, `${path}.chain`, { nonEmpty: true }),
        walletAddress: str(it.walletAddress, `${path}.walletAddress`, { nonEmpty: true }),
        apassAddress: optionalStr(it.apassAddress, `${path}.apassAddress`),
        txHash: optionalStr(it.txHash, `${path}.txHash`),
        registeredAt: optionalStr(it.registeredAt, `${path}.registeredAt`),
        ...apassFields(it, path),
      };
    }),
  };
}

/** `code` 4 is the only value that means "valid A-Pass, transfer allowed". */
export type VerifyApassResult = { chain: string; atoken: string; address: string; code: 1 | 2 | 3 | 4; message: string; magickLink: string };

export function parseVerifyApass(data: unknown): VerifyApassResult {
  const d = obj(data, 'data');
  return {
    chain: str(d.chain, 'data.chain', { nonEmpty: true }),
    atoken: str(d.atoken, 'data.atoken', { nonEmpty: true }),
    address: str(d.address, 'data.address', { nonEmpty: true }),
    code: oneOf(d.code, [1, 2, 3, 4] as const, 'data.code'),
    message: optionalStr(d.message, 'data.message'),
    magickLink: optionalStr(d.magickLink, 'data.magickLink'),
  };
}

type TokenInfo = { address: string; name: string; symbol: string; decimals: number };
export type AtokenList = { chain: string; tokens: { originToken: TokenInfo; atoken: TokenInfo; accesscoreAddress: string; apassAddress: string }[] };

function tokenInfo(v: unknown, path: string): TokenInfo {
  const t = obj(v, path);
  return { address: str(t.address, `${path}.address`, { nonEmpty: true }), name: str(t.name, `${path}.name`), symbol: str(t.symbol, `${path}.symbol`, { nonEmpty: true }), decimals: nat(t.decimals, `${path}.decimals`) };
}

export function parseAtokenList(data: unknown): AtokenList {
  const d = obj(data, 'data');
  if (!Array.isArray(d.tokens)) throw new ShapeError('data.tokens', 'array', d.tokens);
  return {
    chain: str(d.chain, 'data.chain', { nonEmpty: true }),
    tokens: d.tokens.map((raw, i) => {
      const t = obj(raw, `data.tokens[${i}]`);
      return {
        originToken: tokenInfo(t.origin_token, `data.tokens[${i}].origin_token`),
        atoken: tokenInfo(t.atoken, `data.tokens[${i}].atoken`),
        accesscoreAddress: optionalStr(t.accesscore_address, `data.tokens[${i}].accesscore_address`),
        apassAddress: optionalStr(t.apass_address, `data.tokens[${i}].apass_address`),
      };
    }),
  };
}

export type FaucetResult = { chain: string; symbol: string; depositAddress: string; amount: string; txHash: string };

export function parseFaucet(data: unknown): FaucetResult {
  const d = obj(data, 'data');
  return {
    chain: str(d.chain, 'data.chain', { nonEmpty: true }),
    symbol: str(d.symbol, 'data.symbol', { nonEmpty: true }),
    depositAddress: str(d.deposit_address, 'data.deposit_address', { nonEmpty: true }),
    amount: str(d.amount, 'data.amount', { nonEmpty: true }),
    txHash: str(d.tx_hash, 'data.tx_hash', { nonEmpty: true }),
  };
}

export const parseRegistered = (data: unknown): boolean => bool(obj(data, 'data').registered, 'data.registered');
export const parseValid = (data: unknown): boolean => bool(obj(data, 'data').valid, 'data.valid');
export const parsePaused = (data: unknown): boolean => bool(obj(data, 'data').paused, 'data.paused');

export type PoolRule = { allowedGroup: string; allowedSubGroup: string; minTier: number; minSubTier: number; isBlackList: boolean; countries: string[] };

export function parsePoolRules(data: unknown): PoolRule[] {
  const d = obj(data, 'data');
  if (!Array.isArray(d.rules)) throw new ShapeError('data.rules', 'array', d.rules);
  return d.rules.map((raw, i) => {
    const r = obj(raw, `data.rules[${i}]`);
    return {
      allowedGroup: optionalStr(r.allowed_group, `data.rules[${i}].allowed_group`),
      allowedSubGroup: optionalStr(r.allowed_sub_group, `data.rules[${i}].allowed_sub_group`),
      minTier: nat(r.min_tier, `data.rules[${i}].min_tier`),
      minSubTier: nat(r.min_sub_tier, `data.rules[${i}].min_sub_tier`),
      // is_black_list and countries are optional in the reference (false / empty when omitted).
      isBlackList: r.is_black_list === undefined || r.is_black_list === null ? false : bool(r.is_black_list, `data.rules[${i}].is_black_list`),
      countries: countries(r.countries, `data.rules[${i}].countries`),
    };
  });
}
