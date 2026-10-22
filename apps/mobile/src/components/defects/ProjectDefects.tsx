import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { FlatList, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { fetchProtocols, protocolUrl } from "../../lib/api";
import type { Protocol } from "../../lib/api";
import {
  STATUS_COLORS,
  assigneesOf,
  emptyFilter,
  filterDefects,
  formatDay,
  isOverdue,
  pageLabel,
  pagesOf,
  protocolQuery,
} from "../../lib/defects";
import type { DefectFilter, StatusFilter } from "../../lib/defects";
import { pluralPl } from "../../lib/format";
import type { ViewPin } from "../../lib/pins";
import { useConnection } from "../../lib/settings";
import { colors, radius, spacing } from "../../lib/theme";
import { Button } from "../Button";
import { usePageViewer } from "../chat/PageViewer";
import { confirm } from "../pins/pickPhotos";
import { Chip, StatusBadge } from "../pins/DefectPanel";
import { usePins } from "../pins/PinsProvider";
import { ProtocolSheet } from "../protocols/ProtocolSheet";

// The punch list (#74): every defect on the drawings, filtered by status, person and floor. It is built from what the
// phone keeps, so it works without signal; only the PDF protocol needs the server.

const STATUS_CHOICES: { value: StatusFilter; label: string }[] = [
  { value: "active", label: "Do zrobienia" },
  { value: "open", label: "Otwarte" },
  { value: "to_check", label: "Do sprawdzenia" },
  { value: "closed", label: "Zamknięte" },
  { value: "all", label: "Wszystkie" },
];

const ChipRow = ({ children }: { children: ReactNode }) => (
  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} accessibilityRole="radiogroup">
    {children}
  </ScrollView>
);

const DefectRow = ({ pin, onPress }: { pin: ViewPin; onPress: () => void }) => {
  const status = pin.status ?? "open";
  const overdue = isOverdue(pin);
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
      <View style={[styles.stripe, { backgroundColor: STATUS_COLORS[status] }]} />
      <View style={styles.cardBody}>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {pin.room || pin.note || "Usterka"}
          </Text>
          <StatusBadge status={status} />
        </View>
        {pin.room && pin.note ? (
          <Text style={styles.note} numberOfLines={2}>
            {pin.note}
          </Text>
        ) : null}
        <Text style={styles.meta}>
          {[pageLabel(pin), pin.assignee || "bez osoby", pin.dueDate ? `do ${formatDay(pin.dueDate)}` : null].filter(Boolean).join(" · ")}
          {overdue ? <Text style={styles.overdue}> · po terminie</Text> : null}
          {pin.pending ? " · czeka na zasięg" : ""}
        </Text>
      </View>
    </Pressable>
  );
};

