import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ prepare: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/information-agent-contribution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/information-agent-contribution")>()),
  prepareInformationAgentContributionUpload: mocks.prepare,
}));

import { InformationAgentContributionError } from "@/lib/information-agent-contribution";
import { POST } from "./route";

const MISSION_ID = "11111111-1111-4111-8111-111111111111";
const params = { params: Promise.resolve({ missionId: MISSION_ID }) };

function body(overrides: Record<string, unknown> = {}) {
  return {
    token: "a".repeat(64),
    filename: "pv.pdf",
    mimeType: "application/pdf",
    size: 1234,
    ...overrides,
  };
}

function post(payload: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request(
      `https://immojudis.example/api/information-agent/contributions/${MISSION_ID}/upload`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof payload === "string" ? payload : JSON.stringify(payload),
      },
    ),
    params,
  );
}

beforeEach(() => {
  mocks.prepare.mockReset().mockResolvedValue({
    bucket: "information-agent-evidence",
    path: "case/portal/file/pv.pdf",
    token: "signed-upload-token",
    ticket: `1234567890123.${"b".repeat(64)}`,
    remainingBytes: 1,
    remainingFiles: 11,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/information-agent/contributions/[missionId]/upload", () => {
  it("prépare le dépôt d'une pièce sans mise en cache", async () => {
    const response = await post(body());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      path: "case/portal/file/pv.pdf",
      remainingFiles: 11,
    });
    expect(mocks.prepare).toHaveBeenCalledWith({
      missionId: MISSION_ID,
      input: { token: "a".repeat(64), filename: "pv.pdf", mimeType: "application/pdf", size: 1234 },
    });
  });

  it.each([
    ["un jeton mal formé", { token: "court" }],
    ["un nom vide", { filename: "   " }],
    ["un nom de plus de 180 caractères", { filename: `${"n".repeat(181)}.pdf` }],
    ["un fichier vide", { size: 0 }],
    ["un fichier de plus de 20 Mo", { size: 20 * 1024 * 1024 + 1 }],
  ])("refuse en 400 %s, sans réserver de capacité", async (_label, change) => {
    const response = await post(body(change));

    expect(response.status).toBe(400);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("refuse un corps trop volumineux avant de le lire", async () => {
    const response = await post(body(), { "content-length": String(65 * 1024) });

    expect(response.status).toBe(413);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("transmet 429 quand la limite de dépôts du dossier est atteinte", async () => {
    mocks.prepare.mockRejectedValue(
      new InformationAgentContributionError("Limite de dépôts atteinte pour ce dossier.", 429),
    );

    const response = await post(body());

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "Limite de dépôts atteinte pour ce dossier." });
  });

  it("répond 404 pour un lien invalide, sans le journaliser comme une panne", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.prepare.mockRejectedValue(
      new InformationAgentContributionError("Lien de dépôt invalide ou expiré.", 404),
    );

    expect((await post(body())).status).toBe(404);
    expect(log).not.toHaveBeenCalled();
  });

  it("journalise une panne de Storage sans le nom du fichier et répond 500", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.prepare.mockRejectedValue(
      Object.assign(new Error("Storage failed for portal/cabinet-dupont-pv.pdf"), { code: "S3" }),
    );

    const response = await post(body());

    expect(response.status).toBe(500);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("information-agent.contribution.upload");
    expect(line).not.toContain("dupont");
  });
});
