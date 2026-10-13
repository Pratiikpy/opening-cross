// What a check reports and what the engine decides from it.
export type Severity = 'critical' | 'warning' | 'info';

export type Finding = {
  /** The check that produced it, for example `vault-covers-orders`. */
  readonly check: string;
  /** What it is about (a cross, a program, a wallet) so the same problem on the same subject is recognised across passes. */
  readonly subject: string;
  readonly severity: Severity;
  readonly message: string;
  /** The figures behind the message, so a reader can check them. */
  readonly evidence: Readonly<Record<string, string | number | boolean | null>>;
};

/** A read-only connection to the cluster. Every check goes through this, so a test can stand in for the cluster. */
export interface Rpc {
  getAccount(address: string): Promise<{ data: Uint8Array; owner: string; lamports: bigint } | null>;
  /** All accounts of `program` with this exact data size and a given 32-byte value at `offset`, or with the discriminator at offset 0. */
  getProgramAccounts(program: string, filters: { dataSize?: number; memcmp?: { offset: number; bytes: Uint8Array } }[]): Promise<{ address: string; data: Uint8Array }[]>;
  getTokenBalance(account: string): Promise<bigint | null>;
  /** Newest-first signatures for an address, stopping before `until` when given. */
  getSignatures(address: string, opts: { until?: string; limit: number }): Promise<{ signature: string; slot: bigint; err: unknown; blockTime: number | null }[]>;
  /** Token balance changes of one transaction, or null if it cannot be read. */
  getTokenChanges(signature: string): Promise<{ mint: string; owner: string; delta: bigint }[] | null>;
  /** The cluster's clock in unix seconds. */
  unixTime(): Promise<number>;
}

export interface Check {
  readonly name: string;
  run(ctx: CheckContext): Promise<Finding[]>;
}

export type CheckContext = {
  rpc: Rpc;
  now: number;
  /** Runs `fn` once per pass for this key and shares the result with every check, so a scan of all crosses is read once. */
  memo<T>(key: string, fn: () => Promise<T>): Promise<T>;
};

/** Where a decision is announced. */
export interface Notifier {
  notify(event: { kind: 'finding' | 'decision' | 'incident'; at: number; body: unknown }): Promise<void>;
}
