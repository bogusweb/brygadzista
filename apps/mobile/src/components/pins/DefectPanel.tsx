import { useCallback, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ApiError, transcribe } from "../../lib/api";
import { STATUS_COLORS, STATUS_LABELS, daysFrom, formatDay, isOverdue, parseDay } from "../../lib/defects";
import { discardRecording, readRecording, recordingFormat } from "../../lib/diaryAudio";
import { formatDateTime } from "../../lib/format";
import type { DefectSpec, DefectStatus, PhotoStage, ViewPhoto, ViewPin } from "../../lib/pins";
import { useConnection } from "../../lib/settings";
import { colors, radius, spacing } from "../../lib/theme";
import { Button } from "../Button";
import { useDiaryRecorder } from "../diary/useDiaryRecorder";
import type { FinishedRecording } from "../diary/useDiaryRecorder";
import { PhotoThumb, PickerButtons } from "./PinPanel";
import type { PickedPhoto } from "./PinsProvider";

// Defects and fixes on the drawing (#74): what is wrong, who fixes it by when, photos before and after, and what the
// project says about the spot.

export const StatusBadge = ({ status }: { status: DefectStatus }) => (
  <View style={[styles.badge, { backgroundColor: STATUS_COLORS[status] }]}>
    <Text style={styles.badgeText}>{STATUS_LABELS[status]}</Text>
  </View>
);

export const Chip = ({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) => (
  <Pressable
    accessibilityRole="radio"
    accessibilityState={{ selected }}
    onPress={onPress}
    style={[styles.chip, selected && styles.chipSelected]}
  >
    <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>{label}</Text>
  </Pressable>
);

const SpecBlock = ({ spec, onOpenSource }: { spec: DefectSpec | null | undefined; onOpenSource: (spec: DefectSpec) => void }) => {
  if (!spec) return null;
  if (!spec.found) return <Text style={styles.specMissing}>Nie znalazłem w projekcie, jak to powinno być wykonane.</Text>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Otwiera stronę projektu"
      onPress={() => onOpenSource(spec)}
      style={({ pressed }) => [styles.spec, pressed && styles.pressed]}
    >
      <Text style={styles.specLabel}>W projekcie</Text>
      <Text style={styles.specText}>{spec.statement}</Text>
      <Text style={styles.specQuote}>„{spec.quote}”</Text>
      {spec.source ? <Text style={styles.specSource}>{`Str. ${spec.source.pageNo}${spec.source.title ? ` – ${spec.source.title}` : ""} ›`}</Text> : null}
    </Pressable>
  );
};

const PhotoRow = ({
  projectId,
  title,
  photos,
  onOpenPhoto,
  onAdd,
}: {
  projectId: string;
  title: string;
  photos: ViewPhoto[];
  onOpenPhoto: (photo: ViewPhoto) => void;
  onAdd: (photos: PickedPhoto[]) => void;
}) => (
  <View style={styles.field}>
    <Text style={styles.label}>{title}</Text>
    {photos.length ? (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbs}>
        {photos.map((photo) => (
          <PhotoThumb key={photo.id} projectId={projectId} photo={photo} onPress={() => onOpenPhoto(photo)} />
        ))}
      </ScrollView>
    ) : null}
    <PickerButtons onPicked={onAdd} labels={["Zrób zdjęcie", "Z galerii"]} />
  </View>
);

// The next step is the big button; going back a step is there too, for a fix that did not hold.
const STATUS_ACTIONS: Record<DefectStatus, { label: string; status: DefectStatus }[]> = {
  open: [{ label: "Naprawione, do sprawdzenia", status: "to_check" }],
  to_check: [
    { label: "Zamknij usterkę", status: "closed" },
    { label: "Nadal do poprawy", status: "open" },
  ],
  closed: [{ label: "Otwórz ponownie", status: "open" }],
};

