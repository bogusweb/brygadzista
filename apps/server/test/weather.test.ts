import { afterEach, describe, expect, it, vi } from "vitest";
import { describeWeather, fetchDayWeather, geocodePlace, skyLabel } from "../src/weather.js";

const daily = (day: string, values: (number | null)[]) => ({
  daily: {
    time: [day],
    weather_code: [values[0]],
    temperature_2m_max: [values[1]],
    temperature_2m_min: [values[2]],
    precipitation_sum: [values[3]],
    wind_speed_10m_max: [values[4]],
  },
});

const respond = (...bodies: unknown[]) => {
  const fetch = vi.fn<(url: string) => Promise<Response>>();
  for (const body of bodies) fetch.mockResolvedValueOnce(new Response(JSON.stringify(body)));
  vi.stubGlobal("fetch", fetch);
  return fetch;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("skyLabel", () => {
  it("names WMO codes in Polish", () => {
    expect(skyLabel(0)).toBe("bezchmurnie");
    expect(skyLabel(63)).toBe("deszcz");
    expect(skyLabel(1234)).toBe("brak opisu");
  });
});

describe("fetchDayWeather", () => {
  const place = { lat: 50.68, lon: 16.74 };
  const today = new Date("2026-10-22T10:00:00Z");

  it("asks the forecast API for a recent day", async () => {
    const fetch = respond(daily("2026-10-21", [63, 14.7, 8.24, 3.2, 24.6]));
    const weather = await fetchDayWeather(place, "2026-10-21", today);
    expect(weather).toEqual({ code: 63, sky: "deszcz", tempMin: 8.2, tempMax: 14.7, precipitationMm: 3.2, windMaxKmh: 24.6, source: "open-meteo" });
    expect(fetch.mock.calls[0]![0]).toContain("api.open-meteo.com/v1/forecast");
    expect(fetch.mock.calls[0]![0]).toContain("start_date=2026-10-21");
    expect(describeWeather(weather!)).toBe("deszcz, 8,2–14,7 °C, opad 3,2 mm, wiatr do 25 km/h");
  });

  it("goes to the archive for an old day and falls back to the forecast when it has nothing", async () => {
    const fetch = respond(daily("2026-09-01", [null, null, null, null, null]), daily("2026-09-01", [0, 20, 10, 0, 5]));
    const weather = await fetchDayWeather(place, "2026-09-01", today);
    expect(fetch.mock.calls[0]![0]).toContain("archive-api.open-meteo.com");
    expect(fetch.mock.calls[1]![0]).toContain("/v1/forecast");
    expect(weather && describeWeather(weather)).toBe("bezchmurnie, 10–20 °C, bez opadu, wiatr do 5 km/h");
  });

  it("returns null when neither API has the day", async () => {
    respond(daily("2027-01-01", [null, null, null, null, null]), daily("2027-01-01", [null, null, null, null, null]));
    expect(await fetchDayWeather(place, "2027-01-01", today)).toBeNull();
  });
});

describe("geocodePlace", () => {
  it("looks up the town from the end of an address", async () => {
    const fetch = respond({ results: [] }, { results: [{ name: "Piława Górna", latitude: 50.68, longitude: 16.74, admin1: "Województwo dolnośląskie" }] });
    const place = await geocodePlace("Piława Górna, ul. Polna 3, 58-240");
    expect(place).toEqual({ lat: 50.68, lon: 16.74, label: "Piława Górna, Województwo dolnośląskie" });
    expect(decodeURIComponent(fetch.mock.calls[0]![0])).toContain("name=ul.+Polna+3");
  });
});
