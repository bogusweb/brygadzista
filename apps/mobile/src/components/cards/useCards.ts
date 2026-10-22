import { useCallback, useEffect, useState } from "react";
import { fetchCard, fetchCards, requestCard } from "../../lib/cardApi";
import { cardPages, cardsKey, withCard } from "../../lib/cards";
import type { CardKind, ElementCard } from "../../lib/cards";
import { loadWithFallback } from "../../lib/offline";
import { readJson, savePage, writeJson } from "../../lib/offlineCache";
import { useConnection } from "../../lib/settings";
import type { Connection } from "../../lib/settings";

const GENERATING_POLL_MS = 3_000;

// The chat and the Karty screen both add cards; the screen redraws when either saves one.
const listeners = new Set<(projectId: string) => void>();

// A ready card is saved on the phone with the pages it cites, so it opens on site without signal (#49).
// Pages that fail to download now are fetched again the next time the card is saved.
export const rememberCard = async (connection: Connection, card: ElementCard) => {
  const saved = await readJson<ElementCard[]>(connection, cardsKey(card.projectId)).catch(() => null);
  await writeJson(connection, cardsKey(card.projectId), withCard(saved, card));
  listeners.forEach((listener) => listener(card.projectId));
  if (card.status !== "ready") return;
  await Promise.all(cardPages(card).map((page) => savePage(connection, page.documentId, page.pageNo).catch(() => undefined)));
};

type State = { cards: ElementCard[] | null; offline: boolean; error: string | null; loading: boolean };

export const useCards = (projectId: string) => {
  const connection = useConnection();
  const [state, setState] = useState<State>({ cards: null, offline: false, error: null, loading: true });

  const readSaved = useCallback(async () => {
    const cards = await readJson<ElementCard[]>(connection, cardsKey(projectId)).catch(() => null);
    if (cards) setState((previous) => ({ ...previous, cards }));
  }, [connection, projectId]);

  const reload = useCallback(async () => {
    setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const { data, offline } = await loadWithFallback(() => fetchCards(connection, projectId), {
        read: () => readJson<ElementCard[]>(connection, cardsKey(projectId)),
        write: (cards) => writeJson(connection, cardsKey(projectId), cards),
      });
      setState({ cards: data, offline, error: null, loading: false });
      if (!offline) for (const card of data) void rememberCard(connection, card);
    } catch (caught) {
      setState((previous) => ({ ...previous, loading: false, error: caught instanceof Error ? caught.message : "Nie udało się pobrać kart." }));
    }
  }, [connection, projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const listener = (changed: string) => changed === projectId && void readSaved();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [projectId, readSaved]);

  // Cards still collecting values are asked for again until they are done.
  const generating = state.cards?.filter((card) => card.status === "generating").map((card) => card.id).join(",") ?? "";
  useEffect(() => {
    if (!generating || state.offline) return;
    const timer = setInterval(() => {
      for (const id of generating.split(",")) {
        void fetchCard(connection, id)
          .then((card) => rememberCard(connection, card))
          .catch(() => undefined);
      }
    }, GENERATING_POLL_MS);
    return () => clearInterval(timer);
  }, [connection, generating, state.offline]);

  const create = useCallback(
    async (kind: CardKind, name: string, refresh = false) => {
      const card = await requestCard(connection, projectId, kind, name, refresh);
      await rememberCard(connection, card);
      return card.id;
    },
    [connection, projectId],
  );

  return { ...state, reload, create };
};
