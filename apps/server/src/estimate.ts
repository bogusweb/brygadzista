import { config } from "./config.js";

// Without an API key only the PDF text is extracted, which is free and takes well under a second per page.
const TEXT_ONLY_SECONDS_PER_PAGE = 0.5;

export type IndexingEstimate = { pages: number; costUsd: number; seconds: number; vision: boolean };

// Rough cost and duration of indexing `pages` pages, shown before indexing starts.
export const estimateIndexing = (pages: number, vision = config.openrouterApiKey !== ""): IndexingEstimate => {
  const secondsPerPage = vision ? config.indexSecondsPerPage : TEXT_ONLY_SECONDS_PER_PAGE;
  return {
    pages,
    vision,
    costUsd: vision ? Math.round(pages * config.indexCostPerPageUsd * 100) / 100 : 0,
    seconds: Math.ceil(Math.ceil(pages / Math.max(1, config.indexConcurrency)) * secondsPerPage),
  };
};

// Remaining time of a running document from its own pace so far; before the first page is done, from the estimate.
export const etaSeconds = (run: { total: number; done: number; startedAt: Date | null }, now = Date.now()): number => {
  const remaining = Math.max(0, run.total - run.done);
  if (remaining === 0) return 0;
  if (!run.startedAt || run.done === 0) return estimateIndexing(remaining).seconds;
  const secondsPerPage = (now - run.startedAt.getTime()) / 1000 / run.done;
  return Math.ceil(remaining * secondsPerPage);
};
