import { router } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Button } from "../components/Button";
import { confirm } from "../components/pins/pickPhotos";
import { TENANT_ROLE_LABELS, login, logout, switchTenant } from "../lib/account";
import type { Tenant } from "../lib/account";
import { ApiError } from "../lib/api";
import { hostedServerUrl, normalizeServerUrl, useSettings } from "../lib/settings";
import { colors, radius, spacing } from "../lib/theme";

const errorText = (caught: unknown, fallback: string) => (caught instanceof ApiError ? caught.message : fallback);

const LoginForm = () => {
  const { serverUrl: lastServerUrl, signIn } = useSettings();
  const hostedUrl = hostedServerUrl();
  const [serverUrl, setServerUrl] = useState(lastServerUrl ?? hostedUrl ?? "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const canSave = serverUrl.trim().length > 0 && email.trim().length > 0 && password.length > 0;

  const submit = async () => {
    const url = normalizeServerUrl(serverUrl);
    setChecking(true);
    setError(null);
    try {
      await signIn(url, await login(url, email, password));
      if (router.canGoBack()) router.back();
      else router.replace("/");
    } catch (caught) {
      setError(errorText(caught, "Nie udało się zalogować."));
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <Text style={styles.intro}>
        Zaloguj się kontem, które założył Ci właściciel firmy. Aplikacja pokaże budowy Twojej firmy.
      </Text>

      {hostedUrl ? null : (
        <View style={styles.field}>
          <Text style={styles.label} nativeID="serverUrlLabel">
            Adres serwera
          </Text>
          <TextInput
            accessibilityLabelledBy="serverUrlLabel"
            value={serverUrl}
            onChangeText={setServerUrl}
            placeholder="np. brygadzista.example.pl"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            textContentType="URL"
            style={styles.input}
          />
        </View>
      )}

      <View style={styles.field}>
        <Text style={styles.label} nativeID="emailLabel">
          E-mail
        </Text>
        <TextInput
          accessibilityLabelledBy="emailLabel"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="username"
          autoComplete="email"
          style={styles.input}
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.label} nativeID="passwordLabel">
          Hasło
        </Text>
        <TextInput
          accessibilityLabelledBy="passwordLabel"
          value={password}
          onChangeText={setPassword}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          textContentType="password"
          autoComplete="current-password"
          style={styles.input}
          onSubmitEditing={canSave ? submit : undefined}
        />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Button label="Zaloguj" onPress={submit} loading={checking} disabled={!canSave} />
    </>
  );
};

const TenantRow = ({ tenant, active, onPress }: { tenant: Tenant; active: boolean; onPress: () => void }) => (
  <Pressable
    accessibilityRole="radio"
    accessibilityState={{ selected: active }}
    onPress={onPress}
    disabled={active}
    style={({ pressed }) => [styles.tenant, active && styles.tenantActive, pressed && styles.pressed]}
  >
    <Text style={styles.tenantName}>{tenant.name}</Text>
    <Text style={styles.meta}>
      {TENANT_ROLE_LABELS[tenant.role]}
      {active ? " · aktywna" : ""}
    </Text>
  </Pressable>
);

const AccountView = () => {
  const { connection, account, updateAccount, signOut } = useSettings();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!connection || !account) return null;

  // Each firm has its own saved projects and queues on the phone, so nothing waiting for signal is lost by switching.
  const pickTenant = async (tenant: Tenant) => {
    setBusy(true);
    setError(null);
    try {
      await updateAccount(await switchTenant(connection, tenant.id));
      if (router.canGoBack()) router.back();
      else router.replace("/");
    } catch (caught) {
      setError(errorText(caught, "Nie udało się zmienić firmy."));
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    const sure = await confirm(
      "Wylogować?",
      "Z telefonu znikną zapisane rysunki i listy, a także zmiany, które jeszcze czekają na zasięg.",
      "Wyloguj",
    );
    if (!sure) return;
    // The session is ended on the server when it can be; without signal it simply expires.
    await logout(connection).catch(() => undefined);
    await signOut();
  };

  return (
    <>
      <View style={styles.card}>
        <Text style={styles.tenantName}>{account.user.name || account.user.email}</Text>
        <Text style={styles.meta}>{account.user.email}</Text>
        <Text style={styles.meta}>{connection.serverUrl}</Text>
      </View>

      <Text style={styles.label}>{account.tenants.length > 1 ? "Firma" : "Twoja firma"}</Text>
      <View style={styles.tenants} accessibilityRole="radiogroup">
        {account.tenants.map((tenant) => (
          <TenantRow key={tenant.id} tenant={tenant} active={tenant.id === account.tenant?.id} onPress={() => void pickTenant(tenant)} />
        ))}
      </View>
      {account.tenants.length > 1 ? <Text style={styles.meta}>Każda firma ma na telefonie osobne budowy i zapisane dane.</Text> : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button label="Wyloguj" variant="secondary" onPress={() => void leave()} loading={busy} />
    </>
  );
};

const SettingsScreen = () => {
  const { connection } = useSettings();
  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        {connection ? <AccountView /> : <LoginForm />}
      </ScrollView>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: spacing.md, gap: spacing.md },
  intro: { fontSize: 16, lineHeight: 22, color: colors.muted },
  field: { gap: spacing.xs },
  label: { fontSize: 15, fontWeight: "600", color: colors.text },
  input: {
    minHeight: 52,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    fontSize: 17,
    color: colors.text,
  },
  card: { gap: 2, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  tenants: { gap: spacing.sm },
  tenant: { gap: 2, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  tenantActive: { borderColor: colors.accent, borderWidth: 2 },
  tenantName: { fontSize: 17, fontWeight: "600", color: colors.text },
  meta: { fontSize: 14, color: colors.muted },
  error: { fontSize: 15, color: colors.danger },
  pressed: { opacity: 0.8 },
});

export default SettingsScreen;
