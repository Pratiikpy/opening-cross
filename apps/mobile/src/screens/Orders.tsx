import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';
import { loadAllOrders } from '../lib/orders';
import type { OwnerOrder } from '../lib/types';
import { shortAddress } from '../lib/units';
import { useWallet } from '../lib/wallet';
import { ActionButton } from '../ui/action';
import { Card, Notice, Pill, Txt } from '../ui/components';
import { useTheme } from '../ui/theme';
import type { RootStack } from '../navigation';

/** Every order of the connected wallet across crosses, with a claim for each one that has settled and is not yet paid. */
export function OrdersScreen({ navigation }: NativeStackScreenProps<RootStack, 'Orders'>) {
  const t = useTheme();
  const { address } = useWallet();
  const [orders, setOrders] = useState<OwnerOrder[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => {
    if (!address) return;
    const o = await loadAllOrders(address);
    setFailed(o === null);
    setOrders(o);
  }, [address]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!address) return <View style={{ flex: 1, padding: 16, backgroundColor: t.bg }}><Notice>Connect a wallet to see your orders.</Notice></View>;
  return (
    <FlatList
      data={orders ?? []}
      keyExtractor={(o) => o.address}
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={{ padding: 16, gap: 12 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
      ListHeaderComponent={failed ? <Notice tone="error">The Opening Cross API could not be reached. Pull down to try again.</Notice> : null}
      ListEmptyComponent={orders === null && !failed ? <Txt tone="muted">Loading your orders…</Txt> : orders?.length === 0 ? <Txt tone="muted">You have not placed an order yet.</Txt> : null}
      renderItem={({ item: o }) => (
        <Card>
          <Pressable accessibilityRole="button" onPress={() => navigation.navigate('Cross', { address: o.cross_address })}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Txt variant="heading">
                {o.side === 'buy' ? 'Buy' : 'Sell'} in {shortAddress(o.cross_address)}
              </Txt>
              <Pill label={o.status} tone={o.status === 'claimed' ? 'good' : 'plain'} />
            </View>
            <Txt variant="small" tone="muted" style={{ marginTop: 6 }}>
              {o.fill ? `filled ${o.fill} · ` : ''}escrow {o.escrow}
            </Txt>
          </Pressable>
        </Card>
      )}
    />
  );
}
