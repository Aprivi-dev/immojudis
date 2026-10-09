import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { PublicApiError, RateLimitError, isPublicErrorMessage } from "./api-errors";
import { apiRouteError } from "./api-observability";

function request() {
  return new Request("https://example.test/api/thing", {
    headers: { "x-request-id": "req-12345678" },
  });
}

describe("isPublicErrorMessage", () => {
  it("lets short French business messages through", () => {
    expect(isPublicErrorMessage("Vente introuvable.")).toBe(true);
    expect(isPublicErrorMessage("Cette invitation n'est plus disponible.")).toBe(true);
    expect(isPublicErrorMessage("Estimation de marché réservée au plan Analyse.")).toBe(true);
  });

  it("blocks driver, database and runtime messages", () => {
    for (const message of [
      'duplicate key value violates unique constraint "auction_sales_pkey"',
      'relation "public.user_profiles" does not exist',
      "JWT expired",
      "fetch failed",
      "connect ECONNREFUSED 10.0.0.1:5432",
      "Missing Supabase environment variable(s): SUPABASE_URL",
      "Cannot read properties of undefined (reading 'id')",
      "Erreur Postgres : la relation public.x n'existe pas",
      "Échec de l'appel https://api.stripe.com/v1/customers",
      "",
      "x".repeat(300),
    ]) {
      expect(isPublicErrorMessage(message), message).toBe(false);
    }
  });
});

describe("apiRouteError", () => {
  afterEach(() => vi.restoreAllMocks());

  it("never returns the message of an unexpected error and exposes a request id", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = apiRouteError(
      new Error('column "raw_payload" does not exist'),
      request(),
      "test.scope",
      { fallbackMessage: "Liste indisponible.", extra: { items: [] } },
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      items: [],
      ok: false,
      error: "Liste indisponible.",
      code: "INTERNAL_ERROR",
      requestId: "req-12345678",
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.stringify(body)).not.toContain("raw_payload");
    expect(String(errorLog.mock.calls[0]?.[0])).toContain("raw_payload");
  });

  it("does not leak the detail of a non-Error database object", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = apiRouteError(
      { code: "42501", message: "permission denied for table auction_sales" },
      request(),
      "test.scope",
      { fallbackMessage: "Action impossible." },
    );

    expect(JSON.stringify(await response.json())).not.toContain("auction_sales");
  });

  it("keeps French business messages and maps them to meaningful statuses", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const forbidden = apiRouteError(
      new Error("Export PDF réservé au plan Analyse."),
      request(),
      "test.scope",
      { fallbackMessage: "Export impossible." },
    );
    const missing = apiRouteError(new Error("Rapport introuvable."), request(), "test.scope", {
      fallbackMessage: "Rapport indisponible.",
    });
    const business = apiRouteError(
      new Error("Cette invitation n'est plus disponible."),
      request(),
      "test.scope",
      { fallbackMessage: "Action impossible." },
    );

    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error).toBe("Export PDF réservé au plan Analyse.");
    expect(missing.status).toBe(404);
    expect(business.status).toBe(400);
    expect((await business.json()).error).toBe("Cette invitation n'est plus disponible.");
  });

  it("answers authentication failures with a generic 401", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = apiRouteError(
      new Error("Unauthorized: User access profile unavailable (relation x)"),
      request(),
      "test.scope",
      { fallbackMessage: "Action impossible." },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: "Authentification requise.",
      code: "AUTH_REQUIRED",
    });
  });

  it("maps invalid input to 400 without echoing the validation payload", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = apiRouteError(new ZodError([]), request(), "test.scope", {
      fallbackMessage: "Action impossible.",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Requête invalide.",
      code: "INVALID_REQUEST",
    });
  });

  it("returns 429 with Retry-After for a rate limit error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = apiRouteError(new RateLimitError(undefined, 42), request(), "test.scope", {
      fallbackMessage: "Action impossible.",
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    expect(await response.json()).toMatchObject({ code: "RATE_LIMITED" });
  });

  it("honours the status of a PublicApiError", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = apiRouteError(
      new PublicApiError("Le dossier a changé. Rechargez la page.", 409),
      request(),
      "test.scope",
      { fallbackMessage: "Action impossible." },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "CONFLICT",
      error: "Le dossier a changé. Rechargez la page.",
    });
  });
});
