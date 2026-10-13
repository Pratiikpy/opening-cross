import type { AuthenticityView } from '@/lib/trust-types';
import type { CrossDetail } from '@/lib/types';
import { type Market, formatPrice } from '@/lib/units';
import { CopyButton } from './copy-button';
import { IdentityPanel } from './identity-panel';
import { SafetyBadge } from './safety-badge';

// The program's supply modes (cross_core SupplyMode): what the issuer sells and where it comes from.
const SUPPLY: Record<string, string> = {
  mint: 'Minted at settlement. The issuer’s price steps set how much is offered.',
  escrow: 'Escrowed. Sellers lock tokens that already exist.',
  'deferred-mint': 'Minted after settlement, once the token exists.',
};

function Address({ value, label }: { value: string; label: string }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="break-all font-mono text-xs sm:text-sm" data-testid="address">
        {value}
      </span>
      <CopyButton value={value} label={`Copy ${label}`} />
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/** What this cross is made of: both mints, decimals, supply, fees, gate, guard, creator, and whether the tokens are the real ones. */
export function TokenFacts({ cross, market: m, identity }: { cross: CrossDetail; market: Market; identity: AuthenticityView | null }) {
  const totalBps = cross.fees.protocolBps + cross.fees.integratorBps;
  const min = BigInt(cross.grid.minPrice);
  const max = min + BigInt(cross.grid.ticks - 1) * BigInt(cross.grid.tick);
  return (
    <section aria-labelledby="facts">
      <h2 id="facts" className="font-mono text-xs uppercase tracking-widest text-muted">
        Token facts
      </h2>
      <dl className="mt-2 divide-y divide-border" data-testid="token-facts">
        <Row label="Token being sold">{cross.baseMint ? <Address value={cross.baseMint} label="token mint address" /> : 'Created at settlement. Its address is not known yet.'}</Row>
        <Row label="Paid in">
          <Address value={cross.quoteMint} label="quote mint address" />
        </Row>
        <Row label="Decimals">
          {m.baseDecimals} for the token, {m.quoteDecimals} for the quote
        </Row>
        <Row label="Supply">{SUPPLY[cross.supplyMode] ?? cross.supplyMode}</Row>
        <Row label="Price grid">
          {formatPrice(min, m)} to {formatPrice(max, m)} in steps of {formatPrice(BigInt(cross.grid.tick), m)}, at most {cross.orders.max.toLocaleString('en-US')} orders
        </Row>
        <Row label="Fees">
          <span data-testid="fees">
            {totalBps} bps ({totalBps / 100}%) of the sale proceeds: {cross.fees.protocolBps} bps protocol, {cross.fees.integratorBps} bps integrator. Taken from the proceeds, so buyers pay no extra.
          </span>
        </Row>
        <Row label="Eligibility">
          {cross.gateMint ? (
            <>
              <span className="mb-1 block">An eligibility pass is required to order. Pass mint:</span>
              <Address value={cross.gateMint} label="eligibility pass mint address" />
            </>
          ) : (
            'Open to anyone with a wallet.'
          )}
        </Row>
        <Row label="Oracle guard">{cross.oracleGuard ? 'On. The cross does not print if its price strays from the Pyth price.' : 'Off. Only the orders in the book set the price.'}</Row>
        <Row label="Bids">{cross.disclosure === 'sealed' ? 'Sealed until the reveal window.' : 'Open book; everyone sees resting orders.'}</Row>
        <Row label="Created by">
          <Address value={cross.creator} label="creator address" />
        </Row>
        {cross.safety ? (
          <Row label="Token safety">
            <SafetyBadge safety={cross.safety} label="Token safety" />
          </Row>
        ) : null}
        <Row label="Is it the real token?">
          <IdentityPanel address={cross.address} initial={identity} embedded />
        </Row>
      </dl>
    </section>
  );
}
