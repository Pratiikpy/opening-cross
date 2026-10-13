// Deployment settings shared by server and client code.
//
// NEXT_PUBLIC_RPC_URL may list several endpoints separated by commas (a dedicated one first). The public devnet endpoints each answer
// a short burst and then 429, so the browser spreads its reads and moves to the next endpoint when one is limiting it.
const DEFAULT_ENDPOINTS = 'https://api.devnet.solana.com,https://solana-devnet.gateway.tatum.io,https://solana-devnet.api.onfinality.io/public';
export const RPC_ENDPOINTS = (process.env.NEXT_PUBLIC_RPC_URL ?? DEFAULT_ENDPOINTS)
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);
/** The primary endpoint: what the pages name and link to. */
export const RPC_URL = RPC_ENDPOINTS[0]!;
