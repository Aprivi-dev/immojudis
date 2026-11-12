import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminRequiredError, AuthRequiredError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: (request: Request) => {
    const header = request.headers.get("authorization");
    if (!header) throw new AuthRequiredError("Unauthorized: No authorization header provided");
    return header.replace("Bearer ", "");
  },
}));
vi.mock("@/lib/admin-offer-opening-survey", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-offer-opening-survey")>()),
  getAdminOfferOpeningInterviewees: mocks.list,
}));

import { GET } from "./route";

const url = "https://example.test/api/admin/offer-opening-interviewees";

describe("GET /api/admin/offer-opening-interviewees", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rend la liste sans cache, avec le jeton de l'administrateur", async () => {
    const list = {
      total: 1,
      interviewees: [
        { consentedAt: "2026-11-07T09:00:00Z", profile: "avocat", email: "a@example.test" },
      ],
    };
    mocks.list.mockResolvedValue(list);
    const response = await GET(
      new Request(url, { headers: { authorization: "Bearer admin-token" } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(list);
    expect(mocks.list).toHaveBeenCalledWith("admin-token");
  });

  it("refuse sans jeton, sans rien lire", async () => {
    const response = await GET(new Request(url));
    expect(response.status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("refuse un compte qui n'est pas administrateur", async () => {
    mocks.list.mockRejectedValue(new AdminRequiredError());
    const response = await GET(
      new Request(url, { headers: { authorization: "Bearer user-token" } }),
    );
    expect(response.status).toBe(403);
  });
});
