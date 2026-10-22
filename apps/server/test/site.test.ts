import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { siteWeather } from "../src/site.js";
import { ADMIN, APP, createProject, createTenant, createUser, login, resetDatabase } from "./helpers.js";

let projectId: string;

const daily = (day: string, code: number) => ({
  daily: {
    time: [day],
    weather_code: [code],
    temperature_2m_max: [14.7],
    temperature_2m_min: [8.2],
    precipitation_sum: [3.2],
    wind_speed_10m_max: [24.6],
  },
});

const putSite = (body: unknown, headers: Record<string, string> = ADMIN) =>
  app.request(`/api/projects/${projectId}/site`, { method: "PUT", body: JSON.stringify(body), headers: { ...headers, "content-type": "application/json" } });

beforeEach(async () => {
  await resetDatabase();
  projectId = await createProject("Dom w Piławie");
  config.weatherEnabled = true;
});

afterEach(() => {
  config.weatherEnabled = false;
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await sql.end();
});

describe("site location", () => {
  it("looks up the town of the address and keeps it with the project", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [{ name: "Piława Górna", latitude: 50.68, longitude: 16.74 }] }))),
    );
    const response = await putSite({ address: "ul. Polna 3, 58-240 Piława Górna" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ address: "ul. Polna 3, 58-240 Piława Górna", lat: 50.68, lon: 16.74, found: "Piława Górna" });
    const read = await app.request(`/api/projects/${projectId}/site`, { headers: APP });
    expect(await read.json()).toEqual({ address: "ul. Polna 3, 58-240 Piława Górna", lat: 50.68, lon: 16.74 });
  });

  it("takes a point given by hand and rejects one off the globe", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await (await putSite({ address: "Działka 123/4", lat: 50.1, lon: 17.2 })).json()).toMatchObject({ lat: 50.1, lon: 17.2 });
    expect(fetch).not.toHaveBeenCalled();
    expect((await putSite({ lat: 120, lon: 0 })).status).toBe(400);
  });

  it("is set by managers, not workers, and not on another firm's project", async () => {
    await createUser("brygadzista@example.com", "worker");
    const worker = await login("brygadzista@example.com");
    expect((await putSite({ lat: 50, lon: 17 }, worker)).status).toBe(401);
    const other = await createTenant("Inna firma");
    await createUser("szef@inna.pl", "owner", undefined, other);
    expect((await putSite({ lat: 50, lon: 17 }, await login("szef@inna.pl"))).status).toBe(404);
  });
});

describe("siteWeather", () => {
  it("reads the day once it is over and then answers from the table", async () => {
    await sql`update projects set site_lat = 50.68, site_lon = 16.74 where id = ${projectId}`;
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(daily("2026-10-19", 63))));
    vi.stubGlobal("fetch", fetch);
    const now = new Date("2026-10-22T10:00:00Z");
    expect(await siteWeather(projectId, "2026-10-19", now)).toMatchObject({ sky: "deszcz", tempMax: 14.7 });
    expect(await siteWeather(projectId, "2026-10-19", new Date("2026-10-30T10:00:00Z"))).toMatchObject({ sky: "deszcz" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stays quiet without a location or when Open-Meteo fails", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetch);
    expect(await siteWeather(projectId, "2026-10-19")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    await sql`update projects set site_lat = 50.68, site_lon = 16.74 where id = ${projectId}`;
    expect(await siteWeather(projectId, "2026-10-19")).toBeNull();
  });
});

describe("diary PDF", () => {
  it("exports a period with the weather of each day and refuses a broken range", async () => {
    await sql`insert into site_weather (project_id, day, weather, final)
      values (${projectId}, '2026-10-20', ${sql.json({ code: 63, sky: "deszcz", tempMin: 8, tempMax: 14, precipitationMm: 3, windMaxKmh: 20, source: "open-meteo" })}, true)`;
    await sql`insert into diary_entries (project_id, entry_date, source, transcript, status, entry)
      values (${projectId}, '2026-10-20', 'text', 'x', 'ready', ${sql.json({ summary: "Ławy", work: ["Zabetonowano ławy"], people: [], deliveries: [], weather: null, problems: [], references: [] })})`;

    const list = (await (await app.request(`/api/projects/${projectId}/diary`, { headers: APP })).json()) as { siteWeather: { text: string } | null }[];
    expect(list[0]!.siteWeather?.text).toBe("deszcz, 8–14 °C, opad 3 mm, wiatr do 20 km/h");

    const pdf = await app.request(`/api/projects/${projectId}/diary/report.pdf?from=2026-10-19&to=2026-10-25&token=test-app`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toContain("dziennik-2026-10-19_2026-10-25.pdf");
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");

    expect((await app.request(`/api/projects/${projectId}/diary/report.pdf?from=2026-10-25&to=2026-10-19`, { headers: APP })).status).toBe(400);
    expect((await app.request(`/api/projects/${projectId}/diary/report.pdf?from=2026-01-01&to=2026-10-19`, { headers: APP })).status).toBe(400);
  });
});
