import { router, Stack } from 'expo-router';
import { Button, StateScreen } from '@/components/ui';

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Not found', headerShown: false }} />
      <StateScreen
        title="This scene isn’t in the script"
        message="The screen you were looking for doesn’t exist or has moved."
      >
        <Button label="Back to home" onPress={() => router.replace('/')} />
      </StateScreen>
    </>
  );
}
