export const CHAINS = ['solana', 'base', 'avalanche', 'arbitrum', 'ethereum', 'polygon', 'bsc', 'monad', 'hashkey', 'platon'] as const;
export type Chain = (typeof CHAINS)[number];

/** A-Pass status as the API reports it. */
export const APASS_STATUS = { active: 1, frozen: 2 } as const;
