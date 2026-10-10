import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { reviewAdminInformationAgentFact } from "@/lib/admin-information-agent";

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  download: vi.fn(),
  remove: vi.fn(),
  rpc: vi.fn(),
  assetUpdate: vi.fn(),
  extractionStatus: vi.fn(),
  caseStatus: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: vi.fn().mockResolvedValue({ isAdmin: true, userId: "admin-1" }),
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const saleId = "11111111-1111-4111-8111-111111111111";
  const assetId = "22222222-2222-4222-8222-222222222222";
  const caseId = "33333333-3333-4333-8333-333333333333";
  const query = (table: string) => ({
    update: (payload: unknown) => ({
      eq: async () => {
        mocks.assetUpdate(table, payload);
        return { error: null };
      },
    }),
    select: () => ({
      eq: () => ({
        single: async () => ({
          data:
            table === "information_agent_fact_candidates"
              ? {
                  id: "fact-1",
                  fact_key: "photo",
                  evidence_asset_id: assetId,
                  case_id: caseId,
                  sale_id: saleId,
                  status: "pending",
                }
              : table === "information_agent_evidence_extractions"
                ? { status: mocks.extractionStatus() }
                : table === "information_agent_cases"
                  ? { status: mocks.caseStatus() }
                  : {
                      id: assetId,
                      storage_bucket: "information-agent-evidence",
                      storage_path: "private/photo.jpg",
                      mime_type: "image/jpeg",
                      rights_status: "authorized",
                      metadata: {
                        approved_public_path: `${saleId}/${assetId}/piece-jointe.jpg`,
                        approved_public_url: "https://example.test/old-photo.jpg",
                      },
                    },
          error: null,
        }),
      }),
    }),
  });
  return {
    supabaseAdmin: {
      from: query,
      storage: {
        from: (bucket: string) =>
          bucket === "information-agent-evidence"
            ? { download: mocks.download }
            : {
                upload: mocks.upload,
                remove: mocks.remove,
                getPublicUrl: (path: string) => ({
                  data: { publicUrl: `https://example.test/${path}` },
                }),
              },
      },
      rpc: mocks.rpc,
    },
  };
});

