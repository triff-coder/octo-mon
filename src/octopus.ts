import { addDaysToDateKey, londonMidnightUtc } from "./time";
import { getJson, putJson } from "./cache";
import type { AgileRate, Env, KrakenJwtCache, TelemetryPoint } from "./types";

const GRAPHQL_ENDPOINT = "https://api.octopus.energy/v1/graphql/";
const REST_BASE = "https://api.octopus.energy/v1";

const KRAKEN_JWT_KV_KEY = "kraken:jwt";
const KRAKEN_JWT_REFRESH_BUFFER_SECONDS = 5 * 60;
// obtainKrakenToken doesn't return an explicit expiry; Kraken JWTs are
// documented as short-lived (~1hr), so we assume a conservative lifetime and
// re-authenticate well before it could actually expire.
const ASSUMED_JWT_LIFETIME_SECONDS = 50 * 60;

interface GraphQlError {
  message: string;
}

interface GraphQlResponse<T> {
  data?: T;
  errors?: GraphQlError[];
}

async function graphqlRequest<T>(
  jwt: string | null,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (jwt) headers.Authorization = `JWT ${jwt}`;

  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Octopus GraphQL request failed: HTTP ${response.status}`);
  }

  const body = (await response.json()) as GraphQlResponse<T>;
  if (body.errors?.length) {
    throw new Error(
      `Octopus GraphQL request returned errors: ${body.errors.map((e) => e.message).join("; ")}`,
    );
  }
  if (!body.data) {
    throw new Error("Octopus GraphQL request returned no data");
  }
  return body.data;
}

const OBTAIN_KRAKEN_TOKEN_MUTATION = `
  mutation ObtainKrakenToken($apiKey: String!) {
    obtainKrakenToken(input: { APIKey: $apiKey }) {
      token
    }
  }
`;

/**
 * Returns a valid Kraken JWT, reusing a cached one from KV when it isn't
 * close to expiry, otherwise re-authenticating with the Octopus API key.
 */
export async function obtainKrakenJwt(env: Env, now: Date = new Date()): Promise<string> {
  const cached = await getJson<KrakenJwtCache>(env.OCTOMON_KV, KRAKEN_JWT_KV_KEY);
  if (cached) {
    const msRemaining = new Date(cached.expiresAt).getTime() - now.getTime();
    if (msRemaining > KRAKEN_JWT_REFRESH_BUFFER_SECONDS * 1000) {
      return cached.token;
    }
  }

  const data = await graphqlRequest<{ obtainKrakenToken: { token: string } | null }>(
    null,
    OBTAIN_KRAKEN_TOKEN_MUTATION,
    { apiKey: env.OCTOPUS_API_KEY },
  );

  const token = data.obtainKrakenToken?.token;
  if (!token) {
    throw new Error("obtainKrakenToken returned no token");
  }

  const expiresAt = new Date(now.getTime() + ASSUMED_JWT_LIFETIME_SECONDS * 1000).toISOString();
  const jwtCache: KrakenJwtCache = { token, expiresAt };
  await putJson(env.OCTOMON_KV, KRAKEN_JWT_KV_KEY, jwtCache, {
    expirationTtl: ASSUMED_JWT_LIFETIME_SECONDS,
  });

  return token;
}

const SMART_METER_TELEMETRY_QUERY = `
  query SmartMeterTelemetry($deviceId: String!, $start: DateTime!, $end: DateTime!) {
    smartMeterTelemetry(
      deviceId: $deviceId
      grouping: TEN_SECONDS
      start: $start
      end: $end
    ) {
      readAt
      demand
      consumptionDelta
    }
  }
`;

interface RawTelemetryPoint {
  readAt: string;
  // Documented as "instant power draw, in Watts"; observed as either a
  // number or a numeric string depending on client, so parse defensively.
  demand: string | number | null;
  // Energy consumed since the previous point, in Wh.
  consumptionDelta: string | number | null;
}

/**
 * Fetches smart-meter telemetry points for the configured Home Mini device
 * between `start` and `end`, sorted ascending by reading time. Each point
 * carries both the instantaneous demand (for "current £/hr") and the energy
 * consumed since the previous point (for accumulating "today's total").
 */
export async function fetchTelemetry(
  env: Env,
  jwt: string,
  start: Date,
  end: Date = new Date(),
): Promise<TelemetryPoint[]> {
  const data = await graphqlRequest<{ smartMeterTelemetry: RawTelemetryPoint[] | null }>(
    jwt,
    SMART_METER_TELEMETRY_QUERY,
    { deviceId: env.OCTOPUS_DEVICE_ID, start: start.toISOString(), end: end.toISOString() },
  );

  const points = data.smartMeterTelemetry ?? [];

  return points
    .map((p): TelemetryPoint => {
      const demandWatts = Number(p.demand);
      const consumptionDeltaWh = Number(p.consumptionDelta);
      return {
        readAt: p.readAt,
        demandKw: Number.isFinite(demandWatts) ? demandWatts / 1000 : 0,
        consumptionDeltaKwh: Number.isFinite(consumptionDeltaWh) ? consumptionDeltaWh / 1000 : 0,
      };
    })
    .sort((a, b) => new Date(a.readAt).getTime() - new Date(b.readAt).getTime());
}

interface RawRateEntry {
  value_inc_vat: number;
  valid_from: string;
  valid_to: string | null;
}

interface RatesPage {
  next: string | null;
  results: RawRateEntry[];
}

const MAX_RATE_PAGES = 5;

/**
 * Fetches and caches the published Agile standard unit rates covering the
 * Europe/London calendar day identified by `dateKey`. Rates for a day are
 * immutable once published, so this is cached in KV for hours rather than
 * seconds.
 */
export async function fetchAgileRatesForDay(env: Env, dateKey: string): Promise<AgileRate[]> {
  const cacheKey = `rates:${dateKey}`;
  const cached = await getJson<AgileRate[]>(env.OCTOMON_KV, cacheKey);
  if (cached) return cached;

  const periodFrom = londonMidnightUtc(dateKey).toISOString();
  const periodTo = londonMidnightUtc(addDaysToDateKey(dateKey, 1)).toISOString();

  const results: RawRateEntry[] = [];
  let url: string | null =
    `${REST_BASE}/products/${env.OCTOPUS_PRODUCT_CODE}/electricity-tariffs/${env.OCTOPUS_TARIFF_CODE}` +
    `/standard-unit-rates/?period_from=${encodeURIComponent(periodFrom)}&period_to=${encodeURIComponent(periodTo)}`;

  for (let page = 0; url && page < MAX_RATE_PAGES; page++) {
    const response: Response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Octopus standard-unit-rates request failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as RatesPage;
    results.push(...body.results);
    url = body.next;
  }

  const rates: AgileRate[] = results
    .filter((r): r is RawRateEntry & { valid_to: string } => r.valid_to !== null)
    .map((r) => ({
      pencePerKwh: r.value_inc_vat,
      validFrom: r.valid_from,
      validTo: r.valid_to,
    }))
    .sort((a, b) => new Date(a.validFrom).getTime() - new Date(b.validFrom).getTime());

  // Cache for 6 hours: long enough to avoid re-fetching on every cron tick,
  // short enough that a same-day product rollover or correction is picked
  // up within a working day.
  await putJson(env.OCTOMON_KV, cacheKey, rates, { expirationTtl: 6 * 60 * 60 });

  return rates;
}
