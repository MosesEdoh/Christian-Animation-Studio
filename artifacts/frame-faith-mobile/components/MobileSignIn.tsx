import { createElement, useState, type FormEvent, type ReactNode } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';
import { useSignIn, useSignUp, useSSO } from '@clerk/expo';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';

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
  const pending = busy || signInStatus === 'fetching' || signUpStatus === 'fetching';
  const inputStyle = { padding: 16, borderWidth: 1, borderColor: colors.border, borderRadius: 12, color: colors.foreground, backgroundColor: colors.card };
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
  return <KeyboardAwareScrollViewCompat bottomOffset={24} keyboardShouldPersistTaps="handled"
    style={{ flex: 1, backgroundColor: colors.background }}
    contentContainerStyle={{ padding: 28, paddingTop: (Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top) + 35, paddingBottom: Math.max(insets.bottom, 34), gap: 18 }}>
    <Text style={{ color: colors.teal, fontFamily: 'Manrope_700Bold' }}>FRAME & FAITH</Text>
    <Text style={{ fontSize: 30, fontFamily: 'Fraunces_600SemiBold', color: colors.foreground }}>{verification ? 'Verify your email' : register ? 'Create an account' : 'Your private studio'}</Text>
    <Text style={{ color: colors.mutedForeground }}>Use any verified email, then trust each device before opening the shared studio.</Text>
    <AuthForm onSubmit={() => void submit()}>
      {verification ? <TextInput testID="mobile-code" accessibilityLabel="Verification code" style={inputStyle} value={code} onChangeText={setCode} keyboardType="number-pad" returnKeyType="done" onSubmitEditing={() => void submit()} placeholder="Verification code" placeholderTextColor={colors.mutedForeground} /> : <>
        <TextInput testID="mobile-email" accessibilityLabel="Email" style={inputStyle} value={emailAddress} onChangeText={setEmailAddress} autoCapitalize="none" autoComplete="email" keyboardType="email-address" returnKeyType="next" placeholder="Email" placeholderTextColor={colors.mutedForeground} />
        <TextInput testID="mobile-password" accessibilityLabel="Password" style={inputStyle} value={password} onChangeText={setPassword} secureTextEntry returnKeyType="done" onSubmitEditing={() => void submit()} placeholder="Password" placeholderTextColor={colors.mutedForeground} />
      </>}
      {!!error && <Text accessibilityRole="alert" style={{ color: colors.destructive }}>{error}</Text>}
      {Object.values(errors.fields).map((field, index) => field?.message ? <Text key={index} style={{ color: colors.destructive }}>{field.message}</Text> : null)}
      <Pressable testID="mobile-login" disabled={pending} onPress={submit} style={{ backgroundColor: colors.primary, borderRadius: 14, padding: 17 }}>
        <Text style={{ textAlign: 'center', color: colors.primaryForeground }}>{pending ? 'Please wait…' : verification ? 'Verify' : register ? 'Create account' : 'Sign in'}</Text>
      </Pressable>
    </AuthForm>
    {!verification && <Pressable testID="mobile-google" disabled={pending} onPress={google} style={{ backgroundColor: colors.secondary, padding: 17, borderRadius: 14 }}><Text style={{ color: colors.foreground, textAlign: 'center' }}>Continue with Google</Text></Pressable>}
    <Pressable disabled={pending} onPress={() => { setRegister(!register); setVerification(false); setCode(''); setError(''); void signIn.reset(); void signUp.reset(); }}><Text style={{ color: colors.teal }}>{verification ? 'Start over' : register ? 'Already have an account? Sign in' : 'Create an account'}</Text></Pressable>
    <View nativeID="clerk-captcha" />
  </KeyboardAwareScrollViewCompat>;
}
