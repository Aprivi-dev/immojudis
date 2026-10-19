import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), client: vi.fn() }));

vi.mock("next/cache", () => ({
  // Pas de cache de données hors Next.js : chaque appel atteint la base simulée.
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));
vi.mock("@/lib/supabase-public.server", () => ({
  createPublicSupabaseClient: mocks.client,
}));

import { HEARINGS_RPC_DAYS } from "./upcoming-hearings";
import {
  HEARINGS_DATA_REVALIDATE_SECONDS,
  mustFailOnHearingsReadError,
  tryLoadUpcomingHearings,
} from "./upcoming-hearings.server";

function row(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    sale_date: "2026-10-22T12:00:00Z",
    date_only: false,
    property_type: "house",
    city: "Bobigny",
    department: "93",
    tribunal_code: "bobigny",
    tribunal_name: "TJ Bobigny",
    tribunal_city: "Bobigny",
    starting_price_eur: "40500",
    total_count: 2,
    ...overrides,
  };
}

describe("tryLoadUpcomingHearings", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.client.mockReset();
    mocks.client.mockReturnValue({ rpc: mocks.rpc });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lit les 30 prochains jours (aujourd'hui + 29) et rend des audiences", async () => {
    mocks.rpc.mockResolvedValue({ data: [row(1), row(2)], error: null });

    const result = await tryLoadUpcomingHearings();

    expect(mocks.rpc).toHaveBeenCalledWith("get_public_upcoming_hearings", {
      p_days: HEARINGS_RPC_DAYS,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.hearings.map((hearing) => hearing.id)).toEqual([row(1).id, row(2).id]);
    expect(result.hearings[0]).toMatchObject({ time: "14 h 00", startingPriceEur: 40_500 });
    expect(result.totalCount).toBe(2);
  });

  it("garde le total de la base quand la liste est tronquée", async () => {
    mocks.rpc.mockResolvedValue({ data: [row(1, { total_count: "1500" })], error: null });
    const result = await tryLoadUpcomingHearings();
    expect(result.status === "ok" ? result.totalCount : 0).toBe(1500);
  });

  it("distingue l'absence d'audience d'une lecture en échec", async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    expect(await tryLoadUpcomingHearings()).toEqual({
      status: "ok",
      hearings: [],
      totalCount: 0,
    });

    mocks.rpc.mockResolvedValue({ data: null, error: new Error("function does not exist") });
    expect(await tryLoadUpcomingHearings()).toEqual({ status: "error" });
  });

  it("ne lève pas quand Supabase n'est pas configuré", async () => {
    mocks.client.mockReturnValue(null);
    expect(await tryLoadUpcomingHearings()).toEqual({ status: "error" });
  });

  it("garde son cache de données plus court que le rafraîchissement de la page", () => {
    expect(HEARINGS_DATA_REVALIDATE_SECONDS).toBeLessThan(3_600);
  });
});

describe("mustFailOnHearingsReadError", () => {
  it("fait échouer le rendu en production, pour garder la dernière bonne page", () => {
    expect(mustFailOnHearingsReadError({ NODE_ENV: "production", NEXT_PHASE: "" })).toBe(true);
    expect(
      mustFailOnHearingsReadError({
        NODE_ENV: "production",
        NEXT_PHASE: "phase-production-server",
      }),
    ).toBe(true);
  });

  it("ne fait pas échouer le build, ni le développement, ni les tests", () => {
    expect(
      mustFailOnHearingsReadError({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" }),
    ).toBe(false);
    expect(mustFailOnHearingsReadError({ NODE_ENV: "development" })).toBe(false);
    expect(mustFailOnHearingsReadError({ NODE_ENV: "test" })).toBe(false);
  });
});
