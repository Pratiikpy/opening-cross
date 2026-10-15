// Sandbox credentials are read from the environment or from a file outside the repository, never from the repo and never
// logged. The owner's file holds `appId` and `apiKey`; the gateway's header for the first is `api-id` (probed 2026-10-12:
// a request with `appId` and `apiKey` headers and no `api-id` is answered 400, with a wrong `api-id` 403).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SANDBOX_URL, type ClientConfig } from './client.js';

export const DEFAULT_ENV_FILE = join(homedir(), 'cleanverse', '.secrets', 'cleanverse.env');

const ID_NAMES = ['CLEANVERSE_API_ID', 'CLEANVERSE_APP_ID', 'API_ID', 'APP_ID', 'APPID'];
const KEY_NAMES = ['CLEANVERSE_API_KEY', 'API_KEY', 'APIKEY'];

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]!.toUpperCase()] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export type LoadedCredentials = { config: Pick<ClientConfig, 'baseUrl' | 'apiId' | 'apiKey'>; source: string } | { config: null; source: string; reason: string };

/** Looks in the environment first, then in `CLEANVERSE_ENV_FILE` (default `~/cleanverse/.secrets/cleanverse.env`). */
export function loadCredentials(env: NodeJS.ProcessEnv = process.env, file = env.CLEANVERSE_ENV_FILE ?? DEFAULT_ENV_FILE): LoadedCredentials {
  const pick = (vars: Record<string, string | undefined>, names: string[]) => names.map((n) => vars[n]).find((v) => v !== undefined && v !== '');
  let vars: Record<string, string | undefined> = env;
  let source = 'environment';
  if (!pick(vars, ID_NAMES) || !pick(vars, KEY_NAMES)) {
    try {
      vars = { ...parseEnvFile(readFileSync(file, 'utf8')), ...(env.CLEANVERSE_BASE_URL ? { CLEANVERSE_BASE_URL: env.CLEANVERSE_BASE_URL } : {}) };
      source = file;
    } catch {
      return { config: null, source: file, reason: `no credentials in the environment and no readable file at ${file}` };
    }
  }
  const apiId = pick(vars, ID_NAMES);
  const apiKey = pick(vars, KEY_NAMES);
  if (!apiId || !apiKey) return { config: null, source, reason: 'the file needs an app/api id and an api key (CLEANVERSE_API_ID, CLEANVERSE_API_KEY)' };
  return { config: { baseUrl: pick(vars, ['CLEANVERSE_BASE_URL']) ?? SANDBOX_URL, apiId, apiKey }, source };
}
