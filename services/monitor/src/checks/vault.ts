// Do the vaults hold at least what the open orders put in?
//
// A bid escrows its whole worst-case cost in the cross's quote vault and an ask escrows its tokens in the base vault (the
// program's own rule, INVARIANTS I5, I6). While a cross is Live nothing has been paid out, so each vault must hold at least the
// escrow of the open order accounts that exist. If it holds less, tokens have left that no order explains: the one condition
// under which an operator should stop new money from entering. Pausing blocks new crosses and new orders only (I11); every
// claim and refund keeps working.
//
// Two reads cannot be taken at one instant, so a new order or a claim landing between them can make a healthy cross look short
// for a moment. The engine therefore acts only when the same shortfall is seen on several passes in a row.
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, CrossState, OrderSide, baseVaultAddress, getCrossDecoder, getOrderDecoder, getOrderEncoder, quoteVaultAddress } from '@opening-cross/sdk';
import { getAddressEncoder, type Address } from '@solana/kit';
import type { Check, CheckContext, Finding } from '../types.js';

/** Every cross_core cross account, decoded. Read once per pass and shared. */
export const allCrosses = (ctx: CheckContext) =>
  ctx.memo('crosses', async () =>
    (await ctx.rpc.getProgramAccounts(CROSS_CORE_PROGRAM_ADDRESS, [{ memcmp: { offset: 0, bytes: CROSS_DISCRIMINATOR as Uint8Array } }])).map((c) => ({ address: c.address as Address, data: getCrossDecoder().decode(c.data) })),
  );

const ORDER_SIZE = getOrderEncoder().fixedSize;

export type VaultCheckOptions = {
  /** Most Live crosses examined in one pass. */
  maxCrosses?: number;
};

export function vaultCoversOrders(o: VaultCheckOptions = {}): Check {
  return {
    name: 'vault-covers-orders',
    async run(ctx) {
      const { rpc } = ctx;
      const findings: Finding[] = [];
      const live = (await allCrosses(ctx)).filter((c) => c.data.state === CrossState.Live && c.data.ordersOpen > 0).slice(0, o.maxCrosses ?? 50);
      for (const c of live) {
        // The vault first, then the orders: a claim in between can only make the vault look fuller than the orders, never emptier.
        const quoteBalance = await rpc.getTokenBalance(await quoteVaultAddress(c.address));
        const baseBalance = c.data.baseBound ? await rpc.getTokenBalance(await baseVaultAddress(c.address)) : null;
        const orders = (await rpc.getProgramAccounts(CROSS_CORE_PROGRAM_ADDRESS, [{ dataSize: ORDER_SIZE }, { memcmp: { offset: 8, bytes: Uint8Array.from(getAddressEncoder().encode(c.address)) } }])).map((a) => getOrderDecoder().decode(a.data));
        const owed = { buy: 0n, sell: 0n };
        for (const ord of orders) owed[ord.side === OrderSide.Buy ? 'buy' : 'sell'] += ord.escrow;
        for (const [side, vault, balance] of [['quote', 'buy', quoteBalance], ['base', 'sell', baseBalance]] as const) {
          const need = owed[vault];
          if (need === 0n) continue;
          if (balance === null || balance < need) {
            findings.push({
              check: 'vault-covers-orders',
              subject: `${c.address}:${side}`,
              severity: 'critical',
              message: balance === null ? `the ${side} vault of cross ${c.address} does not exist but open orders escrowed ${need}` : `the ${side} vault of cross ${c.address} holds ${balance}, less than the ${need} the open orders escrowed`,
              evidence: { cross: c.address, vault: side, balance: balance === null ? null : balance.toString(), owed: need.toString(), shortfall: balance === null ? need.toString() : (need - balance).toString(), orders: orders.length, ordersOpenCounter: c.data.ordersOpen },
            });
          }
        }
        if (orders.length !== c.data.ordersOpen) {
          findings.push({
            check: 'vault-covers-orders',
            subject: `${c.address}:counter`,
            severity: 'warning',
            message: `cross ${c.address} counts ${c.data.ordersOpen} open orders but ${orders.length} order accounts exist (a placement or claim may have landed between the two reads)`,
            evidence: { cross: c.address, counter: c.data.ordersOpen, accounts: orders.length },
          });
        }
      }
      return findings;
    },
  };
}
