import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';
import { type CrossSummary, get } from '../lib/api';
import { shortAddress } from '../lib/units';
import { Card, Notice, Pill, Txt } from '../ui/components';
import { useTheme } from '../ui/theme';
import type { RootStack } from '../navigation';

const TONE = { Live: 'live', Cleared: 'good', NoPrint: 'plain', Finalized: 'plain' } as const;

function when(ts: string): string {
  return new Date(Number(ts) * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export function CrossesScreen({ navigation }: NativeStackScreenProps<RootStack, 'Crosses'>) {
  const t = useTheme();
  const [rows, setRows] = useState<CrossSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const r = await get<{ crosses: CrossSummary[] }>('/v1/crosses?limit=100');
    if (r.ok) {
      setRows(r.data.crosses);
      setError(null);
    } else setError(r.error);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <FlatList
      data={rows ?? []}
      keyExtractor={(c) => c.address}
      contentContainerStyle={{ padding: 16, gap: 12 }}
      style={{ backgroundColor: t.bg }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
      ListHeaderComponent={error ? <Notice tone="error">{error} Pull down to try again.</Notice> : null}
      ListEmptyComponent={rows === null && !error ? <Txt tone="muted">Loading crosses…</Txt> : rows?.length === 0 ? <Txt tone="muted">No crosses yet.</Txt> : null}
      renderItem={({ item: c }) => (
        <Pressable accessibilityRole="button" accessibilityLabel={`Cross ${shortAddress(c.address)}, ${c.state}`} onPress={() => navigation.navigate('Cross', { address: c.address })}>
          <Card>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Txt variant="heading">{shortAddress(c.address)}</Txt>
              <Pill label={c.state === 'Live' ? 'Open' : c.state === 'NoPrint' ? 'No print' : c.state} tone={TONE[c.state]} />
            </View>
            <Txt variant="small" tone="muted" style={{ marginTop: 8 }}>
              {c.orders_committed} order{c.orders_committed === 1 ? '' : 's'} · closes {when(c.close_ts)}
            </Txt>
          </Card>
        </Pressable>
      )}
    />
  );
}
