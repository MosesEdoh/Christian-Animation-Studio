import { Alert, Platform } from 'react-native';

/**
 * Ask the user to confirm an action. Uses the native alert on iOS/Android and
 * the browser dialog on web, where react-native-web's Alert shows nothing.
 */
export function confirmAction({
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
}): Promise<boolean> {
  if (Platform.OS === 'web') {
    const confirmFn = typeof globalThis.confirm === 'function' ? globalThis.confirm : null;
    return Promise.resolve(confirmFn ? confirmFn(`${title}\n\n${message}`) : true);
  }
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: cancelLabel, style: 'cancel', onPress: () => resolve(false) },
      { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}
