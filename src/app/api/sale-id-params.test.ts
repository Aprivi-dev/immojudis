import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicApiError } from "@/lib/api-errors";

/**
 * Routes dont l'identifiant (vente, analyse, zone, demande) vient de l'URL ou de la requête, et qui
 * n'avaient aucun test de route : un identifiant mal formé donne 400, un identifiant bien formé mais
 * inconnu donne 404, jamais 500. Depuis zod 4, `z.string().guid()` accepte toute suite de 8-4-4-4-12
 * chiffres hexadécimaux (`1111…`, non conforme à la RFC 4122) : le cas est testé, et passe la validation.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  updateSet: vi.fn(),
  deleteSet: vi.fn(),
  enableShare: vi.fn(),
  disableShare: vi.fn(),
  deleteZone: vi.fn(),
  updateZone: vi.fn(),
  getWorkspace: vi.fn(),
  upsertWorkspace: vi.fn(),
  exportProfessional: vi.fn(),
  estimate: vi.fn(),
  maybeSingle: vi.fn(),
  entitlement: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: vi.fn(async () => 1) }));
vi.mock("@/lib/property-reports", () => ({ assertFeatureEntitlement: mocks.entitlement }));
vi.mock("@/lib/sale-analysis-sets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sale-analysis-sets")>()),
  updateSaleAnalysisSet: mocks.updateSet,
  deleteSaleAnalysisSet: mocks.deleteSet,
  enableSaleComparisonShare: mocks.enableShare,
  disableSaleComparisonShare: mocks.disableShare,
}));
vi.mock("@/lib/watched-zones", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/watched-zones")>()),
  deleteWatchedZone: mocks.deleteZone,
  updateWatchedZone: mocks.updateZone,
}));
vi.mock("@/lib/sale-workspaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sale-workspaces")>()),
  getSaleWorkspace: mocks.getWorkspace,
  upsertSaleWorkspace: mocks.upsertWorkspace,
}));
vi.mock("@/lib/privacy-requests", () => ({
  exportProfessionalPrivacyData: mocks.exportProfessional,
}));
vi.mock("@/lib/admin-route-deadline", () => ({
  withAdminDeadline: <T>(handler: T) => handler,
}));
vi.mock("@/lib/sale-market-estimates", () => ({ getPrecomputedMarketEstimate: mocks.estimate }));

import { GET as valuePreviewGet } from "./sales/[id]/value-preview/route";
import { DELETE as setDelete, PATCH as setPatch } from "./sale-analysis-sets/[id]/route";
import { DELETE as shareDelete, POST as sharePost } from "./sale-analysis-sets/[id]/share/route";
import { DELETE as zoneDelete, PATCH as zonePatch } from "./watched-zones/[id]/route";
import { GET as workspaceGet } from "./sale-workspace/route";
import { GET as professionalExportGet } from "./admin/privacy-requests/professional-export/route";

const NOT_RFC = "11111111-1111-1111-1111-111111111111";
const UPPERCASE = "ABCDEF12-3456-4789-8ABC-DEF123456789";
const MALFORMED = [
  "pas-un-uuid",
  "",
  "1111",
  `${NOT_RFC}0`,
  "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
];
const NOT_FOUND = new PublicApiError("Ressource introuvable.", 404);

const request = (url = "https://example.test/api/x", init: RequestInit = {}) =>
  new Request(url, { ...init, headers: { authorization: "Bearer token", ...init.headers } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

type Case = {
  name: string;
  /** Appelle la route avec cet identifiant. */
  call: (id: string) => Promise<Response>;
  /** La fonction de la bibliothèque qui ne doit jamais être atteinte avec un identifiant mal formé. */
  library: () => ReturnType<typeof vi.fn>;
};

