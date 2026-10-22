import { useState } from "react";
import { Linking, Modal, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ApiError, createProtocol, protocolPdfUrl, signProtocol } from "../../lib/api";
import type { Protocol, SignatureRole } from "../../lib/api";
import { protocolFields } from "../../lib/defects";
import type { DefectFilter } from "../../lib/defects";
import { useConnection } from "../../lib/settings";
import { colors, radius, spacing } from "../../lib/theme";
import { Button } from "../Button";
import { Chip } from "../pins/DefectPanel";
import { SignaturePad } from "./SignaturePad";
import type { Strokes } from "./SignaturePad";

const ROLES: { role: SignatureRole; label: string }[] = [
  { role: "contractor", label: "Wykonawca" },
  { role: "investor", label: "Inwestor" },
];

const signedLabel = (iso: string) =>
  new Date(iso).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

const errorText = (caught: unknown, fallback: string) => (caught instanceof ApiError && caught.status !== 401 ? caught.message : fallback);

// One side's signature: the name and a finger signature, saved with the date by the server.
const SignatureBlock = ({ label, signed, onSign }: { label: string; signed: Protocol["signatures"][number] | undefined; onSign: (name: string, strokes: Strokes) => Promise<void> }) => {
  const [editing, setEditing] = useState(!signed);
  const [name, setName] = useState(signed?.name ?? "");
  const [strokes, setStrokes] = useState<Strokes | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!strokes) return;
    setBusy(true);
    setError(null);
    try {
      await onSign(name.trim(), strokes);
      setEditing(false);
    } catch (caught) {
      setError(errorText(caught, "Nie udało się zapisać podpisu. Sprawdź zasięg."));
    } finally {
      setBusy(false);
    }
  };

  if (signed && !editing) {
    return (
      <View style={styles.card}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.text}>
          Podpisano: {signed.name}, {signedLabel(signed.signedAt)}
        </Text>
        <Pressable accessibilityRole="button" onPress={() => setEditing(true)} hitSlop={8}>
          <Text style={styles.link}>Podpisz ponownie</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={styles.card}>
      <Text style={styles.label}>{label}</Text>
      <TextInput value={name} onChangeText={setName} placeholder="Imię i nazwisko" accessibilityLabel={`${label}: imię i nazwisko`} style={styles.input} />
      <SignaturePad onChange={(signature) => setStrokes(signature?.strokes ?? null)} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button label="Zapisz podpis" onPress={() => void save()} loading={busy} disabled={!name.trim() || !strokes} />
    </View>
  );
};

type Props = { projectId: string; filter: DefectFilter; protocol: Protocol | null; onChange: (protocol: Protocol) => void; onClose: () => void };

// A saved protocol (#82): made from the list as filtered on screen, then signed on the phone by both sides.
export const ProtocolSheet = ({ projectId, filter, protocol, onChange, onClose }: Props) => {
  const connection = useConnection();
  const [scope, setScope] = useState<"stage" | "final">("stage");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      onChange(await createProtocol(connection, projectId, { ...protocolFields(filter), scope, title: title.trim() }));
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 401
          ? "Protokół z kodem QR zapisuje właściciel albo kierownik firmy."
          : errorText(caught, "Nie udało się zapisać protokołu. Sprawdź zasięg."),
      );
    } finally {
      setBusy(false);
    }
  };

  const sign = async (role: SignatureRole, name: string, strokes: Strokes) => {
    if (!protocol) return;
    onChange(await signProtocol(connection, protocol.id, role, { name, signature: { aspect: 3, strokes } }));
  };

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Text style={styles.title}>{protocol?.title ?? "Nowy protokół odbioru"}</Text>
          <Pressable accessibilityRole="button" onPress={onClose} hitSlop={12}>
            <Text style={styles.link}>Zamknij</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {protocol ? (
            <>
              <Text style={styles.muted}>
                {protocol.scopeText}. Usterek: {protocol.defectCount}, otwartych: {protocol.openCount}. Na wydruku jest kod QR do wersji online.
              </Text>
              {ROLES.map(({ role, label }) => (
                <SignatureBlock
                  key={role}
                  label={label}
                  signed={protocol.signatures.find((signature) => signature.role === role)}
                  onSign={(name, strokes) => sign(role, name, strokes)}
                />
              ))}
              <Button label="Otwórz PDF" onPress={() => void Linking.openURL(protocolPdfUrl(connection, protocol.id))} />
              <Button label="Wyślij link do wersji online" variant="secondary" onPress={() => void Share.share({ message: `${protocol.title}: ${protocol.url}` })} />
            </>
          ) : (
            <>
              <Text style={styles.muted}>Protokół zapisze usterki z listy tak, jak są teraz przefiltrowane. Potem obie strony podpiszą go palcem.</Text>
              <View style={styles.chips}>
                <Chip label="Odbiór etapu" selected={scope === "stage"} onPress={() => setScope("stage")} />
                <Chip label="Odbiór końcowy" selected={scope === "final"} onPress={() => setScope("final")} />
              </View>
              <TextInput
                value={title}
                onChangeText={setTitle}
                placeholder={scope === "final" ? "Protokół odbioru końcowego" : "np. Odbiór stanu surowego"}
                accessibilityLabel="Nazwa protokołu"
                style={styles.input}
              />
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <Button label="Zapisz protokół" onPress={() => void create()} loading={busy} />
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { flex: 1, fontSize: 18, fontWeight: "600", color: colors.text },
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xl },
  card: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  label: { fontSize: 15, fontWeight: "600", color: colors.text },
  text: { fontSize: 15, color: colors.text },
  muted: { fontSize: 14, lineHeight: 20, color: colors.muted },
  chips: { flexDirection: "row", gap: spacing.sm },
  input: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    fontSize: 16,
    color: colors.text,
  },
  error: { fontSize: 14, color: colors.danger },
  link: { fontSize: 16, color: colors.link },
});
