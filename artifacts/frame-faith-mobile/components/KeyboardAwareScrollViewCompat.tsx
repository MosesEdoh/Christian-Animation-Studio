import { Platform, ScrollView, ScrollViewProps, StyleSheet } from 'react-native';
import {
  KeyboardAwareScrollView,
  KeyboardAwareScrollViewProps,
} from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';

type Props = KeyboardAwareScrollViewProps & ScrollViewProps & {
  /**
   * Treat this as a full tab screen: fill the background and pad the content
   * for the status bar at the top and the floating tab bar at the bottom.
   */
  screen?: boolean;
};

export function KeyboardAwareScrollViewCompat({
  children,
  keyboardShouldPersistTaps = 'handled',
  screen = false,
  style,
  contentContainerStyle,
  ...props
}: Props) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const screenStyle = screen ? [{ flex: 1, backgroundColor: colors.background }, style] : style;
  const screenContent = screen
    ? [
      {
        paddingHorizontal: 20,
        paddingTop: (Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top) + 16,
        paddingBottom: Math.max(insets.bottom, 16) + 96,
        gap: 14,
      },
      StyleSheet.flatten(contentContainerStyle),
    ]
    : contentContainerStyle;
  if (Platform.OS === 'web') {
    return (
      <ScrollView
        keyboardShouldPersistTaps={keyboardShouldPersistTaps}
        style={screenStyle}
        contentContainerStyle={screenContent}
        {...props}
      >
        {children}
      </ScrollView>
    );
  }
  return (
    <KeyboardAwareScrollView
      keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      style={screenStyle}
      contentContainerStyle={screenContent}
      {...props}
    >
      {children}
    </KeyboardAwareScrollView>
  );
}
