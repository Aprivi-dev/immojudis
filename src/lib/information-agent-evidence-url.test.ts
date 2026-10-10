import { beforeEach, describe, expect, it, vi } from "vitest";

const SALE = "11111111-1111-4111-8111-111111111111";
const ASSET = "22222222-2222-4222-8222-222222222222";
const PATH = `${SALE}/${ASSET}/piece-jointe-33333333-3333-4333-8333-333333333333.pdf`;

const mocks = vi.hoisted(() => ({
  fact: vi.fn(),
  sign: vi.fn(),
  visible: vi.fn(),
  filter: vi.fn(),
}));

vi.mock("@/lib/sale-publication-guard", () => ({ assertSalePublicationVisible: mocks.visible }));
vi.mock("@/integrations/supabase/client.server", () => {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "limit"]) query[method] = () => query;
  query.filter = (...args: unknown[]) => {
    mocks.filter(...args);
    return query;
  };
  query.maybeSingle = () => mocks.fact();
  return {
    supabaseAdmin: {
      from: () => query,
      storage: {
        from: (bucket: string) => ({
          createSignedUrl: (...a: unknown[]) => mocks.sign(bucket, ...a),
        }),
      },
    },
  };
});

import {
  APPROVED_EVIDENCE_URL_TTL_SECONDS,
  createApprovedEvidenceSignedUrl,
  parseApprovedEvidencePath,
} from "./information-agent-evidence-url";

describe("approved evidence signed URLs (P4-11)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.visible.mockResolvedValue(undefined);
    mocks.fact.mockResolvedValue({ data: { id: "fact-1" }, error: null });
    mocks.sign.mockResolvedValue({
      data: { signedUrl: "https://signed.example/doc?t=1" },
      error: null,
    });
  });

  it("signs for exactly 10 minutes on the private bucket", async () => {
    expect(APPROVED_EVIDENCE_URL_TTL_SECONDS).toBe(600);
    await expect(createApprovedEvidenceSignedUrl(PATH)).resolves.toBe(
      "https://signed.example/doc?t=1",
    );
    expect(mocks.sign).toHaveBeenCalledWith("information-agent-approved", PATH, 600);
    expect(mocks.filter).toHaveBeenCalledWith("proposed_value->>public_path", "eq", PATH);
  });

  it.each([
    null,
    "",
    "../../etc/passwd",
    `${SALE}/${ASSET}/../secret.pdf`,
    `${SALE}/${ASSET}/original.pdf`,
    `${SALE}/${ASSET}/piece-jointe-33333333-3333-4333-8333-333333333333.txt`,
    `${SALE}/piece-jointe-33333333-3333-4333-8333-333333333333.pdf`,
  ])("rejects a malformed or unexpected path: %s", async (path) => {
    expect(parseApprovedEvidencePath(path)).toBeNull();
    await expect(createApprovedEvidenceSignedUrl(path)).resolves.toBeNull();
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("does not sign a piece that no administrator accepted", async () => {
    mocks.fact.mockResolvedValue({ data: null, error: null });
    await expect(createApprovedEvidenceSignedUrl(PATH)).resolves.toBeNull();
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("does not sign a piece of a sale that is no longer visible", async () => {
    mocks.visible.mockRejectedValue(new Error("Vente introuvable ou inaccessible."));
    await expect(createApprovedEvidenceSignedUrl(PATH)).resolves.toBeNull();
    expect(mocks.sign).not.toHaveBeenCalled();
  });
});
