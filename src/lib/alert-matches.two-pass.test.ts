import { beforeEach, describe, expect, it, vi } from "vitest";

// Deux passages successifs du cron des alertes sur les MÊMES ventes, avec la vraie création des notifications et
// une base en mémoire qui applique la clé d'unicité (compte, correspondance, genre, canal) : la base silencieuse du
// changement de loyers de référence doit taire la correspondance au premier passage ET au second (n° 1).

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  alerts: [] as Row[],
  sales: [] as Row[],
  matches: [] as Row[],
  notifications: [] as Row[],
  emailConsent: false,
  /** Lecture de la carte des loyers en échec ? */
  rentUnavailable: false,
}));

function notificationKey(row: Row) {
  return [row.user_id, row.match_id, row.notification_kind, row.delivery_channel].join("|");
}

function fakeClient() {
  return {
    async rpc() {
      return { data: [], error: null };
    },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let op: "select" | "update" | "upsert" = "select";
      let patch: Row | null = null;
      let upserted: Row[] = [];
      let options: { ignoreDuplicates?: boolean } = {};
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return chain;
        },
        order: () => chain,
        in: () => chain,
        range: () => chain,
        update(value: Row) {
          op = "update";
          patch = value;
          return chain;
        },
        upsert(rows: Row[], opts?: { ignoreDuplicates?: boolean }) {
          op = "upsert";
          upserted = rows;
          options = opts ?? {};
          return chain;
        },
        then(resolve: (value: { data: unknown; error: unknown }) => void) {
          if (table === "user_alert_matches" && op === "upsert") {
            const written = upserted.map((row) => {
              const existing = db.matches.find(
                (match) => match.alert_id === row.alert_id && match.sale_id === row.sale_id,
              );
              if (existing) return Object.assign(existing, row);
              const created = {
                ...row,
                id: `match-${String(row.sale_id)}`,
                read_at: null,
                dismissed_at: null,
              };
              db.matches.push(created);
              return created;
            });
            return resolve({ data: written, error: null });
          }
          if (table === "user_alert_notifications" && op === "upsert") {
            const inserted: Row[] = [];
            for (const row of upserted) {
              const duplicate = db.notifications.some(
                (item) => notificationKey(item) === notificationKey(row),
              );
              if (duplicate && options.ignoreDuplicates) continue;
              const created = { ...row, id: `notification-${db.notifications.length}` };
              db.notifications.push(created);
              inserted.push(created);
            }
            return resolve({ data: inserted.map((row) => ({ id: row.id })), error: null });
          }
          if (table === "user_alerts" && op === "update") {
            const alert = db.alerts.find((item) => item.id === filters.id);
            if (alert) Object.assign(alert, patch);
            return resolve({ data: null, error: null });
          }
          if (table === "user_alerts") {
            return resolve({
              data: db.alerts.filter((row) => row.is_active === true),
              error: null,
            });
          }
          return resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  };
}

vi.mock("server-only", () => ({}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: fakeClient() }));
vi.mock("@/lib/system-auth", () => ({
  systemAuthForUser: async (userId: string) => ({
    supabase: fakeClient(),
    userId,
    claims: {},
    accountTier: "free",
    userRole: "user",
    isAdmin: false,
  }),
}));
vi.mock("@/lib/property-reports", () => ({
  resolvePlanEntitlements: async () => ({ plan: "analyse", hasAnalysisAccess: true }),
  assertFeatureEntitlement: async () => undefined,
}));
vi.mock("@/lib/queries", () => ({
  getSalesForAlertEvaluation: async (_filters: unknown, limit: number, offset: number) =>
    db.sales.slice(offset, offset + limit).map((sale) => ({ ...sale })),
  getSaleAlertDetails: async (ids: string[]) => ids.map((id) => ({ id })),
}));
vi.mock("@/lib/sale-market-estimates", () => ({ getPrecomputedMarketEstimate: async () => null }));
vi.mock("@/lib/notification-preferences", () => ({
  emailAlertConsentEnabled: async () => db.emailConsent,
}));
vi.mock("@/lib/email-alerts", () => ({ dispatchQueuedEmailAlertNotifications: async () => ({}) }));
vi.mock("@/lib/rent-reference.server", () => ({
  createRentLookupSession: () => ({
    load: async () => (sale: { id: string }) => REFERENCES[sale.id] ?? null,
    unavailable: () => db.rentUnavailable,
  }),
}));

