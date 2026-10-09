import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getClaims: vi.fn(), from: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getClaims: mocks.getClaims }, from: mocks.from }),
}));

import { GET } from "./route";

const request = () =>
  new Request("https://example.test/api/admin/dashboard", {
    headers: { authorization: "Bearer admin-jwt" },
  });

function adminProfile() {
  mocks.from.mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue({
          data: { account_tier: "premium", user_role: "admin" },
          error: null,
        }),
      }),
    }),
  });
}

describe("GET /api/admin/dashboard administrator MFA", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "fixture-key");
    adminProfile();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("answers 403 to an admin JWT at aal1 once ADMIN_MFA_REQUIRED is on", async () => {
    vi.stubEnv("ADMIN_MFA_REQUIRED", "true");
    mocks.getClaims.mockResolvedValue({
      data: { claims: { sub: "admin-1", email: "admin@example.test", aal: "aal1" } },
      error: null,
    });

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a JWT without any aal claim the same way", async () => {
    vi.stubEnv("ADMIN_MFA_REQUIRED", "true");
    mocks.getClaims.mockResolvedValue({
      data: { claims: { sub: "admin-1", email: "admin@example.test" } },
      error: null,
    });

    expect((await GET(request())).status).toBe(403);
  });
});
