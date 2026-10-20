// expo-secure-store has no web implementation; the web build is only a dev preview, so localStorage is enough.
export const secureStorage = {
  get: async (key: string) => localStorage.getItem(key),
  set: async (key: string, value: string) => localStorage.setItem(key, value),
  remove: async (key: string) => localStorage.removeItem(key),
};
