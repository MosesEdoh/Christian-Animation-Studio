import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';

// Shared mobile building blocks that mirror the web studio's look.
// They only use core react-native primitives and inline styles so screen
// tests that mock react-native keep working.

export const fonts = {
  serif: 'Fraunces_600SemiBold',
  serifMedium: 'Fraunces_500Medium',
  regular: 'Manrope_400Regular',
  medium: 'Manrope_500Medium',
  semibold: 'Manrope_600SemiBold',
  bold: 'Manrope_700Bold',
};

/** The deep ink used by the web studio's sidebar; reads well in both themes. */
export const inkSurface = '#292743';
export const inkText = '#fcf9f3';

export function BrandMark({ tone = 'dark', compact = false }: { tone?: 'dark' | 'light'; compact?: boolean }) {
  const colors = useColors();
  const ink = tone === 'light' ? colors.card : colors.foreground;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }} accessibilityLabel="Frame & Faith">
      <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontFamily: fonts.serif, fontSize: 13, color: colors.accentForeground }}>F&amp;F</Text>
      </View>
      {compact ? null : (
        <View>
          <Text style={{ fontFamily: fonts.serif, fontSize: 16, color: ink }}>Frame &amp; Faith</Text>
          <Text style={{ fontFamily: fonts.semibold, fontSize: 10, letterSpacing: 1.1, color: tone === 'light' ? colors.accent : colors.mutedForeground }}>CHRISTIAN ANIMATION STUDIO</Text>
        </View>
      )}
    </View>
  );
}

export function ScreenHeader({ kicker, title, subtitle, kickerColor, right }: {
  kicker: string;
  title: string;
  subtitle?: string;
  kickerColor?: string;
  right?: ReactNode;
}) {
  const colors = useColors();
  return (
    <View style={{ gap: 6, marginBottom: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <Text style={{ fontFamily: fonts.bold, fontSize: 11, letterSpacing: 1.4, color: kickerColor ?? colors.coral }}>{kicker}</Text>
        {right}
      </View>
      <Text accessibilityRole="header" style={{ fontFamily: fonts.serif, fontSize: 30, lineHeight: 36, color: colors.foreground }}>{title}</Text>
      {subtitle ? <Text style={{ fontFamily: fonts.regular, fontSize: 15, lineHeight: 22, color: colors.mutedForeground }}>{subtitle}</Text> : null}
    </View>
  );
}

export function SectionHeader({ title, caption, right }: { title: string; caption?: string; right?: ReactNode }) {
  const colors = useColors();
  return (
    <View style={{ marginTop: 14, gap: 3 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <Text accessibilityRole="header" style={{ fontFamily: fonts.serif, fontSize: 22, color: colors.foreground, flexShrink: 1 }}>{title}</Text>
        {right}
      </View>
      {caption ? <Text style={{ fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: colors.mutedForeground }}>{caption}</Text> : null}
    </View>
  );
}

export function Card({ children, tone = 'default', padded = true, style }: {
  children: ReactNode;
  tone?: 'default' | 'ink' | 'quiet';
  padded?: boolean;
  style?: object;
}) {
  const colors = useColors();
  const palette = tone === 'ink'
    ? { backgroundColor: inkSurface, borderColor: 'transparent' }
    : tone === 'quiet'
      ? { backgroundColor: colors.muted, borderColor: 'transparent' }
      : { backgroundColor: colors.card, borderColor: colors.border };
  return (
    <View style={{ borderWidth: 1, borderRadius: 18, gap: 12, ...(padded ? { padding: 16 } : {}), ...palette, ...style }}>
      {children}
    </View>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'sun';

export function Button({
  label,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  testID,
  accessibilityLabel,
  accessibilityHint,
  icon,
  compact = false,
  children,
}: {
  label?: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  icon?: ReactNode;
  compact?: boolean;
  children?: ReactNode;
}) {
  const colors = useColors();
  const palette: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
    primary: { bg: colors.primary, fg: colors.primaryForeground, border: colors.primary },
    secondary: { bg: colors.card, fg: colors.foreground, border: colors.border },
    ghost: { bg: 'transparent', fg: colors.teal, border: 'transparent' },
    danger: { bg: 'transparent', fg: colors.destructive, border: colors.destructive },
    sun: { bg: colors.accent, fg: colors.accentForeground, border: colors.accent },
  };
  const tone = palette[variant];
  const inactive = disabled || loading;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      hitSlop={compact ? 8 : undefined}
      style={({ pressed }: { pressed: boolean }) => ({
        minHeight: compact ? 36 : 48,
        paddingHorizontal: compact ? 12 : 18,
        paddingVertical: compact ? 7 : 12,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: tone.border,
        backgroundColor: tone.bg,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        opacity: inactive ? 0.55 : pressed ? 0.85 : 1,
        transform: [{ scale: pressed && !inactive ? 0.985 : 1 }],
      })}
    >
      {loading ? <ActivityIndicator size="small" color={tone.fg} /> : icon}
      {children ?? <Text numberOfLines={2} style={{ flexShrink: 1, fontFamily: fonts.bold, fontSize: compact ? 13 : 15, color: tone.fg, textAlign: 'center' }}>{label}</Text>}
    </Pressable>
  );
}

export function Chip({
  label,
  selected = false,
  onPress,
  testID,
  disabled,
  accessibilityLabel,
  grow = false,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  testID?: string;
  disabled?: boolean;
  accessibilityLabel?: string;
  grow?: boolean;
}) {
  const colors = useColors();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }: { pressed: boolean }) => ({
        minHeight: 40,
        paddingHorizontal: 14,
        paddingVertical: 9,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: selected ? colors.primary : colors.border,
        backgroundColor: selected ? colors.primary : colors.card,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        ...(grow ? { flex: 1 } : {}),
      })}
    >
      <Text style={{ fontFamily: fonts.semibold, fontSize: 13, color: selected ? colors.primaryForeground : colors.foreground, textAlign: 'center' }}>{label}</Text>
    </Pressable>
  );
}

