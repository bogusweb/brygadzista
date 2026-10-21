// Notes recorded without signal wait on the phone and go out when the server answers again (#69).
// Each carries a clientId, so a note whose answer was lost on the way is not saved twice: the server keeps the first copy.

type QueuedBase = { clientId: string; projectId: string; date: string; createdAt: string; error?: string };

export type QueuedNote =
  | (QueuedBase & { kind: "audio"; audioUri: string; mediaType: string; durationMillis: number })
  | (QueuedBase & { kind: "text"; text: string });

export const newClientId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// Server errors carry an HTTP status; a missing status means no answer at all, so the note waits for signal.
const isUnreachable = (error: unknown) => error instanceof Error && (error as { status?: number }).status === undefined;

// Rate limit and server trouble pass; anything else (bad format, too long) will fail the same way every time.
const isTemporary = (status: number) => status === 408 || status === 429 || status >= 500;

export type FlushResult = { remaining: QueuedNote[]; sent: QueuedNote[] };

// Sends in recording order and stops at the first sign of no signal. A note the server refuses for good stays
// in the queue with the reason, for the user to read and remove.
export const flushQueue = async (queue: QueuedNote[], send: (note: QueuedNote) => Promise<void>): Promise<FlushResult> => {
  const remaining: QueuedNote[] = [];
  const sent: QueuedNote[] = [];
  let offline = false;
  for (const note of queue) {
    if (offline || note.error) {
      remaining.push(note);
      continue;
    }
    try {
      await send(note);
      sent.push(note);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (isUnreachable(error) || (status !== undefined && isTemporary(status))) {
        offline = true;
        remaining.push(note);
      } else {
        remaining.push({ ...note, error: error instanceof Error ? error.message : "Serwer odrzucił nagranie." });
      }
    }
  }
  return { remaining, sent };
};
