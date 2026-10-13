import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("@/lib/client-api", () => ({ updateNotificationPreferences: mocks.update }));

import { enableAlertEmailRecap } from "./alert-email-consent";

beforeEach(() => vi.clearAllMocks());

describe("enableAlertEmailRecap", () => {
  it("records the consent with the alert-creation source and refreshes the preferences", async () => {
    mocks.update.mockResolvedValue({ preferences: { alertEmailEnabled: true } });
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await expect(enableAlertEmailRecap(client, "user-1")).resolves.toBe(true);

    expect(mocks.update).toHaveBeenCalledWith({
      alertEmailEnabled: true,
      consentSource: "alert_creation",
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["notification-preferences", "user-1"],
    });
  });

  it("reports a failure instead of throwing, so the saved alert is not rolled back", async () => {
    mocks.update.mockRejectedValue(new Error("offline"));
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await expect(enableAlertEmailRecap(client, "user-1")).resolves.toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
