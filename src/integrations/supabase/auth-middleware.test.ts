import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getClaims: vi.fn(), from: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getClaims: mocks.getClaims }, from: mocks.from }),
}));
import { requireSupabaseAuthContext } from "./auth-middleware";
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "fixture-key");
});
afterEach(() => vi.unstubAllEnvs());
it("normalizes a thrown expired JWT error before querying account rights", async () => {
  mocks.getClaims.mockRejectedValue(new Error("JWT has expired"));
  await expect(requireSupabaseAuthContext("expired-fixture")).rejects.toThrow(
    "Unauthorized: Invalid token",
  );
  expect(mocks.from).not.toHaveBeenCalled();
});
it("rejects errors returned by the SDK before querying account rights", async () => {
  mocks.getClaims.mockResolvedValue({ data: null, error: new Error("Invalid JWT") });
  await expect(requireSupabaseAuthContext("invalid-fixture")).rejects.toThrow(
    "Unauthorized: Invalid token",
  );
  expect(mocks.from).not.toHaveBeenCalled();
});
it("uses the verified subject to read the account's current rights", async () => {
  mocks.getClaims.mockResolvedValue({ data: { claims: { sub: "verified-user" } }, error: null });
  const eq = vi.fn().mockReturnValue({
    maybeSingle: vi
      .fn()
      .mockResolvedValue({ data: { account_tier: "premium", user_role: "user" }, error: null }),
  });
  mocks.from.mockReturnValue({ select: vi.fn().mockReturnValue({ eq }) });
  const result = await requireSupabaseAuthContext("valid-fixture");
  expect(eq).toHaveBeenCalledWith("user_id", "verified-user");
  expect(result).toMatchObject({ userId: "verified-user", accountTier: "premium", isAdmin: false });
});
it("does not leak the database detail when the access profile cannot be read", async () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.getClaims.mockResolvedValue({ data: { claims: { sub: "verified-user" } }, error: null });
  const eq = vi.fn().mockReturnValue({
    maybeSingle: vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'relation "public.user_profiles" does not exist' },
    }),
  });
  mocks.from.mockReturnValue({ select: vi.fn().mockReturnValue({ eq }) });
  const failure = await requireSupabaseAuthContext("valid-fixture").catch((error: Error) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("Unauthorized: User access profile unavailable");
  expect(String(errorLog.mock.calls[0]?.[0])).toContain("user_profiles");
  errorLog.mockRestore();
});

function adminClaimsFixture(aal?: string) {
  mocks.getClaims.mockResolvedValue({
    data: { claims: { sub: "admin-user", ...(aal ? { aal } : {}) } },
    error: null,
  });
  const eq = vi.fn().mockReturnValue({
    maybeSingle: vi
      .fn()
      .mockResolvedValue({ data: { account_tier: "premium", user_role: "admin" }, error: null }),
  });
  mocks.from.mockReturnValue({ select: vi.fn().mockReturnValue({ eq }) });
}

it("keeps administrator rights at aal1 while ADMIN_MFA_REQUIRED is off (default)", async () => {
  adminClaimsFixture("aal1");
  const result = await requireSupabaseAuthContext("admin-fixture");
  expect(result).toMatchObject({ userRole: "admin", isAdmin: true });
});

it("withholds administrator rights from an aal1 session when ADMIN_MFA_REQUIRED is on", async () => {
  vi.stubEnv("ADMIN_MFA_REQUIRED", "true");
  for (const aal of ["aal1", undefined]) {
    adminClaimsFixture(aal);
    const result = await requireSupabaseAuthContext("admin-fixture");
    expect(result).toMatchObject({ userRole: "admin", isAdmin: false });
  }
});

it("grants administrator rights to an aal2 session when ADMIN_MFA_REQUIRED is on", async () => {
  vi.stubEnv("ADMIN_MFA_REQUIRED", "true");
  adminClaimsFixture("aal2");
  const result = await requireSupabaseAuthContext("admin-fixture");
  expect(result).toMatchObject({ userRole: "admin", isAdmin: true });
});
