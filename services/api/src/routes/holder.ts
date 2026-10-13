// The holder-side routes in one call, for server.ts to wire: `await registerHolderRoutes(app, d)` next to the other register calls.
//
//   alerts      /v1/alerts/*           push, email and Telegram reminders and an in-app feed        (holder-alerts.ts)
//   actions     /v1/actions/*          Solana Actions: bid from a link                              (holder-actions.ts)
//   sponsor     /v1/sponsor, /v1/tx/place-order-sponsored                                          (holder-sponsor.ts)
//   comments    /v1/crosses/:address/comments, /v1/comments/:id/hide                              (holder-social.ts)
//   retention   /v1/metrics/retention                                                              (holder-retention.ts)
//   balances    /v1/balances/:owner                                                                (holder-balances.ts)
//   terms       /v1/orders/:address/terms                                                          (holder-terms.ts)
//   support     /v1/support/*                                                                      (holder-support.ts)
//
// Configuration is read from the environment (docs/CONFIGURATION.md): a channel or service with no keys is reported as not enabled,
// never faked.
import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.js';
import { registerHolderActions } from './holder-actions.js';
import { loadAlertConfig, mailSender } from './holder-alerts-channels.js';
import { registerHolderAlerts } from './holder-alerts.js';
import type { Db } from './holder-alerts-store.js';
import { registerHolderBalances } from './holder-balances.js';
import { registerHolderRetention } from './holder-retention.js';
import { registerHolderSocial } from './holder-social.js';
import { loadSponsor, registerHolderSponsor } from './holder-sponsor.js';
import { registerHolderSupport } from './holder-support.js';
import { registerHolderTerms } from './holder-terms.js';

export async function registerHolderRoutes(app: FastifyInstance, d: ApiDeps): Promise<{ stop: () => void }> {
  const db = d.db as unknown as Db;
  const alerts = registerHolderAlerts(app, { db, ...(d.clock && { clock: d.clock }) });
  registerHolderActions(app, { account: d.account, lifetime: d.lifetime, ...(d.clock && { clock: d.clock }) });
  registerHolderSponsor(app, { db, account: d.account, lifetime: d.lifetime, sponsor: await loadSponsor(), ...(d.clock && { clock: d.clock }) });
  registerHolderSocial(app, { db, account: d.account, ...(d.clock && { clock: d.clock }) });
  registerHolderRetention(app, { db, ...(d.ownWallets && { ownWallets: d.ownWallets }), ...(d.clock && { clock: d.clock }) });
  registerHolderBalances(app, { account: d.account });
  registerHolderTerms(app, { account: d.account });
  const mail = loadAlertConfig().email;
  registerHolderSupport(app, { db, ...(d.clock && { clock: d.clock }), mail: mail ? mailSender(mail) : null });
  return { stop: alerts.stop };
}
