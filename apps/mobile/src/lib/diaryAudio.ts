import { File } from "expo-file-system";

// The recorder writes straight into the document directory (see useDiaryRecorder), which the system does not clear,
// so a note waiting for signal survives closing the app.
export const recordingFormat = { supported: true, mediaType: "audio/mp4", webMimeType: undefined as string | undefined };

export const keepRecording = async (uri: string) => uri;

export const readRecording = async (uri: string) => new File(uri).bytes();

export const discardRecording = (uri: string) => {
  const file = new File(uri);
  if (file.exists) file.delete();
};
