import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRequiredError, ForbiddenError, PublicApiError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), update: vi.fn() }));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: (request: Request) => {
    if (!request.headers.get("authorization")) {
      throw new AuthRequiredError("Unauthorized: No authorization header provided");
    }
    return "token";
  },
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/alert-notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/alert-notifications")>()),
  updateAlertNotificationState: mocks.update,
}));
// Ces modules sont importés par `alert-notifications` et lisent la base ou l'environnement.
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/email-alerts", () => ({
  dispatchQueuedEmailAlertNotifications: vi.fn(),
  resolveEmailAlertDeliveryConfig: vi.fn(),
}));
vi.mock("@/lib/notification-preferences", () => ({ emailAlertConsentEnabled: vi.fn() }));
vi.mock("@/lib/property-reports", () => ({ assertFeatureEntitlement: vi.fn() }));

import { PATCH } from "./route";

const NOTIFICATION_ID = "0b6f1d2c-3a4e-4f5a-8b9c-1d2e3f4a5b6c";

const patch = (body: unknown, withToken = true) =>
  PATCH(
    new Request("https://immojudis.test/api/alerts/notifications", {
      method: "PATCH",
      headers: withToken ? { authorization: "Bearer token" } : undefined,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

describe("PATCH /api/alerts/notifications", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.auth.mockResolvedValue({ userId: "user-1" });
    mocks.update.mockResolvedValue({ notification: { id: NOTIFICATION_ID } });
  });

  it("answers 401 without a token, whatever the body", async () => {
    expect((await patch("{bad", false)).status).toBe(401);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("refuses an unknown action with 400 and never changes the notification", async () => {
    for (const action of ["archive", "READ", "", null, 3]) {
      const response = await patch({ notificationId: NOTIFICATION_ID, action });
      expect(response.status, String(action)).toBe(400);
    }
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("refuses a missing field, a malformed identifier and a null or malformed body with 400", async () => {
    expect((await patch({ action: "read" })).status).toBe(400);
    expect((await patch({ notificationId: NOTIFICATION_ID })).status).toBe(400);
    expect((await patch({ notificationId: "pas-un-uuid", action: "read" })).status).toBe(400);
    expect((await patch("null")).status).toBe(400);
    expect((await patch("{bad")).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each(["read", "unread", "dismiss", "restore"] as const)(
    "accepts the action %s",
    async (action) => {
      const response = await patch({ notificationId: NOTIFICATION_ID, action });

      expect(response.status).toBe(200);
      expect(mocks.update).toHaveBeenCalledWith({
        auth: { userId: "user-1" },
        notificationId: NOTIFICATION_ID,
        action,
      });
    },
  );

  it("answers 404 for a notification that does not exist or belongs to someone else", async () => {
    mocks.update.mockRejectedValue(new PublicApiError("Notification introuvable.", 404));

    const response = await patch({ notificationId: NOTIFICATION_ID, action: "read" });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("answers 403 when the plan does not include the notifications", async () => {
    mocks.update.mockRejectedValue(
      new ForbiddenError("Notifications d'alertes réservées à l’offre Analyse."),
    );

    expect((await patch({ notificationId: NOTIFICATION_ID, action: "read" })).status).toBe(403);
  });
});
