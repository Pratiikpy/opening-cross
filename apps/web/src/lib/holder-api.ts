// Where the holder-side routes (alerts, actions, sponsored orders, comments, retention) live. They are served by the same API as
// everything else, so this is NEXT_PUBLIC_API_URL; it can be pointed elsewhere (NEXT_PUBLIC_HOLDER_API_URL) to try those routes on
// their own while the rest of the app reads the deployed API.
import { API_URL } from './api';

export const HOLDER_API_URL = process.env.NEXT_PUBLIC_HOLDER_API_URL ?? API_URL;
