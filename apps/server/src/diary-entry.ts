import { z } from "zod";

// One day on site, sorted out of a voice note (#69). Every list is plain lines, so the app can edit it as text.
export const diaryEntrySchema = z.object({
  summary: z.string().max(500),
  work: z.array(z.string().max(500)).max(50),
  people: z.array(z.string().max(300)).max(30),
  deliveries: z.array(z.string().max(300)).max(30),
  weather: z.string().max(300).nullable(),
  problems: z.array(z.string().max(500)).max(30),
  references: z
    .array(z.object({ documentId: z.string(), pageNo: z.number().int().min(1), title: z.string().nullable(), note: z.string().max(300) }))
    .max(10),
});

export type DiaryEntry = z.infer<typeof diaryEntrySchema>;

export type DiaryReference = DiaryEntry["references"][number];

// A page the model may point to: found in the project by the words of the note.
export type CandidatePage = { documentId: string; pageNo: number; title: string | null };

// Audio types the model accepts through OpenRouter, with the file extension they are stored under.
// Browsers recording WebM (older Chrome) are not on the list; the app picks MP4 or Ogg where the browser has them.
const AUDIO_TYPES: Record<string, string> = {
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/x-aac": "aac",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
};

// "audio/ogg; codecs=opus" → "audio/ogg"; null when the model cannot take it.
export const audioType = (contentType: string | undefined) => {
  const base = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return base in AUDIO_TYPES ? { mediaType: base, extension: AUDIO_TYPES[base]! } : null;
};

const SAMPLE_TRANSCRIPT =
  "Dzisiaj zalaliśmy ławy fundamentowe od osi A do C, było nas sześciu, czterech zbrojarzy i dwóch na betonie. " +
  "Przyszła dostawa bloczków betonowych, dwie palety. Padało od czternastej, więc przerwaliśmy szalowanie. " +
  "Brakuje jeszcze stali na wieniec.";

// FAKE_AGENT=1 and the mock server: the same note every time, so the app can be built without a key.
export const fakeTranscript = () => SAMPLE_TRANSCRIPT;

const sentences = (text: string) =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim().replace(/[.!?]+$/, ""))
    .filter(Boolean);

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// A keyword sort of the sentences, standing in for the model when there is no key.
export const fakeOrganize = (transcript: string, pages: CandidatePage[]): DiaryEntry => {
  const entry: DiaryEntry = { summary: "", work: [], people: [], deliveries: [], weather: null, problems: [], references: [] };
  for (const sentence of sentences(transcript).map(capitalize)) {
    if (/dostaw|przyjecha|przywie/i.test(sentence)) entry.deliveries.push(sentence);
    else if (/pada|deszcz|słońc|mróz|wiatr|upał|pogod/i.test(sentence)) entry.weather = sentence;
    else if (/brak|problem|awari|opóźni|uszkodz|usterk/i.test(sentence)) entry.problems.push(sentence);
    else entry.work.push(sentence);
    if (/było nas|osób|ludzi|zbrojarz|murarz|cieśl|ekip/i.test(sentence)) entry.people.push(sentence);
  }
  entry.summary = entry.work[0] ?? entry.deliveries[0] ?? "Wpis dnia";
  entry.references = pages.slice(0, 2).map((page) => ({ ...page, note: "Wspomniane w nagraniu (dane testowe)" }));
  return entry;
};
