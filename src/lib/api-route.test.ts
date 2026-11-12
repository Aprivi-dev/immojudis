import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthRequiredError, ForbiddenError, NotFoundError } from "@/lib/api-errors";
import { apiRoute } from "./api-route";

const request = (headers: HeadersInit = {}) =>
  new Request("https://example.test/api/x", { headers });
const failing = (error: unknown) =>
  apiRoute({ scope: "api.test", fallbackMessage: "Diagnostic indisponible" }, async () => {
    throw error;
  });

describe("apiRoute", () => {
  afterEach(() => vi.restoreAllMocks());

  it("garde les statuts d'autorisation, avec un message générique et un identifiant de requête", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unauthorized = await failing(new AuthRequiredError("Unauthorized: session required"))(
      request(),
    );
    const forbidden = await failing(new ForbiddenError("Réservé"))(request());
    const notFound = await failing(new NotFoundError("Introuvable"))(request());

    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({
      ok: false,
      error: "Authentification requise.",
      code: "AUTH_REQUIRED",
      requestId: expect.any(String),
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("x-request-id")).toEqual(expect.any(String));
    expect(notFound.status).toBe(404);
  });

  it("répond 500 avec le message de la route pour une panne inconnue", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await failing(null)(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "Diagnostic indisponible" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("authorization");
  });

  it("garde le détail de la base dans le journal et hors de la réponse, sous l'identifiant reçu", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await failing(
      new Error('duplicate key value violates unique constraint "auction_sales_pkey"'),
    )(request({ "x-request-id": "support-12345678" }));
    const body = await response.json();

    expect(body).toEqual({
      ok: false,
      error: "Diagnostic indisponible",
      code: "INTERNAL_ERROR",
      requestId: "support-12345678",
    });
    expect(String(errorLog.mock.calls[0]?.[0])).toContain("auction_sales_pkey");
  });

  it("journalise le succès, le rend privé et y renvoie l'identifiant de requête", async () => {
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const route = apiRoute({ scope: "api.test", fallbackMessage: "x" }, async () => ({
      items: [1],
    }));
    const response = await route(request({ "x-request-id": "client-12345678" }));

    expect(await response.json()).toEqual({ items: [1] });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-request-id")).toBe("client-12345678");
    expect(JSON.parse(String(infoLog.mock.calls[0]?.[0]))).toMatchObject({
      scope: "api.test",
      status: 200,
    });
  });

  it("laisse un cache public posé par la route et n'y répète pas l'identifiant de requête", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const route = apiRoute({ scope: "api.test", fallbackMessage: "x" }, async () =>
      Response.json({ ok: true }, { headers: { "cache-control": "public, s-maxage=60" } }),
    );
    const response = await route(request({ "x-request-id": "client-12345678" }));

    expect(response.headers.get("cache-control")).toBe("public, s-maxage=60");
    expect(response.headers.get("x-request-id")).toBeNull();
    expect(response.headers.get("vary")).toBeNull();
  });

  it("fusionne la forme de succès vide dans le corps d'erreur", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const route = apiRoute(
      { scope: "api.test", fallbackMessage: "x", emptyBody: { favorites: [] } },
      async () => {
        throw new Error("boom");
      },
    );
    expect(await (await route(request())).json()).toMatchObject({ ok: false, favorites: [] });
  });
});
