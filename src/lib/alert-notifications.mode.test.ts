import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  dispatchEmails: vi.fn(),
  resolveConfig: vi.fn(),
  channelFilters: [] as string[],
  orFilters: [] as string[],
}));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("@/lib/email-alerts", () => ({
  dispatchQueuedEmailAlertNotifications: mocks.dispatchEmails,
  resolveEmailAlertDeliveryConfig: mocks.resolveConfig,
}));
vi.mock("@/lib/notification-preferences", () => ({ emailAlertConsentEnabled: vi.fn() }));
vi.mock("@/lib/property-reports", () => ({ assertFeatureEntitlement: vi.fn() }));

import {
  dispatchDueAlertNotifications,
  filterEmailNotificationsByMode,
} from "@/lib/alert-notifications";

const NOW = new Date("2026-10-31T09:30:00.000Z");

function row(id: string, userId: string, channel: "email" | "in_app") {
  return {
    id,
    user_id: userId,
    delivery_channel: channel,
    delivery_status: "queued",
    scheduled_for: "2026-10-31T07:00:00.000Z",
    alert_id: "alert-1",
    notification_snapshot: {},
  } as Record<string, unknown>;
}

/**
 * Chaîne de requête minimale : `await` rend les lignes du tableau lu ou mis à jour. À la lecture
 * des notifications, le filtre de canal (`eq`), le filtre `or` du mode internal, l'ordre et la
 * limite sont appliqués comme le ferait la base.
 */
function installTables(queue: Array<Record<string, unknown>>, adminUserIds: string[] = []) {
  mocks.from.mockImplementation((table: string) => {
    const builder: Record<string, unknown> = {};
    let channel: string | null = null;
    let allowedEmailUsers: string[] | null = null;
    let max = Infinity;
    let updating = false;
    for (const method of ["select", "lte", "order", "in"]) {
      builder[method] = () => builder;
    }
    builder.update = () => {
      updating = true;
      return builder;
    };
    builder.limit = (value: number) => {
      max = value;
      return builder;
    };
    builder.eq = (column: string, value: string) => {
      if (column === "delivery_channel") {
        mocks.channelFilters.push(value);
        channel = value;
      }
      return builder;
    };
    builder.or = (expression: string) => {
      mocks.orFilters.push(expression);
      const list = /user_id\.in\.\(([^)]*)\)/.exec(expression)?.[1] ?? "";
      allowedEmailUsers = list ? list.split(",") : [];
      return builder;
    };
    builder.then = (resolve: (value: unknown) => unknown) => {
      if (table === "user_profiles") {
        return resolve({ data: adminUserIds.map((user_id) => ({ user_id })), error: null });
      }
      if (table !== "user_alert_notifications") return resolve({ data: [], error: null });
      if (updating) return resolve({ data: queue, error: null });
      const rows = queue
        .filter((item) => channel === null || item.delivery_channel === channel)
        .filter(
          (item) =>
            allowedEmailUsers === null ||
            item.delivery_channel === "in_app" ||
            allowedEmailUsers.includes(item.user_id as string),
        )
        .slice(0, max);
      return resolve({ data: rows, error: null });
    };
    return builder;
  });
}

describe("filterEmailNotificationsByMode", () => {
  const emails = [row("n1", "admin-1", "email"), row("n2", "user-2", "email")];

  it("laisse tout partir en mode on, sans lire les profils", async () => {
    const loadAdminUserIds = vi.fn();
    const result = await filterEmailNotificationsByMode({
      mode: "on",
      notifications: emails as never,
      loadAdminUserIds,
    });
    expect(result.allowed).toHaveLength(2);
    expect(result.heldBackCount).toBe(0);
    expect(loadAdminUserIds).not.toHaveBeenCalled();
  });

  it("n'envoie rien en mode off et garde tout en file", async () => {
    const loadAdminUserIds = vi.fn();
    const result = await filterEmailNotificationsByMode({
      mode: "off",
      notifications: emails as never,
      loadAdminUserIds,
    });
    expect(result).toEqual({ allowed: [], heldBackCount: 2 });
    expect(loadAdminUserIds).not.toHaveBeenCalled();
  });

  it("ne garde que les administrateurs en mode internal", async () => {
    const loadAdminUserIds = vi.fn().mockResolvedValue(new Set(["admin-1"]));
    const result = await filterEmailNotificationsByMode({
      mode: "internal",
      notifications: emails as never,
      loadAdminUserIds,
    });
    expect(result.allowed.map((notification) => notification.id)).toEqual(["n1"]);
    expect(result.heldBackCount).toBe(1);
    expect(loadAdminUserIds).toHaveBeenCalledWith(["admin-1", "user-2"]);
  });
});

