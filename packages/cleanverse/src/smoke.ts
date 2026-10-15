// Sandbox smoke run: `pnpm --filter @opening-cross/cleanverse sandbox:smoke`. Reads credentials from the environment or
// ~/cleanverse/.secrets/cleanverse.env, calls the read endpoints against the sandbox and prints what came back (never the
// credentials). Exits 2 when there are no credentials, 1 when a call fails, 0 when every call returned a valid body.
import { CleanverseClient } from './client.js';
import { loadCredentials } from './credentials.js';
import { BusinessError } from './errors.js';

const creds = loadCredentials();
if (!creds.config) {
  console.error(`BLOCKED: ${creds.reason}\nPut the sandbox credentials (CLEANVERSE_API_ID, CLEANVERSE_API_KEY) in the file above or the environment and run again.`);
  process.exit(2);
}
const client = new CleanverseClient(creds.config);
console.log(`credentials from ${creds.source}; host ${new URL(creds.config.baseUrl).host}`);
let failed = 0;
async function step<T>(name: string, run: () => Promise<T>) {
  try {
    console.log(`PASS ${name}:`, JSON.stringify(await run()).slice(0, 400));
  } catch (e) {
    // A business refusal is a real answer from the service (for example "no A-Pass for this wallet") and shows its text.
    if (e instanceof BusinessError) console.log(`ANSWER ${name}: business ${e.code} ${e.subCode ?? ''} ${e.message}`);
    else {
      failed++;
      console.log(`FAIL ${name}: ${(e as Error).name}: ${(e as Error).message}`);
    }
  }
}
const WALLET = process.env.CLEANVERSE_SMOKE_WALLET ?? '11111111111111111111111111111111';
await step('query_deposit_atoken_list (solana)', () => client.queryDepositAtokenList('solana'));
await step('query_apass_list (solana, page 1)', () => client.queryApassList({ chain: 'solana', pageSize: 5 }));
await step(`query_apass (${WALLET.slice(0, 6)}...)`, () => client.queryApass('solana', WALLET));
process.exit(failed ? 1 : 0);