const cases: Case[] = [
  {
    name: "PATCH sale-analysis-sets/[id]",
    call: (id) =>
      setPatch(request("https://example.test/api/x", { method: "PATCH", body: "{}" }), params(id)),
    library: () => mocks.updateSet,
  },
  {
    name: "DELETE sale-analysis-sets/[id]",
    call: (id) =>
      setDelete(request("https://example.test/api/x", { method: "DELETE" }), params(id)),
    library: () => mocks.deleteSet,
  },
  {
    name: "POST sale-analysis-sets/[id]/share",
    call: (id) => sharePost(request("https://example.test/api/x", { method: "POST" }), params(id)),
    library: () => mocks.enableShare,
  },
  {
    name: "DELETE sale-analysis-sets/[id]/share",
    call: (id) =>
      shareDelete(request("https://example.test/api/x", { method: "DELETE" }), params(id)),
    library: () => mocks.disableShare,
  },
  {
    name: "PATCH watched-zones/[id]",
    call: (id) =>
      zonePatch(request("https://example.test/api/x", { method: "PATCH", body: "{}" }), params(id)),
    library: () => mocks.updateZone,
  },
  {
    name: "DELETE watched-zones/[id]",
    call: (id) =>
      zoneDelete(request("https://example.test/api/x", { method: "DELETE" }), params(id)),
    library: () => mocks.deleteZone,
  },
  {
    name: "GET sales/[id]/value-preview",
    call: (id) => valuePreviewGet(request(), params(id)),
    library: () => mocks.maybeSingle,
  },
  {
    name: "GET sale-workspace?saleId=",
    call: (id) => workspaceGet(request(`https://example.test/api/sale-workspace?saleId=${id}`)),
    library: () => mocks.getWorkspace,
  },
  {
    name: "GET admin/privacy-requests/professional-export?requestId=",
    call: (id) =>
      professionalExportGet(
        request(
          `https://example.test/api/admin/privacy-requests/professional-export?requestId=${id}`,
        ),
      ),
    library: () => mocks.exportProfessional,
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  mocks.entitlement.mockResolvedValue(undefined);
  // `auth.supabase.from(...).select(...).eq(...).maybeSingle()` de value-preview : vente inconnue.
  const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: mocks.maybeSingle };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
  mocks.auth.mockResolvedValue({ userId: "user-1", supabase: { from: () => query } });
  for (const library of [
    mocks.updateSet,
    mocks.deleteSet,
    mocks.enableShare,
    mocks.disableShare,
    mocks.deleteZone,
    mocks.updateZone,
    mocks.getWorkspace,
    mocks.exportProfessional,
  ]) {
    library.mockRejectedValue(NOT_FOUND);
  }
});

describe.each(cases)("$name", ({ call, library }) => {
  it.each(MALFORMED)("refuse l'identifiant mal formé %j en 400, sans rien lire", async (id) => {
    const response = await call(id);
    expect(response.status).toBe(400);
    expect(library()).not.toHaveBeenCalled();
  });

  it("accepte un identifiant non conforme à la RFC 4122 et répond 404 (inconnu), jamais 500", async () => {
    const response = await call(NOT_RFC);
    expect(response.status).toBe(404);
  });

  it("accepte un identifiant en majuscules (la validation ne le refuse pas)", async () => {
    const response = await call(UPPERCASE);
    expect(response.status).toBe(404);
  });
});

describe("transmission de l'identifiant à la bibliothèque", () => {
  it("passe l'identifiant tel quel à la suppression d'une analyse", async () => {
    await setDelete(request("https://example.test/api/x", { method: "DELETE" }), params(NOT_RFC));
    expect(mocks.deleteSet).toHaveBeenCalledWith(expect.objectContaining({ setId: NOT_RFC }));
  });

  it("exige la session avant tout, même avec un identifiant mal formé", async () => {
    mocks.auth.mockRejectedValue(new Error("Unauthorized: missing bearer token"));
    const response = await setDelete(
      new Request("https://example.test/api/x", { method: "DELETE" }),
      params("pas-un-uuid"),
    );
    expect(response.status).toBe(401);
  });
});