export const DefectDetails = ({
  projectId,
  pin,
  onClose,
  onEdit,
  onDelete,
  onSetStatus,
  onAddPhotos,
  onOpenPhoto,
  onOpenSource,
}: {
  projectId: string;
  pin: ViewPin;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSetStatus: (status: DefectStatus) => void;
  onAddPhotos: (photos: PickedPhoto[], stage: PhotoStage) => void;
  onOpenPhoto: (photo: ViewPhoto) => void;
  onOpenSource: (spec: DefectSpec) => void;
}) => {
  const status = pin.status ?? "open";
  const overdue = isOverdue(pin);
  const [primary, secondary] = STATUS_ACTIONS[status];
  const stagePhotos = (stage: PhotoStage) => pin.photos.filter((photo) => (photo.stage ?? "before") === stage);
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.panel} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <View style={styles.flex}>
          <View style={styles.titleRow}>
            <Text style={styles.title} numberOfLines={1}>
              {pin.room || "Usterka"}
            </Text>
            <StatusBadge status={status} />
          </View>
          <Text style={styles.meta}>
            {[pin.assignee || "Bez osoby", pin.dueDate ? `termin ${formatDay(pin.dueDate)}` : "bez terminu"].join(" · ")}
            {overdue ? <Text style={styles.overdue}> · po terminie</Text> : null}
          </Text>
          <Text style={styles.meta}>{[`Zgłoszono ${formatDateTime(pin.createdAt)}`, pin.authorName].filter(Boolean).join(" · ")}</Text>
        </View>
        <Pressable accessibilityRole="button" onPress={onClose} hitSlop={8} style={styles.textButton}>
          <Text style={styles.textButtonLabel}>Zamknij</Text>
        </Pressable>
      </View>
      {pin.pending ? <Text style={styles.pending}>Zapisane na telefonie, wyślę na serwer, gdy będzie zasięg.</Text> : null}
      {pin.note ? <Text style={styles.note}>{pin.note}</Text> : null}
      <SpecBlock spec={pin.spec} onOpenSource={onOpenSource} />
      {primary ? <Button label={primary.label} onPress={() => onSetStatus(primary.status)} /> : null}
      {secondary ? <Button label={secondary.label} variant="secondary" onPress={() => onSetStatus(secondary.status)} /> : null}
      <PhotoRow projectId={projectId} title="Przed naprawą" photos={stagePhotos("before")} onOpenPhoto={onOpenPhoto} onAdd={(photos) => onAddPhotos(photos, "before")} />
      <PhotoRow projectId={projectId} title="Po naprawie" photos={stagePhotos("after")} onOpenPhoto={onOpenPhoto} onAdd={(photos) => onAddPhotos(photos, "after")} />
      <View style={styles.row}>
        <View style={styles.flex}>
          <Button label="Edytuj" variant="secondary" onPress={onEdit} />
        </View>
        <View style={styles.flex}>
          <Button label="Usuń usterkę" variant="secondary" onPress={onDelete} />
        </View>
      </View>
    </ScrollView>
  );
};

