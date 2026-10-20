// expo-secure-store has no web implementation. In the browser the code stays in this site's localStorage,
// which only pages from the same server can read.
export const secureStorage = {
  get: async (key: string) => localStorage.getItem(key),
  set: async (key: string, value: string) => localStorage.setItem(key, value),
  remove: async (key: string) => localStorage.removeItem(key),
};
