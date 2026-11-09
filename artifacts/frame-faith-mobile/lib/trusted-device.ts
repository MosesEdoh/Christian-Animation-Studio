import * as SecureStore from "expo-secure-store";

const TRUSTED_DEVICE_TOKEN_KEY = "frame-faith.trusted-device-token";

export function getTrustedDeviceToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TRUSTED_DEVICE_TOKEN_KEY);
}

export function saveTrustedDeviceToken(token: string): Promise<void> {
  return SecureStore.setItemAsync(TRUSTED_DEVICE_TOKEN_KEY, token);
}

export function clearTrustedDeviceToken(): Promise<void> {
  return SecureStore.deleteItemAsync(TRUSTED_DEVICE_TOKEN_KEY);
}