const clock = (millis: number) => {
  const seconds = Math.floor(millis / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

// Say what is wrong instead of typing with gloves on; the text lands in the field to check before saving. Needs signal.
const VoiceButton = ({ projectId, onText }: { projectId: string; onText: (text: string) => void }) => {
  const connection = useConnection();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finished = useCallback(
    async ({ uri }: FinishedRecording) => {
      setBusy(true);
      setError(null);
      try {
        const text = await transcribe(connection, projectId, await readRecording(uri), recordingFormat.mediaType);
        if (text.trim()) onText(text.trim());
        else setError("Nie słychać mowy w nagraniu. Spróbuj jeszcze raz.");
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : "Nie udało się przepisać nagrania.");
      } finally {
        discardRecording(uri);
        setBusy(false);
      }
    },
    [connection, projectId, onText],
  );
  const recorder = useDiaryRecorder((recording) => void finished(recording));
  if (!recordingFormat.supported) return null;
  return (
    <View style={styles.field}>
      <Button
        label={recorder.recording ? `Zakończ nagranie (${clock(recorder.durationMillis)})` : busy ? "Przepisuję…" : "Powiedz, co jest nie tak"}
        variant={recorder.recording ? "primary" : "secondary"}
        loading={busy || recorder.starting}
        onPress={() => void (recorder.recording ? recorder.stop() : recorder.start())}
      />
      {error ?? recorder.error ? <Text style={styles.error}>{error ?? recorder.error}</Text> : null}
    </View>
  );
};

export type DefectDraft = { note: string; room: string; assignee: string; dueDate: string | null; photos: PickedPhoto[] };

const DUE_CHOICES = [
  { label: "Bez terminu", days: null },
  { label: "Jutro", days: 1 },
  { label: "Za 3 dni", days: 3 },
  { label: "Za tydzień", days: 7 },
  { label: "Za 2 tygodnie", days: 14 },
] as const;

export const DefectEditor = ({
  projectId,
  initial,
  isNew,
  assignees,
  onSave,
  onCancel,
}: {
  projectId: string;
  initial: DefectDraft;
  isNew: boolean;
  assignees: string[];
  onSave: (draft: DefectDraft) => void;
  onCancel: () => void;
}) => {
  const [draft, setDraft] = useState(initial);
  const [dueText, setDueText] = useState(initial.dueDate ? formatDay(initial.dueDate) : "");
  const change = (fields: Partial<DefectDraft>) => setDraft((current) => ({ ...current, ...fields }));
  const typedDue = dueText.trim() ? parseDay(dueText) : null;
  const dueInvalid = dueText.trim() !== "" && typedDue === null;
  const empty = !draft.note.trim() && draft.photos.length === 0;
  const appendNote = useCallback((text: string) => setDraft((current) => ({ ...current, note: current.note.trim() ? `${current.note.trim()} ${text}` : text })), []);
  const pickDue = (days: number | null) => {
    const day = days === null ? null : daysFrom(new Date(), days);
    change({ dueDate: day });
    setDueText(day ? formatDay(day) : "");
  };
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.panel} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>{isNew ? "Nowa usterka w tym miejscu" : "Usterka"}</Text>
      {isNew ? (
        <View style={styles.field}>
          {draft.photos.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbs}>
              {draft.photos.map((photo) => (
                <Image key={photo.uri} source={{ uri: photo.uri }} style={styles.thumb} resizeMode="cover" />
              ))}
            </ScrollView>
          ) : null}
          <PickerButtons onPicked={(photos) => change({ photos: [...draft.photos, ...photos] })} />
        </View>
      ) : null}
      <View style={styles.field}>
        <Text style={styles.label}>Co jest nie tak</Text>
        <TextInput
          value={draft.note}
          onChangeText={(note) => change({ note })}
          placeholder="np. parapet osadzony za nisko"
          placeholderTextColor={colors.muted}
          style={[styles.input, styles.multiline]}
          multiline
          maxLength={4000}
        />
      </View>
      <VoiceButton projectId={projectId} onText={appendNote} />
      <View style={styles.field}>
        <Text style={styles.label}>Pomieszczenie</Text>
        <TextInput
          value={draft.room}
          onChangeText={(room) => change({ room })}
          placeholder="np. Salon 0.03"
          placeholderTextColor={colors.muted}
          style={styles.input}
          maxLength={200}
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Kto poprawia</Text>
        <TextInput
          value={draft.assignee}
          onChangeText={(assignee) => change({ assignee })}
          placeholder="np. Kowalski (stolarka)"
          placeholderTextColor={colors.muted}
          style={styles.input}
          maxLength={200}
        />
        {assignees.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} accessibilityRole="radiogroup">
            {assignees.map((name) => (
              <Chip key={name} label={name} selected={draft.assignee.trim() === name} onPress={() => change({ assignee: name })} />
            ))}
          </ScrollView>
        ) : null}
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Termin</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} accessibilityRole="radiogroup">
          {DUE_CHOICES.map(({ label, days }) => (
            <Chip
              key={label}
              label={label}
              selected={days === null ? draft.dueDate === null : draft.dueDate === daysFrom(new Date(), days)}
              onPress={() => pickDue(days)}
            />
          ))}
        </ScrollView>
        <TextInput
          value={dueText}
          onChangeText={(text) => {
            setDueText(text);
            const day = text.trim() ? parseDay(text) : null;
            if (day || !text.trim()) change({ dueDate: day });
          }}
          placeholder="albo wpisz dzień, np. 30.10"
          placeholderTextColor={colors.muted}
          style={styles.input}
          keyboardType="numbers-and-punctuation"
          maxLength={10}
        />
        {dueInvalid ? <Text style={styles.error}>Wpisz dzień jako 30.10 albo 30.10.2026.</Text> : null}
      </View>
      <View style={styles.row}>
        <View style={styles.flex}>
          <Button label="Anuluj" variant="secondary" onPress={onCancel} />
        </View>
        <View style={styles.flex}>
          <Button label="Zapisz usterkę" onPress={() => onSave({ ...draft, dueDate: dueText.trim() ? typedDue : null })} disabled={empty || dueInvalid} />
        </View>
      </View>
    </ScrollView>
  );
};