import { resetPepiteSaleIdsForAlertsCache, runSmartAlertEvaluationBatch } from "./alert-matches";

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const home = (id: string, department: string) => ({
  id,
  department,
  property_type: "apartment",
  starting_price_eur: 100_000,
  app_surface_m2: 50,
  app_surface_kind: "habitable",
});
const reference = (rentPerM2: number) => ({
  rentPerM2,
  source: "anil_commune",
  reliability: "reliable",
  segment: "apt_all",
  communeCode: "23096",
  lowPerM2: null,
  highPerM2: null,
  observations: 100,
  vintage: 2025,
  sourceUpdatedOn: "2025-12-11",
});
const REFERENCES: Record<string, unknown> = {
  "sale-new": reference(12),
  "sale-old": reference(12),
};

const queuedFor = (saleId: string) =>
  db.notifications.filter(
    (row) =>
      row.sale_id === saleId &&
      row.delivery_status === "queued" &&
      db.matches.some((match) => match.id === row.match_id && match.sale_id === saleId),
  );
const statusesFor = (saleId: string) =>
  db.notifications
    .filter((row) => row.sale_id === saleId)
    .map((row) => `${String(row.delivery_channel)}:${String(row.delivery_status)}`)
    .sort();

describe("base silencieuse : deux passages successifs sur les mêmes ventes", () => {
  beforeEach(() => {
    db.alerts = [
      {
        id: "alert-1",
        user_id: "user-1",
        name: "Rendement",
        is_active: true,
        alert_frequency: "daily",
        last_evaluated_at: hoursAgo(5),
        dpe_classes: [],
        advanced_criteria: {},
        min_yield_pct: 6,
      },
    ];
    // Le département 23 n'a aucun repère départemental : une vente n'y correspond que grâce à l'ANIL ; le 33 en a un.
    db.sales = [home("sale-new", "23"), home("sale-old", "33")];
    db.matches = [];
    db.notifications = [];
    db.emailConsent = true;
    db.rentUnavailable = false;
    process.env.ALERT_RENT_BASIS_SWITCH_AT = hoursAgo(1);
    resetPepiteSaleIdsForAlertsCache();
  });

  it("la correspondance tue au premier passage n'est pas notifiée au second, hors fenêtre silencieuse", async () => {
    await runSmartAlertEvaluationBatch();

    // Premier passage : la vente due au seul changement de loyers est enregistrée, annulée sur les deux canaux ;
    // celle qui correspondait déjà reste notifiée normalement.
    expect(db.matches.map((match) => match.sale_id).sort()).toEqual(["sale-new", "sale-old"]);
    expect(statusesFor("sale-new")).toEqual(["email:cancelled", "in_app:cancelled"]);
    expect(statusesFor("sale-old")).toEqual(["email:queued", "in_app:queued"]);
    const lastEvaluated = String(db.alerts[0].last_evaluated_at);
    expect(Date.parse(lastEvaluated)).toBeGreaterThan(Date.parse(hoursAgo(1)));
    const afterFirst = db.notifications.length;

    // Second passage (l'alerte a été évaluée après le changement : plus de base silencieuse) : le pipeline a
    // réécrit les ventes, elles correspondent de nouveau.
    await runSmartAlertEvaluationBatch();

    expect(queuedFor("sale-new")).toEqual([]);
    expect(statusesFor("sale-new")).toEqual(["email:cancelled", "in_app:cancelled"]);
    expect(statusesFor("sale-old")).toEqual(["email:queued", "in_app:queued"]);
    expect(db.notifications).toHaveLength(afterFirst);
  });

  it("couvre le canal e-mail même sans consentement au premier passage (donné ensuite)", async () => {
    db.emailConsent = false;
    await runSmartAlertEvaluationBatch();
    expect(statusesFor("sale-new")).toEqual(["email:cancelled", "in_app:cancelled"]);
    expect(statusesFor("sale-old")).toEqual(["in_app:queued"]);

    db.emailConsent = true;
    await runSmartAlertEvaluationBatch();
    expect(queuedFor("sale-new")).toEqual([]);
  });

  it("lecture de l'ANIL en échec : rien n'est écrit, l'alerte garde sa date et la fenêtre reste utilisable", async () => {
    const before = String(db.alerts[0].last_evaluated_at);
    db.rentUnavailable = true;

    const failed = await runSmartAlertEvaluationBatch();

    expect(failed.failedUserCount).toBe(1);
    expect(db.alerts[0].last_evaluated_at).toBe(before);
    expect(db.matches).toEqual([]);
    expect(db.notifications).toEqual([]);

    db.rentUnavailable = false;
    await runSmartAlertEvaluationBatch();
    expect(statusesFor("sale-new")).toEqual(["email:cancelled", "in_app:cancelled"]);
    await runSmartAlertEvaluationBatch();
    expect(queuedFor("sale-new")).toEqual([]);
  });
});
