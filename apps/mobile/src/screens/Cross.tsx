import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Share, View } from 'react-native';
import { API_URL } from '../lib/config';
import { type Result, get } from '../lib/api';
import { random, store } from '../lib/device';
import { type OrderView, loadOrders } from '../lib/orders';
import { type Draft, type Phase, check, marketOf, phaseOf, placeOrderBody } from '../lib/order';
import { explainCalibration } from '../lib/reasons';
import { type SealedBid, exportBackup, loadBids, nonceFrom, rememberOrder, saltFrom, saveBid } from '../lib/sealed';
import { ActionError } from '../lib/tx';
import type { AuthenticityView, PromiseView } from '../lib/trust-types';
import type { BookResponse, CrossDetail } from '../lib/types';
import { type Market, formatAtoms, formatDuration, formatPrice, shortAddress } from '../lib/units';
import { useWallet } from '../lib/wallet';
import { ActionButton } from '../ui/action';
import { BookChart } from '../ui/book';
import { Button, Card, Fact, Field, Notice, Pill, Txt } from '../ui/components';
import { useTheme } from '../ui/theme';
import type { RootStack } from '../navigation';

const VERDICT: Record<string, string> = {
  GENUINE: "Matches the issuer's list and keys",
  FAMILY_UNLISTED: "Held by the issuer's keys, not yet on its list",
  IMPERSONATOR: 'Copies a genuine token and is not it',
  ADDRESS_LOOKALIKE: 'Address made to look like a genuine token',
  UNVERIFIED_STOCK_TOKEN: 'Tokenized stock from an issuer we cannot verify',
  UNRELATED_TOKEN: 'Not a covered issuer token',
  NOT_A_MINT: 'Not a token mint',
  UNKNOWN: 'Could not be confirmed',
};

