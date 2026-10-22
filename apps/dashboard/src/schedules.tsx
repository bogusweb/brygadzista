import { useCallback, useEffect, useState } from "react";
import { ApiError, type Api, type Schedule, type ScheduleCategory, type ScheduleItem } from "./api";
import { errorMessage } from "./format";
import { usePageViewer } from "./pageViewer";

// Material schedules (#67): rows of the steel, lintel, window and door tables with their pages, totals for the order,
// and a CSV for the wholesaler. Totals count only rows whose numbers the server found on the page.

const READING_POLL_MS = 4_000;

export const CATEGORY_LABELS: Record<ScheduleCategory, string> = {
  stal: "Stal zbrojeniowa",
  nadproza: "Nadproża",
  okna: "Stolarka okienna",
  drzwi: "Stolarka drzwiowa",
  prefabrykaty: "Prefabrykaty",
  inne: "Inne",
};

const number = (value: number) => value.toLocaleString("pl-PL", { maximumFractionDigits: 3 });

const itemLine = (item: ScheduleItem) =>
  [
    item.mark,
    item.description,
    item.dimensions,
    item.quantity === null ? null : `${number(item.quantity)} ${item.unit}`.trim(),
    item.element || item.level ? `(${[item.element, item.level].filter(Boolean).join(", ")})` : null,
    `str. ${item.pageNo}`,
    item.verified ? null : "DO SPRAWDZENIA",
  ]
    .filter(Boolean)
    .join(" · ");

// Plain text to paste into a message to the wholesaler.
export const scheduleText = (schedule: Schedule) => {
  const lines: string[] = [];
  for (const category of Object.keys(CATEGORY_LABELS) as ScheduleCategory[]) {
    const items = schedule.items.filter((item) => item.category === category);
    if (!items.length) continue;
    lines.push(CATEGORY_LABELS[category].toUpperCase());
    for (const total of schedule.totals.filter((candidate) => candidate.category === category)) {
      lines.push(`Razem ${total.label}: ${number(total.quantity)} ${total.unit}`.trim());
    }
    lines.push(...items.map((item) => `- ${itemLine(item)}`), "");
  }
  return lines.join("\n").trim();
};

const statusNote = (schedule: Schedule) => {
  if (schedule.status === "reading") return "Odczytuję zestawienia z projektu…";
  if (schedule.status === "no_model") return "Zestawienia nie są odczytane: serwer nie ma klucza modelu.";
  if (!schedule.pages.length) return "W projekcie nie ma zestawień materiałów. Agent nie policzy ich na oko z rysunków.";
  return null;
};

export const SchedulesPanel = ({ api, projectId, onUnauthorized }: { api: Api; projectId: string; onUnauthorized: () => void }) => {
  const viewer = usePageViewer();
  const [category, setCategory] = useState<ScheduleCategory | "">("");
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setSchedule(await api.getSchedule(projectId, category || undefined));
      setError(null);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) return onUnauthorized();
      setError(errorMessage(cause));
    }
  }, [api, projectId, category, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (schedule?.status !== "reading") return;
    const timer = setTimeout(() => void load(), READING_POLL_MS);
    return () => clearTimeout(timer);
  }, [schedule, load]);

  const download = async () => {
    try {
      const blob = await api.scheduleCsv(projectId, category || undefined);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `zestawienie${category ? `-${category}` : ""}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const copy = async () => {
    if (!schedule) return;
    await navigator.clipboard.writeText(scheduleText(schedule));
    setCopied(true);
  };

  const refresh = async () => {
    try {
      setSchedule(await api.refreshSchedule(projectId));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const unverified = schedule?.items.filter((item) => !item.verified).length ?? 0;
  const note = schedule ? statusNote(schedule) : null;

  return (
    <section className="stack schedules">
      <div className="section-head">
        <h2>Zestawienia materiałów</h2>
        <select value={category} onChange={(event) => setCategory(event.target.value as ScheduleCategory | "")} aria-label="Rodzaj zestawienia">
          <option value="">Wszystkie</option>
          {(Object.keys(CATEGORY_LABELS) as ScheduleCategory[]).map((key) => (
            <option key={key} value={key}>
              {CATEGORY_LABELS[key]}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="error">{error}</p>}
      {note && <p className="muted small">{note}</p>}
      {schedule?.failedPages.length ? (
        <p className="error small">
          Nie udało się odczytać str. {schedule.failedPages.join(", ")}.{" "}
          <button type="button" className="link small" onClick={() => void refresh()}>
            Odczytaj ponownie
          </button>
        </p>
      ) : null}
      {schedule && schedule.totals.length > 0 && (
        <div className="card">
          <strong>Do zamówienia (sumy z projektu)</strong>
          <table className="schedule-table">
            <tbody>
              {schedule.totals.map((total) => (
                <tr key={`${total.category}|${total.label}|${total.unit}`}>
                  <td>{CATEGORY_LABELS[total.category]}</td>
                  <td>{total.label}</td>
                  <td className="num">
                    {number(total.quantity)} {total.unit}
                  </td>
                  <td className="muted small">{total.rows > 1 ? `${total.rows} pozycje` : "1 pozycja"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {schedule && schedule.items.length > 0 && (
        <>
          {unverified > 0 && (
            <p className="muted small">
              {unverified} {unverified === 1 ? "pozycja" : "pozycji"} do sprawdzenia: liczby nie zgadzają się z tekstem strony, więc nie
              wchodzą do sum.
            </p>
          )}
          <table className="schedule-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Opis</th>
                <th>Wymiary</th>
                <th className="num">Ilość</th>
                <th>Element</th>
                <th>Strona</th>
              </tr>
            </thead>
            <tbody>
              {schedule.items.map((item, index) => (
                <tr key={index} className={item.verified ? undefined : "unverified"}>
                  <td>{item.mark}</td>
                  <td>
                    {item.description}
                    {!item.verified && <span className="badge"> do sprawdzenia</span>}
                  </td>
                  <td>{item.dimensions}</td>
                  <td className="num">{item.quantity === null ? "–" : `${number(item.quantity)} ${item.unit}`}</td>
                  <td>{[item.element, item.level].filter(Boolean).join(", ")}</td>
                  <td>
                    <button type="button" className="link small" onClick={() => viewer.open(item.documentId, item.pageNo)}>
                      str. {item.pageNo}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row-actions">
            <button type="button" className="button" onClick={() => void download()}>
              Pobierz CSV
            </button>
            <button type="button" className="button ghost" onClick={() => void copy()}>
              {copied ? "Skopiowano" : "Kopiuj jako tekst"}
            </button>
          </div>
        </>
      )}
    </section>
  );
};
