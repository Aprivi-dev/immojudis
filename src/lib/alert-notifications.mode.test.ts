import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  dispatchEmails: vi.fn(),
  resolveConfig: vi.fn(),
  channelFilters: [] as string[],
  orFilters: [] as string[],
  userFilters: [] as string[][],
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
 * Base minimale : `await` rend les lignes lues ou mises à jour. Les filtres (`eq`, `lte`, `in`, `not in`, `or` du
 * mode internal), la limite et la page (`range`) sont appliqués comme le ferait PostgREST ; une mise à jour passe
 * les lignes au statut `sent`.
 */
function installTables(queue: Array<Record<string, unknown>>, adminUserIds: string[] = []) {
  mocks.from.mockImplementation((table: string) => {
    const builder: Record<string, unknown> = {};
    const filters: Array<(item: Record<string, unknown>) => boolean> = [];
    let window: [number, number] = [0, Infinity];
    let updating = false;
    for (const method of ["select", "order"]) {
      builder[method] = () => builder;
    }
    builder.update = () => {
      updating = true;
      return builder;
    };
    builder.limit = (value: number) => {
      window = [0, value];
      return builder;
    };
    builder.range = (from: number, to: number) => {
      window = [from, to + 1];
      return builder;
    };
    builder.eq = (column: string, value: string) => {
      if (column === "delivery_channel") mocks.channelFilters.push(value);
      filters.push((item) => item[column] === value);
      return builder;
    };
    builder.lte = (column: string, value: string) => {
      filters.push((item) => String(item[column]) <= value);
      return builder;
    };
    builder.in = (column: string, values: string[]) => {
      if (column === "user_id") mocks.userFilters.push([...values]);
      filters.push((item) => values.includes(item[column] as string));
      return builder;
    };
    builder.not = (column: string, _operator: string, list: string) => {
      const values = list.replace(/^\(|\)$/g, "").split(",");
      filters.push((item) => !values.includes(item[column] as string));
      return builder;
    };
    builder.or = (expression: string) => {
      mocks.orFilters.push(expression);
      return builder;
    };
    builder.then = (resolve: (value: unknown) => unknown) => {
      if (table === "user_profiles") {
        return resolve({ data: adminUserIds.map((user_id) => ({ user_id })), error: null });
      }
      if (table !== "user_alert_notifications") return resolve({ data: [], error: null });
      const rows = queue.filter((item) => filters.every((filter) => filter(item)));
      if (updating) {
        for (const item of rows) item.delivery_status = "sent";
        return resolve({ data: rows, error: null });
      }
      return resolve({ data: rows.slice(window[0], window[1]), error: null });
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
    mocks.userFilters = [];
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
    expect(mocks.channelFilters).not.toContain("email");
    expect(result.emailMode).toBe("off");
    expect(result.emailCandidateCount).toBe(0);
    expect(result.emailDispatchedCount).toBe(0);
  });

  it("en mode on envoie les emails dus", async () => {
    installTables([row("n1", "user-1", "email")]);

    const result = await dispatchDueAlertNotifications({ now: NOW, emailMode: "on" });

    expect(mocks.dispatchEmails).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchEmails.mock.calls[0][0].notifications).toHaveLength(1);
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

    // Seuls les administrateurs sont lus : les 200 emails plus anciens des autres comptes restent en file.
    expect(mocks.userFilters[0]).toEqual(["admin-1"]);
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
    expect(mocks.channelFilters).not.toContain("email");
    expect(mocks.dispatchEmails.mock.calls[0][0].notifications).toHaveLength(0);
  });

  it("un compte reçoit toute sa file en un seul passage, même quand son alerte couvre le catalogue", async () => {
    // 03/11/2026 : 841 emails en file pour un compte, 474 pour un autre ; la fenêtre de 200 lignes n'en prenait
    // qu'une partie par jour, et un compte à une seule vente attendait derrière eux.
    const heavy = Array.from({ length: 1_500 }, (_, index) =>
      row(`heavy-${String(index).padStart(4, "0")}`, "user-heavy", "email"),
    );
    const other = Array.from({ length: 474 }, (_, index) =>
      row(`other-${index}`, "user-other", "email"),
    );
    installTables([...heavy, ...other, row("single", "user-single", "email")]);

    const result = await dispatchDueAlertNotifications({ now: NOW, emailMode: "on" });

    expect(mocks.dispatchEmails).toHaveBeenCalledTimes(1);
    const sent: Array<{ user_id: string }> = mocks.dispatchEmails.mock.calls[0][0].notifications;
    expect(sent).toHaveLength(1_975);
    expect(new Set(sent.map((item) => item.user_id))).toEqual(
      new Set(["user-heavy", "user-other", "user-single"]),
    );
    expect(result.candidateCount).toBe(1_975);
  });

  it("publie toutes les notifications dues dans l'application, par pages", async () => {
    installTables(
      Array.from({ length: 450 }, (_, index) => row(`app-${index}`, `user-${index % 3}`, "in_app")),
    );

    const result = await dispatchDueAlertNotifications({ now: NOW, limit: 200, emailMode: "off" });

    expect(result.dispatchedCount).toBe(450);
  });

  it("n'envoie pas un email prévu plus tard", async () => {
    installTables([
      row("due", "user-1", "email"),
      { ...row("later", "user-1", "email"), scheduled_for: "2026-11-09T07:00:00.000Z" },
    ]);

    await dispatchDueAlertNotifications({ now: NOW, emailMode: "on" });

    expect(
      mocks.dispatchEmails.mock.calls[0][0].notifications.map((item: { id: string }) => item.id),
    ).toEqual(["due"]);
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
