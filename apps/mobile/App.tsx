import { HankenGrotesk_400Regular, HankenGrotesk_500Medium, HankenGrotesk_600SemiBold, HankenGrotesk_700Bold } from '@expo-google-fonts/hanken-grotesk';
import { IBMPlexMono_400Regular, IBMPlexMono_500Medium } from '@expo-google-fonts/ibm-plex-mono';
import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { WalletProvider, useWallet } from './src/lib/wallet';
import type { RootStack } from './src/navigation';
import { CrossScreen } from './src/screens/Cross';
import { AlertsScreen } from './src/screens/Alerts';
import { CrossesScreen } from './src/screens/Crosses';
import { OrdersScreen } from './src/screens/Orders';
import { PremiumScreen } from './src/screens/Premium';
import { Button } from './src/ui/components';
import { FONT, useTheme } from './src/ui/theme';

const Stack = createNativeStackNavigator<RootStack>();

function WalletButton({ onOrders, onAlerts }: { onOrders: () => void; onAlerts: () => void }) {
  const w = useWallet();
  const [busy, setBusy] = useState(false);
  return (
    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
      {w.address ? <Button label="Alerts" variant="secondary" onPress={onAlerts} /> : null}
      {w.address ? <Button label="Orders" variant="secondary" onPress={onOrders} /> : null}
      <Button
        label={w.address ? `${w.address.slice(0, 4)}…${w.address.slice(-4)}` : 'Connect'}
        variant={w.address ? 'secondary' : 'primary'}
        busy={busy || w.connecting}
        onPress={async () => {
          setBusy(true);
          try {
            if (w.address) await w.disconnect();
            else await w.connect();
          } catch (e) {
            Alert.alert('Wallet', e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      />
    </View>
  );
}

function Shell() {
  const t = useTheme();
  const base = t.dark ? DarkTheme : DefaultTheme;
  const theme = { ...base, colors: { ...base.colors, background: t.bg, card: t.bg, text: t.ink, border: t.border, primary: t.accentText } };
  return (
    <NavigationContainer theme={theme}>
      <Stack.Navigator screenOptions={{ headerTitleStyle: { fontFamily: FONT.semibold }, headerShadowVisible: false }}>
        <Stack.Screen
          name="Crosses"
          component={CrossesScreen}
          options={({ navigation }) => ({ title: 'Opening Bell', headerRight: () => <WalletButton onOrders={() => navigation.navigate('Orders')} onAlerts={() => navigation.navigate('Alerts')} /> })}
        />
        <Stack.Screen name="Cross" component={CrossScreen} options={({ navigation }) => ({ title: 'Cross', headerRight: () => <WalletButton onOrders={() => navigation.navigate('Orders')} onAlerts={() => navigation.navigate('Alerts')} /> })} />
        <Stack.Screen name="Orders" component={OrdersScreen} options={{ title: 'Your orders' }} />
        <Stack.Screen name="Alerts" component={AlertsScreen} options={{ title: 'Needs you' }} />
        <Stack.Screen name="Premium" component={PremiumScreen} options={{ title: 'Premium monitor' }} />
      </Stack.Navigator>
      <StatusBar style={t.dark ? 'light' : 'dark'} />
    </NavigationContainer>
  );
}

export default function App() {
  const [loaded] = useFonts({ HankenGrotesk_400Regular, HankenGrotesk_500Medium, HankenGrotesk_600SemiBold, HankenGrotesk_700Bold, IBMPlexMono_400Regular, IBMPlexMono_500Medium });
  if (!loaded) return <View style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator /></View>;
  return (
    <SafeAreaProvider>
      <WalletProvider>
        <Shell />
      </WalletProvider>
    </SafeAreaProvider>
  );
}
