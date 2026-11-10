import type { Connection } from "./settings";

// The browser preview opens the crop in a new tab, from where it can be saved or sent.
export const shareCrop = async (connection: Connection, path: string, _name: string) => {
  // Same origin as the server, so the file cookie opens it (#165).
  const url = `${connection.serverUrl}${path}`;
  window.open(url, "_blank", "noopener");
};
