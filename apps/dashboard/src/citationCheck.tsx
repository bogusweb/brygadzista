import { z } from "zod";

// The server checks every page the answer cites against the pages its tools returned (#57) and sends the result
// as an activity after the answer. Unconfirmed text citations are marked in the answer; this card lists them all,
// including the ones on A2UI cards.

export const CITATION_ACTIVITY_TYPE = "citation-check";

const citation = z.object({ pageNo: z.number(), documentId: z.string().optional(), in: z.enum(["text", "card"]) });
const citationCheck = z.object({ cited: z.array(citation), unverified: z.array(citation) });

export type CitationCheck = z.infer<typeof citationCheck>;

type ChatMessage = { id: string; role: string; activityType?: string; content?: unknown };

// The check of the run that wrote this message: the first one after it, before the next question.
export const citationCheckFor = (messages: readonly ChatMessage[], messageId: string): CitationCheck | null => {
  const start = messages.findIndex((message) => message.id === messageId);
  if (start < 0) return null;
  for (const message of messages.slice(start + 1)) {
    if (message.role === "user") return null;
    if (message.role === "activity" && message.activityType === CITATION_ACTIVITY_TYPE) {
      const parsed = citationCheck.safeParse(message.content);
      return parsed.success ? parsed.data : null;
    }
  }
  return null;
};

export const unverifiedTextPages = (check: CitationCheck | null) =>
  new Set(check?.unverified.filter((item) => item.in === "text").map((item) => item.pageNo) ?? []);

const describe = (check: CitationCheck) =>
  check.unverified.map((item) => `str. ${item.pageNo}${item.in === "card" ? " (na karcie)" : ""}`).join(", ");

const CitationWarning = ({ content }: { content: CitationCheck }) => {
  if (!content.unverified.length) return null;
  return (
    <p className="citation-warning" role="note">
      Nie potwierdzono źródła: {describe(content)}. Agent nie dostał tej strony z wyszukiwania ani odczytu, sprawdź ją w
      projekcie.
    </p>
  );
};

export const citationActivityRenderer = {
  activityType: CITATION_ACTIVITY_TYPE,
  content: citationCheck,
  render: CitationWarning,
};