export function CrossScreen({ route, navigation }: NativeStackScreenProps<RootStack, 'Cross'>) {
  const { address } = route.params;
  const t = useTheme();
  const wallet = useWallet();
  const [cross, setCross] = useState<CrossDetail | null>(null);
  const [book, setBook] = useState<BookResponse | null>(null);
  const [band, setBand] = useState<PromiseView | null>(null);
  const [identity, setIdentity] = useState<AuthenticityView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)));
  const [version, setVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    const [c, b, p, a] = await Promise.all([
      get<CrossDetail>(`/v1/crosses/${address}`),
      get<BookResponse>(`/v1/crosses/${address}/book`),
      get<PromiseView>(`/v1/crosses/${address}/promise`),
      get<AuthenticityView>(`/v1/crosses/${address}/authenticity`),
    ]);
    if (c.ok) {
      setCross(c.data);
      setError(null);
    } else setError(c.error);
    if (b.ok) setBook(b.data);
    setBand(p.ok ? p.data : null);
    setIdentity(a.ok ? a.data : null);
    setVersion((v) => v + 1);
  }, [address]);

  useEffect(() => {
    void refresh();
    const clock = setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), 1000);
    const poll = setInterval(() => void refresh(), 15_000);
    return () => {
      clearInterval(clock);
      clearInterval(poll);
    };
  }, [refresh]);

  if (!cross) {
    return (
      <View style={{ flex: 1, padding: 16, backgroundColor: t.bg }}>
        {error ? <Notice tone="error">{error}</Notice> : <Txt tone="muted">Loading the cross…</Txt>}
      </View>
    );
  }
  const m = marketOf(cross);
  const phase = phaseOf(cross, now);
  const next = phase === 'upcoming' ? cross.window.openTs : phase === 'open' ? cross.window.closeTs : phase === 'reveal' ? cross.window.revealEndTs : null;

  return (
    <ScrollView
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={{ padding: 16, gap: 14 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await refresh();
            setRefreshing(false);
          }}
        />
      }
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Txt variant="title">Cross {shortAddress(cross.address)}</Txt>
        <Pill label={phase === 'open' ? 'Open' : cross.state === 'NoPrint' ? 'No print' : cross.state === 'Live' ? 'Closed' : cross.state} tone={phase === 'open' ? 'live' : cross.state === 'Cleared' ? 'good' : 'plain'} />
      </View>
      <Txt variant="small" tone="muted">
        {cross.kind} · {cross.disclosure === 'sealed' ? 'sealed bids' : 'open book'} · base {cross.baseMint ? shortAddress(cross.baseMint) : 'minted at settlement'} · quote {shortAddress(cross.quoteMint)}
      </Txt>

      <Card>
        <Txt variant="label" tone="muted">
          {cross.clearing ? 'Clearing price' : phase === 'settled' ? 'Result' : 'Price if it closed now'}
        </Txt>
        <Txt variant="monoBig" style={{ marginTop: 6 }}>
          {cross.clearing ? formatPrice(BigInt(cross.clearing.price), m) : cross.state === 'NoPrint' || cross.state === 'Finalized' ? 'No print' : book?.indicative ? formatPrice(BigInt(book.indicative.price), m) : '—'}
        </Txt>
        <Txt variant="small" tone="muted" style={{ marginTop: 6 }}>
          {cross.clearing
            ? `${formatAtoms(BigInt(cross.clearing.matched), m.baseDecimals)} tokens traded at this one price`
            : cross.noPrintReason
              ? `Did not print (${cross.noPrintReason}); every order is refunded in full.`
              : book?.indicative
                ? `${formatAtoms(BigInt(book.indicative.matched), m.baseDecimals)} tokens would trade. Indicative until the call closes.`
                : cross.disclosure === 'sealed'
                  ? 'Sealed: prices stay hidden until bids are revealed.'
                  : 'No crossing orders yet.'}
        </Txt>
        {next ? (
          <Txt variant="mono" style={{ marginTop: 10 }}>
            {phase === 'upcoming' ? 'Opens in' : phase === 'open' ? 'Closes in' : 'Reveals close in'} {formatDuration(BigInt(next) - now)}
          </Txt>
        ) : null}
        <View style={{ marginTop: 14 }}>
          <BookChart book={book} market={m} clearing={cross.clearing?.price ?? book?.indicative?.price ?? null} />
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          <Fact label="Orders" value={String(cross.orders.total)} />
          <Fact label="Seller fee" value={`${(cross.fees.protocolBps + cross.fees.integratorBps) / 100}%`} />
        </View>
      </Card>

      <SignedBand band={band} market={m} />
      <Identity view={identity} />

      <Card>
        <Txt variant="heading">Premium monitor</Txt>
        <Txt variant="small" tone="muted" style={{ marginTop: 4 }}>
          How far a Solana stock token trades from an independent reference, by order size and market session.
        </Txt>
        <View style={{ marginTop: 12 }}>
          <Button label="Open the premium monitor" variant="secondary" onPress={() => navigation.navigate('Premium')} />
        </View>
      </Card>

      {wallet.address ? (
        <>
          {phase === 'open' ? <OrderTicket cross={cross} owner={wallet.address} onPlaced={refresh} /> : null}
          {phase === 'awaiting-settlement' ? <SettleCard cross={cross} payer={wallet.address} onDone={refresh} /> : null}
          <MyOrders cross={cross} phase={phase} market={m} owner={wallet.address} version={version} onChanged={refresh} />
        </>
      ) : (
        <Notice>{phase === 'open' ? 'Connect a wallet to place an order in this cross.' : 'Connect a wallet to see your orders, fills and refunds in this cross.'}</Notice>
      )}
      <Txt variant="small" tone="subtle" selectable>
        API: {API_URL}
      </Txt>
    </ScrollView>
  );
}

