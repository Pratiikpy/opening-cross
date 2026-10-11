// The two device facilities the pure libraries take as arguments: a random source and a key-value store.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getRandomBytes } from 'expo-crypto';
import type { KeyValue } from './sealed';

export const random = (n: number): Uint8Array => getRandomBytes(n);
export const store: KeyValue = AsyncStorage;
