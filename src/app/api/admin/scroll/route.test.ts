import { beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({ start: vi.fn() }));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: async () => ({ userId: "admin-user", isAdmin: true }),
}));
vi.mock("@/lib/admin.server", () => ({
  startAdminScroll: mocks.start,
}));

import { POST } from "./route";

const request = (body: string) =>
  new Request("https://example.test/api/admin/scroll", {
    method: "POST",
    body,
  });

beforeEach(() => vi.resetAllMocks());

it("returns a client error for malformed JSON before starting a run", async () => {
  const response = await POST(request("{"));

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: expect.any(String) });
  expect(mocks.start).not.toHaveBeenCalled();
});

it("returns an upstream error when the run was queued but not dispatched", async () => {
  mocks.start.mockResolvedValue({
    ok: false,
    dispatched: false,
    dispatchMode: "github_actions",
    message: "La demande reste en file ; corrigez le canal puis relancez-la.",
    run: { id: "run-1" },
  });

  const response = await POST(request(JSON.stringify({ source: "all" })));

  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({
    error: "La demande reste en file ; corrigez le canal puis relancez-la.",
    ok: false,
  });
  expect(mocks.start).toHaveBeenCalledWith("token", { source: "all" });
});

it("replaces a dispatch message that does not read like a public message", async () => {
  mocks.start.mockResolvedValue({
    ok: false,
    dispatched: false,
    dispatchMode: "github_actions",
    message: "GitHub API returned 401 for https://api.github.com/repos/x/dispatches",
    run: { id: "run-1" },
  });

  const response = await POST(request(JSON.stringify({ source: "all" })));

  expect(response.status).toBe(502);
  const body = await response.json();
  expect(body).toMatchObject({ ok: false, error: "La collecte n'a pas pu être lancée." });
  expect(JSON.stringify(body)).not.toContain("api.github.com");
});

it("returns a client error for an invalid launch request", async () => {
  mocks.start.mockRejectedValue(
    new z.ZodError([{ code: "custom", path: ["source"], message: "Source inconnue" }]),
  );

  const response = await POST(request(JSON.stringify({ source: "unknown" })));

  expect(response.status).toBe(400);
});

it("returns successful dispatch results unchanged", async () => {
  const result = {
    ok: true,
    dispatched: true,
    dispatchMode: "github_actions",
    message: "Demande envoyée au worker GitHub Actions.",
    run: { id: "run-1" },
  };
  mocks.start.mockResolvedValue(result);

  const response = await POST(request(JSON.stringify({ source: "licitor" })));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(result);
});
