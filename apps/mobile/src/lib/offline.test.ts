import { describe, expect, it, vi } from "vitest";
import { pluralPl, formatMegabytes } from "./format";
import { loadWithFallback, pageNoFromFileName, runQueue, serverFolderName } from "./offline";

class HttpError extends Error {
  constructor(readonly status?: number) {
    super("http");
  }
}

const memoryStore = <T>(initial: T | null = null) => {
  let value = initial;
  return { read: vi.fn(async () => value), write: vi.fn(async (next: T) => void (value = next)) };
};

describe("loadWithFallback", () => {
  it("saves fresh data", async () => {
    const store = memoryStore<number[]>();
    await expect(loadWithFallback(async () => [1, 2], store)).resolves.toEqual({ data: [1, 2], offline: false });
    expect(store.write).toHaveBeenCalledWith([1, 2]);
  });

  it("uses the saved copy when the server cannot be reached", async () => {
    const store = memoryStore([7]);
    const unreachable = () => Promise.reject(new HttpError());
    await expect(loadWithFallback(unreachable, store)).resolves.toEqual({ data: [7], offline: true });
  });

  it("does not hide server answers such as a wrong access code", async () => {
    const store = memoryStore([7]);
    await expect(loadWithFallback(() => Promise.reject(new HttpError(401)), store)).rejects.toThrow("http");
  });

  it("fails when nothing was saved yet", async () => {
    await expect(loadWithFallback(() => Promise.reject(new HttpError()), memoryStore())).rejects.toThrow("http");
  });

  it("still returns fresh data when saving it fails", async () => {
    const store = { read: async () => null, write: () => Promise.reject(new Error("disk full")) };
    await expect(loadWithFallback(async () => "ok", store)).resolves.toEqual({ data: "ok", offline: false });
  });
});

describe("file names", () => {
  it("turns a server address into one folder name", () => {
    expect(serverFolderName("https://brygadzista.example.pl")).toBe("brygadzista.example.pl");
    expect(serverFolderName("http://192.168.1.20:3100/")).toBe("192.168.1.20_3100");
  });

  it("reads page numbers back from saved files only", () => {
    expect(pageNoFromFileName("12.jpg")).toBe(12);
    expect(pageNoFromFileName("12.part")).toBeNull();
  });
});

describe("runQueue", () => {
  it("runs every item with limited concurrency", async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    await runQueue(
      [1, 2, 3, 4, 5],
      async (item) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.push(item);
        active -= 1;
      },
      { concurrency: 2 },
    );
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it("stops taking new items once aborted", async () => {
    const controller = new AbortController();
    const seen: number[] = [];
    await runQueue(
      [1, 2, 3, 4],
      async (item) => {
        seen.push(item);
        if (item === 2) controller.abort();
      },
      { concurrency: 1, signal: controller.signal },
    );
    expect(seen).toEqual([1, 2]);
  });
});

describe("format", () => {
  it("uses Polish plural forms", () => {
    expect(pluralPl(1, "strona", "strony", "stron")).toBe("1 strona");
    expect(pluralPl(3, "strona", "strony", "stron")).toBe("3 strony");
    expect(pluralPl(12, "strona", "strony", "stron")).toBe("12 stron");
    expect(pluralPl(22, "strona", "strony", "stron")).toBe("22 strony");
    expect(pluralPl(42, "strona", "strony", "stron")).toBe("42 strony");
  });

  it("shows sizes in megabytes", () => {
    expect(formatMegabytes(1.5 * 1024 * 1024)).toBe("1,5 MB");
    expect(formatMegabytes(42 * 1024 * 1024)).toBe("42 MB");
  });
});
