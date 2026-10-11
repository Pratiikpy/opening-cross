import { View } from 'react-native';
import type { BookResponse } from '../lib/types';
import { type Market, formatAtoms, formatPrice } from '../lib/units';
import { Txt } from './components';
import { useTheme } from './theme';

/** The resting book, best prices first: buys in ink on the left, sells in grey on the right, the clearing level marked. */
export function BookChart({ book, market, clearing }: { book: BookResponse | null; market: Market; clearing: string | null }) {
  const t = useTheme();
  if (!book) return <Txt variant="small" tone="muted">Loading the book…</Txt>;
  if (book.levels.length === 0) return <Txt variant="small" tone="muted">{book.disclosure === 'sealed' ? 'Sealed: prices stay hidden until bids are revealed.' : 'No orders yet.'}</Txt>;
  const levels = [...book.levels].sort((a, b) => (BigInt(b.price) > BigInt(a.price) ? 1 : -1));
  const max = levels.reduce((m, l) => (BigInt(l.buy) > m ? BigInt(l.buy) : BigInt(l.sell) > m ? BigInt(l.sell) : m), 1n);
  const width = (q: string) => `${Number((BigInt(q) * 1000n) / max) / 10}%` as `${number}%`;
  return (
    <View accessibilityLabel="Order book" style={{ gap: 6 }}>
      {levels.map((l) => {
        const at = clearing !== null && l.price === clearing;
        return (
          <View key={l.price} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1, alignItems: 'flex-end' }}>
              <View accessibilityLabel={`buy ${formatAtoms(BigInt(l.buy), market.baseDecimals)}`} style={{ height: 16, width: width(l.buy), backgroundColor: t.ink, borderRadius: 4 }} />
            </View>
            <View style={{ width: 62, paddingVertical: 2, borderRadius: 6, backgroundColor: at ? t.accentFill : 'transparent' }}>
              <Txt variant="small" style={{ textAlign: 'center', color: at ? t.onAccent : t.ink, fontFamily: 'IBMPlexMono_400Regular' }}>
                {formatPrice(BigInt(l.price), market)}
              </Txt>
            </View>
            <View style={{ flex: 1 }}>
              <View accessibilityLabel={`sell ${formatAtoms(BigInt(l.sell), market.baseDecimals)}`} style={{ height: 16, width: width(l.sell), backgroundColor: t.borderStrong, borderRadius: 4 }} />
            </View>
          </View>
        );
      })}
    </View>
  );
}