function SignedBand({ band, market }: { band: PromiseView | null; market: Market }) {
  if (!band) return null;
  const { claim, subject } = band.promise;
  const price = (tick: number) => formatPrice(BigInt(subject.grid.minPrice) + BigInt(tick) * BigInt(subject.grid.tick), market);
  const calibrated = claim.status === 'CALIBRATED' && claim.nominalCoverageBps !== null;
  const g = band.grade;
  const outcome = g?.status === 'HIT' ? 'The final price landed inside this band.' : g?.status === 'MISS' ? 'The final price landed outside this band.' : g?.status === 'SCORED' ? (g.errorTicks === 0 ? 'The final price was exactly this estimate.' : `The final price was ${g.errorTicks} tick${g.errorTicks === 1 ? '' : 's'} from this estimate.`) : g?.status === 'VOID' ? 'This cross did not print, so the promise is void.' : null;
  return (
    <Card>
      <Txt variant="label" tone="muted">
        Signed price band
      </Txt>
      <Txt variant="heading" style={{ marginTop: 6 }}>
        {calibrated ? `${price(claim.loTick)} to ${price(claim.hiTick)}` : price(claim.pointTick)}
      </Txt>
      <Txt variant="small" tone="muted">
        {calibrated ? `expected to hold at least ${((claim.nominalCoverageBps as number) / 100).toFixed(0)}% of the time` : 'estimate, no coverage claimed yet'}
      </Txt>
      {!calibrated && claim.reason ? (
        <Txt variant="small" tone="muted" style={{ marginTop: 6 }}>
          {explainCalibration(claim.reason)}
        </Txt>
      ) : null}
      {outcome ? (
        <Txt variant="body" style={{ marginTop: 8, fontFamily: 'HankenGrotesk_500Medium' }}>
          {outcome}
        </Txt>
      ) : null}
      <Txt variant="small" tone="subtle" style={{ marginTop: 8 }} selectable>
        Signed by {shortAddress(band.signer)} · promise {band.promise.id.slice(0, 12)}…{band.anchor ? ' · anchored on chain' : ''}
      </Txt>
    </Card>
  );
}

function Identity({ view }: { view: AuthenticityView | null }) {
  if (!view) return null;
  if (!view.comparable) {
    return <Notice>Identity check: {view.note}</Notice>;
  }
  const rows = [...(view.base ? [{ role: 'Token', ...view.base }] : []), { role: 'Quote', ...view.quote }];
  return (
    <Card>
      <Txt variant="label" tone="muted">
        Is this real?
      </Txt>
      {rows.map((r) => {
        const v = r.verdict;
        const good = v.verdict === 'GENUINE';
        return (
          <View key={r.role} style={{ marginTop: 12 }}>
            <Txt variant="body">
              {r.role} {v.listing ? v.listing.symbol : (v.observed.symbol ?? shortAddress(r.mint))} <Txt variant="small" tone="subtle">{shortAddress(r.mint)}</Txt>
            </Txt>
            <View style={{ marginTop: 4 }}>
              <Pill label={VERDICT[v.verdict] ?? v.verdict} tone={good ? 'good' : v.verdict === 'IMPERSONATOR' || v.verdict === 'ADDRESS_LOOKALIKE' || v.verdict === 'NOT_A_MINT' ? 'bad' : 'plain'} />
            </View>
            {!good && v.reasons[0] ? (
              <Txt variant="small" tone="muted" style={{ marginTop: 4 }}>
                {v.reasons[0].message}
              </Txt>
            ) : null}
            {v.impersonates[0] ? (
              <Txt variant="small" tone="muted" style={{ marginTop: 4 }} selectable>
                The real {v.impersonates[0].symbol} is {v.impersonates[0].mint}.
              </Txt>
            ) : null}
          </View>
        );
      })}
      <Txt variant="small" tone="subtle" style={{ marginTop: 12 }}>
        It says who issued a token, not whether it is a good buy.
      </Txt>
    </Card>
  );
}

