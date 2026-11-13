import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn(), entitlement: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/email-alerts", () => ({
  dispatchQueuedEmailAlertNotifications: vi.fn(),
  resolveEmailAlertDeliveryConfig: vi.fn(),
}));
vi.mock("@/lib/notification-preferences", () => ({ emailAlertConsentEnabled: vi.fn() }));
vi.mock("@/lib/entitlements.server", () => ({ assertFeatureEntitlement: mocks.entitlement }));

import { PublicApiError } from "@/lib/api-errors";
import {
  alertNotificationUpdateSchema,
  updateAlertNotificationState,
} from "@/lib/alert-notifications";

const NOTIFICATION_ID = "0b6f1d2c-3a4e-4f5a-8b9c-1d2e3f4a5b6c";

function row() {
  return {
    id: NOTIFICATION_ID,
    alert_id: "alert-1",
    match_id: "match-1",
    sale_id: "sale-1",
    user_id: "user-1",
    notification_kind: "daily_digest",
    delivery_channel: "in_app",
    delivery_status: "sent",
    scheduled_for: "2026-10-31T07:00:00.000Z",
    sent_at: null,
    read_at: "2026-10-31T10:00:00.000Z",
    dismissed_at: null,
    created_at: "2026-10-31T06:00:00.000Z",
    updated_at: "2026-10-31T10:00:00.000Z",
    notification_snapshot: {},
  };
}

function install(result: { data: unknown; error?: unknown }) {
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["update", "eq", "select"]) {
    builder[method] = vi.fn().mockReturnValue(builder);
  }
  builder.maybeSingle = vi.fn().mockResolvedValue({ error: null, ...result });
  builder.single = vi.fn();
  mocks.from.mockReturnValue(builder);
  return builder;
}

const auth = (): never => ({ userId: "user-1", supabase: { from: mocks.from } }) as never;

describe("updateAlertNotificationState", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.entitlement.mockResolvedValue({ plan: "analyse" });
  });

  it("reads the updated row with maybeSingle, scoped to the account", async () => {
    const query = install({ data: row() });

    const result = await updateAlertNotificationState({
      auth: auth(),
      notificationId: NOTIFICATION_ID,
      action: "read",
    });

    expect(result.notification.id).toBe(NOTIFICATION_ID);
    expect(query.maybeSingle).toHaveBeenCalled();
    expect(query.single).not.toHaveBeenCalled();
    expect(query.eq).toHaveBeenCalledWith("id", NOTIFICATION_ID);
    expect(query.eq).toHaveBeenCalledWith("user_id", "user-1");
  });

  it.each([
    ["read", "read_at", "string"],
    ["unread", "read_at", null],
    ["dismiss", "dismissed_at", "string"],
    ["restore", "dismissed_at", null],
  ] as const)("action %s writes only %s", async (action, column, expected) => {
    const query = install({ data: row() });

    await updateAlertNotificationState({ auth: auth(), notificationId: NOTIFICATION_ID, action });

    const patch = query.update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(patch).sort()).toEqual([column, "updated_at"].sort());
    if (expected === null) expect(patch[column]).toBeNull();
    else expect(typeof patch[column]).toBe("string");
  });

  it("answers 404 when no row matches (unknown notification or another account's)", async () => {
    install({ data: null });

    const error = await updateAlertNotificationState({
      auth: auth(),
      notificationId: NOTIFICATION_ID,
      action: "read",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PublicApiError);
    expect((error as PublicApiError).status).toBe(404);
  });

  it("restores nothing and writes nothing for an action outside the list", async () => {
    const query = install({ data: row() });

    const error = await updateAlertNotificationState({
      auth: auth(),
      notificationId: NOTIFICATION_ID,
      action: "archive" as never,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PublicApiError);
    expect((error as PublicApiError).status).toBe(400);
    expect(query.update).not.toHaveBeenCalled();
  });

  it("lets a database failure through", async () => {
    install({ data: null, error: new Error("connection reset") });

    await expect(
      updateAlertNotificationState({
        auth: auth(),
        notificationId: NOTIFICATION_ID,
        action: "read",
      }),
    ).rejects.toThrow("connection reset");
  });
});

describe("alertNotificationUpdateSchema", () => {
  it("accepte tout UUID que Postgres accepte, comme le reste de l'application (`uuid.ts`)", () => {
    const parse = (notificationId: string) =>
      alertNotificationUpdateSchema.safeParse({ notificationId, action: "read" }).success;

    expect(parse("00000000-0000-0000-0000-000000000000")).toBe(true);
    expect(parse(NOTIFICATION_ID.toUpperCase())).toBe(true);
    expect(parse("pas-un-uuid")).toBe(false);
  });
});
