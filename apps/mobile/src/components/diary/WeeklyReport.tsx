import { useState } from "react";
import { Linking, Modal, Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ApiError, createWeeklyReport, shareWeeklyReport, weeklyReportPdfUrl } from "../../lib/api";
import type { WeeklyReport as Report } from "../../lib/api";
import { formatDay, localDate, shiftDate } from "../../lib/diary";
import { useConnection } from "../../lib/settings";
import { colors, radius, spacing } from "../../lib/theme";
import { Button } from "../Button";

// Monday of the phone's week.
const mondayOf = (isoDate: string) => {
  const [year, month, day] = isoDate.split("-").map(Number) as [number, number, number];
  const weekday = new Date(year, month - 1, day).getDay();
  return shiftDate(isoDate, -((weekday + 6) % 7));
};

const shortDay = (isoDate: string) => formatDay(isoDate).split(" ")[0]!;

// The weekly report for the investor (#84): pick a week, let the server write it, then send the PDF or a read-only link.
export const WeeklyReport = ({ projectId, onClose }: { projectId: string; onClose: () => void }) => {
  const connection = useConnection();
  const thisWeek = mondayOf(localDate());
  const [week, setWeek] = useState(thisWeek);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState<"make" | "share" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const changeWeek = (days: number) => {
    setWeek((current) => shiftDate(current, days));
    setReport(null);
    setError(null);
  };

  const make = async () => {
    setBusy("make");
    setError(null);
    try {
      setReport(await createWeeklyReport(connection, projectId, week));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Nie udało się przygotować raportu.");
    } finally {
      setBusy(null);
    }
  };

  const share = async () => {
    if (!report) return;
    setBusy("share");
    setError(null);
    try {
      const { url } = await shareWeeklyReport(connection, report.id);
      await Share.share({ message: `Raport tygodniowy z budowy (${shortDay(report.periodStart)}–${shortDay(report.periodEnd)}): ${url}` });
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 401
          ? "Link dla inwestora może utworzyć właściciel albo kierownik firmy. Możesz wysłać PDF."
          : "Nie udało się utworzyć linku. Sprawdź zasięg.",
      );
    } finally {
      setBusy(null);
    }
  };

  const facts = report?.snapshot;
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Text style={styles.title}>Raport dla inwestora</Text>
          <Pressable accessibilityRole="button" onPress={onClose} hitSlop={12}>
            <Text style={styles.link}>Zamknij</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.weekRow}>
            <Pressable accessibilityRole="button" accessibilityLabel="Poprzedni tydzień" onPress={() => changeWeek(-7)} hitSlop={12}>
              <Text style={styles.arrow}>‹</Text>
            </Pressable>
            <Text style={styles.week}>
              {shortDay(week)} – {shortDay(shiftDate(week, 6))}
              {week === thisWeek ? " (ten tydzień)" : ""}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Następny tydzień"
              onPress={() => changeWeek(7)}
              disabled={week >= thisWeek}
              hitSlop={12}
            >
              <Text style={[styles.arrow, week >= thisWeek && styles.disabled]}>›</Text>
            </Pressable>
          </View>
          <Text style={styles.hint}>
            Raport zbiera prace z dziennika, zdjęcia z rzutu, usterki i zamknięte checklisty z tego tygodnia. Podsumowanie pisze asystent.
          </Text>
          <Button label={report ? "Przygotuj od nowa" : "Przygotuj raport"} variant={report ? "secondary" : "primary"} onPress={() => void make()} loading={busy === "make"} disabled={busy !== null} />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {report && facts ? (
            <View style={styles.card}>
              {report.summary.paragraphs.map((paragraph, index) => (
                <Text key={index} style={styles.paragraph}>
                  {paragraph.text}
                  {paragraph.sources.length ? <Text style={styles.sources}> [{paragraph.sources.join(", ")}]</Text> : null}
                </Text>
              ))}
              <Text style={styles.hint}>
                {[
                  `dni w dzienniku: ${facts.days.length}`,
                  `zdjęcia: ${facts.photos.length}`,
                  `usterki: +${facts.defects.opened.length} / zamknięte ${facts.defects.closed.length}`,
                  `checklisty: ${facts.checklists.length}`,
                ].join(" · ")}
              </Text>
            </View>
          ) : null}
          {report ? (
            <>
              <Button label="Wyślij link inwestorowi" onPress={() => void share()} loading={busy === "share"} disabled={busy !== null} />
              <Button label="Otwórz PDF" variant="secondary" onPress={() => void Linking.openURL(weeklyReportPdfUrl(connection, report.id))} />
            </>
          ) : null}
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
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { fontSize: 18, fontWeight: "600", color: colors.text },
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xl },
  weekRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  week: { fontSize: 16, fontWeight: "600", color: colors.text },
  arrow: { fontSize: 28, lineHeight: 32, paddingHorizontal: spacing.md, color: colors.link },
  disabled: { opacity: 0.3 },
  hint: { fontSize: 14, lineHeight: 20, color: colors.muted },
  card: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  paragraph: { fontSize: 15, lineHeight: 22, color: colors.text },
  sources: { fontSize: 13, color: colors.link },
  error: { fontSize: 14, color: colors.danger },
  link: { fontSize: 16, color: colors.link },
});
