import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
const store = vi.hoisted(() => ({
  /** Lignes par table, une par compte (`user_id`), comme les tables touchées par les retraits. */
  tables: new Map<string, Map<string, Record<string, unknown>>>(),
  notifications: [] as Record<string, unknown>[],
}));

// Base minimale en mémoire : `upsert` fusionne par compte dans sa table, `select().eq().maybeSingle()`
// lit la ligne du compte, `update().eq()…` modifie les envois d'alerte qui correspondent.
vi.mock("@/integrations/supabase/client.server", () => {
  const table = (name: string) => {
    if (!store.tables.has(name)) store.tables.set(name, new Map());
    return store.tables.get(name)!;
  };
  return {
    supabaseAdmin: {
      from(name: string) {
        return {
          upsert(row: Row) {
            const key = String(row.user_id);
            const merged = { ...table(name).get(key), ...row };
            table(name).set(key, merged);
            const written: Record<string, unknown> = {
              select: () => written,
              single: () => Promise.resolve({ data: merged, error: null }),
              then: (ok: (value: unknown) => unknown, ko: (reason: unknown) => unknown) =>
                Promise.resolve({ error: null }).then(ok, ko),
            };
            return written;
          },
          select() {
            const filters: Array<[string, unknown]> = [];
            const builder: Record<string, unknown> = {
              eq(column: string, value: unknown) {
                filters.push([column, value]);
                return builder;
              },
              maybeSingle: () =>
                Promise.resolve({
                  data:
                    [...table(name).values()].find((row) =>
                      filters.every(([column, value]) => row[column] === value),
                    ) ?? null,
                  error: null,
                }),
            };
            return builder;
          },
          update(patch: Row) {
            const filters: Array<[string, unknown]> = [];
            const builder: Record<string, unknown> = {
              eq(column: string, value: unknown) {
                filters.push([column, value]);
                return builder;
              },
              then(ok: (value: unknown) => unknown, ko: (reason: unknown) => unknown) {
                for (const row of name === "user_alert_notifications" ? store.notifications : []) {
                  if (filters.every(([column, value]) => row[column] === value))
                    Object.assign(row, patch);
                }
                return Promise.resolve({ error: null }).then(ok, ko);
              },
            };
            return builder;
          },
        };
      },
    },
  };
});

import { revokeAllEmailConsents } from "@/lib/account-email-delivery-events";

function snapshot() {
  return JSON.stringify([
    [...store.tables.entries()].map(([name, rows]) => [name, [...rows.entries()]]),
    store.notifications,
  ]);
}

describe("retrait des consentements : idempotent quand Resend rejoue l'évènement", () => {
  it("rejouer le retrait laisse le même état final", async () => {
    store.tables.set(
      "user_notification_preferences",
      new Map([
        [
          "user-1",
          {
            user_id: "user-1",
            alert_email_enabled: true,
            sale_reminders_enabled: true,
            weekly_digest_enabled: true,
            sale_results_enabled: true,
          },
        ],
      ]),
    );
    store.tables.set(
      "offer_opening_notifications",
      new Map([
        [
          "user-1",
          {
            user_id: "user-1",
            notify_enabled: true,
            consented_at: "2026-10-20T10:00:00.000Z",
            consent_text_version: "offer-opening-v1",
          },
        ],
      ]),
    );
    store.notifications.push(
      { user_id: "user-1", delivery_channel: "email", delivery_status: "queued" },
      { user_id: "user-1", delivery_channel: "email", delivery_status: "sent" },
      { user_id: "user-2", delivery_channel: "email", delivery_status: "queued" },
    );

    await revokeAllEmailConsents("user-1", new Date("2026-11-01T10:00:00.000Z"));
    const afterFirst = snapshot();
    await revokeAllEmailConsents("user-1", new Date("2026-11-01T10:00:00.000Z"));
    const afterReplay = snapshot();

    expect(afterReplay).toBe(afterFirst);
    expect(store.tables.get("user_notification_preferences")?.size).toBe(1);
    expect(store.tables.get("user_notification_preferences")?.get("user-1")).toMatchObject({
      alert_email_enabled: false,
      sale_reminders_enabled: false,
      weekly_digest_enabled: false,
      sale_results_enabled: false,
    });
    // C8 : l'avis de fin d'essai (J+5) et l'email d'ouverture ne partent plus vers cette adresse.
    expect([...(store.tables.get("launch_offer_end_notice_optouts")?.keys() ?? [])]).toEqual([
      "user-1",
    ]);
    expect(store.tables.get("offer_opening_notifications")?.get("user-1")).toMatchObject({
      notify_enabled: false,
      revoked_at: "2026-11-01T10:00:00.000Z",
    });
    expect(store.notifications.map((row) => row.delivery_status)).toEqual([
      "cancelled",
      "sent",
      "queued",
    ]);
  });
});
