import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Share, View } from 'react-native';
import { API_URL } from '../lib/config';
import { type Result, get } from '../lib/api';
import { random, store } from '../lib/device';
import { type OrderView, loadOrders } from '../lib/orders';
import { type Draft, type Phase, check, marketOf, phaseOf, placeOrderBody } from '../lib/order';
import { explainCalibration } from '../lib/reasons';
import { PEG_NOTE, pegPrice } from '../lib/peg';
import { type HaltRead, type SeriesRead, haltBanner, seriesNote } from '../lib/schedule';
import { type BackingRead, type GraduationRead, type ListingsRead, backingBanner, governedNote, listingNote } from '../lib/wave3d';
import { type SealedBid, exportBackup, loadBids, nonceFrom, rememberOrder, saltFrom, saveBid } from '../lib/sealed';
import { type ClassId, type IndicativeRead, type RulesRead, type Standing, blocked, classOptions, clock, endingNow, imbalanceText, needsAck, summaryLines, ticketChecks } from '../lib/rules';
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
  const [rules, setRules] = useState<RulesRead | null | undefined>(undefined);
  const [indicative, setIndicative] = useState<IndicativeRead | null>(null);
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
    const r = await get<RulesRead>(`/v1/crosses/${address}/rules`);
    setRules(r.ok ? r.data : null);
    // In the ending period the app shows the coarse figures of /indicative, never the book's.
    if (c.ok && c.data.state === 'Live' && r.ok && r.data.rules && endingNow(r.data.rules, r.data.state, BigInt(c.data.window.closeTs), BigInt(Math.floor(Date.now() / 1000))).kind === 'ending') {
      const i = await get<IndicativeRead>(`/v1/crosses/${address}/indicative`);
      setIndicative(i.ok ? i.data : null);
    } else setIndicative(null);
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
  const ending = endingNow(rules?.rules ?? null, rules?.state, BigInt(cross.window.closeTs), now);
  const inEnding = ending.kind === 'ending' && phase === 'open';
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
          {cross.clearing ? formatPrice(BigInt(cross.clearing.price), m) : cross.state === 'NoPrint' || cross.state === 'Finalized' ? 'No print' : inEnding ? (indicative?.indicative?.price ? `about ${formatPrice(BigInt(indicative.indicative.price), m)}` : '—') : book?.indicative ? formatPrice(BigInt(book.indicative.price), m) : '—'}
        </Txt>
        <Txt variant="small" tone="muted" style={{ marginTop: 6 }}>
          {cross.clearing
            ? `${formatAtoms(BigInt(cross.clearing.matched), m.baseDecimals)} tokens traded at this one price`
            : cross.noPrintReason
              ? `Did not print (${cross.noPrintReason}); every order is refunded in full.`
              : inEnding
                ? `Ending period, window ${ending.kind === 'ending' ? ending.bucket + 1 : 1} of ${ending.kind === 'ending' ? ending.buckets : 1}: the price is shown to the nearest of eight bands${indicative?.indicative ? ` and demand as a direction (${imbalanceText(indicative.indicative.imbalance).toLowerCase()})` : ''}. The exact figures return when the call closes. This is a display rule of this app; the accounts are public.`
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
        {inEnding ? null : (
          <View style={{ marginTop: 14 }}>
            <BookChart book={book} market={m} clearing={cross.clearing?.price ?? book?.indicative?.price ?? null} />
          </View>
        )}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          <Fact label="Orders" value={String(cross.orders.total)} />
          <Fact label="Seller fee" value={`${(cross.fees.protocolBps + cross.fees.integratorBps) / 100}%`} />
        </View>
      </Card>

      <ScheduleNotes cross={cross} rules={rules} />
      <RulesCard rules={rules} cross={cross} market={m} />
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
          {phase === 'open' ? <OrderTicket cross={cross} owner={wallet.address} onPlaced={refresh} rules={rules} now={now} ending={inEnding} /> : null}
          {phase === 'awaiting-settlement' ? <SettleCard cross={cross} payer={wallet.address} onDone={refresh} rules={rules} /> : null}
          <MyOrders cross={cross} phase={phase} market={m} owner={wallet.address} version={version} onChanged={refresh} rules={rules} now={now} />
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

function OrderTicket({ cross, owner, onPlaced, rules, now, ending }: { cross: CrossDetail; owner: string; onPlaced: () => void; rules: RulesRead | null | undefined; now: bigint; ending: boolean }) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [priceText, setPriceText] = useState('');
  const [qtyText, setQtyText] = useState('');
  const [placed, setPlaced] = useState<string | null>(null);
  const [cls, setCls] = useState<ClassId>(0);
  const [lockDays, setLockDays] = useState('');
  const [acked, setAcked] = useState(false);
  const [standing, setStanding] = useState<Standing>({ gatePass: null, priorityPass: null, usage: null });
  const ruled = rules?.rules ?? null;
  const m = marketOf(cross);
  const sealed = cross.disclosure === 'sealed';
  const draft: Draft = { side, priceText, qtyText };
  const checked = check(draft, cross);
  const feeBps = cross.fees.protocolBps + cross.fees.integratorBps;
  const priorityGate = ruled?.alloc.priorityGate ?? null;
  useEffect(() => {
    if (!ruled) return;
    let live = true;
    void (async () => {
      const [el, pg, mine] = await Promise.all([
        cross.gateMint ? get<{ eligible: boolean; acceptingOrders: boolean }>(`/v1/eligibility/${cross.address}/${owner}`) : Promise.resolve(null),
        priorityGate ? get<{ standing?: { hasPass: boolean } }>(`/v1/gates/${priorityGate}?wallet=${owner}`) : Promise.resolve(null),
        loadOrders(cross.address, owner, store),
      ]);
      if (!live) return;
      const open = mine.filter((o) => o.open);
      setStanding({
        gatePass: el && el.ok && el.data.acceptingOrders ? el.data.eligible : null,
        priorityPass: pg && pg.ok ? (pg.data.standing?.hasPass ?? null) : null,
        usage: { orders: open.length, escrow: open.filter((o) => o.side === 'buy').reduce((a, o) => a + BigInt(o.escrow), 0n) },
      });
    })();
    return () => {
      live = false;
    };
  }, [ruled, cross.address, cross.gateMint, owner, priorityGate, placed]);
  const options = ruled ? classOptions(ruled, { wallet: owner, now, market: m, gated: cross.gateMint !== null }, standing) : null;
  const effectiveClass: ClassId = side === 'buy' ? cls : 0;
  const lockSecs = effectiveClass === 2 ? Math.floor(Number(lockDays || '0') * 86_400) : 0;
  const checks = ruled
    ? ticketChecks({ rules: ruled, ...(rules?.state ? { state: rules.state } : {}), ...(rules?.calls ? { calls: rules.calls } : {}), wallet: owner, side, cls: effectiveClass, lockSecs, escrow: checked.ok ? checked.escrow : null, quantity: checked.ok ? checked.quantity : null, now, closeTs: BigInt(cross.window.closeTs), market: m, gated: cross.gateMint !== null, standing })
    : [];
  const stops = blocked(checks);
  const acks = needsAck(checks);
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
      {priceText === formatPrice(pegPrice(cross.grid, side), m) ? (
        <Txt variant="small" tone="muted">
          {PEG_NOTE[side]}
        </Txt>
      ) : (
        <Button label="Take whatever the open prints" variant="secondary" onPress={() => setPriceText(formatPrice(pegPrice(cross.grid, side), m))} />
      )}
      {ruled && options && side === 'buy' && options.length > 1 ? (
        <View style={{ marginTop: 14, gap: 8 }}>
          <Txt variant="small" tone="muted">
            How this order shares the volume at the margin
          </Txt>
          {options.map((o) => (
            <View key={o.id}>
              <Button
                label={`${o.label}${o.available ? '' : ' (not available)'}`}
                variant={cls === o.id ? 'primary' : 'secondary'}
                disabled={!o.available}
                onPress={() => {
                  setCls(o.id);
                  setAcked(false);
                }}
              />
              <Txt variant="small" tone="muted" style={{ marginTop: 4 }}>
                {o.why ?? o.summary}
              </Txt>
            </View>
          ))}
          {cls === 2 ? (
            <Field label={`Lock the tokens you receive for how many days (at least ${Number((ruled.alloc.minLockSecs / 86_400).toFixed(2))})`} value={lockDays} onChangeText={setLockDays} keyboardType="decimal-pad" placeholder={String(Math.ceil(ruled.alloc.minLockSecs / 86_400))} />
          ) : null}
        </View>
      ) : null}
      <Field label="Tokens" value={qtyText} onChangeText={setQtyText} keyboardType="decimal-pad" placeholder="0" error={checked.ok ? null : checked.qtyError} />
      {ruled && checks.length > 0 ? (
        <View style={{ marginTop: 14, gap: 8 }}>
          {stops.map((c) => (
            <Notice key={c.id} tone="error">
              {c.message}
            </Notice>
          ))}
          {checks
            .filter((c) => c.level === 'note')
            .map((c) => (
              <Txt key={c.id} variant="small" tone="muted">
                {c.message}
              </Txt>
            ))}
          {acks.length > 0 ? (
            <View style={{ gap: 8 }}>
              {acks.map((c) => (
                <Notice key={c.id}>{c.message}</Notice>
              ))}
              <Button label={acked ? 'Understood: you can place the order' : 'I understand and want to place this order'} variant={acked ? 'primary' : 'secondary'} onPress={() => setAcked(!acked)} />
            </View>
          ) : null}
        </View>
      ) : null}
      {ending ? (
        <View style={{ marginTop: 14 }}>
          <Notice>The ending period is open, so no comparison with the exact book is shown for this order.</Notice>
        </View>
      ) : null}
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
          path={ruled ? '/v1/tx/place-order-ext' : '/v1/tx/place-order'}
          disabled={!checked.ok || rules === undefined || stops.length > 0 || (acks.length > 0 && !acked)}
          before={async () => {
            if (!checked.ok) throw new ActionError('Check the price and amount first.');
            // The reveal needs these; keep them before anything is signed.
            if (sealed && !(await saveBid(store, { cross: cross.address, owner, nonce: attempt.nonce, side, price: String(checked.price), quantity: String(checked.quantity), salt: attempt.salt!, placedAt: new Date().toISOString() }))) {
              throw new ActionError('This device could not store your sealed bid, so it could not be revealed later. Nothing was sent.');
            }
          }}
          body={() => {
            if (!checked.ok) throw new ActionError('Check the price and amount first.');
            return { ...placeOrderBody(cross, owner, { ...draft, price: checked.price, quantity: checked.quantity }, attempt.nonce, attempt.salt), ...(ruled && side === 'buy' ? { class: effectiveClass, ...(effectiveClass === 2 ? { lockSecs } : {}) } : {}) };
          }}
          onDone={(sigs, extra) => {
            if (typeof extra.order === 'string') void rememberOrder(store, cross.address, owner, extra.order);
            setPlaced(sigs[0] ?? null);
            setPriceText('');
            setQtyText('');
            setAcked(false);
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

function SettleCard({ cross, payer, onDone, rules }: { cross: CrossDetail; payer: string; onDone: () => void; rules: RulesRead | null | undefined }) {
  const owed = rules?.calls?.drawOwed ?? null;
  const status = rules?.calls?.drawStatus ?? 'not-begun';
  if (owed) {
    const begin = status === 'not-begun' || status === 'void';
    return (
      <Card>
        <Txt variant="heading">A draw comes before settlement</Txt>
        <Txt variant="small" tone="muted" style={{ marginTop: 4 }}>
          {owed === 'end' ? 'This cross draws the last ending window that counts.' : 'The cross did not print and its rules allow one extension; a draw sets how long the call reopens.'} The draw is the cluster's own block hashes, not a verifiable random function. Anyone may send either step; you pay the network fee.
        </Txt>
        <View style={{ marginTop: 12 }}>
          {begin ? (
            <ActionButton label="Begin the draw" path="/v1/tx/draw-begin" body={() => ({ cross: cross.address, payer })} onDone={() => onDone()} />
          ) : (
            <ActionButton label="Finish the draw" path="/v1/tx/draw-finish" body={() => ({ cross: cross.address, payer })} onDone={() => onDone()} />
          )}
        </View>
      </Card>
    );
  }
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

function MyOrders({ cross, phase, market, owner, version, onChanged, rules, now }: { cross: CrossDetail; phase: Phase; market: Market; owner: string; version: number; onChanged: () => void; rules: RulesRead | null | undefined; now: bigint }) {
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [bids, setBids] = useState<SealedBid[]>([]);
  const settled = cross.state === 'Cleared' || cross.state === 'NoPrint';
  const sealed = cross.disclosure === 'sealed';
  const deadline = rules?.calls ? BigInt(rules.calls.cancelDeadline) : BigInt(cross.window.closeTs);
  const extended = (rules?.state?.draw.epoch ?? 0) > 0;

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
              {o.open && o.nonce !== null && phase === 'open' && now < deadline && !extended ? <ActionButton label="Cancel and refund" variant="secondary" path="/v1/tx/cancel" body={() => ({ cross: cross.address, owner, nonce: o.nonce })} onDone={() => onChanged()} /> : null}
              {o.open && phase === 'open' && (now >= deadline || extended) ? (
                <Txt variant="small" tone="muted">
                  {extended ? 'Placed in the extension of the call, which cannot be cancelled.' : `Cancellation closed at ${clock(deadline)}. This order stays until the cross settles, and is refunded in full if it does not print.`}
                </Txt>
              ) : null}
              {o.open && o.nonce !== null && sealed && !o.revealed && phase === 'reveal' ? (
                bid ? (
                  <ActionButton label="Reveal bid" path="/v1/tx/reveal" body={() => ({ cross: cross.address, owner, nonce: bid.nonce, price: bid.price, quantity: bid.quantity, salt: bid.salt })} onDone={() => onChanged()} />
                ) : (
                  <Notice tone="error">This device has no record of this sealed bid, so it cannot be revealed. It will be refunded in full at settlement.</Notice>
                )
              ) : null}
              {o.open && o.nonce !== null && settled ? <ActionButton label="Claim fill and refund" path="/v1/tx/claim" body={() => ({ cross: cross.address, owner, nonce: o.nonce })} onDone={() => onChanged()} /> : null}
              {o.open && settled ? (
                <Txt variant="small" tone="muted">
                  If nothing of this order traded, a keeper may refund it before you claim; it then shows here as paid out.
                </Txt>
              ) : null}
              {!o.open && settled && o.status !== 'claimed' && o.status !== 'cancelled' ? (
                <Txt variant="small" tone="muted">
                  Paid out on chain without waiting for you. The amounts appear once the index has recorded them.
                </Txt>
              ) : null}
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

function RulesCard({ rules, cross, market }: { rules: RulesRead | null | undefined; cross: CrossDetail; market: Market }) {
  if (rules === undefined) return null;
  if (rules === null) return <Notice tone="error">The rules of this cross could not be read just now. Treat it as having limits you cannot see.</Notice>;
  if (!rules.rules) {
    return (
      <Card>
        <Txt variant="heading">Rules</Txt>
        <Txt variant="small" tone="muted" style={{ marginTop: 4 }}>
          This cross has no rules: a plain call auction. It was created by the first release of the cross program, or its creator set none. The rules extension is built and proved on LiteSVM and a local validator but is not deployed to devnet yet (H27).
        </Txt>
      </Card>
    );
  }
  return (
    <Card>
      <Txt variant="heading">Rules</Txt>
      {summaryLines(rules.rules, market, BigInt(cross.window.closeTs), rules.calls).map((l) => (
        <Txt key={l} variant="small" tone="muted" style={{ marginTop: 6 }}>
          {l}
        </Txt>
      ))}
    </Card>
  );
}

/** Two facts that change what a person expects of a cross: it belongs to a recurring series, or it honours a halt that is up now. */
function ScheduleNotes({ cross, rules }: { cross: CrossDetail; rules: RulesRead | null | undefined }) {
  const [series, setSeries] = useState<SeriesRead | null>(null);
  const [halt, setHalt] = useState<HaltRead | null>(null);
  useEffect(() => {
    let live = true;
    // The list is asked first so that a cross made by a person never provokes a 404 for a series that does not exist.
    void get<{ series: { address: string }[] }>('/v1/series').then(async (l) => {
      if (!live || !l.ok || !l.data.series.some((x) => x.address === cross.creator)) return;
      const one = await get<SeriesRead>(`/v1/series/${cross.creator}`);
      if (live && one.ok) setSeries(one.data);
    });
    return () => {
      live = false;
    };
  }, [cross.creator]);
  const honours = Boolean(rules?.rules?.guards.haltSource);
  useEffect(() => {
    if (!honours || !cross.baseMint) {
      setHalt(null);
      return;
    }
    let live = true;
    void get<HaltRead>(`/v1/halts/${cross.baseMint}`).then((h) => live && setHalt(h.ok ? h.data : null));
    return () => {
      live = false;
    };
  }, [honours, cross.baseMint, cross.state]);
  // The Wave 3D programs: listings against a bond, a failing backing policy and a governed graduation. A network without them answers with nothing, and nothing is shown.
  const [listings, setListings] = useState<ListingsRead['listings']>([]);
  const [backing, setBacking] = useState<BackingRead | null>(null);
  const [grad, setGrad] = useState<GraduationRead | null>(null);
  const governed = rules?.rules?.flags?.governedGraduation === true;
  useEffect(() => {
    let live = true;
    void get<ListingsRead>(`/v1/crosses/${cross.address}/listings`).then((r) => live && setListings(r.ok ? r.data.listings : []));
    if (cross.baseMint) void get<BackingRead>(`/v1/assets/${cross.baseMint}/backing`).then((r) => live && setBacking(r.ok ? r.data : null));
    return () => {
      live = false;
    };
  }, [cross.address, cross.baseMint, cross.state]);
  useEffect(() => {
    if (!governed) return setGrad(null);
    let live = true;
    void get<GraduationRead>(`/v1/crosses/${cross.address}/graduation`).then((r) => live && setGrad(r.ok ? r.data : null));
    return () => {
      live = false;
    };
  }, [governed, cross.address, cross.state]);
  const banner = haltBanner(halt, cross.state);
  const backed = backingBanner(backing);
  const govNote = governedNote(grad);
  if (!banner && !series && !backed && !govNote && listings.length === 0) return null;
  return (
    <>
      {banner ? <Notice tone="error">{banner}</Notice> : null}
      {backed ? <Notice tone="error">{backed}</Notice> : null}
      {govNote ? <Notice>{govNote}</Notice> : null}
      {listings.map((l) => (
        <Notice key={l.listing} tone={l.status === 'slashed' ? 'error' : 'plain'}>
          {listingNote(l)}
        </Notice>
      ))}
      {series ? (
        <Card>
          <Txt variant="small" tone="muted">
            {seriesNote(series, cross.address)}
          </Txt>
        </Card>
      ) : null}
    </>
  );
}
