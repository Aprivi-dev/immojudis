import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  writes: [] as Array<{ table: string; rows: Row[] }>,
  launchOffer: vi.fn(),
  confirmedEmail: vi.fn(),
}));

vi.mock("@/lib/launch-offer.server", () => ({
  isLaunchOfferActive: mocks.launchOffer,
  hasConfirmedEmail: mocks.confirmedEmail,
}));
vi.mock("@/lib/usage", () => ({ recordFeatureUsageEvent: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => {
  /** Table en mémoire : applique les filtres d'égalité, de liste et de page. */
  function table(name: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let window: [number, number] | null = null;
    let limit: number | null = null;
    let inserted: Row[] | null = null;
    const rows = () => {
      if (inserted) return inserted;
      let found = (mocks.tables[name] ?? []).filter((row) => filters.every((keep) => keep(row)));
      if (window) found = found.slice(window[0], window[1] + 1);
      if (limit != null) found = found.slice(0, limit);
      return found;
    };
    const query: Record<string, unknown> = {
      select: () => query,
      order: () => query,
      // `a.eq.x,b.eq.y` : l'une des égalités suffit.
      or: (expression: string) => {
        const terms = expression.split(",").map((term) => term.split(".eq."));
        filters.push((row) => terms.some(([column, value]) => row[column] === value));
        return query;
      },
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return query;
      },
      neq: (column: string, value: unknown) => {
        filters.push((row) => row[column] !== value);
        return query;
      },
      is: (column: string, value: unknown) => {
        filters.push((row) => (row[column] ?? null) === value);
        return query;
      },
      in: (column: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[column]));
        return query;
      },
      limit: (count: number) => {
        limit = count;
        return query;
      },
      range: (from: number, to: number) => {
        window = [from, to];
        return query;
      },
      upsert: (payload: Row[]) => {
        mocks.writes.push({ table: name, rows: payload });
        inserted = payload.map((row, index) => ({
          id: `event-${index + 1}`,
          read_at: null,
          dismissed_at: null,
          ...row,
        }));
        return query;
      },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        resolve({ data: rows(), error: null }),
    };
    return query;
  }
  return { supabaseAdmin: { from: table } };
});

import {
  monitorUserSaleChanges,
  runSaleChangeMonitorBatch,
  type SaleChangeSnapshot,
} from "@/lib/sale-change-monitor";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";

const USER = "7d335032-e935-4550-9347-ed22b0f63449";
const SALE = "11111111-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-03T06:45:00Z");

const previousSnapshot: SaleChangeSnapshot = {
  title: "Maison",
  city: "Bordeaux",
  department: "33",
  startingPriceEur: 100_000,
  saleDate: "2026-11-10T13:00:00Z",
  status: "upcoming",
  investmentScore: null,
  documentCount: 0,
  documentSignature: null,
  updatedAt: null,
  sourceUrl: null,
};

function auth(): SupabaseAuthContext {
  return {
    supabase: supabaseAdmin as unknown as SupabaseAuthContext["supabase"],
    userId: USER,
    claims: {},
    accountTier: "premium",
    userRole: "user",
    isAdmin: false,
  };
}

/** Une vente suivie en favori, avec son instantané précédent, absente de la vue du catalogue. */
function followedSaleOutsideCatalogue(sale: Row) {
  mocks.tables = {
    user_favorites: [{ id: "fav-1", user_id: USER, sale_id: SALE, created_at: "2026-10-01" }],
    user_sale_watch_snapshots: [
      {
        user_id: USER,
        sale_id: SALE,
        watch_kind: "favorite",
        watch_id: "fav-1",
        snapshot: previousSnapshot,
      },
    ],
    v_auction_sales_app: [],
    auction_sales: [{ id: SALE, sale_date: "2026-11-10T13:00:00Z", ...sale }],
  };
}

beforeEach(() => {
  mocks.tables = {};
  mocks.writes = [];
  mocks.launchOffer.mockReset();
  mocks.confirmedEmail.mockReset();
});

