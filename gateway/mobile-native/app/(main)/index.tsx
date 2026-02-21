import { useMemo } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import { useColorScheme } from "@/components/useColorScheme";
import Colors from "@/constants/Colors";
import { authClient } from "@/src/lib/auth-client";
import { useSessionQuery } from "@/src/hooks/useSessionQuery";
import { useUserAppsQuery } from "@/src/hooks/useUserAppsQuery";

export default function HomeScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: session } = useSessionQuery();
  const appsQuery = useUserAppsQuery(Boolean(session));
  const colorScheme = useColorScheme() ?? "light";
  const colors = Colors[colorScheme];

  const apps = useMemo(() => appsQuery.data ?? [], [appsQuery.data]);

  const isLoading = appsQuery.isLoading && !appsQuery.data;

  const handleSignOut = () => {
    Alert.alert("Sign out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: () => {
          void (async () => {
            try {
              await authClient.signOut();
              await queryClient.invalidateQueries({
                queryKey: ["auth", "session"],
              });
              queryClient.removeQueries({ queryKey: ["apps", "user"] });
              router.replace("/(auth)/sign-in");
            } catch {
              Alert.alert("Sign out failed", "Please try again.");
            }
          })();
        },
      },
    ]);
  };

  if (isLoading) {
    return (
      <SafeAreaView
        style={[styles.safeArea, { backgroundColor: colors.background }]}
      >
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={[styles.safeArea, { backgroundColor: colors.background }]}
    >
      <View style={styles.header}>
        <View style={styles.headerTextWrap}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>
            Gateway
          </Text>
          <Text
            style={[styles.headerSubtitle, { color: colors.textSecondary }]}
          >
            Access your apps
          </Text>
        </View>
        <Pressable
          onPress={handleSignOut}
          hitSlop={12}
          style={styles.headerAction}
        >
          <Ionicons
            name="person-outline"
            size={20}
            color={colors.textSecondary}
          />
        </Pressable>
      </View>

      <FlatList
        data={apps}
        keyExtractor={(item) => item.id}
        contentContainerStyle={
          apps.length ? styles.listContent : styles.emptyListContent
        }
        refreshControl={
          <RefreshControl
            refreshing={appsQuery.isRefetching}
            onRefresh={() => void appsQuery.refetch()}
            tintColor={colors.primary}
            colors={[colors.primary]}
            progressBackgroundColor={colors.surface}
          />
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() =>
              router.push({
                pathname: "/apps/[appId]",
                params: { appId: item.appId },
              })
            }
            style={({ pressed }) => [
              styles.appCard,
              {
                backgroundColor: colors.background,
                borderColor: colors.border,
              },
              pressed && styles.rowPressed,
            ]}
          >
            <Text style={[styles.appTitle, { color: colors.text }]}>
              {item.name}
            </Text>
            <Text
              style={[styles.appDescription, { color: colors.textSecondary }]}
            >
              {item.description || item.appId}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={[styles.emptyTitle, { color: colors.text }]}>
              No apps available
            </Text>
            <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>
              Ask an owner to grant app access from the web admin panel.
            </Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 16,
  },
  headerTextWrap: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: "700",
  },
  headerSubtitle: {
    fontSize: 15,
    lineHeight: 20,
    marginTop: 4,
  },
  headerAction: {
    padding: 4,
    marginTop: 4,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 24,
    gap: 10,
  },
  emptyListContent: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  appCard: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  appTitle: {
    fontSize: 17,
    fontWeight: "600",
    lineHeight: 22,
  },
  appDescription: {
    marginTop: 3,
    fontSize: 15,
    lineHeight: 20,
  },
  rowPressed: {
    opacity: 0.82,
  },
  emptyWrap: {
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: "600",
  },
  emptyBody: {
    marginTop: 8,
    textAlign: "center",
    fontSize: 15,
    lineHeight: 22,
  },
});
