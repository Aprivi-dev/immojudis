import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRequiredError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/followed-sale-snapshots", () => ({
  listFollowedSaleSnapshots: mocks.list,
  deleteFollowedSaleSnapshot: mocks.remove,
  updateFollowedSaleSnapshot: mocks.update,
}));

import { DELETE, GET, PUT } from "./route";

const SNAPSHOT_ID = "7d335032-e935-4550-9347-ed22b0f63449";
const AUTH = { userId: "user-1" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.auth.mockResolvedValue(AUTH);
});

describe("/api/favorites/snapshots", () => {
  it("liste les ventes passées du compte, jamais mises en cache", async () => {
    mocks.list.mockResolvedValue({ snapshots: [] });
    const response = await GET(new Request("https://immojudis.test/api/favorites/snapshots"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ snapshots: [] });
    expect(mocks.list).toHaveBeenCalledWith({ auth: AUTH });
  });

  it("exige un compte connecté", async () => {
    mocks.auth.mockRejectedValue(new AuthRequiredError("Unauthorized: No token provided"));
    const response = await GET(new Request("https://immojudis.test/api/favorites/snapshots"));
    expect(response.status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("retire un instantané du compte", async () => {
    mocks.remove.mockResolvedValue({ ok: true, removed: true });
    const response = await DELETE(
      new Request(`https://immojudis.test/api/favorites/snapshots?id=${SNAPSHOT_ID}`, {
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledWith({ auth: AUTH, id: SNAPSHOT_ID });
  });

  it("refuse un identifiant invalide avant toute suppression", async () => {
    const response = await DELETE(
      new Request("https://immojudis.test/api/favorites/snapshots?id=nope", { method: "DELETE" }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});

describe("PUT /api/favorites/snapshots (bilan après adjudication)", () => {
  const put = (body: unknown) =>
    PUT(
      new Request("https://immojudis.test/api/favorites/snapshots", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    );

  it("enregistre le statut et le prix final du compte, jamais mis en cache", async () => {
    mocks.update.mockResolvedValue({ snapshot: { id: SNAPSHOT_ID } });
    const response = await put({ id: SNAPSHOT_ID, personalStatus: "won", finalPriceEur: 172500.4 });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.update).toHaveBeenCalledWith({
      auth: AUTH,
      input: { id: SNAPSHOT_ID, personalStatus: "won", finalPriceEur: 172500 },
    });
  });

  it("exige un compte connecté", async () => {
    mocks.auth.mockRejectedValue(new AuthRequiredError("Unauthorized: No token provided"));
    const response = await put({ id: SNAPSHOT_ID, personalStatus: "won" });
    expect(response.status).toBe(401);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("refuse un corps invalide avant toute écriture", async () => {
    for (const body of [
      {},
      { id: SNAPSHOT_ID },
      { id: "nope", personalStatus: "won" },
      { id: SNAPSHOT_ID, personalStatus: "gagné" },
      { id: SNAPSHOT_ID, finalPriceEur: 0 },
      { id: SNAPSHOT_ID, finalPriceEur: -5 },
      { id: SNAPSHOT_ID, finalPriceEur: 1e12 },
      { id: SNAPSHOT_ID, finalPriceEur: "100000" },
    ]) {
      const response = await put(body);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
