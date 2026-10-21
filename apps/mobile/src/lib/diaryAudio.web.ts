// The browser records with MediaRecorder. The model hears MP4 (Safari, newer Chrome) and Ogg (Firefox), not WebM,
// so the first supported of these is used; a browser with none of them offers typing only.
const CANDIDATES = ["audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"];

const webMimeType =
  typeof MediaRecorder === "undefined" ? undefined : CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));

export const recordingFormat = {
  supported: webMimeType !== undefined && typeof navigator !== "undefined" && Boolean(navigator.mediaDevices),
  mediaType: webMimeType?.split(";")[0] ?? "audio/mp4",
  webMimeType,
};

// A blob: URL dies with the tab, so a note waiting for signal is kept as a data: URL in localStorage with the queue.
export const keepRecording = async (uri: string) => {
  const blob = await (await fetch(uri)).blob();
  URL.revokeObjectURL(uri);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Nie udało się zapisać nagrania"));
    reader.readAsDataURL(blob);
  });
};

export const readRecording = async (uri: string) => (await fetch(uri)).blob();

export const discardRecording = (_uri: string) => {};
