import { useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Link, useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useColorScheme } from "@/components/useColorScheme";
import Colors from "@/constants/Colors";
import { fetchSignInMethods } from "@/src/api/gateway";
import {
  accessSignInErrorMessage,
  signInWithAccess,
} from "@/src/lib/access-sign-in";
import { authClient, getGatewayUrl } from "@/src/lib/auth-client";
import { syncSessionCookieToWebView } from "@/src/lib/webview-cookies";

const logo = require("@/assets/images/transparent-logo.png");

export default function SignInScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const colorScheme = useColorScheme() ?? "light";
  const colors = Colors[colorScheme];

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: methods } = useQuery({
    queryKey: ["auth", "sign-in-methods", getGatewayUrl()],
    queryFn: fetchSignInMethods,
  });
  const accessProvider = methods?.providers[0];
  const passwordSignIn = methods?.emailPassword ?? true;

  const finishSignIn = async () => {
    const didSyncCookie = await syncSessionCookieToWebView();
    if (!didSyncCookie) {
      setError("Sign in succeeded, but the session cookie was unavailable.");
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["auth", "session"] });
    router.replace("/(main)");
  };

  // Cloudflare Access sign-in runs in the system browser, never in a
  // WebView: the identity provider's page gets the browser's own protections
  // and saved logins. The gateway hands the session back to the app with a
  // one-time code (src/lib/access-sign-in.ts).
  const handleAccessSignIn = async () => {
    if (!accessProvider) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const result = await signInWithAccess(accessProvider.id, {
        redirectURL: Linking.createURL("/sign-in"),
        openAuthSession: (url, redirectURL) =>
          WebBrowser.openAuthSessionAsync(url, redirectURL),
      });
      if (result.status === "canceled") return;
      if (result.status === "refused") {
        setError(accessSignInErrorMessage(result.code, accessProvider.label));
        return;
      }
      const session = await authClient.getSession();
      if (!session.data) {
        setError(accessSignInErrorMessage("", accessProvider.label));
        return;
      }
      await finishSignIn();
    } catch {
      setError("Unable to sign in right now.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSignIn = async () => {
    setError(null);

    if (!email.trim() || !password) {
      setError("Email and password are required.");
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await authClient.signIn.email({
        email: email.trim(),
        password,
      });

      if (result.error) {
        setError(result.error.message ?? "Sign in failed.");
        return;
      }

      await finishSignIn();
    } catch {
      setError("Unable to sign in right now.");
    } finally {
      setIsSubmitting(false);
    }
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

        <Text style={[styles.title, { color: colors.text }]}>Sign In</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          {passwordSignIn
            ? "Enter your email and password to sign in"
            : `Sign in with ${accessProvider?.label ?? "Cloudflare Access"}`}
        </Text>

        <Pressable
          onPress={() => router.push("/connect")}
          style={[styles.gatewayBadge, { backgroundColor: colors.surface }]}
        >
          <Text
            style={[styles.gatewayBadgeText, { color: colors.textSecondary }]}
            numberOfLines={1}
          >
            {(() => {
              try {
                return new URL(getGatewayUrl()).host;
              } catch {
                return getGatewayUrl();
              }
            })()}
          </Text>
          <Text style={[styles.gatewayBadgeAction, { color: colors.link }]}>
            Change
          </Text>
        </Pressable>

        {error ? (
          <Text style={[styles.error, { color: colors.danger }]}>{error}</Text>
        ) : null}

        {accessProvider ? (
          <Pressable
            onPress={() => void handleAccessSignIn()}
            disabled={isSubmitting}
            style={({ pressed }) => [
              styles.accessButton,
              { borderColor: colors.border },
              (pressed || isSubmitting) && styles.buttonPressed,
            ]}
          >
            <Text style={[styles.accessButtonText, { color: colors.text }]}>
              Continue with {accessProvider.label}
            </Text>
          </Pressable>
        ) : null}

        {passwordSignIn ? (
          <View style={styles.formSection}>
            <Text style={[styles.label, { color: colors.textSecondary }]}>
              Email
            </Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              style={[
                styles.input,
                {
                  borderColor: colors.border,
                  backgroundColor: colors.background,
                  color: colors.text,
                },
              ]}
              autoCapitalize="none"
              keyboardType="email-address"
              placeholder="you@example.com"
              placeholderTextColor={colors.textSecondary}
              editable={!isSubmitting}
            />

            <Text style={[styles.label, { color: colors.textSecondary }]}>
              Password
            </Text>
            <TextInput
              value={password}
              onChangeText={setPassword}
              style={[
                styles.input,
                {
                  borderColor: colors.border,
                  backgroundColor: colors.background,
                  color: colors.text,
                },
              ]}
              secureTextEntry
              placeholder="Enter your password"
              placeholderTextColor={colors.textSecondary}
              editable={!isSubmitting}
            />

            <Pressable
              onPress={() => void handleSignIn()}
              disabled={isSubmitting}
              style={({ pressed }) => [
                (pressed || isSubmitting) && styles.buttonPressed,
              ]}
            >
              <LinearGradient
                colors={["#424242", "#353535", "#2a2a2a"]}
                locations={[0, 0.5, 1]}
                style={styles.button}
              >
                {isSubmitting ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <Text style={styles.buttonText}>Sign In</Text>
                )}
              </LinearGradient>
            </Pressable>
          </View>
        ) : null}

        <View style={styles.footerLinks}>
          <Link
            href="/(auth)/sign-up"
            style={[styles.inlineLink, { color: colors.textSecondary }]}
          >
            Don't have an account?{" "}
            <Text style={[styles.linkStrong, { color: colors.text }]}>
              Sign up in browser
            </Text>
          </Link>
        </View>
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
  accessButton: {
    marginTop: 20,
    height: 48,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  accessButtonText: {
    fontWeight: "600",
    fontSize: 17,
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
  footerLinks: {
    marginTop: 16,
    gap: 6,
  },
  inlineLink: {
    fontSize: 13,
    lineHeight: 20,
  },
  linkStrong: {
    fontWeight: "600",
  },
  gatewayBadge: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    gap: 8,
  },
  gatewayBadgeText: {
    fontSize: 13,
    flexShrink: 1,
  },
  gatewayBadgeAction: {
    fontSize: 13,
    fontWeight: "600",
  },
});
