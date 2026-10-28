import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authHeaders: vi.fn() }));
vi.mock("@/lib/client-api-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-api-core")>()),
  authHeaders: mocks.authHeaders,
}));

import { extendAdminSignupTrials, fetchAdminSignups } from "@/lib/client-api/admin-signups";

afterEach(() => vi.restoreAllMocks());

describe("client de la vue « Inscriptions »", () => {
  it("cherche en POST : l'adresse ou le nom ne figure jamais dans l'URL", async () => {
    mocks.authHeaders.mockResolvedValue({ Authorization: "Bearer jeton" });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ accounts: [] }), { status: 200 }));

    await fetchAdminSignups({
      offset: 50,
      limit: 25,
      q: "marie.dupont@exemple.fr",
      access: "trial",
    });

    const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(target).toBe("/api/admin/signups/search");
    expect(target).not.toContain("?");
    expect(target).not.toContain("marie");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      offset: 50,
      limit: 25,
      q: "marie.dupont@exemple.fr",
      access: "trial",
      activity: "all",
    });
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer jeton",
    });
  });

  it("garde les valeurs par défaut de la liste", async () => {
    mocks.authHeaders.mockResolvedValue({});
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ accounts: [] }), { status: 200 }));

    await fetchAdminSignups();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      offset: 0,
      limit: 50,
      q: "",
      access: "all",
      activity: "all",
    });
  });

  it("prolonge en POST sur la route des inscriptions", async () => {
    mocks.authHeaders.mockResolvedValue({});
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ endsAt: "x", results: [] }), { status: 200 }),
      );

    await extendAdminSignupTrials({
      userIds: ["a"],
      endsAt: "2026-11-10T00:00:00.000Z",
      note: "Motif",
    });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/signups");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("POST");
  });
});
