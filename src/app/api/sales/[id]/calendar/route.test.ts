import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  enforceIp: vi.fn(),
  rpc: vi.fn(),
  client: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({ enforceIpRateLimit: mocks.enforceIp }));
vi.mock("@/lib/supabase-public.server", () => ({ createPublicSupabaseClient: mocks.client }));

import { GET } from "./route";

const saleId = "11111111-1111-4111-8111-111111111111";

function call(id = saleId) {
  return GET(new Request(`https://example.test/api/sales/${id}/calendar`), {
    params: Promise.resolve({ id }),
  });
}

function rpcRow(overrides: Record<string, unknown> = {}) {
  return {
    id: saleId,
    exportable: true,
    sale_date: "2026-10-20T07:30:00+00:00",
    date_only: false,
    property_type: "apartment",
    city: "Bordeaux",
    tribunal_name: "TJ Bordeaux",
    tribunal_city: "Bordeaux",
    updated_at: "2026-10-14T08:00:00+00:00",
    ...overrides,
  };
}

describe("GET /api/sales/[id]/calendar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SITE_URL", "https://www.immojudis.example");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.enforceIp.mockResolvedValue(undefined);
    mocks.client.mockReturnValue({ rpc: mocks.rpc });
    mocks.rpc.mockResolvedValue({ data: [rpcRow()], error: null });
  });

  it("serves the calendar file to a signed-out visitor, not indexed", async () => {
    const response = await call();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="immojudis-audience-11111111.ics"',
    );
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const body = (await response.text()).replace(/\r\n /g, "");
    expect(body).toContain("BEGIN:VCALENDAR\r\n");
    expect(body).toContain("DTSTART:20261020T073000Z");
    expect(body).toContain(`URL:https://www.immojudis.example/sales/${saleId}`);
    expect(body).toContain(`UID:sale-${saleId}@www.immojudis.example`);
    expect(mocks.rpc).toHaveBeenCalledWith("get_public_sale_calendar_event", {
      p_sale_id: saleId,
    });
  });

  it("keeps the file one minute in the CDN and does not echo the request id on it", async () => {
    const response = await GET(
      new Request(`https://example.test/api/sales/${saleId}/calendar`, {
        headers: { "x-request-id": "req-agenda-1" },
      }),
      { params: Promise.resolve({ id: saleId }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=60, stale-while-revalidate=60",
    );
    // A shared cache would serve the id of the first request to every other visitor.
    expect(response.headers.has("x-request-id")).toBe(false);
  });

  it("still returns the request id on an error, which is never cached", async () => {
    const response = await GET(
      new Request(`https://example.test/api/sales/${saleId}/calendar`, {
        headers: { "x-request-id": "req-agenda-2" },
      }),
      { params: Promise.resolve({ id: "pas-un-uuid" }) },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-request-id")).toBe("req-agenda-2");
  });

  it("limits the number of requests per IP address", async () => {
    await call();
    expect(mocks.enforceIp).toHaveBeenCalledWith(
      expect.objectContaining({ bucketKey: "sales.calendar", limit: 60, windowSeconds: 60 }),
    );

    mocks.enforceIp.mockRejectedValue(new RateLimitError(undefined, 42));
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("42");
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("refuses a date the database does not consider reliable (postponed, conflict, unverified)", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        rpcRow({
          exportable: false,
          sale_date: null,
          date_only: null,
          property_type: null,
          city: null,
          tribunal_name: null,
          tribunal_city: null,
          updated_at: null,
        }),
      ],
      error: null,
    });

    const response = await call();

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).not.toContain("text/calendar");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "CONFLICT",
      error: expect.stringContaining("n’est pas confirmée"),
    });
  });

  it("answers an all-day event when the hour is unknown", async () => {
    mocks.rpc.mockResolvedValue({
      data: [rpcRow({ sale_date: "2026-10-22T22:00:00+00:00", date_only: true })],
      error: null,
    });

    const body = await (await call()).text();

    expect(body).toContain("DTSTART;VALUE=DATE:20261023");
    expect(body).not.toMatch(/DTSTART:/);
  });

  it("answers 404 for a sale that is not public or does not exist", async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    expect((await call()).status).toBe(404);
  });

  it("answers 404 for an identifier that is not a UUID, without querying the database", async () => {
    const response = await call("pas-un-uuid");
    expect(response.status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("exports nothing when the database function is not deployed yet", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function" },
    });
    const response = await call();
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).not.toContain("text/calendar");
  });

  it("answers 503 when the database is not configured", async () => {
    mocks.client.mockReturnValue(null);
    expect((await call()).status).toBe(503);
  });

  it("does not leak a database error", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "XX000", message: "connection to server at 10.0.0.1 failed" },
    });
    const response = await call();
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("10.0.0.1");
  });
});
