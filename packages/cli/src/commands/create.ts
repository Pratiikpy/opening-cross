import { readFile } from 'node:fs/promises';
import { ActionError } from '@opening-cross/client';
import { type CommandDef, noExtra } from '../command.js';
import { type CreateFile, toCreateRequest, validateCreateFile } from '../create-file.js';
import { EXIT, UsageError } from '../exit.js';
import { dryRunLines, execute, exitFor } from '../act.js';
import { describeCross, emit } from '../format.js';
import { actingAddress, loadCross, stringOpt } from '../inputs.js';

const create: CommandDef = {
  path: ['create'],
  summary: 'Open a new cross from a JSON file (validated against schemas/create-cross.schema.json). The create and every shard are sent in order.',
  args: '',
  signs: true,
  options: {
    file: { type: 'string', value: 'path', description: 'the create file (required)' },
    creator: { type: 'string', value: 'address', description: 'with --dry-run and no key: simulate for this wallet' },
  },
  examples: ['opening-cross create --file launch.json --keypair issuer.json --cluster devnet', 'opening-cross create --file launch.json --dry-run --creator <address>'],
  async run(ctx, args) {
    noExtra(args, 0);
    const path = stringOpt(args.values.file);
    if (!path) throw new UsageError('Missing --file <path> (the JSON file that describes the cross).');
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (e) {
      throw new UsageError(`Could not read ${path} (${(e as NodeJS.ErrnoException).code ?? 'error'}).`);
    }
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch (e) {
      throw new UsageError(`${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    validateCreateFile(doc, path);
    const creator = await actingAddress(ctx, stringOpt(args.values.creator), '--creator');
    const now = await ctx.rpc.unixTime();
    const request = await toCreateRequest(doc as CreateFile, { creator, rpc: ctx.rpc, now });
    const built = await ctx.builder().createCross(request);
    const cross = String(built.extra.cross);
    let r: Awaited<ReturnType<typeof execute>>;
    try {
      r = await execute(ctx, built);
    } catch (e) {
      // The create transaction is first. Once it has landed the cross exists, and what is missing is only some of its shards:
      // say which cross it is and how to finish it, since the address was never printed.
      if (e instanceof ActionError && e.completed > 0) {
        e.message = `${e.message} The cross ${cross} exists but is not complete; finish it with: opening-cross init-shards ${cross} (same --keypair, --cluster and --rpc).`;
      }
      throw e;
    }
    const summary = { cross, crossId: request.crossId.toString(), creator, shards: request.shards };
    if (r.mode === 'dry-run') {
      emit(ctx, { ...summary, dryRun: true, simulations: r.simulations }, [`Cross ${cross} would be created with ${request.shards} shards.`, ...dryRunLines(r)]);
      return exitFor(r);
    }
    const after = await loadCross(ctx, cross);
    emit(ctx, { ...summary, signatures: r.signatures, state: after.detail.state }, [`Cross created: ${cross}`, ...r.signatures.map((s) => `signature ${s}`), '', ...describeCross(after.detail, after.now)]);
    return EXIT.OK;
  },
};

export const createCommands: CommandDef[] = [create];
