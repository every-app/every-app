import { useEffect, useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { SafeAreaView } from "react-native-safe-area-context";
import { useColorScheme } from "@/components/useColorScheme";
import Colors from "@/constants/Colors";
import { useQueryClient } from "@tanstack/react-query";
import { setGatewayUrl } from "@/src/lib/gateway-store";
import { authClient, initAuthClient } from "@/src/lib/auth-client";

const logo = require("@/assets/images/transparent-logo.png");

function validateGatewayUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;

  const isDevRuntime = typeof __DEV__ !== "undefined" && __DEV__ === true;

  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const parsed = new URL(withProtocol);
    const isHttps = parsed.protocol === "https:";
    const isLocalDev =
      isDevRuntime &&
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "::1");

    if (!isHttps && !isLocalDev) return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

export default function ConnectScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ gateway?: string }>();
  const colorScheme = useColorScheme() ?? "light";
  const colors = Colors[colorScheme];

  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Pre-fill from deep link param
  useEffect(() => {
    if (params.gateway) {
      setUrl(params.gateway);
    }
  }, [params.gateway]);

  const handleConnect = async () => {
    setError(null);

    const validated = validateGatewayUrl(url);
    if (!validated) {
      setError("Enter a valid gateway URL (e.g. my-gateway.example.com)");
      return;
    }

    // Clear previous session data (tokens are gateway-specific)
    await authClient.signOut().catch(() => {});
    queryClient.clear();

    await setGatewayUrl(validated);
    initAuthClient(validated);
    router.replace("/(auth)/sign-in");
  };

  return (
    <SafeAreaView
      style={[styles.safeArea, { backgroundColor: colors.background }]}
    >
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.logoWrap}>
          <Image source={logo} style={styles.logo} />
        </View>

        <Text style={[styles.title, { color: colors.text }]}>
          Connect to your Gateway
        </Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          Enter the URL of your Every App gateway to get started.
        </Text>

        {error ? (
          <Text style={[styles.error, { color: colors.danger }]}>{error}</Text>
        ) : null}

        <View style={styles.formSection}>
          <Text style={[styles.label, { color: colors.textSecondary }]}>
            Gateway URL
          </Text>
          <TextInput
            value={url}
            onChangeText={setUrl}
            style={[
              styles.input,
              {
                borderColor: colors.border,
                backgroundColor: colors.background,
                color: colors.text,
              },
            ]}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="my-gateway.example.com"
            placeholderTextColor={colors.textSecondary}
            returnKeyType="go"
            onSubmitEditing={() => void handleConnect()}
          />

          <Pressable
            onPress={() => void handleConnect()}
            style={({ pressed }) => [pressed && styles.buttonPressed]}
          >
            <LinearGradient
              colors={["#424242", "#353535", "#2a2a2a"]}
              locations={[0, 0.5, 1]}
              style={styles.button}
            >
              <Text style={styles.buttonText}>Connect</Text>
            </LinearGradient>
          </Pressable>
        </View>

        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          You can find your gateway URL in the web dashboard, or scan the QR
          code from the dashboard to connect automatically.
        </Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  container: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  logoWrap: {
    alignItems: "center",
    marginBottom: 20,
  },
  logo: {
    width: 36,
    height: 36,
    resizeMode: "contain",
  },
  title: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: "600",
  },
  subtitle: {
    marginTop: 6,
    fontSize: 15,
    lineHeight: 20,
  },
  formSection: {
    marginTop: 20,
    gap: 8,
  },
  label: {
    marginTop: 4,
    fontSize: 13,
    fontWeight: "500",
  },
  input: {
    height: 44,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 12,
    fontSize: 17,
  },
  button: {
    marginTop: 12,
    height: 48,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonPressed: {
    opacity: 0.86,
  },
  buttonText: {
    fontWeight: "600",
    fontSize: 17,
    color: "#ffffff",
  },
  error: {
    marginTop: 10,
    fontSize: 13,
  },
  hint: {
    marginTop: 20,
    fontSize: 12,
    lineHeight: 18,
  },
});