export function FieldLabel({ children, hint }: { children: string; hint?: string }) {
  const colors = useColors();
  return (
    <View style={{ gap: 2 }}>
      <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.foreground }}>{children}</Text>
      {hint ? <Text style={{ fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: colors.mutedForeground }}>{hint}</Text> : null}
    </View>
  );
}

export function Notice({ tone = 'info', children, testID }: { tone?: 'info' | 'error' | 'success'; children: ReactNode; testID?: string }) {
  const colors = useColors();
  const accent = tone === 'error' ? colors.destructive : tone === 'success' ? colors.teal : colors.mutedForeground;
  return (
    <View style={{ flexDirection: 'row', gap: 10, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: accent, backgroundColor: colors.card }}>
      <View style={{ width: 4, borderRadius: 2, backgroundColor: accent }} />
      <Text testID={testID} accessibilityRole={tone === 'info' ? undefined : 'alert'} style={{ flex: 1, fontFamily: fonts.medium, fontSize: 14, lineHeight: 20, color: tone === 'info' ? colors.foreground : accent }}>
        {children}
      </Text>
    </View>
  );
}

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'success' | 'warning' | 'danger' }) {
  const colors = useColors();
  const map = {
    neutral: { bg: colors.muted, fg: colors.mutedForeground },
    success: { bg: colors.teal, fg: colors.card },
    warning: { bg: colors.accent, fg: colors.accentForeground },
    danger: { bg: colors.destructive, fg: colors.destructiveForeground },
  } as const;
  const tint = map[tone];
  return (
    <View style={{ alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: tint.bg }}>
      <Text style={{ fontFamily: fonts.bold, fontSize: 10, letterSpacing: 0.6, color: tint.fg }}>{label.toUpperCase()}</Text>
    </View>
  );
}

export function ProgressBar({ value, tone }: { value: number; tone?: string }) {
  const colors = useColors();
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: clamped }}
      style={{ height: 6, borderRadius: 3, backgroundColor: colors.muted, overflow: 'hidden' }}
    >
      <View style={{ width: `${clamped}%`, height: '100%', borderRadius: 3, backgroundColor: tone ?? colors.teal }} />
    </View>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  const colors = useColors();
  return (
    <View style={{ padding: 20, gap: 8, borderRadius: 16, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border, alignItems: 'center' }}>
      <Text style={{ fontFamily: fonts.bold, fontSize: 15, color: colors.foreground, textAlign: 'center' }}>{title}</Text>
      <Text style={{ fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: colors.mutedForeground, textAlign: 'center' }}>{body}</Text>
      {action}
    </View>
  );
}

/** Full-screen centered state for loading, access and recovery screens. */
export function StateScreen({ loading = false, title, message, children, testID }: {
  loading?: boolean;
  title?: string;
  message?: string;
  children?: ReactNode;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <View testID={testID} style={{ flex: 1, justifyContent: 'center', padding: 24, backgroundColor: colors.background }}>
      <View style={{ gap: 16, padding: 22, borderRadius: 22, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, maxWidth: 460, width: '100%', alignSelf: 'center' }}>
        <BrandMark />
        {loading ? (
          <View accessibilityRole="progressbar" accessibilityLabel={message} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <ActivityIndicator color={colors.teal} />
            <Text style={{ fontFamily: fonts.medium, fontSize: 15, color: colors.foreground }}>{message}</Text>
          </View>
        ) : (
          <>
            {title ? <Text accessibilityRole="header" style={{ fontFamily: fonts.serif, fontSize: 26, lineHeight: 32, color: colors.foreground }}>{title}</Text> : null}
            {message ? <Text style={{ fontFamily: fonts.regular, fontSize: 15, lineHeight: 22, color: colors.mutedForeground }}>{message}</Text> : null}
            {children}
          </>
        )}
      </View>
      <Text style={{ marginTop: 16, textAlign: 'center', fontFamily: fonts.medium, fontSize: 12, color: colors.mutedForeground }}>
        Bible-grounded stories for ages 5–17 · Private by default
      </Text>
    </View>
  );
}