const THUMB = 88;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // A defect has more to show than a photo pin; the panel scrolls and leaves the drawing visible above it.
  scroll: { maxHeight: "62%", flexGrow: 0, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, backgroundColor: colors.surface },
  panel: { gap: spacing.md, padding: spacing.md },
  header: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
  title: { fontSize: 18, fontWeight: "600", color: colors.text, flexShrink: 1 },
  meta: { fontSize: 14, color: colors.muted, marginTop: 2 },
  overdue: { color: colors.danger, fontWeight: "600" },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  badgeText: { fontSize: 12, fontWeight: "700", color: "#FFFFFF" },
  pending: { fontSize: 14, lineHeight: 20, color: colors.link },
  note: { fontSize: 16, lineHeight: 22, color: colors.text },
  spec: { gap: 4, padding: spacing.sm, borderRadius: radius.md, borderLeftWidth: 3, borderLeftColor: "#1F4E79", backgroundColor: "#EEF3F8" },
  specLabel: { fontSize: 12, fontWeight: "700", color: "#1F4E79", textTransform: "uppercase" },
  specText: { fontSize: 15, lineHeight: 21, color: colors.text, fontWeight: "600" },
  specQuote: { fontSize: 14, lineHeight: 20, color: colors.muted },
  specSource: { fontSize: 14, fontWeight: "600", color: "#1F4E79" },
  specMissing: { fontSize: 14, color: colors.muted },
  pressed: { opacity: 0.8 },
  row: { flexDirection: "row", gap: spacing.sm },
  thumbs: { gap: spacing.sm },
  thumb: { width: THUMB, height: THUMB, borderRadius: radius.md, backgroundColor: colors.border },
  field: { gap: spacing.xs },
  label: { fontSize: 14, fontWeight: "600", color: colors.text },
  input: {
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.background,
  },
  multiline: { minHeight: 88, textAlignVertical: "top" },
  chips: { gap: spacing.sm, paddingVertical: 2 },
  chip: { minHeight: 40, paddingHorizontal: spacing.md, borderRadius: 20, borderWidth: 1, borderColor: colors.border, justifyContent: "center", backgroundColor: colors.surface },
  chipSelected: { backgroundColor: colors.text, borderColor: colors.text },
  chipLabel: { fontSize: 15, color: colors.text },
  chipLabelSelected: { color: "#FFFFFF", fontWeight: "600" },
  error: { fontSize: 14, color: colors.danger },
  textButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.sm },
  textButtonLabel: { fontSize: 16, fontWeight: "600", color: colors.link },
});

