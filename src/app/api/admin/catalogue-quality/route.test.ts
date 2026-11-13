import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminRequiredError, AuthRequiredError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: (request: Request) => {
    const header = request.headers.get("authorization");
    if (!header) throw new AuthRequiredError("Unauthorized: No authorization header provided");
    return header.replace("Bearer ", "");
  },
}));
vi.mock("@/lib/admin-catalogue-quality.server", () => ({
  getAdminCatalogueQuality: mocks.get,
}));

import { GET } from "./route";

const url = "https://example.test/api/admin/catalogue-quality";

describe("GET /api/admin/catalogue-quality", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rend les contrôles sans cache, avec le jeton de l'administrateur", async () => {
    mocks.get.mockResolvedValue({ snapshot: null, alerts: [] });
    const response = await GET(
      new Request(url, { headers: { authorization: "Bearer admin-token" } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.get).toHaveBeenCalledWith("admin-token");
    expect(await response.json()).toEqual({ snapshot: null, alerts: [] });
  });

  it("répond 401 sans jeton, sans rien lire", async () => {
    const response = await GET(new Request(url));
    expect(response.status).toBe(401);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("répond 403 à un compte qui n'est pas administrateur", async () => {
    mocks.get.mockRejectedValue(new AdminRequiredError());
    const response = await GET(new Request(url, { headers: { authorization: "Bearer user" } }));
    expect(response.status).toBe(403);
  });
});
