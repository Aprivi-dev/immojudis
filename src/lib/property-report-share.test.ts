import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn(), getSale: vi.fn(), getReport: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("./property-report/repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./property-report/repository")>()),
  getSale: mocks.getSale,
  getReport: mocks.getReport,
}));
vi.mock("./property-report/source-integrity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./property-report/source-integrity")>()),
  assertReportSourceCurrent: vi.fn(),
}));

import {
  buildPropertyReportShare,
  enablePropertyReportShare,
  getSharedPropertyReport,
  shareOwnerKeepsSavedReports,
} from "./property-reports";
import { hashShareToken } from "./property-report/serialization";

const TOKEN = "abcDEF123_-abcDEF123_-abcDEF123";
const OWNER = "owner-1";

function table(result: { data: unknown; error?: unknown }) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "update", "insert"]) {
    query[method] = vi.fn().mockReturnValue(query);
  }
  query.maybeSingle = vi.fn().mockResolvedValue({ error: null, ...result });
  query.single = vi.fn().mockResolvedValue({ error: null, ...result });
  return query;
}

function sharedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "report-1",
    user_id: OWNER,
    sale_id: "sale-1",
    title: "Rapport",
    report_kind: "opportunity",
    report_snapshot: { plan: "analyse", sale: {}, analysis: {} },
    market_snapshot: {},
    environmental_snapshot: null,
    ceiling_snapshot: {},
    share_enabled: true,
    shared_at: "2026-10-01T10:00:00.000Z",
    share_expires_at: null,
    share_view_count: 0,
    updated_at: "2026-10-01T10:00:00.000Z",
    ...overrides,
  };
}

function installTables(tables: Record<string, ReturnType<typeof table>>) {
  mocks.from.mockImplementation((name: string) => tables[name]);
}

const ACTIVE_SUBSCRIPTION = {
  plan_code: "analyse",
  status: "active",
  current_period_end: "2099-01-01T00:00:00.000Z",
};

describe("shared property report tokens", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getSale.mockResolvedValue({});
  });

  it("hashes tokens with SHA-256 like the analysis sets", () => {
    expect(hashShareToken(TOKEN)).toBe(createHash("sha256").update(TOKEN).digest("hex"));
  });

  it("stores only the digest when a share is enabled and returns the clear URL once", async () => {
    const reports = table({
      data: sharedRow({ share_token: null, share_token_hash: "x".repeat(64) }),
    });
    installTables({ saved_property_reports: reports });
    const auth = { userId: OWNER, accountTier: "premium", isAdmin: false, supabase: {} };
    mocks.getReport.mockResolvedValue({ id: "report-1", sale_id: "sale-1", report_snapshot: {} });

    const result = await enablePropertyReportShare({
      auth: auth as never,
      reportId: "report-1",
      origin: "https://immojudis.test",
    });

    const update = reports.update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(update.share_token).toBeNull();
    expect(update.share_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.share.enabled).toBe(true);
    expect(result.share.url).toMatch(/^https:\/\/immojudis\.test\/reports\/shared\/[\w-]{24,}$/);
    expect(hashShareToken(result.share.token ?? "")).toBe(update.share_token_hash);
  });

  it("keeps an existing digest-only share enabled but cannot re-display its URL", () => {
    const share = buildPropertyReportShare(
      {
        share_enabled: true,
        share_token: null,
        share_token_hash: hashShareToken(TOKEN),
        shared_at: "2026-10-01T10:00:00.000Z",
        share_expires_at: null,
        share_view_count: 3,
      },
      "https://immojudis.test",
    );
    expect(share).toMatchObject({ enabled: true, token: null, url: null, viewCount: 3 });
  });

  it("looks the report up by digest, never by the clear token", async () => {
    const reports = table({ data: sharedRow() });
    installTables({
      saved_property_reports: reports,
      user_profiles: table({ data: { account_tier: "free", user_role: "user" } }),
      user_subscriptions: table({ data: ACTIVE_SUBSCRIPTION }),
    });

    await getSharedPropertyReport({ token: TOKEN, countView: false });

    expect(reports.eq).toHaveBeenCalledWith("share_token_hash", hashShareToken(TOKEN));
    expect(reports.eq).not.toHaveBeenCalledWith("share_token", expect.anything());
  });

  it("cuts the link when the owner's subscription is no longer active", async () => {
    installTables({
      saved_property_reports: table({ data: sharedRow() }),
      user_profiles: table({ data: { account_tier: "free", user_role: "user" } }),
      user_subscriptions: table({
        data: {
          ...ACTIVE_SUBSCRIPTION,
          status: "canceled",
          current_period_end: "2020-01-01T00:00:00.000Z",
        },
      }),
    });

    await expect(getSharedPropertyReport({ token: TOKEN, countView: false })).rejects.toThrow(
      "introuvable ou expiré",
    );
  });

  it("keeps the link while the owner has an active plan, a premium tier or the admin role", async () => {
    installTables({
      user_profiles: table({ data: { account_tier: "free", user_role: "user" } }),
      user_subscriptions: table({ data: ACTIVE_SUBSCRIPTION }),
    });
    await expect(shareOwnerKeepsSavedReports(OWNER)).resolves.toBe(true);

    installTables({
      user_profiles: table({ data: { account_tier: "premium", user_role: "user" } }),
      user_subscriptions: table({ data: null }),
    });
    await expect(shareOwnerKeepsSavedReports(OWNER)).resolves.toBe(true);

    installTables({
      user_profiles: table({ data: { account_tier: "free", user_role: "user" } }),
      user_subscriptions: table({ data: null }),
    });
    await expect(shareOwnerKeepsSavedReports(OWNER)).resolves.toBe(false);
  });
});
