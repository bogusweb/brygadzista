import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import type { RecordingOptions } from "expo-audio";
import { useCallback, useEffect, useRef, useState } from "react";
import { recordingFormat } from "../../lib/diaryAudio";
import { newClientId } from "../../lib/diaryQueue";

// A day's note is half a minute; five minutes is a generous cap that keeps the upload small.
export const MAX_RECORDING_SECONDS = 5 * 60;

// Mono AAC at 64 kbit/s: speech stays clear and a minute is about 0.5 MB. The file goes to the document directory,
// so a note waiting for signal is not cleared with the cache.
const OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  bitRate: 64_000,
  directory: "document",
  web: { mimeType: recordingFormat.webMimeType, bitsPerSecond: 64_000 },
};

export type FinishedRecording = { uri: string; durationMillis: number };

export const useDiaryRecorder = (onFinished: (recording: FinishedRecording) => void) => {
  const recorder = useAudioRecorder(OPTIONS);
  const state = useAudioRecorderState(recorder, 250);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const stopping = useRef(false);

  const start = useCallback(async () => {
    setError(null);
    setStarting(true);
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setError("Brak dostępu do mikrofonu. Zezwól na niego w ustawieniach telefonu albo wpisz tekst.");
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync({ fileName: `dziennik-${newClientId()}` });
      recorder.record({ forDuration: MAX_RECORDING_SECONDS });
    } catch {
      setError("Nie udało się włączyć nagrywania. Spróbuj jeszcze raz albo wpisz tekst.");
    } finally {
      setStarting(false);
    }
  }, [recorder]);

  // Each recording has its own file name, so the uri tells a new recording from one already handed over.
  const handedOver = useRef<string | null>(null);
  const handOver = useCallback(
    (durationMillis: number) => {
      const uri = recorder.uri;
      if (!uri || uri === handedOver.current) return;
      handedOver.current = uri;
      void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      onFinished({ uri, durationMillis });
    },
    [onFinished, recorder],
  );

  const stop = useCallback(async () => {
    if (stopping.current) return;
    stopping.current = true;
    const durationMillis = recorder.getStatus().durationMillis;
    try {
      await recorder.stop();
      if (recorder.uri) handOver(durationMillis);
      else setError("Nagranie się nie zapisało. Spróbuj jeszcze raz.");
    } catch {
      setError("Nie udało się zakończyć nagrania. Spróbuj jeszcze raz.");
    } finally {
      stopping.current = false;
    }
  }, [handOver, recorder]);

  // The time cap stops the recorder by itself; that note is handed over here.
  const wasRecording = useRef(false);
  useEffect(() => {
    if (wasRecording.current && !state.isRecording && !stopping.current) handOver(state.durationMillis);
    wasRecording.current = state.isRecording;
  }, [handOver, state.durationMillis, state.isRecording]);

  return { recording: state.isRecording, durationMillis: state.durationMillis, starting, error, start, stop };
};
