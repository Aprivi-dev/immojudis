import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { reviewAdminInformationAgentFact } from "@/lib/admin-information-agent";

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  download: vi.fn(),
  remove: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: vi.fn().mockResolvedValue({ isAdmin: true, userId: "admin-1" }),
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const saleId = "11111111-1111-4111-8111-111111111111";
  const assetId = "22222222-2222-4222-8222-222222222222";
  const query = (table: string) => ({
    select: () => ({
      eq: () => ({
        single: async () => ({
          data:
            table === "information_agent_fact_candidates"
              ? {
                  id: "fact-1",
                  fact_key: "photo",
                  evidence_asset_id: assetId,
                  sale_id: saleId,
                  status: "pending",
                }
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
    mocks.rpc.mockResolvedValue({ data: {}, error: null });
    mocks.upload.mockResolvedValue({ data: {}, error: null });
    mocks.remove.mockResolvedValue({ data: {}, error: null });
  });

  it("replaces a previously staged uncompressed photo with a WebP derivative", async () => {
    const original = await sharp({
      create: { width: 2500, height: 1800, channels: 3, background: "#aabbcc" },
    })
      .jpeg()
      .toBuffer();
    mocks.download.mockResolvedValue({ data: new Blob([original]), error: null });

    await reviewAdminInformationAgentFact({
      authToken: "test-token",
      input: { factId: "fact-1", decision: "accepted" },
    });

    const expectedPath =
      "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/photo-v1.webp";
    expect(mocks.upload).toHaveBeenCalledWith(expectedPath, expect.any(Uint8Array), {
      contentType: "image/webp",
      upsert: false,
    });
    const publishedBytes = mocks.upload.mock.calls[0][1] as Uint8Array;
    expect((await sharp(publishedBytes).metadata()).format).toBe("webp");
    expect(mocks.remove).toHaveBeenCalledWith([
      "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/piece-jointe.jpg",
    ]);
    expect(mocks.rpc).toHaveBeenCalledWith("stage_information_agent_evidence_publication", {
      p_fact_id: "fact-1",
      p_public_path: expectedPath,
      p_public_url: `https://example.test/${expectedPath}`,
    });
  });
});
