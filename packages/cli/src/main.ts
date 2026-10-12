import { ActionError } from '@opening-cross/client';
import { type CommandDef, GLOBAL_OPTIONS, WRITE_OPTIONS, contextFor, globalsOf, parseCommandArgs } from './command.js';
import { createCommands } from './commands/create.js';
import { crossCommands } from './commands/cross.js';
import { orderCommands } from './commands/order.js';
import { quoteCommands } from './commands/quote.js';
import { settleCommands } from './commands/settle.js';
import { watchCommands } from './commands/watch.js';
import type { Runtime } from './context.js';
import { EXIT, UsageError, exitCodeFor } from './exit.js';
import { jsonText } from './format.js';

export const COMMANDS: readonly CommandDef[] = [...crossCommands, ...orderCommands, ...settleCommands, ...createCommands, ...quoteCommands, ...watchCommands];

const EXIT_HELP = [
  'Exit codes:',
  `  ${EXIT.OK}  success`,
  `  ${EXIT.FAILED}  the command ran and the answer is no: a proof did not verify, a transaction failed or a simulation would fail`,
  `  ${EXIT.USAGE}  bad command, flag or input (a bad address, an off-grid price, junk JSON, a missing key file); nothing was sent`,
  `  ${EXIT.UNREACHABLE}  the network or the API could not be reached or was too busy; a send that timed out names the signature to check`,
  `  ${EXIT.UNAVAILABLE}  this deployment does not offer what was asked (for example best-execution quotes)`,
];

function optionLines(opts: Record<string, { type: string; description: string; value?: string; short?: string }>): string[] {
  const rows = Object.entries(opts).map(([name, o]) => [`${o.short ? `-${o.short}, ` : ''}--${name}${o.type === 'string' ? ` <${o.value ?? 'value'}>` : ''}`, o.description] as const);
  const w = Math.max(...rows.map(([a]) => a.length));
  return rows.map(([a, d]) => `  ${a.padEnd(w)}  ${d}`);
}

export function overview(): string[] {
  const rows = COMMANDS.map((c) => [`${c.path.join(' ')}${c.args ? ` ${c.args}` : ''}`, c.summary] as const);
  const w = Math.max(...rows.map(([a]) => a.length));
  return [
    'opening-cross: read, trade and verify Opening Cross auctions from a terminal.',
    '',
    'Usage: opening-cross <command> [arguments] [options]',
    '',
    'Commands:',
    ...rows.map(([a, d]) => `  ${a.padEnd(w)}  ${d}`),
    '',
    'Options for every command:',
    ...optionLines(GLOBAL_OPTIONS),
    '',
    'Commands that sign also take:',
    ...optionLines(WRITE_OPTIONS),
    '',
    'This tool signs with a keypair file you name and never generates, stores or prints keys. Sealed-bid salts are kept in the vault file.',
    '',
    ...EXIT_HELP,
    '',
    'Run `opening-cross <command> --help` for one command.',
  ];
}

export function commandHelp(def: CommandDef): string[] {
  return [
    `opening-cross ${def.path.join(' ')}${def.args ? ` ${def.args}` : ''} [options]`,
    '',
    def.summary,
    '',
    'Options:',
    ...optionLines({ ...def.options, ...(def.signs ? WRITE_OPTIONS : {}), ...GLOBAL_OPTIONS }),
    ...(def.examples?.length ? ['', 'Examples:', ...def.examples.map((e) => `  ${e}`)] : []),
    '',
    ...EXIT_HELP,
  ];
}

function find(argv: readonly string[]): { def: CommandDef; rest: string[] } | null {
  // Longest match first, so `order place` wins over a hypothetical `order`.
  const sorted = [...COMMANDS].sort((a, b) => b.path.length - a.path.length);
  for (const def of sorted) {
    if (def.path.every((word, i) => argv[i] === word)) return { def, rest: argv.slice(def.path.length) };
  }
  return null;
}

/** Runs the CLI with the given arguments and returns the exit code. Never throws and never calls process.exit, so tests and other programs can call it. */
export async function run(argv: readonly string[], rt: Runtime): Promise<number> {
  const wantsJson = argv.includes('--json');
  const fail = (e: unknown): number => {
    const err = e instanceof ActionError ? e : null;
    const message = err ? err.message : e instanceof Error ? `Unexpected error: ${e.message}` : `Unexpected error: ${String(e)}`;
    const code = err ? exitCodeFor(err) : EXIT.FAILED;
    if (wantsJson) rt.io.err(jsonText({ error: { code: err?.code ?? 'INTERNAL', message, exit: code, ...(err && err.completed > 0 ? { transactionsLanded: err.completed } : {}) } }));
    else {
      rt.io.err(`error: ${message}`);
      if (err && err.completed > 0) rt.io.err(`${err.completed} transaction${err.completed === 1 ? '' : 's'} of this action had already landed before it stopped; check the cross before retrying.`);
    }
    return code;
  };

  try {
    const [first] = argv;
    if (argv.length === 0 || first === '--help' || first === '-h' || first === 'help') {
      const target = first === 'help' ? find(argv.slice(1)) : null;
      for (const l of target ? commandHelp(target.def) : overview()) rt.io.out(l);
      return EXIT.OK;
    }
    if (first === '--version' || first === '-v') {
      rt.io.out((await import('./version.js')).VERSION);
      return EXIT.OK;
    }
    const found = find(argv);
    if (!found) {
      if (first === 'keygen' || first === 'wallet' || first === 'new-keypair') throw new UsageError('This tool never generates or stores keys. Make a keypair file with `solana-keygen new` and pass it with --keypair.');
      throw new UsageError(`Unknown command "${argv.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ')}". Run \`opening-cross --help\` for the list.`);
    }
    const parsed = parseCommandArgs(found.def, found.rest);
    if (parsed.help) {
      for (const l of commandHelp(found.def)) rt.io.out(l);
      return EXIT.OK;
    }
    const ctx = contextFor(globalsOf(parsed.values), rt);
    return await found.def.run(ctx, parsed, globalsOf(parsed.values));
  } catch (e) {
    return fail(e);
  }
}
