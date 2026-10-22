import { z } from "zod";
import { config } from "./config.js";

// Weather of a site day (#81) from Open-Meteo: free, no key, and nothing about the project leaves the server but the
// coordinates and the date. Recent days come from the forecast API, older ones from the archive (the forecast API
// returns nulls for days more than a few weeks back); either one fills in when the other has no data.

export type SiteWeather = {
  code: number;
  sky: string;
  tempMin: number;
  tempMax: number;
  precipitationMm: number;
  windMaxKmh: number;
  source: "open-meteo";
};

export type Coordinates = { lat: number; lon: number };

// WMO weather codes, as Open-Meteo documents them, in words a site log uses.
const SKY: [number[], string][] = [
  [[0], "bezchmurnie"],
  [[1], "przeważnie pogodnie"],
  [[2], "częściowe zachmurzenie"],
  [[3], "pochmurno"],
  [[45, 48], "mgła"],
  [[51, 53, 55], "mżawka"],
  [[56, 57], "marznąca mżawka"],
  [[61, 63], "deszcz"],
  [[65], "ulewny deszcz"],
  [[66, 67], "marznący deszcz"],
  [[71, 73, 75, 77], "śnieg"],
  [[80, 81, 82], "przelotne opady deszczu"],
  [[85, 86], "przelotne opady śniegu"],
  [[95], "burza"],
  [[96, 99], "burza z gradem"],
];

export const skyLabel = (code: number) => SKY.find(([codes]) => codes.includes(code))?.[1] ?? "brak opisu";

const round = (value: number) => Math.round(value * 10) / 10;

// "deszcz, 8–14 °C, opad 3,2 mm, wiatr do 25 km/h"
export const describeWeather = (weather: SiteWeather) => {
  const number = (value: number) => String(round(value)).replace(".", ",");
  return [
    weather.sky,
    `${number(weather.tempMin)}–${number(weather.tempMax)} °C`,
    weather.precipitationMm > 0 ? `opad ${number(weather.precipitationMm)} mm` : "bez opadu",
    `wiatr do ${Math.round(weather.windMaxKmh)} km/h`,
  ].join(", ");
};

const DAILY = "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max";

const dailySchema = z.object({
  daily: z.object({
    time: z.array(z.string()),
    weather_code: z.array(z.number().nullable()),
    temperature_2m_max: z.array(z.number().nullable()),
    temperature_2m_min: z.array(z.number().nullable()),
    precipitation_sum: z.array(z.number().nullable()),
    wind_speed_10m_max: z.array(z.number().nullable()),
  }),
});

// Open-Meteo answers in a second; a slow answer must not hold a diary entry for long.
const TIMEOUT_MS = 10_000;

const getJson = async (url: string) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Open-Meteo ${response.status}`);
  return (await response.json()) as unknown;
};

const dayFrom = async (base: string, { lat, lon }: Coordinates, day: string): Promise<SiteWeather | null> => {
  const query = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    daily: DAILY,
    timezone: "Europe/Warsaw",
    start_date: day,
    end_date: day,
  });
  const { daily } = dailySchema.parse(await getJson(`${base}?${query}`));
  const index = daily.time.indexOf(day);
  const [code, tempMax, tempMin, precipitation, wind] = [
    daily.weather_code[index],
    daily.temperature_2m_max[index],
    daily.temperature_2m_min[index],
    daily.precipitation_sum[index],
    daily.wind_speed_10m_max[index],
  ];
  if (index < 0 || code == null || tempMax == null || tempMin == null) return null;
  return {
    code,
    sky: skyLabel(code),
    tempMin: round(tempMin),
    tempMax: round(tempMax),
    precipitationMm: round(precipitation ?? 0),
    windMaxKmh: round(wind ?? 0),
    source: "open-meteo",
  };
};

const RECENT_DAYS = 7;

const daysAgo = (day: string, today: Date) => (Date.parse(today.toISOString().slice(0, 10)) - Date.parse(day)) / 86_400_000;

// Null when neither API has the day (too far ahead, or a gap in the data).
export const fetchDayWeather = async (place: Coordinates, day: string, today = new Date()): Promise<SiteWeather | null> => {
  const sources = daysAgo(day, today) > RECENT_DAYS ? [config.weatherArchiveUrl, config.weatherForecastUrl] : [config.weatherForecastUrl, config.weatherArchiveUrl];
  for (const source of sources) {
    const weather = await dayFrom(source, place, day);
    if (weather) return weather;
  }
  return null;
};

const geocodeSchema = z.object({
  results: z
    .array(z.object({ name: z.string(), latitude: z.number(), longitude: z.number(), admin1: z.string().optional() }))
    .optional(),
});

// Open-Meteo finds towns, not street addresses, so "ul. Polna 3, Piława Górna" is looked up by its last parts first.
export const geocodePlace = async (address: string): Promise<(Coordinates & { label: string }) | null> => {
  const parts = address
    .split(",")
    .map((part) => part.replace(/\d{2}-\d{3}/, "").trim())
    .filter(Boolean);
  const candidates = [...new Set([parts.at(-1), parts.at(-2), address.trim()].filter((part): part is string => Boolean(part)))];
  for (const name of candidates) {
    const query = new URLSearchParams({ name, count: "1", language: "pl", countryCode: "PL", format: "json" });
    const { results } = geocodeSchema.parse(await getJson(`${config.weatherGeocodingUrl}?${query}`));
    const place = results?.[0];
    if (place) return { lat: place.latitude, lon: place.longitude, label: [place.name, place.admin1].filter(Boolean).join(", ") };
  }
  return null;
};

export const isCoordinates = (lat: unknown, lon: unknown): boolean =>
  typeof lat === "number" && typeof lon === "number" && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