function OrderTicket({ cross, owner, onPlaced }: { cross: CrossDetail; owner: string; onPlaced: () => void }) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [priceText, setPriceText] = useState('');
  const [qtyText, setQtyText] = useState('');
  const [placed, setPlaced] = useState<string | null>(null);
  const m = marketOf(cross);
  const sealed = cross.disclosure === 'sealed';
  const draft: Draft = { side, priceText, qtyText };
  const checked = check(draft, cross);
  const feeBps = cross.fees.protocolBps + cross.fees.integratorBps;
  // One nonce and salt per attempt, fixed until the order lands so a retry cannot place it twice.
  const [attempt, setAttempt] = useState(() => ({ nonce: nonceFrom(random), salt: sealed ? saltFrom(random) : undefined }));

  return (
    <Card>
      <Txt variant="heading">Place an order</Txt>
      {cross.supplyMode !== 'escrow' ? (
        <Txt variant="small" tone="muted" style={{ marginTop: 4 }}>
          The issuer's supply is set by its schedule; this cross takes buy orders only.
        </Txt>
      ) : (
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
          <View style={{ flex: 1 }}>
            <Button label="Buy" variant={side === 'buy' ? 'primary' : 'secondary'} onPress={() => setSide('buy')} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label="Sell" variant={side === 'sell' ? 'primary' : 'secondary'} onPress={() => setSide('sell')} />
          </View>
        </View>
      )}
      <Field label={side === 'buy' ? 'Most you would pay per token' : 'Least you would take per token'} value={priceText} onChangeText={setPriceText} keyboardType="decimal-pad" placeholder={formatPrice(BigInt(cross.grid.minPrice), m)} error={checked.ok ? null : checked.priceError} />
      <Field label="Tokens" value={qtyText} onChangeText={setQtyText} keyboardType="decimal-pad" placeholder="0" error={checked.ok ? null : checked.qtyError} />
      {checked.ok ? (
        <View style={{ marginTop: 14 }}>
          <Notice>
            {side === 'buy'
              ? `Up to ${checked.escrowText} is held in escrow. You pay the clearing price for what you are filled; the rest comes back at settlement.`
              : `${checked.escrowText} tokens are held in escrow. You receive at least ${formatAtoms((checked.quantity * checked.price) / m.priceScale, m.quoteDecimals)} less the ${feeBps / 100}% seller fee.`}
            {sealed ? ' Your price stays sealed until you reveal it after the close.' : ''}
          </Notice>
        </View>
      ) : null}
      <View style={{ marginTop: 14 }}>
        <ActionButton
          label={sealed ? 'Place sealed order' : 'Place order'}
          path="/v1/tx/place-order"
          disabled={!checked.ok}
          before={async () => {
            if (!checked.ok) throw new ActionError('Check the price and amount first.');
            // The reveal needs these; keep them before anything is signed.
            if (sealed && !(await saveBid(store, { cross: cross.address, owner, nonce: attempt.nonce, side, price: String(checked.price), quantity: String(checked.quantity), salt: attempt.salt!, placedAt: new Date().toISOString() }))) {
              throw new ActionError('This device could not store your sealed bid, so it could not be revealed later. Nothing was sent.');
            }
          }}
          body={() => {
            if (!checked.ok) throw new ActionError('Check the price and amount first.');
            return placeOrderBody(cross, owner, { ...draft, price: checked.price, quantity: checked.quantity }, attempt.nonce, attempt.salt);
          }}
          onDone={(sigs, extra) => {
            if (typeof extra.order === 'string') void rememberOrder(store, cross.address, owner, extra.order);
            setPlaced(sigs[0] ?? null);
            setPriceText('');
            setQtyText('');
            setAttempt({ nonce: nonceFrom(random), salt: sealed ? saltFrom(random) : undefined });
            onPlaced();
          }}
        />
      </View>
      {placed ? (
        <View style={{ marginTop: 12 }}>
          <Notice>
            Order placed. {placed}
          </Notice>
        </View>
      ) : null}
    </Card>
  );
}

