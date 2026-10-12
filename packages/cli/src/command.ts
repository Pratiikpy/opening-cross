import { parseArgs } from 'node:util';
import { type Context, type Globals, type Runtime, resolveContext } from './context.js';
import { UsageError } from './exit.js';

export type OptionSpec = { type: 'string' | 'boolean'; description: string; value?: string; short?: string };

export type ParsedArgs = { positionals: string[]; values: Record<string, string | boolean | undefined> };

export type CommandDef = {
  /** The words that select the command, for example `['order', 'place']`. */
  path: readonly string[];
  summary: string;
  /** Positional arguments, as shown in usage: `<cross>`. */
  args: string;
  options: Record<string, OptionSpec>;
  examples?: readonly string[];
  /** Needs a signing key (shown in help; the command itself asks the context for the signer). */
  signs?: boolean;
  run(ctx: Context, args: ParsedArgs, globals: Globals): Promise<number>;
};

/** Options every command accepts. */
export const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  cluster: { type: 'string', value: 'name', description: 'localnet, devnet or mainnet-beta (default devnet; env OPENING_CROSS_CLUSTER)' },
  rpc: { type: 'string', value: 'url', description: 'Solana RPC endpoint (default per cluster; env OPENING_CROSS_RPC)' },
  api: { type: 'string', value: 'url', description: 'Opening Cross API (env OPENING_CROSS_API); needed by commands that read the index' },
  json: { type: 'boolean', description: 'print one JSON document instead of text; errors go to stderr as JSON' },
  help: { type: 'boolean', short: 'h', description: 'show help for this command' },
};

/** Added to commands that build a transaction. */
export const WRITE_OPTIONS: Record<string, OptionSpec> = {
  keypair: { type: 'string', value: 'file', description: 'Solana CLI keypair file that signs (env OPENING_CROSS_KEYPAIR is its path; OPENING_CROSS_SECRET_KEY holds the 64-byte JSON array)' },
  'dry-run': { type: 'boolean', description: 'simulate against the cluster and print the result; sign nothing, send nothing, write nothing' },
  build: { type: 'string', value: 'local|api', description: 'build the transaction here from chain state (default) or ask the API' },
  vault: { type: 'string', value: 'file', description: 'where sealed-bid salts are kept (default ~/.opening-cross/sealed-bids-<cluster>.json; env OPENING_CROSS_VAULT)' },
};

export function parseCommandArgs(def: CommandDef, argv: readonly string[]): ParsedArgs & { help: boolean } {
  const options: Record<string, { type: 'string' | 'boolean'; short?: string }> = {};
  for (const [name, spec] of Object.entries({ ...GLOBAL_OPTIONS, ...(def.signs ? WRITE_OPTIONS : {}), ...def.options })) options[name] = { type: spec.type, ...(spec.short ? { short: spec.short } : {}) };
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });
  } catch (e) {
    const message = e instanceof Error ? e.message.replace(/\. To specify a positional argument starting with a '-'.*$/, '.') : String(e);
    throw new UsageError(`${message} (run "opening-cross ${def.path.join(' ')} --help")`);
  }
  const { help, ...values } = parsed.values as Record<string, string | boolean | undefined>;
  return { positionals: parsed.positionals, values, help: help === true };
}

export function globalsOf(values: ParsedArgs['values']): Globals {
  const s = (k: string) => (typeof values[k] === 'string' ? (values[k] as string) : undefined);
  return { cluster: s('cluster'), rpc: s('rpc'), api: s('api'), keypair: s('keypair'), vault: s('vault'), build: s('build'), json: values.json === true, 'dry-run': values['dry-run'] === true };
}

export function contextFor(globals: Globals, rt: Runtime): Context {
  return resolveContext(globals, rt);
}

/** The positional argument at `index`, or a usage error naming what is missing. */
export function positional(args: ParsedArgs, index: number, name: string): string {
  const v = args.positionals[index];
  if (v === undefined) throw new UsageError(`Missing <${name}>.`);
  return v;
}

export function noExtra(args: ParsedArgs, expected: number): void {
  if (args.positionals.length > expected) throw new UsageError(`Unexpected argument "${args.positionals[expected]}".`);
}
