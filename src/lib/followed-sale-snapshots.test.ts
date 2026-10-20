import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import {
  toFollowedSaleSnapshot,
  type FollowedSaleSnapshotRow,
} from "@/lib/followed-sale-snapshots-shared";

const mocks = vi.hoisted(() => ({
  assertFavorites: vi.fn(),
  calls: [] as Array<[string, unknown[]]>,
  result: { data: null as unknown, error: null as unknown },
}));

vi.mock("@/lib/favorites", () => ({ assertSaleFavoritesAvailable: mocks.assertFavorites }));

import {
  deleteFollowedSaleSnapshot,
  listFollowedSaleSnapshots,
} from "@/lib/followed-sale-snapshots";

function row(overrides: Partial<FollowedSaleSnapshotRow> = {}): FollowedSaleSnapshotRow {
  return {
    id: "snap-1",
    sale_id: "sale-1",
    captured_at: "2026-10-14T12:05:00.000Z",
    expires_at: "2027-04-14T12:05:00.000Z",
    title: "Maison A",
    city: "Bordeaux",
    department: "33",
    postal_code: "33000",
    property_type: "house",
    tribunal_name: "Tribunal judiciaire de Bordeaux",
    sale_venue_type: "tribunal",
    starting_price_eur: 100_000,
    sale_date: "2026-10-14T12:00:00.000Z",
    lawyer_name: "Me Dupont",
    source_name: "vench",
    result_status: "unknown",
    adjudication_price_eur: null,
    adjudication_price_source: null,
    adjudication_price_withheld: false,
    personal_status: null,
    bid_ceiling_eur: null,
    ...overrides,
  };
}

function auth(): SupabaseAuthContext {
  // Un constructeur de requête qui enregistre ses appels et se résout comme une promesse.
  const builder: Record<string, unknown> = {};
  for (const name of ["select", "delete", "eq", "gt", "order", "limit"]) {
    builder[name] = (...args: unknown[]) => {
      mocks.calls.push([name, args]);
      return builder;
    };
  }
  builder.maybeSingle = () => Promise.resolve(mocks.result);
  builder.then = (resolve: (value: unknown) => unknown) => resolve(mocks.result);
  return {
    supabase: { from: () => builder },
    userId: "user-1",
  } as unknown as SupabaseAuthContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  mocks.result = { data: null, error: null };
  mocks.assertFavorites.mockResolvedValue({ plan: "decouverte" });
});

describe("toFollowedSaleSnapshot", () => {
  const now = new Date("2026-10-16T09:00:00.000Z");

  it("garde un résultat inconnu comme inconnu, sans prix ni source", () => {
    const snapshot = toFollowedSaleSnapshot(row(), now);
    expect(snapshot.result).toEqual({
      status: "unknown",
      priceEur: null,
      priceSource: null,
      priceWithheld: false,
    });
    expect(snapshot.personalStatus).toBeNull();
    expect(snapshot.bidCeilingEur).toBeNull();
  });

  it("rend le prix publié avec sa source, et la fenêtre de surenchère d'une vente judiciaire", () => {
    const snapshot = toFollowedSaleSnapshot(
      row({
        result_status: "adjudicated",
        adjudication_price_eur: 250_000,
        adjudication_price_source: "vench",
        personal_status: "bidding",
        bid_ceiling_eur: 180_000,
      }),
      now,
    );
    expect(snapshot.result).toEqual({
      status: "adjudicated",
      priceEur: 250_000,
      priceSource: "vench",
      priceWithheld: false,
    });
    expect(snapshot.personalStatus).toBe("bidding");
    expect(snapshot.bidCeilingEur).toBe(180_000);
    expect(snapshot.surenchere).toMatchObject({
      kind: "window",
      deadline: "2026-10-24",
      adjudicationConfirmed: true,
      expired: false,
    });
    expect(snapshot.surenchere).not.toHaveProperty("daysLeft");
  });

  it("distingue un prix réservé à l'offre Analyse d'un prix non connu", () => {
    const withheld = toFollowedSaleSnapshot(
      row({ result_status: "adjudicated", adjudication_price_withheld: true }),
      now,
    );
    expect(withheld.result).toMatchObject({
      status: "adjudicated",
      priceEur: null,
      priceWithheld: true,
    });
  });

  it("n'invente pas un prix : zéro ou valeur négative sont des prix absents, sans source", () => {
    const snapshot = toFollowedSaleSnapshot(
      row({
        result_status: "adjudicated",
        adjudication_price_eur: 0,
        adjudication_price_source: "vench",
      }),
      now,
    );
    expect(snapshot.result).toMatchObject({ priceEur: null, priceSource: null });
  });

  it("ne calcule pas de fenêtre pour une vente qui n'est pas judiciaire", () => {
    expect(toFollowedSaleSnapshot(row({ sale_venue_type: "notary" }), now).surenchere).toEqual({
      kind: "not_applicable",
    });
  });

  it("traite un statut personnel inconnu comme absent", () => {
    expect(
      toFollowedSaleSnapshot(row({ personal_status: "bogus" }), now).personalStatus,
    ).toBeNull();
  });
});

describe("listFollowedSaleSnapshots", () => {
  it("lit les instantanés du compte non échus, les plus récents d'abord", async () => {
    mocks.result = { data: [row(), row({ id: "snap-2", sale_id: "sale-2" })], error: null };
    const now = new Date("2026-10-16T09:00:00.000Z");

    const response = await listFollowedSaleSnapshots({ auth: auth(), now });

    expect(mocks.assertFavorites).toHaveBeenCalled();
    expect(mocks.calls).toContainEqual(["eq", ["user_id", "user-1"]]);
    expect(mocks.calls).toContainEqual(["gt", ["expires_at", "2026-10-16T09:00:00.000Z"]]);
    expect(mocks.calls).toContainEqual([
      "order",
      ["sale_date", { ascending: false, nullsFirst: false }],
    ]);
    expect(response.snapshots.map((snapshot) => snapshot.id)).toEqual(["snap-1", "snap-2"]);
  });

  it("remonte l'erreur de la base", async () => {
    mocks.result = { data: null, error: new Error("boom") };
    await expect(listFollowedSaleSnapshots({ auth: auth() })).rejects.toThrow("boom");
  });
});

describe("deleteFollowedSaleSnapshot", () => {
  it("retire un instantané du compte seulement", async () => {
    mocks.result = { data: { id: "snap-1" }, error: null };
    const response = await deleteFollowedSaleSnapshot({ auth: auth(), id: "snap-1" });
    expect(mocks.calls).toContainEqual(["eq", ["user_id", "user-1"]]);
    expect(mocks.calls).toContainEqual(["eq", ["id", "snap-1"]]);
    expect(response).toEqual({ ok: true, removed: true });
  });

  it("dit qu'il n'a rien retiré quand l'instantané n'existe pas ou n'est pas au compte", async () => {
    mocks.result = { data: null, error: null };
    expect(await deleteFollowedSaleSnapshot({ auth: auth(), id: "snap-9" })).toEqual({
      ok: true,
      removed: false,
    });
  });
});
