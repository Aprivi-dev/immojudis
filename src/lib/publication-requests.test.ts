import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import {
  createPublicationUploadTargets,
  listPublicationRequests,
  removePublicationRequestUploads,
  PUBLICATION_DOCUMENT_BUCKET,
} from "./publication-requests";

const mocks = vi.hoisted(() => ({
  adminFrom: vi.fn(),
  storageFrom: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: mocks.adminFrom,
    storage: { from: mocks.storageFrom },
  },
}));

afterEach(() => vi.clearAllMocks());

function authContext(overrides: Partial<SupabaseAuthContext> = {}): SupabaseAuthContext {
  return {
    supabase: {} as SupabaseAuthContext["supabase"],
    userId: "7d335032-e935-4550-9347-ed22b0f63449",
    claims: { email: "pro@example.test" },
    accountTier: "free",
    userRole: "user",
    isAdmin: false,
    ...overrides,
  };
}

function queryBuilder(data: unknown[] = []) {
  const query = {
    select: vi.fn(() => query),
    order: vi.fn(() => query),
    range: vi.fn(() => query),
    eq: vi.fn(() => query),
    then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve(resolve({ data, error: null })),
  };
  return query;
}

function existingRequestQuery(data: unknown = null) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn().mockResolvedValue({ data, error: null }),
  };
  return query;
}

describe("publication request access", () => {
  beforeEach(() => {
    mocks.adminFrom.mockReset();
    mocks.storageFrom.mockReset();
  });

  it("filters the list by requester for an owner and leaves admin rows unfiltered", async () => {
    const ownerQuery = queryBuilder();
    mocks.adminFrom.mockReturnValue(ownerQuery);
    const ownerResult = await listPublicationRequests({ auth: authContext() });
    expect(ownerQuery.eq).toHaveBeenCalledWith(
      "requester_id",
      "7d335032-e935-4550-9347-ed22b0f63449",
    );
    expect(ownerResult).toMatchObject({ page: 1, hasMore: false, nextPage: null, requests: [] });

    const adminQuery = queryBuilder();
    mocks.adminFrom.mockReturnValue(adminQuery);
    await listPublicationRequests({ auth: authContext({ isAdmin: true, userRole: "admin" }) });
    expect(adminQuery.eq).not.toHaveBeenCalled();
  });

  it("cleans only the authenticated user's request folder after an upload failure", async () => {
    mocks.adminFrom.mockReturnValue(existingRequestQuery());
    const storage = {
      list: vi.fn().mockResolvedValue({
        data: [{ name: "document.pdf" }, { name: "annexe.png" }],
        error: null,
      }),
      remove: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    mocks.storageFrom.mockReturnValue(storage);

    await removePublicationRequestUploads({
      auth: authContext(),
      requestId: "0d335032-e935-4550-9347-ed22b0f63440",
    });

    expect(mocks.storageFrom).toHaveBeenCalledWith(PUBLICATION_DOCUMENT_BUCKET);
    expect(storage.list).toHaveBeenCalledWith(
      "7d335032-e935-4550-9347-ed22b0f63449/0d335032-e935-4550-9347-ed22b0f63440",
      { limit: 20 },
    );
    expect(storage.remove).toHaveBeenCalledWith([
      "7d335032-e935-4550-9347-ed22b0f63449/0d335032-e935-4550-9347-ed22b0f63440/document.pdf",
      "7d335032-e935-4550-9347-ed22b0f63449/0d335032-e935-4550-9347-ed22b0f63440/annexe.png",
    ]);
  });

  it("preserves uploaded documents when the publication request already exists", async () => {
    const requestQuery = existingRequestQuery({ id: "0d335032-e935-4550-9347-ed22b0f63440" });
    mocks.adminFrom.mockReturnValue(requestQuery);

    await removePublicationRequestUploads({
      auth: authContext(),
      requestId: "0d335032-e935-4550-9347-ed22b0f63440",
    });

    expect(requestQuery.maybeSingle).toHaveBeenCalledOnce();
    expect(mocks.storageFrom).not.toHaveBeenCalled();
  });

  it("rejects pending professionals before issuing signed upload URLs", async () => {
    const profileQuery = {
      select: vi.fn(() => profileQuery),
      eq: vi.fn(() => profileQuery),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          account_type: "b2b",
          professional_status: "pending",
          email: "pro@example.test",
        },
        error: null,
      }),
    };
    const auth = authContext({
      supabase: { from: vi.fn(() => profileQuery) } as unknown as SupabaseAuthContext["supabase"],
    });

    await expect(
      createPublicationUploadTargets({
        auth,
        files: [{ name: "document.pdf", size: 100, mime_type: "application/pdf" }],
      }),
    ).rejects.toThrow("encore en attente");
    expect(mocks.storageFrom).not.toHaveBeenCalled();
  });

  it("removes the prepared folder when signed URL creation fails partway through", async () => {
    mocks.adminFrom.mockReturnValue(existingRequestQuery());
    const storage = {
      createSignedUploadUrl: vi
        .fn()
        .mockResolvedValueOnce({ data: { token: "upload-token" }, error: null })
        .mockResolvedValueOnce({ data: null, error: new Error("storage unavailable") }),
      list: vi.fn().mockResolvedValue({ data: [{ name: "first.pdf" }], error: null }),
      remove: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    mocks.storageFrom.mockReturnValue(storage);

    await expect(
      createPublicationUploadTargets({
        auth: authContext({ isAdmin: true, userRole: "admin" }),
        files: [
          { name: "first.pdf", size: 100, mime_type: "application/pdf" },
          { name: "second.pdf", size: 100, mime_type: "application/pdf" },
        ],
      }),
    ).rejects.toThrow("storage unavailable");
    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect(storage.remove.mock.calls[0]?.[0]).toEqual([
      expect.stringMatching(/^7d335032-e935-4550-9347-ed22b0f63449\//),
    ]);
  });
});