describe("dispatchDueAlertNotifications selon ALERT_NOTIFICATIONS_MODE", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.channelFilters = [];
    mocks.orFilters = [];
    mocks.dispatchEmails.mockResolvedValue({
      configured: true,
      missing: [],
      candidateCount: 1,
      sentCount: 1,
      failedCount: 0,
      skippedCount: 0,
      outcomes: [],
    });
    mocks.resolveConfig.mockReturnValue({ configured: false, missing: ["RESEND_API_KEY"] });
  });

  it("en mode off n'appelle pas l'envoi, ne lit que les notifications dans l'application et reste vert", async () => {
    installTables([row("n1", "user-1", "in_app")]);

    const result = await dispatchDueAlertNotifications({ now: NOW, emailMode: "off" });

    expect(mocks.dispatchEmails).not.toHaveBeenCalled();
    expect(mocks.channelFilters).toContain("in_app");
    expect(result.emailMode).toBe("off");
    expect(result.emailCandidateCount).toBe(0);
    expect(result.emailDispatchedCount).toBe(0);
  });

  it("en mode on envoie les emails dus, sans filtre de canal à la lecture", async () => {
    installTables([row("n1", "user-1", "email")]);

    const result = await dispatchDueAlertNotifications({ now: NOW, emailMode: "on" });

    expect(mocks.dispatchEmails).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchEmails.mock.calls[0][0].notifications).toHaveLength(1);
    expect(mocks.channelFilters).not.toContain("in_app");
    expect(result).toMatchObject({
      emailMode: "on",
      emailDispatchedCount: 1,
      emailHeldBackCount: 0,
    });
  });

  it("en mode internal, 200 anciens emails non administrateurs ne cachent pas l'email d'un administrateur", async () => {
    const olderUserEmails = Array.from({ length: 200 }, (_, index) => ({
      ...row(`old-${index}`, `user-${index}`, "email"),
      scheduled_for: "2026-10-30T07:00:00.000Z",
    }));
    installTables(
      [
        ...olderUserEmails,
        row("admin-email", "admin-1", "email"),
        row("n-app", "user-9", "in_app"),
      ],
      ["admin-1"],
    );

    const result = await dispatchDueAlertNotifications({
      now: NOW,
      limit: 200,
      emailMode: "internal",
    });

    expect(mocks.orFilters).toHaveLength(1);
    expect(mocks.orFilters[0]).toContain("user_id.in.(admin-1)");
    expect(mocks.dispatchEmails).toHaveBeenCalledTimes(1);
    expect(
      mocks.dispatchEmails.mock.calls[0][0].notifications.map((item: { id: string }) => item.id),
    ).toEqual(["admin-email"]);
    expect(result).toMatchObject({ emailMode: "internal", emailHeldBackCount: 0 });
  });

  it("en mode internal sans administrateur, ne lit que les notifications dans l'application", async () => {
    installTables([row("n1", "user-1", "email"), row("n2", "user-2", "in_app")], []);

    await dispatchDueAlertNotifications({ now: NOW, emailMode: "internal" });

    expect(mocks.channelFilters).toContain("in_app");
    expect(mocks.orFilters).toHaveLength(0);
    expect(mocks.dispatchEmails.mock.calls[0][0].notifications).toHaveLength(0);
  });

  it("par défaut (variable absente) le mode est on", async () => {
    installTables([row("n1", "user-1", "email")]);
    const previous = process.env.ALERT_NOTIFICATIONS_MODE;
    delete process.env.ALERT_NOTIFICATIONS_MODE;
    try {
      const result = await dispatchDueAlertNotifications({ now: NOW });
      expect(result.emailMode).toBe("on");
      expect(mocks.dispatchEmails).toHaveBeenCalledTimes(1);
    } finally {
      if (previous !== undefined) process.env.ALERT_NOTIFICATIONS_MODE = previous;
    }
  });
});
