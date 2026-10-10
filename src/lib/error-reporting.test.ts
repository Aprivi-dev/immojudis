import { describe, expect, it, vi } from "vitest";
import { buildErrorEnvelope, parseDsn, reportError } from "./error-reporting";

const dsn = "https://publickey@o123.ingest.example.io/456";

describe("error reporting", () => {
  it("lit un DSN Sentry et en déduit l'adresse d'ingestion", () => {
    expect(parseDsn(dsn)).toEqual({
      publicKey: "publickey",
      endpoint:
        "https://o123.ingest.example.io/api/456/envelope/?sentry_version=7&sentry_key=publickey",
    });
    expect(parseDsn("")).toBeNull();
    expect(parseDsn(undefined)).toBeNull();
    expect(parseDsn("pas un dsn")).toBeNull();
  });

  it("n'envoie rien tant qu'aucun DSN n'est configuré", async () => {
    const fetchImpl = vi.fn();
    const result = await reportError(new Error("boom"), {}, { dsn: "", fetchImpl });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("envoie l'erreur avec le requestId, sans requête ni en-têtes", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const id = await reportError(
      new Error("échec de lecture"),
      {
        source: "route",
        route: "/api/sales/[id]?token=secret",
        requestId: "req-123",
        digest: "d1",
      },
      { dsn, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/456/envelope/");
    const lines = String(init.body).split("\n");
    const event = JSON.parse(lines[2]);
    expect(event.exception.values[0]).toMatchObject({ type: "Error", value: "échec de lecture" });
    expect(event.tags).toMatchObject({
      request_id: "req-123",
      digest: "d1",
      route: "/api/sales/[id]",
    });
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(JSON.stringify(event)).not.toMatch(/cookie|authorization/i);
  });

  it("ne lève jamais d'erreur quand l'envoi échoue", async () => {
    const failing = vi.fn(async () => {
      throw new Error("réseau");
    });
    await expect(
      reportError(new Error("x"), {}, { dsn, fetchImpl: failing as unknown as typeof fetch }),
    ).resolves.toBeNull();
    const refused = vi.fn(async () => new Response("", { status: 429 }));
    await expect(
      reportError(new Error("x"), {}, { dsn, fetchImpl: refused as unknown as typeof fetch }),
    ).resolves.toBeNull();
  });

  it("borne la taille du message", () => {
    const { body } = buildErrorEnvelope(new Error("a".repeat(5_000)));
    const event = JSON.parse(body.split("\n")[2]);
    expect(event.exception.values[0].value.length).toBe(1_000);
  });
});
