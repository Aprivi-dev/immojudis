import { describe, expect, it, vi } from "vitest";
import { warmSalePages } from "./sale-page-warmup";

const ID = "005a914d-563c-427b-88a4-740cbf851afb";
const OTHER_ID = "11111111-2222-4333-8444-555555555555";
const PRODUCTION = { SITE_URL: "https://immojudis.com", VERCEL_ENV: "production" };

function page(status = 200, cache = "MISS") {
  return new Response("<html></html>", { status, headers: { "x-vercel-cache": cache } });
}

describe("warmSalePages", () => {
  it("requests each page once on the public origin, with a short time limit", async () => {
    const fetchImpl = vi.fn(async () => page());
    const log = vi.fn();

    const summary = await warmSalePages([ID, OTHER_ID, ID.toUpperCase()], {
      env: PRODUCTION,
      fetchImpl,
      log,
    });

    expect(summary).toEqual({ requested: 2, warmed: 2, failed: 0 });
    expect(fetchImpl.mock.calls.map(([url]) => url).sort()).toEqual(
      [`https://immojudis.com/sales/${ID}`, `https://immojudis.com/sales/${OTHER_ID}`].sort(),
    );
    for (const [, init] of fetchImpl.mock.calls as unknown as [string, RequestInit][]) {
      expect(init.method).toBe("GET");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "warmed", saleId: ID }));
    expect(log).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: "done", requested: 2, warmed: 2 }),
    );
  });

  it("uses the production domain, never the address of the deployment", async () => {
    const fetchImpl = vi.fn(async () => page());
    await warmSalePages([ID], {
      env: { ...PRODUCTION, VERCEL_URL: "immojudis-abc123.vercel.app" },
      fetchImpl,
      log: vi.fn(),
    });
    expect(fetchImpl.mock.calls[0]).toEqual([
      `https://immojudis.com/sales/${ID}`,
      expect.anything(),
    ]);
  });

  it("does nothing, and says so, when no origin is configured or the origin is invalid", async () => {
    const fetchImpl = vi.fn(async () => page());
    const log = vi.fn();

    await expect(warmSalePages([ID], { env: {}, fetchImpl, log })).resolves.toMatchObject({
      skipped: "origin-not-configured",
    });
    await expect(
      warmSalePages([ID], { env: { SITE_URL: "https://immojudis.com/chemin" }, fetchImpl, log }),
    ).resolves.toMatchObject({ skipped: "origin-invalid" });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("requests nothing for an empty list", async () => {
    const fetchImpl = vi.fn(async () => page());
    await expect(warmSalePages([], { env: PRODUCTION, fetchImpl, log: vi.fn() })).resolves.toEqual({
      requested: 0,
      warmed: 0,
      failed: 0,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("logs a failure or a timeout and carries on with the other pages, without retrying", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith(ID)) throw new DOMException("timeout", "TimeoutError");
      return page(503);
    });
    const log = vi.fn();

    const summary = await warmSalePages([ID, OTHER_ID], { env: PRODUCTION, fetchImpl, log });

    expect(summary).toEqual({ requested: 2, warmed: 0, failed: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "failed", saleId: ID, error: "TimeoutError" }),
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "failed", saleId: OTHER_ID, status: 503 }),
    );
  });

  it("counts a 404 as a warmed page: the sale left the catalogue and its 404 is cached", async () => {
    const fetchImpl = vi.fn(async () => page(404, "MISS"));
    await expect(
      warmSalePages([ID], { env: PRODUCTION, fetchImpl, log: vi.fn() }),
    ).resolves.toMatchObject({ warmed: 1, failed: 0 });
  });

  it("really gives up after the time limit", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );

    const summary = await warmSalePages([ID], {
      env: PRODUCTION,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 20,
      log: vi.fn(),
    });

    expect(summary.failed).toBe(1);
  });

  it("never has more than four pages in flight", async () => {
    const ids = Array.from(
      { length: 30 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return page();
    });

    const summary = await warmSalePages(ids, { env: PRODUCTION, fetchImpl, log: vi.fn() });

    expect(summary.warmed).toBe(30);
    expect(fetchImpl).toHaveBeenCalledTimes(30);
    expect(peak).toBeLessThanOrEqual(4);
  });
});
