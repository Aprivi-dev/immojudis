import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authHeaders: vi.fn() }));
vi.mock("@/lib/client-api-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-api-core")>()),
  authHeaders: mocks.authHeaders,
}));

import { fetchAdminEmailHistory } from "@/lib/client-api/admin-emails";

afterEach(() => vi.restoreAllMocks());

function mockFetch() {
  mocks.authHeaders.mockResolvedValue({ Authorization: "Bearer jeton" });
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ rows: [], next: null }), { status: 200 }));
}

describe("client de l'historique des emails", () => {
  it("cherche une adresse en POST : l'adresse ne figure jamais dans l'URL", async () => {
    const fetchMock = mockFetch();
    await fetchAdminEmailHistory({
      box: "sent",
      address: "alice@example.test",
      cursor: "abc",
      refresh: false,
    });
    const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(target).toBe("/api/admin/emails/history");
    expect(target).not.toContain("alice");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      box: "sent",
      address: "alice@example.test",
      cursor: "abc",
      refresh: false,
    });
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer jeton",
    });
  });

  it("pagine et actualise en GET quand il n'y a pas d'adresse", async () => {
    const fetchMock = mockFetch();
    await fetchAdminEmailHistory({ box: "received", address: "", cursor: "c1", refresh: true });
    const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(target).toBe("/api/admin/emails/history?box=received&cursor=c1&refresh=1");
    expect(target).not.toContain("address");
    expect(init.method).toBeUndefined();
  });
});
