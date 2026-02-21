import {
  Alert,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  Linking,
} from "react-native";
import { Link } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { SafeAreaView } from "react-native-safe-area-context";
import { useColorScheme } from "@/components/useColorScheme";
import Colors from "@/constants/Colors";
import { GATEWAY_API_URL } from "@/src/config";

const logo = require("@/assets/images/transparent-logo.png");

export default function SignUpScreen() {
  const colorScheme = useColorScheme() ?? "light";
  const colors = Colors[colorScheme];
  const signUpUrl = `${GATEWAY_API_URL.replace(/\/$/, "")}/sign-up`;

  const openSignUpInBrowser = async () => {
    try {
      const supported = await Linking.canOpenURL(signUpUrl);
      if (!supported) {
        Alert.alert(
          "Cannot open browser",
          `Open this URL manually:\n${signUpUrl}`,
        );
        return;
      }

      await Linking.openURL(signUpUrl);
    } catch {
      Alert.alert(
        "Cannot open browser",
        `Open this URL manually:\n${signUpUrl}`,
      );
    }
  };

  return (
    <SafeAreaView
      style={[styles.safeArea, { backgroundColor: colors.background }]}
    >
      <View style={styles.container}>
        <View style={styles.logoWrap}>
          <Image source={logo} style={styles.logo} />
        </View>

        <Text style={[styles.title, { color: colors.text }]}>
          Sign up in your browser
        </Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          Account creation is only available from the web app. Open the sign-up
          page in your browser, then return here to sign in.
        </Text>

        <Pressable
          onPress={() => void openSignUpInBrowser()}
          style={({ pressed }) => [pressed && styles.buttonPressed]}
        >
          <LinearGradient
            colors={["#424242", "#353535", "#2a2a2a"]}
            locations={[0, 0.5, 1]}
            style={styles.button}
          >
            <Text style={styles.buttonText}>Open Sign Up in Browser</Text>
          </LinearGradient>
        </Pressable>

        <Text style={[styles.linkHint, { color: colors.textSecondary }]}>
          {signUpUrl}
        </Text>

        <View style={styles.footerLinks}>
          <Link
            href="/(auth)/sign-in"
            style={[styles.inlineLink, { color: colors.textSecondary }]}
          >
            Already have an account?{" "}
            <Text style={[styles.linkStrong, { color: colors.text }]}>
              Sign in
            </Text>
          </Link>
        </View>
      </View>
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
    marginBottom: 20,
  },
  button: {
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
  linkHint: {
    marginTop: 10,
    fontSize: 12,
    lineHeight: 18,
  },
  footerLinks: {
    marginTop: 16,
  },
  inlineLink: {
    fontSize: 13,
    lineHeight: 20,
  },
  linkStrong: {
    fontWeight: "600",
  },
});
