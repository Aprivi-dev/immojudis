import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ revalidateTag: vi.fn(), revalidatePath: vi.fn() }));

vi.mock("next/cache", () => ({
  revalidateTag: mocks.revalidateTag,
  revalidatePath: mocks.revalidatePath,
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return { ...actual, cache: <T extends (...args: never[]) => unknown>(fn: T) => fn };
});

import { POST } from "./route";

const SECRET = "cron-secret-for-tests";
const ID = "005a914d-563c-427b-88a4-740cbf851afb";
const OTHER_ID = "11111111-2222-4333-8444-555555555555";

function request(body: unknown, authorization?: string, raw = false) {
  return new Request("https://example.test/api/pipeline/revalidate-sale", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

describe("POST /api/pipeline/revalidate-sale", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", SECRET);
    mocks.revalidateTag.mockReset();
    mocks.revalidatePath.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a request without the secret", async () => {
    const response = await POST(request({ saleId: ID }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, code: "AUTH_REQUIRED" });
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a wrong secret", async () => {
    const response = await POST(request({ saleId: ID }, "Bearer not-the-secret"));
    expect(response.status).toBe(401);
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses every request when no secret is configured (fails closed)", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const response = await POST(request({ saleId: ID }, "Bearer "));
    expect(response.status).toBe(401);
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });

  it("expires the tag and the page of one sale", async () => {
    const response = await POST(request({ saleId: ID.toUpperCase() }, `Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ ok: true, revalidated: [`sale-${ID}`] });
    expect(mocks.revalidateTag).toHaveBeenCalledExactlyOnceWith(`sale-${ID}`, { expire: 0 });
    expect(mocks.revalidatePath).toHaveBeenCalledExactlyOnceWith(`/sales/${ID}`);
  });

  it("expires several sales once each", async () => {
    const response = await POST(request({ saleIds: [ID, OTHER_ID, ID] }, `Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      revalidated: [`sale-${ID}`, `sale-${OTHER_ID}`],
    });
    expect(mocks.revalidateTag).toHaveBeenCalledTimes(2);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/sales/${OTHER_ID}`);
  });

  it.each([
    ["an empty object", {}],
    ["a malformed identifier", { saleId: "not-a-uuid" }],
    ["an empty list", { saleIds: [] }],
    ["a path traversal attempt", { saleId: `${ID}/../../admin` }],
    ["unexpected fields", { saleId: ID, path: "/admin" }],
    ["too many sales", { saleIds: Array.from({ length: 101 }, () => ID) }],
  ])("rejects %s with 400 and invalidates nothing", async (_label, body) => {
    const response = await POST(request(body, `Bearer ${SECRET}`));
    expect(response.status).toBe(400);
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    const response = await POST(request("{nope", `Bearer ${SECRET}`, true));
    expect(response.status).toBe(400);
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });
});
