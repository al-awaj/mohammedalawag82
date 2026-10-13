import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Token storage: the device keychain/keystore on iOS and Android. The web build (used for testing)
 * keeps tokens in memory only, so they never land in browser storage.
 */
const memory = new Map<string, string>();
const native = Platform.OS === 'ios' || Platform.OS === 'android';

export const storage = {
  get: async (k: string) => (native ? SecureStore.getItemAsync(k) : memory.get(k) ?? null),
  set: async (k: string, v: string) => { if (native) await SecureStore.setItemAsync(k, v); else memory.set(k, v); },
  del: async (k: string) => { if (native) await SecureStore.deleteItemAsync(k); else memory.delete(k); },
};

/** Non-secret preference (language): secure store on devices, localStorage on web. */
export const prefs = {
  get: async (k: string) => (native ? SecureStore.getItemAsync(k) : globalThis.localStorage?.getItem(k) ?? null),
  set: async (k: string, v: string) => { if (native) await SecureStore.setItemAsync(k, v); else globalThis.localStorage?.setItem(k, v); },
};
