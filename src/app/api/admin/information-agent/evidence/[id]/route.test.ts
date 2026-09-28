import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), from: vi.fn(), storageFrom: vi.fn() }));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, storage: { from: mocks.storageFrom } },
}));

import { GET, PATCH } from "./route";

const assetId = "22222222-2222-4222-8222-222222222222";

const request = (body: unknown) =>
  new Request(`https://example.test/api/admin/information-agent/evidence/${assetId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });

function setupPatch({
  reviewStatus = "pending",
  metadata = {},
  updateResult = {
    data: { id: assetId, rights_status: "restricted", review_status: reviewStatus },
    error: null,
  },
}: {
  reviewStatus?: "pending" | "accepted" | "rejected";
  metadata?: Record<string, unknown>;
  updateResult?: { data: unknown; error: { message: string; code?: string } | null };
} = {}) {
  const currentQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    single: vi.fn(),
  };
  currentQuery.select.mockReturnValue(currentQuery);
  currentQuery.eq.mockReturnValue(currentQuery);
  currentQuery.single.mockResolvedValue({
    data: { metadata, review_status: reviewStatus },
    error: null,
  });

  const updateQuery = {
    update: vi.fn(),
    eq: vi.fn(),
    neq: vi.fn(),
    select: vi.fn(),
    maybeSingle: vi.fn(),
  };
  updateQuery.update.mockReturnValue(updateQuery);
  updateQuery.eq.mockReturnValue(updateQuery);
  updateQuery.neq.mockReturnValue(updateQuery);
  updateQuery.select.mockReturnValue(updateQuery);
  updateQuery.maybeSingle.mockResolvedValue(updateResult);

  mocks.from.mockReturnValueOnce(currentQuery).mockReturnValueOnce(updateQuery);
  return { currentQuery, updateQuery };
}

function setupGet() {
  const assetQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    single: vi.fn(),
  };
  assetQuery.select.mockReturnValue(assetQuery);
  assetQuery.eq.mockReturnValue(assetQuery);
  assetQuery.single.mockResolvedValue({
    data: { storage_bucket: "information-agent-private", storage_path: "case/private.pdf" },
    error: null,
  });
  mocks.from.mockReturnValue(assetQuery);
  const createSignedUrl = vi.fn().mockResolvedValue({
    data: { signedUrl: "https://storage.example.test/private-document?token=secret" },
    error: null,
  });
  mocks.storageFrom.mockReturnValue({ createSignedUrl });
  return createSignedUrl;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ isAdmin: true, userId: "admin-1" });
});

describe("information-agent evidence rights review", () => {
  it("returns a short-lived signed URL to an authenticated JSON client", async () => {
    const createSignedUrl = setupGet();
    const response = await GET(
      new Request(
        `https://example.test/api/admin/information-agent/evidence/${assetId}?format=json`,
      ),
      { params: Promise.resolve({ id: assetId }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      signedUrl: "https://storage.example.test/private-document?token=secret",
    });
    expect(mocks.storageFrom).toHaveBeenCalledWith("information-agent-private");
    expect(createSignedUrl).toHaveBeenCalledWith("case/private.pdf", 600);
  });

  it("keeps the direct redirect form for existing callers", async () => {
    setupGet();

    const response = await GET(
      new Request(`https://example.test/api/admin/information-agent/evidence/${assetId}`),
      { params: Promise.resolve({ id: assetId }) },
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://storage.example.test/private-document?token=secret",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("rejects a restriction after acceptance before issuing an update", async () => {
    setupPatch({ reviewStatus: "accepted" });

    const response = await PATCH(request({ rightsStatus: "restricted" }), {
      params: Promise.resolve({ id: assetId }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: expect.stringContaining("objet public"),
    });
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  it("rejects a restriction when public publication metadata remains staged", async () => {
    setupPatch({
      metadata: { approved_public_path: `${assetId}/piece-jointe.pdf` },
    });

    const response = await PATCH(request({ rightsStatus: "restricted" }), {
      params: Promise.resolve({ id: assetId }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: expect.stringContaining("opération atomique"),
    });
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  it("allows restriction before publication and excludes a concurrent acceptance", async () => {
    const { updateQuery } = setupPatch();

    const response = await PATCH(request({ rightsStatus: "restricted", notes: "No licence" }), {
      params: Promise.resolve({ id: assetId }),
    });

    expect(response.status).toBe(200);
    expect(updateQuery.update).toHaveBeenCalledWith({
      rights_status: "restricted",
      metadata: {
        rights_reviewed_at: expect.any(String),
        rights_reviewed_by: "admin-1",
        rights_review_notes: "No licence",
      },
    });
    expect(updateQuery.neq).toHaveBeenCalledWith("review_status", "accepted");
  });

  it("returns a conflict when acceptance wins the compare-and-swap", async () => {
    const { updateQuery } = setupPatch({
      updateResult: { data: null, error: null },
    });

    const response = await PATCH(request({ rightsStatus: "restricted" }), {
      params: Promise.resolve({ id: assetId }),
    });

    expect(response.status).toBe(409);
    expect(updateQuery.neq).toHaveBeenCalledWith("review_status", "accepted");
  });

  it("returns a conflict when staging wins after the initial rights read", async () => {
    setupPatch({
      updateResult: {
        data: null,
        error: {
          code: "55000",
          message: "Published or staged evidence must be unpublished before restricting rights.",
        },
      },
    });

    const response = await PATCH(request({ rightsStatus: "restricted" }), {
      params: Promise.resolve({ id: assetId }),
    });

    expect(response.status).toBe(409);
  });

  it("can keep an accepted asset authorized without a revocation check", async () => {
    const { updateQuery } = setupPatch({
      reviewStatus: "accepted",
      updateResult: {
        data: { id: assetId, rights_status: "authorized", review_status: "accepted" },
        error: null,
      },
    });

    const response = await PATCH(request({ rightsStatus: "authorized" }), {
      params: Promise.resolve({ id: assetId }),
    });

    expect(response.status).toBe(200);
    expect(updateQuery.neq).not.toHaveBeenCalled();
  });
});
