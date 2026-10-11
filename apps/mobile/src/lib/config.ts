// Deployment settings. Expo inlines EXPO_PUBLIC_* at build time.
//   EXPO_PUBLIC_API_URL    Opening Cross API (an Android emulator reaches the host machine at 10.0.2.2)
//   EXPO_PUBLIC_RPC_URL    Solana RPC used to send and confirm signed transactions
//   EXPO_PUBLIC_NETWORK    devnet | mainnet-beta | testnet (the cluster the wallet is asked to authorise)
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:8080';
export const RPC_URL = process.env.EXPO_PUBLIC_RPC_URL ?? 'https://api.devnet.solana.com';
export const NETWORK = (process.env.EXPO_PUBLIC_NETWORK ?? 'devnet') as 'devnet' | 'mainnet-beta' | 'testnet';
