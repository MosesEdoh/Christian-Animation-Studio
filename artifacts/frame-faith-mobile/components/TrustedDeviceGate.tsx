import { createContext, useContext, useState, type ReactNode } from "react";
import { Platform, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/expo";
import {
  getGetStudioTrustedDeviceStatusQueryKey,
  useEnrollStudioTrustedDevice,
  useGetStudioTrustedDeviceStatus,
  useRevokeStudioTrustedDevice,
} from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import { Button, Notice, StateScreen, fonts } from "@/components/ui";
import { confirmAction } from "@/lib/confirm";
import {
  clearTrustedDeviceToken,
  saveTrustedDeviceToken,
} from "@/lib/trusted-device";

type TrustedDevice = {
  deviceLabel: string;
  forgetting: boolean;
  forgetError: string;
  forget: () => Promise<void>;
};

const TrustedDeviceContext = createContext<TrustedDevice | null>(null);

/** Trusted-device details for the current screen, or null outside the gate. */
export function useTrustedDevice() {
  return useContext(TrustedDeviceContext);
}

const benefits = [
  "Scripts, references and videos open only on devices you trust.",
  "You only need to do this once on this device.",
  "You can forget this device at any time from Home.",
];

export function TrustedDeviceGate({ children }: { children: ReactNode }) {
  const colors = useColors();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const status = useGetStudioTrustedDeviceStatus();
  const enroll = useEnrollStudioTrustedDevice();
  const revoke = useRevokeStudioTrustedDevice();
  const [actionError, setActionError] = useState("");

  async function refreshStatus() {
    await queryClient.invalidateQueries({ queryKey: getGetStudioTrustedDeviceStatusQueryKey() });
  }

  async function trustDevice() {
    setActionError("");
    try {
      const platform = Platform.OS === "web" ? "web" : "mobile";
      const result = await enroll.mutateAsync({
        data: {
          platform,
          label: Platform.OS === "web" ? "This browser" : "This phone or tablet",
        },
      });
      if (platform === "mobile") {
        if (!result.deviceToken) throw new Error("The secure device token was not returned. Please retry.");
        await saveTrustedDeviceToken(result.deviceToken);
      }
      await refreshStatus();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not trust this device. Please retry.");
    }
  }

  async function forgetDevice() {
    const confirmed = await confirmAction({
      title: "Forget this device?",
      message: "Private scripts and videos will stay locked here until you trust this device again.",
      confirmLabel: "Forget device",
      destructive: true,
    });
    if (!confirmed) return;
    setActionError("");
    try {
      await revoke.mutateAsync();
      try {
        if (Platform.OS !== "web") await clearTrustedDeviceToken();
      } finally {
        await refreshStatus();
      }
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not remove this device. Please retry.");
    }
  }

  if (status.isPending) {
    return <StateScreen loading message="Checking this device…" />;
  }

  if (status.isError) {
    return (
      <StateScreen
        title="Studio access needs attention"
        message="We couldn’t confirm this device. Check your connection, make sure your email is verified, and try again."
      >
        <Notice tone="error">
          {status.error instanceof Error ? status.error.message : "Use a verified email address and try again."}
        </Notice>
        <Button testID="button-retry-device-status" label="Try again" loading={status.isFetching} onPress={() => void status.refetch()} />
        <Button variant="ghost" label="Sign out" onPress={() => void auth.signOut()} />
      </StateScreen>
    );
  }

  if (!status.data?.trusted) {
    return (
      <StateScreen
        title="Trust this device"
        message="Add this device once to unlock the shared studio. Any verified email signed in here can then open it."
      >
        <View style={{ gap: 10 }}>
          {benefits.map((benefit) => (
            <View key={benefit} style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
              <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: colors.teal, alignItems: "center", justifyContent: "center", marginTop: 1 }}>
                <Text style={{ color: colors.card, fontFamily: fonts.bold, fontSize: 11 }}>✓</Text>
              </View>
              <Text style={{ flex: 1, color: colors.foreground, fontFamily: fonts.regular, fontSize: 14, lineHeight: 21 }}>{benefit}</Text>
            </View>
          ))}
        </View>
        {!!actionError && <Notice tone="error">{actionError}</Notice>}
        <Button
          testID="button-trust-device"
          label={enroll.isPending ? "Trusting device…" : "Trust this device"}
          loading={enroll.isPending}
          onPress={() => void trustDevice()}
        />
        <Button variant="ghost" label="Use a different account" onPress={() => void auth.signOut()} />
      </StateScreen>
    );
  }

  const device: TrustedDevice = {
    deviceLabel: status.data.deviceLabel ?? "This device",
    forgetting: revoke.isPending,
    forgetError: actionError,
    forget: forgetDevice,
  };

  return (
    <TrustedDeviceContext.Provider value={device}>
      <View style={{ flex: 1, backgroundColor: colors.background }}>{children}</View>
    </TrustedDeviceContext.Provider>
  );
}
