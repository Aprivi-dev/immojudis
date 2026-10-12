import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revokeEmailAlertConsent: vi.fn(async ({ userId }: { userId: string }) => ({
    userId,
    revokedAt: "2026-10-09T10:00:00.000Z",
  })),
  deactivateAlertForUser: vi.fn(async (_input: { userId: string; alertId: string }) => undefined),
  unsubscribeEmailAlertsByNotificationId: vi.fn(async (_input: { notificationId: string }) => ({
    userId: "u",
    revokedAt: "x",
  })),
}));
const { revokeEmailAlertConsent, deactivateAlertForUser, unsubscribeEmailAlertsByNotificationId } =
  mocks;

vi.mock("@/lib/email-alerts", () => mocks);

import { createUnsubscribeToken } from "@/lib/email-unsubscribe-token";
import { GET, POST } from "./route";

const userId = "7d335032-e935-4550-9347-ed22b0f63449";
const alertId = "11111111-2222-4333-8444-555555555555";

describe("unsubscribe route", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
    revokeEmailAlertConsent.mockClear();
    deactivateAlertForUser.mockClear();
    unsubscribeEmailAlertsByNotificationId.mockClear();
  });

  it("n'écrit rien sur un GET, même avec un jeton valide (scanner de liens)", async () => {
    const token = createUnsubscribeToken({ userId });
    const response = await GET(
      new Request(`https://immojudis.test/api/notification-preferences/unsubscribe?token=${token}`),
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('method="post"');
    expect(revokeEmailAlertConsent).not.toHaveBeenCalled();
    expect(deactivateAlertForUser).not.toHaveBeenCalled();
    expect(unsubscribeEmailAlertsByNotificationId).not.toHaveBeenCalled();
  });

  it("n'écrit rien sur un GET avec l'ancien lien notificationId", async () => {
    const response = await GET(
      new Request(
        "https://immojudis.test/api/notification-preferences/unsubscribe?notificationId=6b6b42a1-b719-48cc-9c9f-f0c9f707e17d",
      ),
    );
    expect(response.status).toBe(200);
    expect(unsubscribeEmailAlertsByNotificationId).not.toHaveBeenCalled();
  });

  it("désinscrit sur le POST one-click envoyé par le client mail", async () => {
    const token = createUnsubscribeToken({ userId });
    const response = await POST(
      new Request(
        `https://immojudis.test/api/notification-preferences/unsubscribe?token=${token}`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(revokeEmailAlertConsent).toHaveBeenCalledWith({ userId });
  });

  it("désactive une seule alerte pour un jeton par alerte", async () => {
    const token = createUnsubscribeToken({ userId, scope: { kind: "alert", alertId } });
    const response = await POST(
      new Request("https://immojudis.test/api/notification-preferences/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `token=${encodeURIComponent(token)}`,
      }),
    );
    expect(response.status).toBe(200);
    expect(deactivateAlertForUser).toHaveBeenCalledWith({ userId, alertId });
    expect(revokeEmailAlertConsent).not.toHaveBeenCalled();
  });

  it("refuse un jeton invalide ou falsifié", async () => {
    const response = await POST(
      new Request("https://immojudis.test/api/notification-preferences/unsubscribe?token=abc.def", {
        method: "POST",
      }),
    );
    expect(response.status).toBe(400);
    expect(revokeEmailAlertConsent).not.toHaveBeenCalled();
  });
});
