import { useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetStudioTrustedDeviceStatusQueryKey,
  useEnrollStudioTrustedDevice,
  useGetStudioTrustedDeviceStatus,
  useRevokeStudioTrustedDevice,
} from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import {
  clearTrustedDeviceToken,
  saveTrustedDeviceToken,
} from "@/lib/trusted-device";

export function TrustedDeviceGate({ children }: { children: ReactNode }) {
  const colors = useColors();
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
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: 12, backgroundColor: colors.background }}>
        <ActivityIndicator color={colors.primary} />
        <Text style={{ color: colors.foreground }}>Checking this device…</Text>
      </View>
    );
  }

  if (status.isError) {
    return (
      <View style={{ flex: 1, justifyContent: "center", padding: 28, gap: 14, backgroundColor: colors.background }}>
        <Text style={{ color: colors.foreground, fontSize: 25, fontFamily: "Fraunces_600SemiBold" }}>Studio access needs attention</Text>
        <Text accessibilityRole="alert" style={{ color: colors.destructive }}>
          {status.error instanceof Error ? status.error.message : "Use a verified email address and try again."}
        </Text>
        <Pressable accessibilityRole="button" testID="button-retry-device-status" onPress={() => void status.refetch()} style={{ backgroundColor: colors.primary, padding: 16, borderRadius: 14 }}>
          <Text style={{ textAlign: "center", color: colors.primaryForeground, fontFamily: "Manrope_700Bold" }}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  if (!status.data?.trusted) {
    return (
      <View style={{ flex: 1, justifyContent: "center", padding: 28, gap: 16, backgroundColor: colors.background }}>
        <Text style={{ color: colors.teal, fontFamily: "Manrope_700Bold" }}>FRAME & FAITH</Text>
        <Text style={{ color: colors.foreground, fontSize: 30, fontFamily: "Fraunces_600SemiBold" }}>Trust this device</Text>
        <Text style={{ color: colors.mutedForeground, lineHeight: 23 }}>
          Use a verified email to add this device. Afterward, any verified email signed in here can access the same shared studio.
        </Text>
        {!!actionError && <Text accessibilityRole="alert" style={{ color: colors.destructive }}>{actionError}</Text>}
        <Pressable
          accessibilityRole="button"
          testID="button-trust-device"
          disabled={enroll.isPending}
          onPress={() => void trustDevice()}
          style={{ backgroundColor: colors.primary, padding: 17, borderRadius: 14, opacity: enroll.isPending ? 0.7 : 1 }}
        >
          <Text style={{ textAlign: "center", color: colors.primaryForeground, fontFamily: "Manrope_700Bold" }}>
            {enroll.isPending ? "Trusting device…" : "Trust this device"}
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ minHeight: 42, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <Text accessibilityLabel="Trusted device status" style={{ color: colors.mutedForeground }}>
          Trusted device · {status.data.deviceLabel ?? "This device"}
        </Text>
        <Pressable accessibilityRole="button" testID="button-forget-device" disabled={revoke.isPending} onPress={() => void forgetDevice()}>
          <Text style={{ color: colors.teal, fontFamily: "Manrope_700Bold" }}>{revoke.isPending ? "Removing…" : "Forget"}</Text>
        </Pressable>
      </View>
      {!!actionError && <Text accessibilityRole="alert" style={{ color: colors.destructive, padding: 12 }}>{actionError}</Text>}
      {children}
    </View>
  );
}
