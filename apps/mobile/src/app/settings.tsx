import { router } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Button } from "../components/Button";
import { ApiError, fetchProjects } from "../lib/api";
import { hostedServerUrl, normalizeServerUrl, useSettings } from "../lib/settings";
import { colors, radius, spacing } from "../lib/theme";

const SettingsScreen = () => {
  const { connection, saveConnection, clearConnection } = useSettings();
  const hostedUrl = hostedServerUrl();
  const [serverUrl, setServerUrl] = useState(connection?.serverUrl ?? hostedUrl ?? "");
  const [token, setToken] = useState(connection?.token ?? "");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const canSave = serverUrl.trim().length > 0 && token.trim().length > 0;

  // Validate against the real projects endpoint so a wrong URL or code fails here, not later in the chat.
  const save = async () => {
    const next = { serverUrl: normalizeServerUrl(serverUrl), token: token.trim() };
    setChecking(true);
    setError(null);
    try {
      await fetchProjects(next);
      await saveConnection(next);
      if (router.canGoBack()) router.back();
      else router.replace("/");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Nie udało się zapisać ustawień.");
    } finally {
      setChecking(false);
    }
  };

  const disconnect = async () => {
    await clearConnection();
    setServerUrl(hostedUrl ?? "");
    setToken("");
  };

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.intro}>
          {hostedUrl
            ? "Podaj kod dostępu, który dostałeś od administratora."
            : "Podaj adres serwera i kod dostępu, które dostałeś od administratora."}
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
          <Text style={styles.label} nativeID="tokenLabel">
            Kod dostępu
          </Text>
          <TextInput
            accessibilityLabelledBy="tokenLabel"
            value={token}
            onChangeText={setToken}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            textContentType="password"
            style={styles.input}
            onSubmitEditing={canSave ? save : undefined}
          />
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Button label="Połącz i zapisz" onPress={save} loading={checking} disabled={!canSave} />
        {connection ? <Button label="Wyloguj z serwera" variant="secondary" onPress={disconnect} /> : null}
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
  error: { fontSize: 15, color: colors.danger },
});

export default SettingsScreen;