export const ProjectDefects = ({ projectId }: { projectId: string }) => {
  const connection = useConnection();
  const { pins, waiting } = usePins();
  const openPage = usePageViewer();
  const [filter, setFilter] = useState<DefectFilter>(emptyFilter);
  const assignees = useMemo(() => assigneesOf(pins), [pins]);
  const pages = useMemo(() => pagesOf(pins), [pins]);
  const defects = useMemo(() => filterDefects(pins, filter), [pins, filter]);
  const overdue = defects.filter((pin) => isOverdue(pin)).length;
  const anyDefects = pins.some((pin) => pin.kind === "defect");
  const change = (fields: Partial<DefectFilter>) => setFilter((current) => ({ ...current, ...fields }));
  // Saved protocols (#82) need the server; without signal the list simply stays empty.
  const [protocols, setProtocols] = useState<Protocol[]>([]);
  const [sheet, setSheet] = useState<{ protocol: Protocol | null } | null>(null);
  useEffect(() => {
    fetchProtocols(connection, projectId).then(setProtocols, () => undefined);
  }, [connection, projectId]);
  const changeProtocol = (protocol: Protocol) => {
    setSheet({ protocol });
    setProtocols((current) => [protocol, ...current.filter((candidate) => candidate.id !== protocol.id)]);
  };

  const openProtocol = async () => {
    if (
      waiting > 0 &&
      !(await confirm(
        "Część zmian jest tylko na telefonie",
        "Protokół powstaje na serwerze, więc nie będzie w nim zmian, które czekają na zasięg. Pobrać mimo to?",
        "Pobierz",
      ))
    ) {
      return;
    }
    await Linking.openURL(protocolUrl(connection, projectId, protocolQuery(filter)));
  };

  if (!anyDefects) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>Nie ma jeszcze usterek</Text>
        <Text style={styles.emptyText}>
          Otwórz rysunek w zakładce „Projekt”, stuknij „+ Usterka” i wskaż miejsce. Usterka trafi tutaj, także bez zasięgu.
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      data={defects}
      keyExtractor={(pin) => pin.id}
      contentContainerStyle={styles.list}
      ListHeaderComponent={
        <View style={styles.filters}>
          <ChipRow>
            {STATUS_CHOICES.map(({ value, label }) => (
              <Chip key={value} label={label} selected={filter.status === value} onPress={() => change({ status: value })} />
            ))}
          </ChipRow>
          {assignees.length ? (
            <ChipRow>
              <Chip label="Wszyscy" selected={filter.assignee === null} onPress={() => change({ assignee: null })} />
              {assignees.map((name) => (
                <Chip key={name} label={name} selected={filter.assignee === name} onPress={() => change({ assignee: name })} />
              ))}
            </ChipRow>
          ) : null}
          {pages.length > 1 ? (
            <ChipRow>
              <Chip label="Wszystkie rysunki" selected={filter.page === null} onPress={() => change({ page: null })} />
              {pages.map((page) => (
                <Chip key={page.key} label={`${page.label} (${page.count})`} selected={filter.page === page.key} onPress={() => change({ page: page.key })} />
              ))}
            </ChipRow>
          ) : null}
          <Text style={styles.summary}>
            {pluralPl(defects.length, "usterka", "usterki", "usterek")}
            {overdue ? <Text style={styles.overdue}>{` · ${overdue} po terminie`}</Text> : null}
            {waiting ? ` · ${pluralPl(waiting, "zmiana czeka", "zmiany czekają", "zmian czeka")} na zasięg` : ""}
          </Text>
          <Button label="Protokół odbioru (PDF)" variant="secondary" onPress={() => void openProtocol()} disabled={defects.length === 0} />
          <Button label="Protokół do podpisu (z kodem QR)" variant="secondary" onPress={() => setSheet({ protocol: null })} disabled={defects.length === 0} />
          {protocols.length ? (
            <View style={styles.protocols}>
              <Text style={styles.summary}>Zapisane protokoły</Text>
              {protocols.map((protocol) => (
                <Pressable key={protocol.id} accessibilityRole="button" onPress={() => setSheet({ protocol })} hitSlop={4}>
                  <Text style={styles.protocolLink}>
                    {protocol.title} · {formatDay(protocol.createdAt.slice(0, 10))} · podpisy: {protocol.signatures.length}/2
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {sheet ? (
            <ProtocolSheet projectId={projectId} filter={filter} protocol={sheet.protocol} onChange={changeProtocol} onClose={() => setSheet(null)} />
          ) : null}
        </View>
      }
      ListEmptyComponent={<Text style={styles.emptyText}>Żadna usterka nie pasuje do wybranych filtrów.</Text>}
      renderItem={({ item }) => (
        <DefectRow
          pin={item}
          onPress={() => openPage({ documentId: item.documentId, pageNo: item.pageNo, title: item.pageTitle ?? null, pinId: item.id })}
        />
      )}
    />
  );
};

const styles = StyleSheet.create({
  list: { padding: spacing.md, gap: spacing.sm },
  filters: { gap: spacing.sm, marginBottom: spacing.sm },
  chips: { gap: spacing.sm },
  summary: { fontSize: 14, color: colors.muted },
  protocols: { gap: spacing.xs },
  protocolLink: { fontSize: 15, color: colors.link },
  overdue: { color: colors.danger, fontWeight: "600" },
  card: { flexDirection: "row", borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, overflow: "hidden" },
  stripe: { width: 5 },
  cardBody: { flex: 1, gap: 4, padding: spacing.md },
  cardTitleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  cardTitle: { flex: 1, fontSize: 16, fontWeight: "600", color: colors.text },
  note: { fontSize: 15, lineHeight: 21, color: colors.text },
  meta: { fontSize: 13, color: colors.muted },
  pressed: { opacity: 0.8 },
  empty: { flex: 1, gap: spacing.sm, padding: spacing.lg, justifyContent: "center" },
  emptyTitle: { fontSize: 18, fontWeight: "600", color: colors.text, textAlign: "center" },
  emptyText: { fontSize: 15, lineHeight: 21, color: colors.muted, textAlign: "center" },
});
