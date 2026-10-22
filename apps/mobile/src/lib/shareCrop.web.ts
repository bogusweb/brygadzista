import type { Connection } from "./settings";

// The browser preview opens the crop in a new tab, from where it can be saved or sent.
export const shareCrop = async (connection: Connection, path: string, _name: string) => {
  const url = `${connection.serverUrl}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(connection.token)}`;
  window.open(url, "_blank", "noopener");
};
