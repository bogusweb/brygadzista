import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { embed, embedImage } from "../src/llm.js";
import { HttpError, isRetryable, parseRetryAfter, withRetry } from "../src/retry.js";

const fast = { retries: 3, baseMs: 1 };

describe("withRetry", () => {
  it("retries rate limits and server errors until the call succeeds", async () => {
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new HttpError("limit", 429))
      .mockRejectedValueOnce(new HttpError("bad gateway", 502))
      .mockResolvedValue("ok");

    expect(await withRetry(task, fast)).toBe("ok");
    expect(task).toHaveBeenCalledTimes(3);
  });

  it("does not retry a request the server will never accept", async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue(new HttpError("zly klucz", 401));

    await expect(withRetry(task, fast)).rejects.toThrow("zly klucz");
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("gives up after the configured number of retries", async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue(new HttpError("overloaded", 503));

    await expect(withRetry(task, fast)).rejects.toThrow("overloaded");
    expect(task).toHaveBeenCalledTimes(4);
  });

  it("waits at least as long as Retry-After asks", async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new HttpError("limit", 429, 120)).mockResolvedValue("ok");
    const delays: number[] = [];

    await withRetry(task, { ...fast, onRetry: (_error, _attempt, delayMs) => delays.push(delayMs) });

    expect(delays).toEqual([120]);
  });

  it("treats timeouts, dropped connections and AI SDK call errors as retryable", () => {
    expect(isRetryable(new DOMException("timeout", "TimeoutError"))).toBe(true);
    expect(isRetryable(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryable(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(true);
    expect(isRetryable(Object.assign(new Error("AI_APICallError"), { statusCode: 529 }))).toBe(true);
    expect(isRetryable(Object.assign(new Error("AI_APICallError"), { statusCode: 400 }))).toBe(false);
    expect(isRetryable(new Error("Nie udało się odczytać PDF"))).toBe(false);
  });

  it("reads Retry-After as seconds or as a date", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("Tue, 20 Oct 2026 00:00:10 GMT", Date.parse("Tue, 20 Oct 2026 00:00:00 GMT"))).toBe(10_000);
    expect(parseRetryAfter("jutro")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe("embed against a flaky OpenRouter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ok = () =>
    new Response(JSON.stringify({ data: [{ index: 0, embedding: Array(config.embeddingDimensions).fill(1) }] }), { status: 200 });

  it("retries a 429 and returns the vectors", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);

    const [vector] = await embed(["sciana"]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vector).toHaveLength(config.embeddingDimensions);
    expect(fetchMock.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends each text as its own single input, keeping the order", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const { input } = JSON.parse(String(init!.body)) as { input: unknown };
      // A string input gets a vector pointing along the axis of its length; an array input gets nothing.
      const embedding = Array.from({ length: config.embeddingDimensions }, (_, i) => (typeof input === "string" && i === input.length ? 1 : 0));
      return new Response(JSON.stringify({ data: [{ index: 0, embedding }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const texts = ["a", "bb", "ccc", "dddd", "eeeee", "ffffff"];
    const vectors = await embed(texts);

    expect(fetchMock).toHaveBeenCalledTimes(texts.length);
    expect(vectors.map((vector) => vector.indexOf(1))).toEqual(texts.map((text) => text.length));
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init!.body)).input)).toEqual(expect.arrayContaining(texts));
  });

  it("fails at once on a rejected key", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("no auth", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(embed(["sciana"])).rejects.toThrow("Embedding 401: no auth");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends a page image as one multimodal input with a data URL", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);
    const image = path.join(await mkdtemp(path.join(tmpdir(), "embed-")), "page-0001.jpg");
    await writeFile(image, Buffer.from("jpeg"));

    const vector = await embedImage(image);

    expect(vector).toHaveLength(config.embeddingDimensions);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.input).toEqual([
      { content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from("jpeg").toString("base64")}` } }] },
    ]);
  });
});
