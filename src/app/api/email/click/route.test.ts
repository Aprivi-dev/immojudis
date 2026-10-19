import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "@/lib/api-errors";
import { createEmailClickToken } from "@/lib/email-click-token";

const mocks = vi.hoisted(() => ({ record: vi.fn(), enforceIp: vi.fn() }));
vi.mock("@/lib/account-product-events.server", () => ({
  recordAccountProductEvent: mocks.record,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceIpRateLimit: mocks.enforceIp }));

import { GET, HEAD } from "./route";

const userId = "7d335032-e935-4550-9347-ed22b0f63449";
const saleId = "a1b2c3d4-0000-4000-8000-000000000001";
const SECRET = "service-role-test-key";

function link(token: string | null) {
  const url = new URL("https://immojudis.com/api/email/click");
  if (token !== null) url.searchParams.set("token", token);
  return new Request(url);
}

const token = (overrides: Partial<Parameters<typeof createEmailClickToken>[0]> = {}) =>
  createEmailClickToken({
    userId,
    kind: "alert",
    target: "sale",
    saleId,
    env: { SUPABASE_SERVICE_ROLE_KEY: SECRET },
    ...overrides,
  });

describe("GET /api/email/click", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SECRET);
    vi.stubEnv("EMAIL_UNSUBSCRIBE_SECRET", "");
    mocks.record.mockResolvedValue(true);
    mocks.enforceIp.mockResolvedValue(undefined);
  });

  it("measures the click for the account of the token, then redirects to the sale", async () => {
    const response = await GET(link(token()));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/sales/${saleId}`);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(mocks.record).toHaveBeenCalledWith(userId, {
      type: "email_clicked",
      email: "alert",
      saleId,
    });
  });

  it("sends the calendar link of a reminder to the .ics of the sale", async () => {
    const response = await GET(link(token({ kind: "reminder", target: "calendar" })));

    expect(response.headers.get("location")).toBe(`/api/sales/${saleId}/calendar`);
    expect(mocks.record).toHaveBeenCalledWith(userId, {
      type: "email_clicked",
      email: "reminder",
      saleId,
    });
  });

  it("goes to the home page, measuring nothing, for a missing, forged or altered token", async () => {
    const forged = createEmailClickToken({
      userId,
      kind: "alert",
      target: "sale",
      saleId,
      env: { SUPABASE_SERVICE_ROLE_KEY: "another-key" },
    });
    for (const bad of [null, "", "garbage", forged, `${token()}x`]) {
      const response = await GET(link(bad));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/");
    }
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("never redirects to an address taken from the request (no open redirect)", async () => {
    const attack = new Request(
      `https://immojudis.com/api/email/click?token=${token()}&url=https://evil.example&next=//evil.example&redirect=https://evil.example`,
    );
    const response = await GET(attack);
    expect(response.headers.get("location")).toBe(`/sales/${saleId}`);

    const noToken = await GET(
      new Request("https://immojudis.com/api/email/click?url=https://evil.example"),
    );
    expect(noToken.headers.get("location")).toBe("/");
  });

  it("still redirects, without measuring, when the token has expired", async () => {
    vi.useFakeTimers();
    try {
      const issued = token();
      vi.setSystemTime(Date.now() + 91 * 86_400_000);
      const response = await GET(link(issued));
      expect(response.headers.get("location")).toBe(`/sales/${saleId}`);
      expect(mocks.record).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still redirects when the rate limit is reached or the measure fails", async () => {
    mocks.enforceIp.mockRejectedValueOnce(new RateLimitError());
    const limited = await GET(link(token()));
    expect(limited.headers.get("location")).toBe(`/sales/${saleId}`);
    expect(mocks.record).not.toHaveBeenCalled();

    mocks.record.mockRejectedValueOnce(new Error("database down"));
    const failed = await GET(link(token()));
    expect(failed.status).toBe(302);
    expect(failed.headers.get("location")).toBe(`/sales/${saleId}`);
  });

  it("does not count a HEAD probe", async () => {
    const response = await HEAD(link(token()));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/sales/${saleId}`);
    expect(mocks.record).not.toHaveBeenCalled();
  });
});
