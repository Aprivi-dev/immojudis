import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ submit: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/information-agent-contribution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/information-agent-contribution")>()),
  submitInformationAgentContribution: mocks.submit,
}));

import { InformationAgentContributionError } from "@/lib/information-agent-contribution";
import { POST } from "./route";

const MISSION_ID = "11111111-1111-4111-8111-111111111111";
const params = { params: Promise.resolve({ missionId: MISSION_ID }) };

function body(overrides: Record<string, unknown> = {}) {
  return {
    token: "a".repeat(64),
    submissionId: "22222222-2222-4222-8222-222222222222",
    senderName: "Cabinet Dupont",
    senderEmail: "cabinet@example.test",
    note: "La visite est possible sur rendez-vous.",
    externalLinks: [],
    authorizedToTransmit: true,
    files: [],
    ...overrides,
  };
}

function post(payload: unknown) {
  return POST(
    new Request(
      `https://immojudis.example/api/information-agent/contributions/${MISSION_ID}/submit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof payload === "string" ? payload : JSON.stringify(payload),
      },
    ),
    params,
  );
}

beforeEach(() => {
  mocks.submit.mockReset().mockResolvedValue({ messageId: "m-1", assetCount: 2, opposed: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/information-agent/contributions/[missionId]/submit", () => {
  it("enregistre le dépôt et répond 201 sans mise en cache", async () => {
    const response = await post(body());

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      ok: true,
      messageId: "m-1",
      assetCount: 2,
      opposed: false,
    });
    expect(mocks.submit).toHaveBeenCalledWith({
      missionId: MISSION_ID,
      input: expect.objectContaining({ senderEmail: "cabinet@example.test", files: [] }),
    });
  });

  it.each([
    ["senderEmail", { senderEmail: "a@b.c" }, "adresse e-mail"],
    ["senderName", { senderName: "N".repeat(181) }, "180 caractères"],
    ["note", { note: "x".repeat(10_001) }, "Raccourcissez"],
    [
      "externalLinks",
      { externalLinks: [`https://example.test/${"a".repeat(2100)}`] },
      "Un lien dépasse",
    ],
    [
      "externalLinks",
      { externalLinks: Array.from({ length: 6 }, () => "https://example.test") },
      "au maximum 5",
    ],
    ["authorizedToTransmit", { authorizedToTransmit: false }, "Confirmez"],
  ])("refuse en 400 en désignant le champ %s", async (field, change, fragment) => {
    const response = await post(body(change));

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string; field?: string };
    expect(payload.field).toBe(field);
    expect(payload.error).toContain(fragment);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("répond 400 pour un corps qui n'est pas du JSON, sans champ", async () => {
    const response = await post("pas du json");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Données de dépôt invalides." });
  });

  it("transmet le statut et le champ d'une erreur métier", async () => {
    mocks.submit.mockRejectedValue(
      new InformationAgentContributionError("Le dépôt dépasse 40 Mo au total.", 400, "files"),
    );

    const response = await post(body());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Le dépôt dépasse 40 Mo au total.",
      field: "files",
    });
  });

  it("répond 409 quand le dossier est fermé", async () => {
    mocks.submit.mockRejectedValue(
      new InformationAgentContributionError("Ce dossier est fermé.", 409),
    );

    expect((await post(body())).status).toBe(409);
  });

  it("journalise une erreur inattendue sans donnée personnelle et répond 500", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.submit.mockRejectedValue(
      Object.assign(new Error("insert failed for cabinet@example.test"), { code: "XX000" }),
    );

    const response = await post(body());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Service de dépôt indisponible." });
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("information-agent.contribution.submit");
    expect(line).toContain("XX000");
    expect(line).not.toContain("cabinet@example.test");
  });
});
