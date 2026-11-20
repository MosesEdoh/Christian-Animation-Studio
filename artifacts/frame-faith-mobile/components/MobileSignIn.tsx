import { createElement, useState, type FormEvent, type ReactNode } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';
import { useSignIn, useSignUp, useSSO } from '@clerk/expo';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { BrandMark, Button, Notice, fonts } from '@/components/ui';

WebBrowser.maybeCompleteAuthSession();

function AuthForm({ children, onSubmit }: { children: ReactNode; onSubmit: () => void }) {
  if (Platform.OS === 'web') {
    return createElement('form', {
      onSubmit: (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        onSubmit();
      },
      style: { display: 'flex', flexDirection: 'column', gap: 18, width: '100%' },
    }, children);
  }
  return <View style={{ gap: 18 }}>{children}</View>;
}

export function MobileSignIn() {
  const { signIn, errors: signInErrors, fetchStatus: signInStatus } = useSignIn();
  const { signUp, errors: signUpErrors, fetchStatus: signUpStatus } = useSignUp();
  const { startSSOFlow } = useSSO();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [register, setRegister] = useState(false);
  const [emailAddress, setEmailAddress] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [verification, setVerification] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const pending = busy || signInStatus === 'fetching' || signUpStatus === 'fetching';
  const inputStyle = { paddingHorizontal: 14, paddingVertical: 14, borderWidth: 1, borderColor: colors.border, borderRadius: 12, color: colors.foreground, backgroundColor: colors.background, fontFamily: fonts.regular, fontSize: 16 };
  async function submit() {
    setError(''); setBusy(true);
    try {
      if (register) {
        if (verification) {
          const result = await signUp.verifications.verifyEmailCode({ code });
          if (result.error) throw new Error(result.error.message);
          if (signUp.status === 'complete') await signUp.finalize();
          else setError('Additional account details are needed. Please complete registration in the web studio.');
        } else {
          const result = await signUp.password({ emailAddress, password });
          if (result.error) throw new Error(result.error.message);
          const sent = await signUp.verifications.sendEmailCode();
          if (sent.error) throw new Error(sent.error.message);
          setVerification(true);
        }
      } else {
        const result = verification
          ? await signIn.mfa.verifyEmailCode({ code })
          : await signIn.password({ emailAddress, password });
        if (result.error) throw new Error(result.error.message);
        if (signIn.status === 'complete') await signIn.finalize();
        else if (signIn.status === 'needs_client_trust' && signIn.supportedSecondFactors.some(factor => factor.strategy === 'email_code')) {
          const sent = await signIn.mfa.sendEmailCode();
          if (sent.error) throw new Error(sent.error.message);
          setVerification(true);
        } else setError('This account needs additional verification. Please sign in through the web studio.');
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Sign-in failed. Please retry.'); }
    finally { setBusy(false); }
  }
  async function google() {
    setBusy(true); setError('');
    try {
      const { createdSessionId, setActive } = await startSSOFlow({
        strategy: 'oauth_google',
        redirectUrl: AuthSession.makeRedirectUri({ scheme: 'frame-faith-mobile' }),
      });
      if (createdSessionId && setActive) await setActive({ session: createdSessionId });
      else setError('Sign-in was not completed. Please retry or use email and password.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Google sign-in failed.'); }
    finally { setBusy(false); }
  }
  const errors = register ? signUpErrors : signInErrors;
  const fieldErrors = Object.values(errors.fields).map(field => field?.message).filter((message): message is string => !!message);
  const canSubmit = verification ? code.trim().length > 0 : emailAddress.trim().length > 0 && password.length > 0;
  function switchMode(nextRegister: boolean) {
    if (nextRegister === register && !verification) return;
    setRegister(nextRegister); setVerification(false); setCode(''); setError(''); void signIn.reset(); void signUp.reset();
  }
  const labelStyle = { fontFamily: fonts.bold, fontSize: 13, color: colors.foreground };
  return <KeyboardAwareScrollViewCompat bottomOffset={24} keyboardShouldPersistTaps="handled"
    style={{ flex: 1, backgroundColor: colors.background }}
    contentContainerStyle={{ padding: 24, paddingTop: (Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top) + 24, paddingBottom: Math.max(insets.bottom, 34), gap: 18, maxWidth: 480, width: '100%', alignSelf: 'center' }}>
    <BrandMark />
    <View style={{ gap: 8, marginTop: 8 }}>
      <Text style={{ fontFamily: fonts.bold, fontSize: 11, letterSpacing: 1.4, color: colors.coral }}>{verification ? 'ONE LAST STEP' : register ? 'JOIN THE STUDIO' : 'WELCOME BACK'}</Text>
      <Text accessibilityRole="header" style={{ fontSize: 30, lineHeight: 36, fontFamily: fonts.serif, color: colors.foreground }}>{verification ? 'Verify your email' : register ? 'Create an account' : 'Your private studio'}</Text>
      <Text style={{ fontFamily: fonts.regular, fontSize: 15, lineHeight: 22, color: colors.mutedForeground }}>
        {verification ? `We sent a code to ${emailAddress || 'your email'}. Enter it below to continue.` : 'Use any verified email, then trust each device before opening the shared studio.'}
      </Text>
    </View>
    {!verification ? (
      <View accessibilityRole="tablist" style={{ flexDirection: 'row', padding: 4, borderRadius: 14, backgroundColor: colors.muted }}>
        {[{ value: false, label: 'Sign in' }, { value: true, label: 'Create account' }].map(option => {
          const active = register === option.value;
          return <Pressable key={option.label} accessibilityRole="tab" accessibilityState={{ selected: active }} disabled={pending} onPress={() => switchMode(option.value)}
            style={{ flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: active ? colors.card : 'transparent' }}>
            <Text style={{ textAlign: 'center', fontFamily: fonts.bold, fontSize: 14, color: active ? colors.foreground : colors.mutedForeground }}>{option.label}</Text>
          </Pressable>;
        })}
      </View>
    ) : null}
    <View style={{ padding: 18, gap: 16, borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}>
      <AuthForm onSubmit={() => void submit()}>
        {verification ? <View style={{ gap: 6 }}>
          <Text style={labelStyle}>Verification code</Text>
          <TextInput testID="mobile-code" accessibilityLabel="Verification code" style={[inputStyle, { letterSpacing: 4, fontSize: 18 }]} value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" returnKeyType="done" onSubmitEditing={() => void submit()} placeholder="123456" placeholderTextColor={colors.mutedForeground} />
        </View> : <>
          <View style={{ gap: 6 }}>
            <Text style={labelStyle}>Email</Text>
            <TextInput testID="mobile-email" accessibilityLabel="Email" style={inputStyle} value={emailAddress} onChangeText={setEmailAddress} autoCapitalize="none" autoCorrect={false} autoComplete="email" textContentType="emailAddress" keyboardType="email-address" returnKeyType="next" placeholder="you@example.com" placeholderTextColor={colors.mutedForeground} />
          </View>
          <View style={{ gap: 6 }}>
            <Text style={labelStyle}>Password</Text>
            <View style={{ justifyContent: 'center' }}>
              <TextInput testID="mobile-password" accessibilityLabel="Password" style={[inputStyle, { paddingRight: 64 }]} value={password} onChangeText={setPassword} secureTextEntry={!showPassword} autoComplete={register ? 'new-password' : 'current-password'} textContentType={register ? 'newPassword' : 'password'} returnKeyType="done" onSubmitEditing={() => void submit()} placeholder={register ? 'Create a strong password' : 'Your password'} placeholderTextColor={colors.mutedForeground} />
              <Pressable accessibilityRole="button" accessibilityLabel={showPassword ? 'Hide password' : 'Show password'} hitSlop={8} onPress={() => setShowPassword(value => !value)} style={{ position: 'absolute', right: 14 }}>
                <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.teal }}>{showPassword ? 'Hide' : 'Show'}</Text>
              </Pressable>
            </View>
          </View>
        </>}
        {!!error && <Notice tone="error">{error}</Notice>}
        {fieldErrors.map((message, index) => <Notice key={index} tone="error">{message}</Notice>)}
        <Button testID="mobile-login" disabled={!canSubmit} loading={pending} onPress={() => void submit()} label={pending ? 'Please wait…' : verification ? 'Verify' : register ? 'Create account' : 'Sign in'} />
      </AuthForm>
      {!verification && <>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
          <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.mutedForeground }}>or</Text>
          <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
        </View>
        <Button testID="mobile-google" variant="secondary" disabled={pending} onPress={() => void google()} label="Continue with Google" />
      </>}
    </View>
    {verification ? <Button variant="ghost" disabled={pending} onPress={() => switchMode(register)} label="Start over" /> : null}
    <Text style={{ textAlign: 'center', fontFamily: fonts.medium, fontSize: 12, lineHeight: 18, color: colors.mutedForeground }}>
      Verified email plus a trusted device keeps studio work private.
    </Text>
    <View nativeID="clerk-captcha" />
  </KeyboardAwareScrollViewCompat>;
}
