// What a cross opened without a pool, for the settlement read (X3 and B4, ADR-0930): the MetaDAO futarchy DAOs (FutarchyDaoSeeded) and the fixed-price presale tranches
// (FixedPricePresaleOpened) of one cross, from migration 020. `GET /v1/crosses/:address/settlement` in services/api returns the pool venue from settle_venues; it adds these two
// lists from here.
import type pg from 'pg';

type Db = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export interface FutarchyDaoOpened {
  dao: string;
  clearingPrice: string;
  baseAmount: string;
  quoteAmount: string;
  signature: string;
  slot: string;
}

export interface FixedPricePresale {
  presale: string;
  clearingPrice: string;
  /** The price in Meteora's Q64.64 form, as the program wrote it. */
  qPrice: string;
  signature: string;
  slot: string;
}

/** Oldest first. Empty lists are the normal answer for a cross that opened neither (and, until cross_settle's batch 2 build is deployed, for every cross). */
export async function settlementMarkets(db: Db, cross: string): Promise<{ futarchyDaos: FutarchyDaoOpened[]; presales: FixedPricePresale[] }> {
  const [daos, presales] = await Promise.all([
    db.query('SELECT dao, clearing_price::text AS "clearingPrice", base_amount::text AS "baseAmount", quote_amount::text AS "quoteAmount", signature, slot::text AS slot FROM settle_futarchy_daos WHERE cross_address = $1 ORDER BY slot, dao', [cross]),
    db.query('SELECT presale, clearing_price::text AS "clearingPrice", q_price::text AS "qPrice", signature, slot::text AS slot FROM settle_presales WHERE cross_address = $1 ORDER BY slot, presale', [cross]),
  ]);
  return { futarchyDaos: daos.rows as FutarchyDaoOpened[], presales: presales.rows as FixedPricePresale[] };
}
