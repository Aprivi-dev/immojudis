import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRequiredError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: (request: Request) => {
    if (!request.headers.get("authorization")) {
      throw new AuthRequiredError("Unauthorized: No authorization header provided");
    }
    return "token";
  },
  requireSupabaseAuthContext: mocks.requireAuth,
}));
// Le garde administrateur et la validation sont ceux du vrai code : la base n'est jamais atteinte
// par un compte sans droit ni par un corps invalide.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: vi.fn(), auth: { admin: {} } },
}));

import { GET, PATCH, POST } from "./route";
import { POST as withdrawal } from "./withdrawal/route";
import { GET as professionalExport } from "./professional-export/route";

const REQUEST_ID = "4d1b3e0a-6f5e-4a39-8d3b-1f2a4c6e8a10";
const url = "https://immojudis.test/api/admin/privacy-requests";

function call(
  handler: (request: Request) => Promise<Response>,
  init: { method: string; token?: boolean; body?: unknown; path?: string },
) {
  return handler(
    new Request(`${url}${init.path ?? ""}`, {
      method: init.method,
      headers: {
        "content-type": "application/json",
        ...(init.token === false ? {} : { authorization: "Bearer token" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
}

const asAdmin = () => mocks.requireAuth.mockResolvedValue({ userId: "admin-1", isAdmin: true });
const asUser = () => mocks.requireAuth.mockResolvedValue({ userId: "user-1", isAdmin: false });

describe("routes admin de confidentialité", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    asAdmin();
  });

  const calls: Array<[string, (token?: boolean) => Promise<Response>]> = [
    ["GET liste", (token) => call(GET, { method: "GET", token })],
    [
      "PATCH mise à jour",
      (token) =>
        call(PATCH, {
          method: "PATCH",
          token,
          body: { requestId: REQUEST_ID, status: "in_review" },
        }),
    ],
    [
      "POST effacement",
      (token) =>
        call(POST, {
          method: "POST",
          token,
          body: { requestId: REQUEST_ID, confirmEmail: "personne@example.test" },
        }),
    ],
    [
      "POST rétractation",
      (token) =>
        call(withdrawal, {
          method: "POST",
          token,
          body: { requestId: REQUEST_ID, refundMode: "full" },
        }),
    ],
    [
      "GET export professionnel",
      (token) =>
        call(professionalExport, {
          method: "GET",
          token,
          path: `/professional-export?requestId=${REQUEST_ID}`,
        }),
    ],
  ];

  it.each(calls)("%s : 401 sans jeton, sans rien lire", async (_name, run) => {
    const response = await run(false);

    expect(response.status).toBe(401);
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each(calls)("%s : 401 quand le jeton est refusé", async (_name, run) => {
    mocks.requireAuth.mockRejectedValue(new AuthRequiredError("Unauthorized: Invalid token"));

    expect((await run()).status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("répond 503, pas 401, quand le profil du compte est illisible", async () => {
    const { PublicApiError } = await import("@/lib/api-errors");
    mocks.requireAuth.mockRejectedValue(
      new PublicApiError("Service temporairement indisponible.", 503),
    );

    expect((await call(GET, { method: "GET" })).status).toBe(503);
  });

  it.each(calls)(
    "%s : 403 pour un compte qui n'est pas administrateur, sans lire la base",
    async (_name, run) => {
      asUser();

      const response = await run();

      expect(response.status).toBe(403);
      expect(mocks.from).not.toHaveBeenCalled();
    },
  );

  it("PATCH, POST et rétractation : 400 pour un corps invalide, jamais envoyé à la base", async () => {
    expect((await call(PATCH, { method: "PATCH", body: { status: "inconnu" } })).status).toBe(400);
    expect((await call(PATCH, { method: "PATCH", body: null })).status).toBe(400);
    expect((await call(POST, { method: "POST", body: { requestId: "pas-un-uuid" } })).status).toBe(
      400,
    );
    expect((await call(withdrawal, { method: "POST", body: { requestId: 1 } })).status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("GET liste : 400 pour une pagination invalide", async () => {
    expect((await call(GET, { method: "GET", path: "?limit=1000" })).status).toBe(400);
    expect((await call(GET, { method: "GET", path: "?offset=-1" })).status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("GET export professionnel : 400 pour un identifiant de demande invalide", async () => {
    const response = await call(professionalExport, {
      method: "GET",
      path: "/professional-export?requestId=pas-un-uuid",
    });

    expect(response.status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