describe("suivi des ventes sorties du catalogue", () => {
  it.each(["withdrawn", "cancelled", "adjudicated"])(
    "signale une vente suivie passée à %s alors qu'elle a quitté la vue du catalogue",
    async (status) => {
      followedSaleOutsideCatalogue({ status });
      const response = await monitorUserSaleChanges({ auth: auth(), now: NOW });

      expect(response.changeCount).toBe(1);
      expect(response.events).toHaveLength(1);
      expect(response.events[0]).toMatchObject({
        saleId: SALE,
        eventKind: "status_changed",
        severity: "urgent",
        fingerprint: `status_changed:status:upcoming:${status}`,
        changeSummary: { field: "status", previousValue: "upcoming", currentValue: status },
      });
      // L'instantané garde le nouveau statut : le même changement n'est pas signalé deux fois.
      const snapshotWrite = mocks.writes.find(
        (write) => write.table === "user_sale_watch_snapshots",
      );
      expect(snapshotWrite?.rows[0]).toMatchObject({
        sale_id: SALE,
        snapshot: { status, startingPriceEur: 100_000 },
      });
    },
  );

  it("ne signale que le statut : la date et les autres champs gardent leur valeur précédente", async () => {
    followedSaleOutsideCatalogue({ status: "withdrawn", sale_date: "2027-01-01T09:00:00Z" });
    const response = await monitorUserSaleChanges({ auth: auth(), now: NOW });
    expect(response.events.map((event) => event.eventKind)).toEqual(["status_changed"]);
  });

  it("respecte la quarantaine : aucune information sur une vente non publique", async () => {
    followedSaleOutsideCatalogue({ status: "withdrawn", catalogue_quarantined: true });
    const response = await monitorUserSaleChanges({ auth: auth(), now: NOW });
    expect(response.changeCount).toBe(0);
    expect(mocks.writes).toEqual([]);

    followedSaleOutsideCatalogue({
      status: "withdrawn",
      source_identity_mismatch: "licitor:abc",
    });
    const marked = await monitorUserSaleChanges({ auth: auth(), now: NOW });
    expect(marked.changeCount).toBe(0);
    expect(mocks.writes).toEqual([]);
  });

  it("reste muet pour une vente sortie du catalogue sans statut grave (fin de validité)", async () => {
    followedSaleOutsideCatalogue({ status: "upcoming" });
    const response = await monitorUserSaleChanges({ auth: auth(), now: NOW });
    expect(response.changeCount).toBe(0);
    expect(mocks.writes).toEqual([]);
  });

  it("ne devine rien sans instantané précédent", async () => {
    followedSaleOutsideCatalogue({ status: "withdrawn" });
    mocks.tables.user_sale_watch_snapshots = [];
    const response = await monitorUserSaleChanges({ auth: auth(), now: NOW });
    expect(response.changeCount).toBe(0);
    expect(mocks.writes).toEqual([]);
  });

  it("signale aussi une vente d'une alerte, d'après l'instantané de la correspondance", async () => {
    followedSaleOutsideCatalogue({ status: "cancelled" });
    mocks.tables.user_favorites = [];
    mocks.tables.user_sale_watch_snapshots = [];
    mocks.tables.user_alert_matches = [
      {
        id: "match-1",
        user_id: USER,
        sale_id: SALE,
        dismissed_at: null,
        matched_at: "2026-10-02",
        match_snapshot: { sale: { id: SALE, ...previousSnapshot } },
      },
    ];
    const response = await monitorUserSaleChanges({ auth: auth(), now: NOW });
    expect(response.events[0]).toMatchObject({
      watchKind: "alert_match",
      eventKind: "status_changed",
    });
  });
});

describe("comptes examinés par le passage du suivi", () => {
  const CONFIRMED = "aaaaaaaa-0000-4000-8000-000000000001";
  const UNCONFIRMED = "aaaaaaaa-0000-4000-8000-000000000002";

  beforeEach(() => {
    mocks.launchOffer.mockResolvedValue(true);
    mocks.confirmedEmail.mockImplementation(async (userId: string) => userId === CONFIRMED);
    mocks.tables = {
      user_profiles: [
        { user_id: CONFIRMED, account_tier: "free", user_role: "user" },
        { user_id: UNCONFIRMED, account_tier: "free", user_role: "user" },
      ],
      user_notification_preferences: [
        { user_id: CONFIRMED, sale_reminders_enabled: true },
        { user_id: UNCONFIRMED, sale_reminders_enabled: true },
      ],
    };
  });

  it("lit le vrai profil et écarte, sans échec, un compte à l'email non confirmé pendant l'offre", async () => {
    const result = await runSaleChangeMonitorBatch({ now: NOW });
    expect(result.candidateUserCount).toBe(2);
    expect(result.monitoredUserCount).toBe(1);
    expect(result.skippedUserCount).toBe(1);
    expect(result.failedUserCount).toBe(0);
    expect(result.results.find((item) => item.userId === UNCONFIRMED)).toMatchObject({
      ok: true,
      skipped: true,
    });
    // Le droit vient de l'offre ET de l'email confirmé, pas d'un niveau premium supposé.
    expect(mocks.confirmedEmail).toHaveBeenCalledWith(CONFIRMED);
    expect(mocks.confirmedEmail).toHaveBeenCalledWith(UNCONFIRMED);
  });

  it("n'accorde aucun droit sans l'offre à un compte gratuit, même consentant", async () => {
    mocks.launchOffer.mockResolvedValue(false);
    const result = await runSaleChangeMonitorBatch({ now: NOW });
    // Sans l'offre, seuls les comptes premium, administrateurs ou abonnés sont candidats.
    expect(result.candidateUserCount).toBe(0);
  });

  it("examine tous les comptes consentants, plus nombreux que le lot", async () => {
    mocks.confirmedEmail.mockResolvedValue(true);
    const consenting = Array.from({ length: 30 }, (_, index) => ({
      user_id: `bbbbbbbb-0000-4000-8000-${String(index).padStart(12, "0")}`,
    }));
    const others = Array.from({ length: 40 }, (_, index) => ({
      user_id: `cccccccc-0000-4000-8000-${String(index).padStart(12, "0")}`,
    }));
    mocks.tables = {
      user_profiles: [...consenting, ...others].map((row) => ({
        ...row,
        account_tier: "free",
        user_role: "user",
      })),
      user_notification_preferences: consenting.map((row) => ({
        ...row,
        sale_reminders_enabled: true,
      })),
    };
    const result = await runSaleChangeMonitorBatch({ userLimit: 25, now: NOW });
    const examined = new Set(result.results.map((item) => item.userId));
    for (const row of consenting) expect(examined.has(row.user_id)).toBe(true);
    // 30 consentants + le lot de 25 autres comptes.
    expect(result.candidateUserCount).toBe(55);
    expect(result.failedUserCount).toBe(0);
  });
});
