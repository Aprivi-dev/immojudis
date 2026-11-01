import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
const store = vi.hoisted(() => ({
  preferences: new Map<string, Row>(),
  notifications: [] as Row[],
}));

// Base minimale en mémoire : `upsert` fusionne par compte, `update().eq()…` modifie les lignes qui correspondent.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from(table: string) {
      return {
        upsert(row: Row) {
          const key = String(row.user_id);
          store.preferences.set(key, { ...store.preferences.get(key), ...row });
          return Promise.resolve({ error: null });
        },
        update(patch: Row) {
          const filters: Array<[string, unknown]> = [];
          const builder: Record<string, unknown> = {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return builder;
            },
            then(ok: (value: unknown) => unknown, ko: (reason: unknown) => unknown) {
              for (const row of table === "user_alert_notifications" ? store.notifications : []) {
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
}));

import { revokeAllEmailConsents } from "@/lib/account-email-delivery-events";

describe("retrait des consentements : idempotent quand Resend rejoue l'évènement", () => {
  it("rejouer le retrait laisse le même état final", async () => {
    store.preferences.set("user-1", {
      user_id: "user-1",
      alert_email_enabled: true,
      sale_reminders_enabled: true,
      weekly_digest_enabled: true,
      sale_results_enabled: true,
    });
    store.notifications.push(
      { user_id: "user-1", delivery_channel: "email", delivery_status: "queued" },
      { user_id: "user-1", delivery_channel: "email", delivery_status: "sent" },
      { user_id: "user-2", delivery_channel: "email", delivery_status: "queued" },
    );

    await revokeAllEmailConsents("user-1", new Date("2026-11-01T10:00:00.000Z"));
    const afterFirst = JSON.stringify([[...store.preferences.entries()], store.notifications]);
    await revokeAllEmailConsents("user-1", new Date("2026-11-01T10:00:00.000Z"));
    const afterReplay = JSON.stringify([[...store.preferences.entries()], store.notifications]);

    expect(afterReplay).toBe(afterFirst);
    expect(store.preferences.size).toBe(1);
    expect(store.preferences.get("user-1")).toMatchObject({
      alert_email_enabled: false,
      sale_reminders_enabled: false,
      weekly_digest_enabled: false,
      sale_results_enabled: false,
    });
    expect(store.notifications.map((row) => row.delivery_status)).toEqual([
      "cancelled",
      "sent",
      "queued",
    ]);
  });
});