function SettleCard({ cross, payer, onDone }: { cross: CrossDetail; payer: string; onDone: () => void }) {
  return (
    <Card>
      <Txt variant="heading">Settle this cross</Txt>
      <Txt variant="small" tone="muted" style={{ marginTop: 4 }}>
        The window has closed. Anyone can settle: it merges the book and prints the clearing price. You pay the network fee.
      </Txt>
      <View style={{ marginTop: 12 }}>
        <ActionButton label="Settle" path="/v1/tx/settle" body={() => ({ cross: cross.address, payer })} onDone={() => onDone()} />
      </View>
    </Card>
  );
}

function MyOrders({ cross, phase, market, owner, version, onChanged }: { cross: CrossDetail; phase: Phase; market: Market; owner: string; version: number; onChanged: () => void }) {
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [bids, setBids] = useState<SealedBid[]>([]);
  const settled = cross.state === 'Cleared' || cross.state === 'NoPrint';
  const sealed = cross.disclosure === 'sealed';

  useEffect(() => {
    let live = true;
    void loadOrders(cross.address, owner, store).then((o) => live && setOrders(o));
    void loadBids(store, cross.address, owner).then((b) => live && setBids(b));
    return () => {
      live = false;
    };
  }, [cross.address, owner, version]);

  return (
    <Card>
      <Txt variant="heading">Your orders</Txt>
      {orders === null ? (
        <Txt variant="small" tone="muted" style={{ marginTop: 8 }}>
          Loading…
        </Txt>
      ) : orders.length === 0 ? (
        <Txt variant="small" tone="muted" style={{ marginTop: 8 }}>
          You have no orders in this cross.
        </Txt>
      ) : (
        orders.map((o) => {
          const bid = bids.find((b) => b.nonce === o.nonce);
          return (
            <View key={o.address} style={{ marginTop: 14, gap: 8 }}>
              <Txt variant="body">
                {o.side === 'buy' ? 'Buy' : 'Sell'}
                {o.price && o.quantity ? ` ${formatAtoms(BigInt(o.quantity), market.baseDecimals)} @ ${formatPrice(BigInt(o.price), market)}` : bid ? ` ${formatAtoms(BigInt(bid.quantity), market.baseDecimals)} @ ${formatPrice(BigInt(bid.price), market)} (sealed)` : ''}
              </Txt>
              <Txt variant="small" tone="muted">
                {o.open ? (o.revealed ? 'revealed' : sealed ? 'sealed' : 'open') : (o.status ?? 'closed')} · escrow {formatAtoms(BigInt(o.escrow), o.side === 'buy' ? market.quoteDecimals : market.baseDecimals)}
                {o.fill ? ` · filled ${formatAtoms(BigInt(o.fill), market.baseDecimals)}` : ''}
              </Txt>
              {o.open && o.nonce !== null && phase === 'open' ? <ActionButton label="Cancel and refund" variant="secondary" path="/v1/tx/cancel" body={() => ({ cross: cross.address, owner, nonce: o.nonce })} onDone={() => onChanged()} /> : null}
              {o.open && o.nonce !== null && sealed && !o.revealed && phase === 'reveal' ? (
                bid ? (
                  <ActionButton label="Reveal bid" path="/v1/tx/reveal" body={() => ({ cross: cross.address, owner, nonce: bid.nonce, price: bid.price, quantity: bid.quantity, salt: bid.salt })} onDone={() => onChanged()} />
                ) : (
                  <Notice tone="error">This device has no record of this sealed bid, so it cannot be revealed. It will be refunded in full at settlement.</Notice>
                )
              ) : null}
              {o.open && o.nonce !== null && settled ? <ActionButton label="Claim fill and refund" path="/v1/tx/claim" body={() => ({ cross: cross.address, owner, nonce: o.nonce })} onDone={() => onChanged()} /> : null}
            </View>
          );
        })
      )}
      {sealed && bids.length ? (
        <View style={{ marginTop: 14 }}>
          <Button label="Back up sealed bids" variant="secondary" onPress={() => void Share.share({ message: exportBackup(bids), title: 'Opening Bell sealed bids' })} />
        </View>
      ) : null}
    </Card>
  );
}
