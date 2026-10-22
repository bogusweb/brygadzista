import { useCallback, useEffect, useState } from "react";
import { ApiError, type Api, type DesignerQuestion, type NewQuestion } from "./api";
import { dateFormat, errorMessage } from "./format";
import { usePageViewer } from "./pageViewer";

// Questions to the designer (#73): the agent drafts them in the chat, the contractor sends them from the phone,
// and the answer written here goes into the agent's prompt.

export const questionText = (question: { question: string; pageNo: number | null; pageTitle: string | null }) =>
  `Dzień dobry,\n\nmam pytanie do projektu${question.pageNo ? ` (str. ${question.pageNo}${question.pageTitle ? `, ${question.pageTitle}` : ""})` : ""}:\n\n` +
  `${question.question.trim()}\n\nPozdrawiam`;

export type QuestionDraft = Required<Pick<NewQuestion, "documentId" | "pageNo" | "question">> & {
  reason: string;
  pageTitle: string | null;
  region: NewQuestion["region"];
};

// The agent's draft in the chat: editable, saved to the register with one click, copied to send by mail.
export const QuestionDraftCard = ({ api, projectId, draft }: { api: Api; projectId: string; draft: QuestionDraft }) => {
  const viewer = usePageViewer();
  const [text, setText] = useState(draft.question);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    try {
      await api.createQuestion(projectId, { ...draft, question: text.trim() || draft.question });
      setSaved(true);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(questionText({ ...draft, question: text }));
    setCopied(true);
  };

  return (
    <div className="question-draft">
      <strong>Pytanie do projektanta</strong>
      <span className="muted small">
        str. {draft.pageNo}
        {draft.pageTitle ? ` · ${draft.pageTitle}` : ""}
        {draft.reason ? ` · ${draft.reason}` : ""}
      </span>
      <button type="button" className="page-card-image" onClick={() => viewer.open(draft.documentId, draft.pageNo)} aria-label={`Otwórz stronę ${draft.pageNo}`}>
        <img className="question-crop" src={api.cropUrl(draft.documentId, draft.pageNo, draft.region ?? null)} alt="" />
      </button>
      <textarea value={text} onChange={(event) => setText(event.target.value)} rows={4} disabled={saved} aria-label="Treść pytania" />
      {error && <p className="error small">{error}</p>}
      <div className="row-actions">
        <button type="button" className="button primary" onClick={() => void save()} disabled={saved}>
          {saved ? "Zapisane w rejestrze" : "Zapisz w rejestrze"}
        </button>
        <button type="button" className="button ghost" onClick={() => void copy()}>
          {copied ? "Skopiowano" : "Kopiuj treść"}
        </button>
        <a className="button ghost" href={api.cropUrl(draft.documentId, draft.pageNo, draft.region ?? null)} download={`str-${draft.pageNo}.jpg`}>
          Pobierz wycinek
        </a>
      </div>
    </div>
  );
};

const QuestionItem = ({ api, projectId, question, onChange, onRemove }: {
  api: Api;
  projectId: string;
  question: DesignerQuestion;
  onChange: (question: DesignerQuestion) => void;
  onRemove: () => void;
}) => {
  const viewer = usePageViewer();
  const [answer, setAnswer] = useState(question.answer ?? "");
  const [editing, setEditing] = useState(question.status === "open");
  const [error, setError] = useState<string | null>(null);

  const saveAnswer = async () => {
    try {
      const updated = await api.answerQuestion(projectId, question.id, answer);
      onChange(updated);
      setEditing(updated.status === "open");
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const remove = async () => {
    if (!window.confirm("Usunąć pytanie i odpowiedź z rejestru?")) return;
    try {
      await api.deleteQuestion(projectId, question.id);
      onRemove();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <li className="card question">
      <div className="question-head">
        <span className={`question-status ${question.status}`}>{question.status === "answered" ? "Odpowiedziane" : "Otwarte"}</span>
        <span className="muted small">
          {dateFormat.format(new Date(question.createdAt))}
          {question.authorName ? ` · ${question.authorName}` : ""}
        </span>
        {question.documentId && question.pageNo && (
          <button type="button" className="link small" onClick={() => viewer.open(question.documentId!, question.pageNo!)}>
            str. {question.pageNo}
            {question.pageTitle ? ` · ${question.pageTitle}` : ""}
          </button>
        )}
      </div>
      <p className="question-text">{question.question}</p>
      {editing ? (
        <div className="question-answer-form">
          <textarea value={answer} onChange={(event) => setAnswer(event.target.value)} rows={3} placeholder="Odpowiedź projektanta" aria-label="Odpowiedź projektanta" />
          <div className="row-actions">
            <button type="button" className="button primary" onClick={() => void saveAnswer()} disabled={!answer.trim()}>
              Zapisz odpowiedź
            </button>
            {question.status === "answered" && (
              <button type="button" className="button ghost" onClick={() => setEditing(false)}>
                Anuluj
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="question-answer">
          <span className="muted small">
            Odpowiedź{question.answeredAt ? ` z ${dateFormat.format(new Date(question.answeredAt))}` : ""}
          </span>
          <p>{question.answer}</p>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
      <div className="row-actions">
        {!editing && (
          <button type="button" className="link small" onClick={() => setEditing(true)}>
            Popraw odpowiedź
          </button>
        )}
        <button type="button" className="link small" onClick={() => void navigator.clipboard.writeText(questionText(question))}>
          Kopiuj treść
        </button>
        <button type="button" className="link small danger" onClick={() => void remove()}>
          Usuń
        </button>
      </div>
    </li>
  );
};

// The register on the project screen.
export const QuestionsPanel = ({ api, projectId, onUnauthorized }: { api: Api; projectId: string; onUnauthorized: () => void }) => {
  const [questions, setQuestions] = useState<DesignerQuestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setQuestions(await api.listQuestions(projectId));
      setError(null);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) return onUnauthorized();
      setError(errorMessage(cause));
    }
  }, [api, projectId, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = questions?.filter((question) => question.status === "open").length ?? 0;

  return (
    <section className="stack questions">
      <div className="section-head">
        <h2>Pytania do projektanta</h2>
        {questions && <span className="muted small">{open ? `otwarte: ${open}` : "wszystkie odpowiedziane"}</span>}
      </div>
      {error && <p className="error">{error}</p>}
      {questions?.length === 0 && (
        <p className="muted small">
          Brak pytań. Agent proponuje pytanie, gdy w projekcie czegoś brakuje albo strony sobie przeczą; odpowiedź wpisana tutaj
          trafia do jego wiedzy o projekcie.
        </p>
      )}
      <ul className="list">
        {questions?.map((question) => (
          <QuestionItem
            key={question.id}
            api={api}
            projectId={projectId}
            question={question}
            onChange={(updated) => setQuestions((current) => current?.map((item) => (item.id === updated.id ? updated : item)) ?? null)}
            onRemove={() => setQuestions((current) => current?.filter((item) => item.id !== question.id) ?? null)}
          />
        ))}
      </ul>
    </section>
  );
};
