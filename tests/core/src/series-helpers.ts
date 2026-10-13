// Builders for recurring series (ADR-0456): create one, and spawn its next cross.
import type { Address, Instruction, TransactionSigner } from '@solana/kit';
import { getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token-2022';
import {
  type Series,
  type SeriesConfigArgs,
  ata,
  baseVaultAddress,
  bookAddress,
  crossAddress,
  getCreateSeriesInstruction,
  getSeriesDecoder,
  getSpawnNextInstruction,
  printFeedAddress,
  protocolAddress,
  quoteVaultAddress,
  readonly,
  seriesAddress,
  withAccounts,
} from '@opening-cross/sdk';

export type SeriesView = { address: Address; data: Series };

export function viewOfSeries(address: Address, bytes: Uint8Array): SeriesView {
  return { address, data: getSeriesDecoder().decode(bytes) };
}

/** Creates a series and the token accounts it holds the dust bond and the proceeds in. */
export async function buildCreateSeries(input: {
  authority: TransactionSigner;
  seriesId: bigint;
  baseMint: Address;
  quoteMint: Address;
  baseTokenProgram: Address;
  quoteTokenProgram: Address;
  config: SeriesConfigArgs;
}): Promise<{ series: Address; instructions: Instruction[] }> {
  const series = await seriesAddress(input.authority.address, input.seriesId);
  return {
    series,
    instructions: [
      getCreateSeriesInstruction({
        authority: input.authority,
        series,
        baseMint: input.baseMint,
        quoteMint: input.quoteMint,
        baseTokenProgram: input.baseTokenProgram,
        quoteTokenProgram: input.quoteTokenProgram,
        seriesId: input.seriesId,
        config: input.config,
      }),
      getCreateAssociatedTokenIdempotentInstruction({ payer: input.authority, ata: await ata(series, input.quoteMint, input.quoteTokenProgram), owner: series, mint: input.quoteMint, tokenProgram: input.quoteTokenProgram }),
      getCreateAssociatedTokenIdempotentInstruction({ payer: input.authority, ata: await ata(series, input.baseMint, input.baseTokenProgram), owner: series, mint: input.baseMint, tokenProgram: input.baseTokenProgram }),
    ],
  };
}

/** `spawn_next` for the series' next cross. The previous cross is required from the second one on. */
export async function buildSpawnNext(series: SeriesView, payer: TransactionSigner, opts: { feed?: boolean } = {}): Promise<{ cross: Address; instruction: Instruction }> {
  const s = series.data;
  const cross = await crossAddress(series.address, s.nextIndex);
  const calendar = s.config.calendar.__option === 'Some' ? s.config.calendar.value : null;
  const ix = getSpawnNextInstruction({
    payer,
    protocol: await protocolAddress(),
    series: series.address,
    cross,
    book: await bookAddress(cross),
    baseMint: s.baseMint,
    quoteMint: s.quoteMint,
    quoteVault: await quoteVaultAddress(cross),
    baseVault: await baseVaultAddress(cross),
    seriesQuote: await ata(series.address, s.quoteMint, s.quoteTokenProgram),
    ...(s.lastCross.__option === 'Some' ? { previous: s.lastCross.value } : {}),
    ...(calendar ? { calendarAccount: calendar } : {}),
    baseTokenProgram: s.baseTokenProgram,
    quoteTokenProgram: s.quoteTokenProgram,
  });
  return { cross, instruction: opts.feed ? withAccounts(ix, [readonly(await printFeedAddress(s.baseMint))]) : ix };
}
