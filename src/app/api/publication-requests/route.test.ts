import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => undefined,
  requireSupabaseAuthContext: mocks.auth,
}));

import { GET as getDetail } from "./[id]/route";
import { GET as getCollection } from "./route";

beforeEach(() => {
  mocks.auth.mockRejectedValue(new Error("Unauthorized: No authorization header provided"));
});

describe("publication request privacy headers", () => {
  it.each([
    [
      "collection",
      () => getCollection(new Request("https://example.test/api/publication-requests")),
    ],
    [
      "detail",
      () =>
        getDetail(new Request("https://example.test/api/publication-requests/request-id"), {
          params: Promise.resolve({ id: "request-id" }),
        }),
    ],
  ])("keeps the unauthenticated %s response private", async (_scope, invoke) => {
    const response = await invoke();

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("authorization");
  });
});
