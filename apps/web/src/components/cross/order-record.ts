import type { OwnerOrder } from '@/lib/types';

/** One row of GET /v1/crosses/:address/orders: the indexer's record of an order in this cross. */
export type OrderRecord = Omit<OwnerOrder, 'cross_address'> & { owner: string };
