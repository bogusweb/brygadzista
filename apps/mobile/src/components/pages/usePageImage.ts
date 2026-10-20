import { useMemo, useState, useSyncExternalStore } from "react";
import type { ImageSourcePropType } from "react-native";
import { pageImageSource } from "../../lib/api";
import { getPageCacheVersion, subscribePageCache } from "../../lib/offline";
import { cachedPageUri, offlineSupported, removePage, savePage } from "../../lib/offlineCache";
import { useConnection } from "../../lib/settings";

export const usePageCacheVersion = () => useSyncExternalStore(subscribePageCache, getPageCacheVersion);

type PageImage = {
  source: ImageSourcePropType;
  saved: boolean;
  onLoad: () => void;
  // True when the error was handled by switching to the server copy, so the caller should keep waiting.
  onError: () => boolean;
};

// A page image read from the phone when it was saved, otherwise from the server. Every page viewed online gets saved too,
// so drawings the contractor already looked at keep working without signal.
export const usePageImage = (documentId: string, pageNo: number): PageImage => {
  const connection = useConnection();
  const version = usePageCacheVersion();
  const [skipSaved, setSkipSaved] = useState(false);
  const savedUri = useMemo(
    () => (skipSaved ? null : cachedPageUri(connection, documentId, pageNo)),
    // version: re-check the disk after any save or removal.
    [connection, documentId, pageNo, skipSaved, version],
  );

  return {
    source: savedUri ? { uri: savedUri } : pageImageSource(connection, documentId, pageNo),
    saved: savedUri !== null,
    onLoad: () => {
      if (!savedUri && offlineSupported) savePage(connection, documentId, pageNo).catch(() => undefined);
    },
    onError: () => {
      if (!savedUri) return false;
      // A damaged saved file: drop it and fetch from the server instead.
      removePage(connection, documentId, pageNo);
      setSkipSaved(true);
      return true;
    },
  };
};
