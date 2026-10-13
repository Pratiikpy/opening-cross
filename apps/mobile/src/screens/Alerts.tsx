import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';
import { type FeedItem, loadFeed, targetOf, when } from '../lib/alerts';
import { useWallet } from '../lib/wallet';
import { Card, Notice, Pill, Txt } from '../ui/components';
import { useTheme } from '../ui/theme';
import type { RootStack } from '../navigation';

/** What needs the connected wallet now: orders to claim, crosses about to close on its orders. */
export function AlertsScreen({ navigation }: NativeStackScreenProps<RootStack, 'Alerts'>) {
  const t = useTheme();
  const { address } = useWallet();
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => {
    if (!address) return;
    const f = await loadFeed(address);
    setFailed(f === null);
    setItems(f);
  }, [address]);
  useEffect(() => {
    void load();
  }, [load]);
  const now = Math.floor(Date.now() / 1000);
  if (!address) {
    return (
      <View style={{ flex: 1, padding: 16, backgroundColor: t.bg }}>
        <Notice>Connect a wallet to see what needs you.</Notice>
      </View>
    );
  }
  return (
    <FlatList
      data={items ?? []}
      keyExtractor={(i) => i.key}
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={{ padding: 16, gap: 12 }}
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
      ListHeaderComponent={
        <View style={{ gap: 12 }}>
          {failed ? <Notice tone="error">The Opening Cross API could not be reached. Pull down to try again.</Notice> : null}
          <Notice>This list is read when you open it. Push notifications to this phone are not switched on in this build: they need a push credential that the operator adds.</Notice>
        </View>
      }
      ListEmptyComponent={items === null && !failed ? <Txt tone="muted">Checking…</Txt> : items?.length === 0 ? <Txt tone="muted">Nothing needs you right now.</Txt> : null}
      renderItem={({ item }) => (
        <Card>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              const target = targetOf(item.href);
              if (target.screen === 'Cross') navigation.navigate('Cross', { address: target.address });
              else navigation.navigate('Orders');
            }}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <Txt variant="heading" style={{ flex: 1 }}>
                {item.title}
              </Txt>
              <Pill label={when(item.at, now)} tone={item.kind === 'claimable' ? 'live' : 'plain'} />
            </View>
            <Txt variant="small" tone="muted" style={{ marginTop: 6 }}>
              {item.body}
            </Txt>
          </Pressable>
        </Card>
      )}
    />
  );
}
