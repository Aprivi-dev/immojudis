import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";

/**
 * Audit de l'administration du 14/11/2026 (D2) : `POST /api/admin/scroll` insère une demande de
 * collecte puis la déclenche. La route exige une confirmation explicite (`confirm: true`) et refuse
 * une seconde collecte de la même source tant que la première est en file ou en cours.
 * Bout en bout : la vraie route et le vrai module, sur une table `auction_runs` en mémoire.
 */
const state = vi.hoisted(() => ({ fake: null as FakeSupabase | null }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (table: string) => state.fake!.client.from(table) },
}));
vi.mock("@/integrations/supabase/auth-middleware", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/integrations/supabase/auth-middleware")>()),
  requireSupabaseAuthContext: async () => ({
    userId: "admin-1",
    isAdmin: true,
    claims: { sub: "admin-1", email: "admin@example.test" },
  }),
}));

import { POST } from "./route";

const MINUTE_MS = 60_000;

const launch = (body: unknown) =>
  POST(
    new Request("https://example.test/api/admin/scroll", {
      method: "POST",
      headers: { authorization: "Bearer jeton-admin", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * MINUTE_MS).toISOString();

describe("POST /api/admin/scroll : confirmation et une seule collecte par source", () => {
  beforeEach(() => {
    state.fake = createFakeSupabase({ auction_runs: [] });
    vi.stubEnv("GITHUB_SCROLL_TOKEN", "dispatch-test-token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refuse en 409 une seconde collecte de la même source, sans rien insérer ni déclencher", async () => {
    const first = await launch({ source: "licitor", confirm: true });
    expect(first.status).toBe(200);

    const second = await launch({ source: "licitor", confirm: true });

    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe(
      "Une collecte de cette source est déjà en file ou en cours. Suivez-la dans l'historique des runs et attendez sa fin avant d'en lancer une autre.",
    );
    expect(state.fake!.rows("auction_runs")).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("laisse lancer une autre source pendant ce temps", async () => {
    expect((await launch({ source: "licitor", confirm: true })).status).toBe(200);
    expect((await launch({ source: "avoventes", confirm: true })).status).toBe(200);
    expect(state.fake!.rows("auction_runs")).toHaveLength(2);
  });

  it.each(["queued", "running"])(
    "un run « %s » de moins de 190 minutes bloque ; au-delà, il ne bloque plus",
    async (status) => {
      state.fake!.tables.auction_runs.push({
        id: "run-recent",
        source: "licitor",
        status,
        created_at: minutesAgo(189),
      });
      expect((await launch({ source: "licitor", confirm: true })).status).toBe(409);

      state.fake!.tables.auction_runs[0].created_at = minutesAgo(191);
      expect((await launch({ source: "licitor", confirm: true })).status).toBe(200);
    },
  );

  it("un run terminé ne bloque pas", async () => {
    state.fake!.tables.auction_runs.push({
      id: "run-done",
      source: "licitor",
      status: "succeeded",
      created_at: minutesAgo(5),
    });
    expect((await launch({ source: "licitor", confirm: true })).status).toBe(200);
  });

  it.each([
    ["sans confirmation", { source: "licitor" }],
    ["avec une confirmation fausse", { source: "licitor", confirm: false }],
    ["avec une confirmation qui n'est pas un booléen", { source: "licitor", confirm: "oui" }],
  ])("refuse en 400 une demande %s, sans rien insérer ni déclencher", async (_case, body) => {
    const response = await launch(body);

    expect(response.status).toBe(400);
    expect(state.fake!.rows("auction_runs")).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
