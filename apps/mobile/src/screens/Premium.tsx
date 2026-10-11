import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { get } from '../lib/api';
import { EXCLUSION_LABEL, type PremiumObservation, type PremiumSummary, SESSION_LABEL, SESSION_ORDER, percentOf, usdOf } from '../lib/premium';
import { Card, Notice, Txt } from '../ui/components';
import { useTheme } from '../ui/theme';

/** The premium monitor: by market session, then the newest round per token. Same data as the web page. */
export function PremiumScreen() {
  const t = useTheme();
  const [summary, setSummary] = useState<PremiumSummary | null>(null);
  const [latest, setLatest] = useState<PremiumObservation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [s, l] = await Promise.all([get<PremiumSummary>('/v1/premium/summary?days=7'), get<{ observations: PremiumObservation[] }>('/v1/premium/latest')]);
    if (s.ok) {
      setSummary(s.data);
      setError(null);
    } else setError(s.error);
    if (l.ok) setLatest(l.data.observations);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const tokens = new Map<string, PremiumObservation[]>();
  for (const o of latest) tokens.set(o.symbol, [...(tokens.get(o.symbol) ?? []), o]);

  return (
    <ScrollView
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={{ padding: 16, gap: 14 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
    >
      <Txt variant="title">Premium monitor</Txt>
      <Txt tone="muted">A real swap quoted on Jupiter at three sizes, priced per share and set against an independent reference. Positive means you pay (or receive) more than the reference.</Txt>
      {error ? <Notice tone="error">The premium record cannot be loaded right now: {error}</Notice> : null}
      {summary && summary.coverage.rounds === 0 ? <Notice>Nothing has been measured in the last {summary.days} days. Nothing here is example data.</Notice> : null}
      {summary
        ? SESSION_ORDER.filter((s) => summary.groups.some((g) => g.session === s)).map((s) => (
            <Card key={s}>
              <Txt variant="heading">{SESSION_LABEL[s]}</Txt>
              {summary.groups
                .filter((g) => g.session === s)
                .map((g) => (
                  <View key={`${g.sizeUsd}-${g.leg}`} style={{ marginTop: 10, flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Txt variant="mono">
                      {g.leg === 'buy' ? 'Buy' : 'Sell'} ${g.sizeUsd.toLocaleString('en-US')}
                    </Txt>
                    <Txt variant="mono">
                      {percentOf(g.summary.medianBpsX100)} <Txt variant="small" tone="muted">n={g.summary.n}{Object.keys(g.excluded).length ? ` · ${Object.entries(g.excluded).map(([k, n]) => `${n} ${EXCLUSION_LABEL[k] ?? k}`).join(', ')}` : ''}</Txt>
                    </Txt>
                  </View>
                ))}
            </Card>
          ))
        : null}
      {tokens.size > 0 ? (
        <Card>
          <Txt variant="heading">Latest round, $1,000</Txt>
          {[...tokens.entries()].map(([symbol, list]) => {
            const buy = list.find((o) => o.sizeUsd === 1000 && o.leg === 'buy');
            const sell = list.find((o) => o.sizeUsd === 1000 && o.leg === 'sell');
            const show = (o?: PremiumObservation) => (o ? (o.status === 'ok' ? percentOf(o.premiumBpsX100) : (EXCLUSION_LABEL[o.status] ?? o.status)) : '—');
            return (
              <View key={symbol} style={{ marginTop: 10, flexDirection: 'row', justifyContent: 'space-between' }}>
                <Txt variant="mono">
                  {symbol} <Txt variant="small" tone="muted">{usdOf(buy?.referenceE6 ?? null)}</Txt>
                </Txt>
                <Txt variant="mono">
                  {show(buy)} / {show(sell)}
                </Txt>
              </View>
            );
          })}
          <Txt variant="small" tone="muted" style={{ marginTop: 10 }}>
            Buy / sell. Quotes, not fills. When the stock's own market is closed the reference is a perpetual, not the cash market.
          </Txt>
        </Card>
      ) : null}
    </ScrollView>
  );
}
