import { Hono } from "hono";
import { requireProjectAccess, requireRole, type AuthEnv } from "./auth.js";
import { config } from "./config.js";
import { sql } from "./db.js";
import { describeWeather, fetchDayWeather, geocodePlace, isCoordinates, type SiteWeather } from "./weather.js";

// The site's location and the weather of its days (#81).

export type Site = { address: string | null; lat: number | null; lon: number | null };

export const projectSite = async (projectId: string): Promise<Site | null> => {
  const [site] = await sql<Site[]>`
    select site_address as address, site_lat as lat, site_lon as lon from projects where id = ${projectId}`;
  return site ?? null;
};

// Today in Warsaw, which is the calendar the site works in.
export const warsawToday = (now = new Date()) => now.toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });

const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;

// A forecast for today changes during the day; it is asked again after this long.
const REFRESH_MS = 3 * 60 * 60_000;

type WeatherRow = { weather: SiteWeather | null; final: boolean; fetchedAt: Date };

// The day's weather, from the table when it is there and settled, otherwise from Open-Meteo. Never throws: a missing
// weather line must not stop a diary entry or a report.
export const siteWeather = async (projectId: string, day: string, now = new Date()): Promise<SiteWeather | null> => {
  const [cached] = await sql<WeatherRow[]>`
    select weather, final, fetched_at as "fetchedAt" from site_weather where project_id = ${projectId} and day = ${day}`;
  if (cached && (cached.final || now.getTime() - cached.fetchedAt.getTime() < REFRESH_MS)) return cached.weather;
  const site = await projectSite(projectId);
  if (!config.weatherEnabled || site?.lat == null || site.lon == null) return cached?.weather ?? null;
  const today = warsawToday(now);
  if (daysBetween(today, day) > 14) return null;
  try {
    const weather = await fetchDayWeather({ lat: site.lat, lon: site.lon }, day, now);
    // The archive settles a day or two after it ends.
    const final = weather !== null && daysBetween(day, today) >= 2;
    await sql`
      insert into site_weather (project_id, day, weather, final, fetched_at)
      values (${projectId}, ${day}, ${weather ? sql.json(weather) : null}, ${final}, now())
      on conflict (project_id, day) do update set weather = coalesce(excluded.weather, site_weather.weather),
        final = excluded.final, fetched_at = excluded.fetched_at`;
    return weather ?? cached?.weather ?? null;
  } catch (error) {
    console.warn(`weather: project ${projectId} day ${day} failed`, error);
    return cached?.weather ?? null;
  }
};

// Weather already known for a range of days, without asking Open-Meteo (the diary list must stay fast).
export const knownWeather = async (projectId: string, days: string[]) => {
  if (days.length === 0) return new Map<string, SiteWeather>();
  const rows = await sql<{ day: string; weather: SiteWeather }[]>`
    select day::text as day, weather from site_weather where project_id = ${projectId} and day in ${sql(days)} and weather is not null`;
  return new Map(rows.map((row) => [row.day, row.weather]));
};

export const withDescription = (weather: SiteWeather | null | undefined) => (weather ? { ...weather, text: describeWeather(weather) } : null);

const MAX_ADDRESS_CHARS = 300;

export const site = new Hono<AuthEnv>();

site.get("/api/projects/:id/site", requireRole("app", "admin"), requireProjectAccess(), async (c) => c.json(await projectSite(c.req.param("id"))));

// The address is looked up when no point is given; a point given by hand (from a map) wins over the lookup.
site.put("/api/projects/:id/site", requireRole("admin"), requireProjectAccess(), async (c) => {
  const body = await c.req.json<{ address?: unknown; lat?: unknown; lon?: unknown }>().catch(() => null);
  if (!body) return c.json({ error: "Nieprawidłowe dane" }, 400);
  const address = typeof body.address === "string" ? body.address.trim().slice(0, MAX_ADDRESS_CHARS) : "";
  const hasPoint = body.lat !== undefined && body.lat !== null;
  if (hasPoint && !isCoordinates(body.lat, body.lon)) return c.json({ error: "Nieprawidłowe współrzędne" }, 400);
  let point = hasPoint ? { lat: body.lat as number, lon: body.lon as number } : null;
  let found: string | null = null;
  if (!point && address && config.weatherEnabled) {
    const place = await geocodePlace(address).catch((error: unknown) => {
      console.warn("weather: geocoding failed", error);
      return null;
    });
    if (place) {
      point = { lat: place.lat, lon: place.lon };
      found = place.label;
    }
  }
  const projectId = c.req.param("id");
  await sql`
    update projects set site_address = ${address || null}, site_lat = ${point?.lat ?? null}, site_lon = ${point?.lon ?? null}
    where id = ${projectId}`;
  // Weather read for the old place is no longer right.
  await sql`delete from site_weather where project_id = ${projectId}`;
  return c.json({ ...(await projectSite(projectId)), found });
});
