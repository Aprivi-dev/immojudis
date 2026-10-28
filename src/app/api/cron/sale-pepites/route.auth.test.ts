import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runSalePepitesBatch: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/operational-alerts", () => ({ deliverOperationalAlertNotifications: vi.fn() }));
vi.mock("@/lib/sale-pepites-batch", () => ({ runSalePepitesBatch: mocks.runSalePepitesBatch }));

import { GET } from "./route";

describe("route planifiée des pépites : protection", () => {
  it("refuse une requête sans jeton et ne calcule rien", async () => {
    vi.stubEnv("CRON_SECRET", "secret-de-test");

    const response = await GET(new Request("https://example.test/api/cron/sale-pepites"));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, code: "AUTH_REQUIRED" });
    expect(mocks.runSalePepitesBatch).not.toHaveBeenCalled();
  });

  it("refuse un mauvais jeton", async () => {
    vi.stubEnv("CRON_SECRET", "secret-de-test");

    const response = await GET(
      new Request("https://example.test/api/cron/sale-pepites", {
        headers: { authorization: "Bearer autre-jeton" },
      }),
    );

    expect(response.status).toBe(401);
    expect(mocks.runSalePepitesBatch).not.toHaveBeenCalled();
  });

  it("échoue fermé quand CRON_SECRET n'est pas défini : 401, même avec un jeton vide ou quelconque", async () => {
    vi.stubEnv("CRON_SECRET", undefined);

    const variants: Record<string, string>[] = [
      {},
      { authorization: "Bearer " },
      { authorization: "Bearer undefined" },
    ];
    for (const headers of variants) {
      const response = await GET(
        new Request("https://example.test/api/cron/sale-pepites", { headers }),
      );
      expect(response.status).toBe(401);
    }
    expect(mocks.runSalePepitesBatch).not.toHaveBeenCalled();
  });
});
