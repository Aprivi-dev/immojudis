import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchAdminInformationAgentEvidenceUrlClient,
  updateAdminInformationAgentEvidenceRightsClient,
} from "./client-api";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), fetch: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: mocks.getSession } },
}));

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("information-agent evidence client", () => {
  beforeEach(() => {
    mocks.getSession.mockReset();
    mocks.fetch.mockReset();
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: "test-access-token" } },
    });
    vi.stubGlobal("fetch", mocks.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves the authenticated short-lived URL without exposing a storage path", async () => {
    mocks.fetch.mockResolvedValue(
      jsonResponse({ signedUrl: "https://storage.example.test/signed-document" }),
    );

    await expect(fetchAdminInformationAgentEvidenceUrlClient("asset/1")).resolves.toBe(
      "https://storage.example.test/signed-document",
    );
    expect(mocks.fetch).toHaveBeenCalledWith(
      "/api/admin/information-agent/evidence/asset%2F1?format=json",
      expect.objectContaining({
        headers: { Authorization: "Bearer test-access-token" },
        cache: "no-store",
      }),
    );
  });

  it("surfaces API errors when a private attachment cannot be opened", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({ error: "Pièce introuvable." }, 404));

    await expect(fetchAdminInformationAgentEvidenceUrlClient("asset-1")).rejects.toThrow(
      "Pièce introuvable.",
    );
  });

  it("sends a traceable rights decision through the existing admin route", async () => {
    mocks.fetch.mockResolvedValue(
      jsonResponse({
        ok: true,
        asset: { id: "asset-1", rights_status: "restricted", review_status: "pending" },
      }),
    );

    await expect(
      updateAdminInformationAgentEvidenceRightsClient({
        assetId: "asset-1",
        rightsStatus: "restricted",
        notes: "Aucune autorisation de diffusion reçue",
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(mocks.fetch).toHaveBeenCalledWith("/api/admin/information-agent/evidence/asset-1", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-access-token",
      },
      body: JSON.stringify({
        rightsStatus: "restricted",
        notes: "Aucune autorisation de diffusion reçue",
      }),
    });
  });
});
