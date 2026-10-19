import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PATCH, POST } from "./route";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), from: vi.fn(), rpc: vi.fn(), send: vi.fn() }));

vi.mock("@/integrations/supabase/auth-middleware", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/integrations/supabase/auth-middleware")>()),
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("@/lib/email-alerts", () => ({ sendResendEmail: mocks.send }));

const saleId = "11111111-1111-4111-8111-111111111111";
const sendAction = {
  action: "approve_and_send",
  missionId: "22222222-2222-4222-8222-222222222222",
  approvalConfirmed: true,
  previewFingerprint: "a".repeat(64),
  recipientEmail: "contact@example.test",
  subject: "Demande de précisions",
  bodyText: "Bonjour, pourriez-vous nous transmettre les pièces du dossier ?",
};

function request(method: string, payload?: unknown, authenticated = true) {
  return new Request("https://immojudis.test/api/admin/information-agent/missions", {
    method,
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { authorization: "Bearer test-token" } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
}

beforeEach(() => vi.resetAllMocks());

describe("admin information request authorization", () => {
  it.each(["free", "premium"])("denies %s users every mission operation", async (tier) => {
    mocks.auth.mockResolvedValue({ isAdmin: false, accountTier: tier, userRole: "user" });
    const responses = await Promise.all([
      GET(request("GET")),
      POST(request("POST", { saleId })),
      PATCH(request("PATCH", sendAction)),
    ]);
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403]);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([
    "?limit=0",
    "?limit=101",
    "?offset=-1",
    "?offset=1.5",
    "?offset=abc",
    "?offset=100001",
    `?saleId=not-a-uuid`,
  ])("rejects the invalid list query %s before any read", async (query) => {
    mocks.auth.mockResolvedValue({ isAdmin: true, userId: "admin-1" });
    const response = await GET(
      new Request(`https://immojudis.test/api/admin/information-agent/missions${query}`, {
        headers: { authorization: "Bearer test-token" },
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("lists missions 50 per page from the requested offset and returns the total", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: true, userId: "admin-1" });
    const calls: Array<[string, unknown[]]> = [];
    const result = { data: [], error: null, count: 120 };
    const chain: Record<string, unknown> = {
      then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
    };
    for (const method of ["select", "eq", "order", "range"]) {
      chain[method] = (...args: unknown[]) => {
        calls.push([method, args]);
        return chain;
      };
    }
    mocks.from.mockReturnValue(chain);

    const response = await GET(
      new Request("https://immojudis.test/api/admin/information-agent/missions?offset=50", {
        headers: { authorization: "Bearer test-token" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      missions: [],
      offset: 50,
      limit: 50,
      total: 120,
      hasMore: true,
    });
    expect(calls).toContainEqual(["select", ["*", { count: "exact" }]]);
    expect(calls).toContainEqual(["range", [50, 99]]);
  });

  it("adds the sale title to each listed mission, read for this page's sales only", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: true, userId: "admin-1" });
    const missionRow = (id: string, sale_id: string | null) => ({
      id,
      case_id: null,
      sale_id,
      status: "sent",
      recipient_kind: "source_lawyer",
      recipient_name: null,
      recipient_email: "contact@example.test",
      subject: "Demande",
      body_text: "Bonjour",
      question_keys: [],
      missing_information: [],
      metadata: {},
      failure_reason: null,
      approved_at: null,
      sent_at: null,
      replied_at: null,
      created_at: "2026-10-01T10:00:00.000Z",
      updated_at: "2026-10-01T10:00:00.000Z",
    });
    const otherSaleId = "33333333-3333-4333-8333-333333333333";
    const salesIn = vi.fn();
    const chainFor = (result: unknown) => {
      const chain: Record<string, unknown> = {
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
      };
      for (const method of ["select", "eq", "order", "range"]) chain[method] = () => chain;
      chain.in = (...args: unknown[]) => {
        salesIn(...args);
        return chain;
      };
      return chain;
    };
    mocks.from.mockImplementation((table: string) =>
      table === "auction_sales"
        ? chainFor({
            data: [
              { id: saleId, title: " Appartement à Bordeaux " },
              { id: otherSaleId, title: null },
            ],
            error: null,
          })
        : chainFor({
            data: [
              missionRow("a", saleId),
              missionRow("b", saleId),
              missionRow("c", otherSaleId),
              missionRow("d", null),
            ],
            error: null,
            count: 4,
          }),
    );

    const response = await GET(request("GET"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      body.missions.map((mission: { id: string; saleTitle: string | null }) => [
        mission.id,
        mission.saleTitle,
      ]),
    ).toEqual([
      ["a", "Appartement à Bordeaux"],
      ["b", "Appartement à Bordeaux"],
      ["c", null],
      ["d", null],
    ]);
    expect(salesIn).toHaveBeenCalledWith("id", [saleId, otherSaleId]);
  });

  it("still lists the missions when the sale titles cannot be read", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: true, userId: "admin-1" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const chainFor = (result: unknown) => {
      const chain: Record<string, unknown> = {
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
      };
      for (const method of ["select", "eq", "order", "range", "in"]) chain[method] = () => chain;
      return chain;
    };
    mocks.from.mockImplementation((table: string) =>
      table === "auction_sales"
        ? chainFor({ data: null, error: { code: "57014", message: "timeout" } })
        : chainFor({
            data: [
              {
                id: "a",
                case_id: null,
                sale_id: saleId,
                status: "sent",
                recipient_kind: "source_lawyer",
                recipient_name: null,
                recipient_email: "contact@example.test",
                subject: "Demande",
                body_text: "Bonjour",
                question_keys: [],
                missing_information: [],
                metadata: {},
                failure_reason: null,
                approved_at: null,
                sent_at: null,
                replied_at: null,
                created_at: "2026-10-01T10:00:00.000Z",
                updated_at: "2026-10-01T10:00:00.000Z",
              },
            ],
            error: null,
            count: 1,
          }),
    );

    const response = await GET(request("GET"));

    expect(response.status).toBe(200);
    expect((await response.json()).missions[0]).toMatchObject({ id: "a", saleTitle: null });
  });

  it("denies visitors before loading a sale or a mission", async () => {
    expect((await POST(request("POST", { saleId }, false))).status).toBe(401);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "not-a-fingerprint"])(
    "rejects a send that was not previewed (%s)",
    async (previewFingerprint) => {
      mocks.auth.mockResolvedValue({ isAdmin: true });
      const response = await PATCH(request("PATCH", { ...sendAction, previewFingerprint }));
      expect(response.status).toBe(400);
      expect(mocks.from).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );

  it.each([false, undefined])("rejects send without explicit confirmation (%s)", async (value) => {
    mocks.auth.mockResolvedValue({ isAdmin: true });
    const response = await PATCH(request("PATCH", { ...sendAction, approvalConfirmed: value }));
    expect(response.status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
