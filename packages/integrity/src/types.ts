// Shared shapes. Amounts are bigint in memory and decimal strings on the wire; nothing here uses floating point for money.

/** The one thing the readers need from a Solana client: a JSON-RPC call. `FailoverRpc` from @opening-cross/reliability fits. */
export interface RpcLike {
  call<T = unknown>(method: string, params?: unknown[]): Promise<T>;
}

export type HolderKind = 'burn' | 'protocol' | 'issuer' | 'team' | 'wallet' | 'program-account';

export interface Label {
  kind: HolderKind;
  /** A short name a person can read: "Meteora DBC pool authority", "Issuer (mint authority)". */
  name: string;
  /** Why it has this label: the fact that makes it so. A label without a basis is not shown. */
  basis: string;
}

export interface Holder {
  /** The token account. */
  tokenAccount: string;
  /** The wallet or program account that owns it. */
  owner: string;
  amount: bigint;
  /** Share of the mint's supply in basis points (10000 = all of it), rounded down. */
  shareBps: number;
  label: Label;
}

/** Where a wallet's first SOL came from. */
export interface Funding {
  wallet: string;
  /** The account that sent the first lamports, or null when none could be found. */
  funder: string | null;
  lamports: bigint | null;
  signature: string | null;
  blockTime: number | null;
  /** Why `funder` is null: the history was longer than the pages read, or the first transactions held no SOL transfer in. */
  unknown?: 'history-too-long' | 'no-inbound-transfer' | 'no-history';
}

export interface Cluster {
  /** Wallets that share a funder, or fund one another, with the links that join them. */
  members: string[];
  links: { a: string; b: string; why: string }[];
  /** Basis points of supply held by the cluster, when holdings are known. */
  shareBps?: number;
}