describe("admin photo publication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assetUpdate.mockReset();
    mocks.rpc.mockResolvedValue({ data: {}, error: null });
    mocks.upload.mockResolvedValue({ data: {}, error: null });
    mocks.remove.mockResolvedValue({ data: {}, error: null });
    mocks.extractionStatus.mockReturnValue("completed");
    mocks.caseStatus.mockReturnValue("review");
  });

  it("stages a unique WebP derivative before accepting the photo", async () => {
    const original = await sharp({
      create: { width: 2500, height: 1800, channels: 3, background: "#aabbcc" },
    })
      .jpeg()
      .toBuffer();
    mocks.download.mockResolvedValue({ data: new Blob([original]), error: null });

    await reviewAdminInformationAgentFact({
      authToken: "test-token",
      input: {
        factId: "fact-1",
        decision: "accepted",
        redactionConfirmed: true,
        redactionVerifiedBy: "Claire Martin",
      },
    });

    const stageCall = mocks.rpc.mock.calls.find(
      ([functionName]) => functionName === "stage_information_agent_evidence_publication",
    );
    const expectedPath = stageCall?.[1].p_public_path as string;
    expect(expectedPath).toMatch(
      /^11111111-1111-4111-8111-111111111111\/22222222-2222-4222-8222-222222222222\/photo-[0-9a-f-]+\.webp$/,
    );
    expect(mocks.upload).toHaveBeenCalledWith(expectedPath, expect.any(Uint8Array), {
      contentType: "image/webp",
      upsert: false,
    });
    const publishedBytes = mocks.upload.mock.calls[0][1] as Uint8Array;
    expect((await sharp(publishedBytes).metadata()).format).toBe("webp");
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith("stage_information_agent_evidence_publication", {
      p_fact_id: "fact-1",
      p_public_path: expectedPath,
      p_public_url: `https://example.test/${expectedPath}`,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("review_information_agent_fact_candidate_with_path", {
      p_reviewer_id: "admin-1",
      p_fact_id: "fact-1",
      p_decision: "accepted",
      p_notes: null,
      p_expected_public_path: expectedPath,
    });

    const stageOrder = mocks.rpc.mock.invocationCallOrder.find((_, index) => {
      return mocks.rpc.mock.calls[index][0] === "stage_information_agent_evidence_publication";
    });
    const reviewOrder = mocks.rpc.mock.invocationCallOrder.find((_, index) => {
      return mocks.rpc.mock.calls[index][0] === "review_information_agent_fact_candidate_with_path";
    });
    expect(stageOrder).toBeDefined();
    expect(reviewOrder).toBeDefined();
    expect(stageOrder).toBeLessThan(mocks.upload.mock.invocationCallOrder[0]);
    expect(mocks.upload.mock.invocationCallOrder[0]).toBeLessThan(reviewOrder!);
  });

  it("aborts the staged path and removes it when the upload fails", async () => {
    const original = await sharp({
      create: { width: 2500, height: 1800, channels: 3, background: "#aabbcc" },
    })
      .jpeg()
      .toBuffer();
    mocks.download.mockResolvedValue({ data: new Blob([original]), error: null });
    mocks.upload.mockResolvedValue({ data: null, error: new Error("upload failed") });
    mocks.rpc.mockImplementation(async (functionName: string) =>
      functionName === "abort_information_agent_evidence_publication"
        ? { data: true, error: null }
        : { data: {}, error: null },
    );

    await expect(
      reviewAdminInformationAgentFact({
        authToken: "test-token",
        input: {
          factId: "fact-1",
          decision: "accepted",
          redactionConfirmed: true,
          redactionVerifiedBy: "Claire Martin",
        },
      }),
    ).rejects.toThrow("upload failed");

    const stageCall = mocks.rpc.mock.calls.find(
      ([functionName]) => functionName === "stage_information_agent_evidence_publication",
    );
    const expectedPath = stageCall?.[1].p_public_path as string;
    expect(mocks.rpc).toHaveBeenCalledWith("abort_information_agent_evidence_publication", {
      p_fact_id: "fact-1",
      p_public_path: expectedPath,
    });
    expect(mocks.remove).toHaveBeenCalledWith([expectedPath]);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "review_information_agent_fact_candidate_with_path",
      expect.anything(),
    );
  });

  it("leaves the path in place when review fails after concurrent acceptance", async () => {
    const original = await sharp({
      create: { width: 2500, height: 1800, channels: 3, background: "#aabbcc" },
    })
      .jpeg()
      .toBuffer();
    mocks.download.mockResolvedValue({ data: new Blob([original]), error: null });
    mocks.rpc.mockImplementation(async (functionName: string) => {
      if (functionName === "review_information_agent_fact_candidate_with_path") {
        return { data: null, error: new Error("review failed") };
      }
      if (functionName === "abort_information_agent_evidence_publication") {
        return { data: false, error: null };
      }
      return { data: {}, error: null };
    });

    await expect(
      reviewAdminInformationAgentFact({
        authToken: "test-token",
        input: {
          factId: "fact-1",
          decision: "accepted",
          redactionConfirmed: true,
          redactionVerifiedBy: "Claire Martin",
        },
      }),
    ).rejects.toThrow("review failed");

    expect(mocks.rpc).toHaveBeenCalledWith(
      "abort_information_agent_evidence_publication",
      expect.objectContaining({ p_fact_id: "fact-1" }),
    );
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("does not stage a photo whose extraction is incomplete", async () => {
    mocks.extractionStatus.mockReturnValue("pending");

    await expect(
      reviewAdminInformationAgentFact({
        authToken: "test-token",
        input: {
          factId: "fact-1",
          decision: "accepted",
          redactionConfirmed: true,
          redactionVerifiedBy: "Claire Martin",
        },
      }),
    ).rejects.toThrow("L’analyse de la pièce doit être terminée");
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("does not stage a photo when its case is already completed", async () => {
    mocks.caseStatus.mockReturnValue("completed");

    await expect(
      reviewAdminInformationAgentFact({
        authToken: "test-token",
        input: {
          factId: "fact-1",
          decision: "accepted",
          redactionConfirmed: true,
          redactionVerifiedBy: "Claire Martin",
        },
      }),
    ).rejects.toThrow("Le dossier n’est plus ouvert");
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("redaction check before publication (P4-11)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockResolvedValue({ data: {}, error: null });
    mocks.extractionStatus.mockReturnValue("completed");
    mocks.caseStatus.mockReturnValue("review");
  });

  it("refuses to publish without the redaction confirmation and the verifier's name", async () => {
    await expect(
      reviewAdminInformationAgentFact({
        authToken: "test-token",
        input: { factId: "fact-1", decision: "accepted" },
      }),
    ).rejects.toThrow("Caviardage vérifié");
    await expect(
      reviewAdminInformationAgentFact({
        authToken: "test-token",
        input: {
          factId: "fact-1",
          decision: "accepted",
          redactionConfirmed: true,
          redactionVerifiedBy: "  ",
        },
      }),
    ).rejects.toThrow("Caviardage vérifié");

    expect(mocks.assetUpdate).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("records who verified the redaction, and when, before staging the publication", async () => {
    const original = await sharp({
      create: { width: 800, height: 600, channels: 3, background: "#123456" },
    })
      .jpeg()
      .toBuffer();
    mocks.download.mockResolvedValue({ data: new Blob([original]), error: null });
    mocks.upload.mockResolvedValue({ data: {}, error: null });

    await reviewAdminInformationAgentFact({
      authToken: "test-token",
      input: {
        factId: "fact-1",
        decision: "accepted",
        redactionConfirmed: true,
        redactionVerifiedBy: "Claire Martin",
      },
    });

    expect(mocks.assetUpdate).toHaveBeenCalledWith(
      "information_agent_evidence_assets",
      expect.objectContaining({
        metadata: expect.objectContaining({
          redaction_verified_by: "Claire Martin",
          redaction_verified_by_admin_id: "admin-1",
          redaction_verified_at: expect.any(String),
        }),
      }),
    );
    expect(mocks.assetUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.rpc.mock.invocationCallOrder[0],
    );
  });
});
