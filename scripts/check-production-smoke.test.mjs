import { describe, expect, it } from "vitest";

import { checkProductionSmoke } from "./check-production-smoke.mjs";

const UNKNOWN_SALE = "/sales/00000000-0000-4000-8000-000000000000";

function page(path, { canonical } = {}) {
  const link = canonical ? `<link rel="canonical" href="https://immojudis.com${canonical}">` : "";
  return `<html><head>${link}</head><body>Immojudis ${path}</body></html>`;
}

/** A fake production: `overrides` replaces the answer of one path. */
function fakeFetch(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { pathname, search } = new URL(url);
    const path = `${pathname}${search}`;
    calls.push(path);
    const requestId = init.headers["x-request-id"];
    const headers = (contentType) => ({
      get: (name) =>
        ({ "x-request-id": requestId, "content-type": contentType })[name.toLowerCase()] ?? null,
    });
    const override = overrides[path];
    if (override) return override(headers);
    if (path === UNKNOWN_SALE) {
      return {
        status: 404,
        headers: headers("text/html; charset=utf-8"),
        body: { cancel: async () => undefined },
      };
    }
    if (path.startsWith("/api/lawyers")) {
      return {
        status: 200,
        headers: headers("application/json"),
        json: async () => ({ lawyers: [] }),
      };
    }
    const canonical = ["/", "/sales", "/annonce-exemple"].includes(path) ? path : undefined;
    return {
      status: 200,
      headers: headers("text/html; charset=utf-8"),
      text: async () => page(path, { canonical }),
    };
  };
  return { fetchImpl, calls };
}

describe("production smoke test", () => {
  it("passes when an unknown sale answers a real 404", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const report = await checkProductionSmoke({ origin: "https://immojudis.com", fetchImpl });

    expect(calls).toContain(UNKNOWN_SALE);
    expect(report.checks.find((check) => check.path === UNKNOWN_SALE)?.status).toBe(404);
  });

  it("fails when an unknown sale answers 200 (soft 404)", async () => {
    const { fetchImpl } = fakeFetch({
      [UNKNOWN_SALE]: (headers) => ({
        status: 200,
        headers: headers("text/html; charset=utf-8"),
        text: async () => page(UNKNOWN_SALE),
      }),
    });

    await expect(
      checkProductionSmoke({ origin: "https://immojudis.com", fetchImpl }),
    ).rejects.toThrow(`${UNKNOWN_SALE}: statut HTTP 200 au lieu de 404.`);
  });

  it("still requires a 200 on the other pages", async () => {
    const { fetchImpl } = fakeFetch({
      "/legal": (headers) => ({
        status: 404,
        headers: headers("text/html"),
        text: async () => "",
      }),
    });

    await expect(
      checkProductionSmoke({ origin: "https://immojudis.com", fetchImpl }),
    ).rejects.toThrow("/legal: statut HTTP 404 au lieu de 200.");
  });
});
