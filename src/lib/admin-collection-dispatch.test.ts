import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  from: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  select: vi.fn(),
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: mocks.from,
  },
}));
import { startAdminScroll } from "@/lib/admin.server";
import { collectionSourceResults } from "@/lib/admin-source-collection";

describe("manual collection includes cloud sources in the existing workflow", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_SCROLL_TOKEN", "dispatch-test-token");
    vi.stubEnv("GITHUB_SCROLL_REF", "main");
    mocks.from.mockImplementation(() => ({
      insert: mocks.insert,
      update: mocks.update,
      select: mocks.select,
    }));
    mocks.auth.mockResolvedValue({
      userId: "admin",
      isAdmin: true,
      claims: { email: "admin@example.test" },
    });
    mocks.insert.mockImplementation((payload) => ({
      select: () => ({
        limit: () =>
          Promise.resolve({
            data: [{ id: "run-test", ...payload }],
            error: null,
          }),
      }),
    }));
    mocks.update.mockImplementation((payload) => {
      const query = {
        eq: vi.fn(),
        select: vi.fn(),
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve({ error: null }).then(resolve, reject),
      };
      query.eq.mockReturnValue(query);
      query.select.mockReturnValue({
        limit: () =>
          Promise.resolve({
            data: [{ id: "run-test", ...payload }],
            error: null,
          }),
      });
      return query;
    });
    mocks.select.mockReturnValue({
      eq: () => ({
        limit: () =>
          Promise.resolve({
            data: [
              {
                id: "run-test",
                status: "running",
                source: "all",
                summary: {},
                errors: {},
              },
            ],
            error: null,
          }),
      }),
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it.each(["all", "petites_affiches", "cessions_etat"])(
    "dispatches %s once with the tracked run id",
    async (source) => {
      const result = await startAdminScroll("admin-token", { source, mode: "collect" });
      expect(result.dispatched).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      const [, options] = vi.mocked(fetch).mock.calls[0];
      expect(JSON.parse(String(options?.body))).toMatchObject({
        ref: "main",
        inputs: {
          source,
          run_id: "run-test",
          llm_backfill: "false",
        },
      });
      expect(mocks.insert).toHaveBeenCalledTimes(1);
    },
  );

  it("marks an upstream HTTP rejection as a failed dispatch while keeping the run trace", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 })),
    );

    const result = await startAdminScroll("admin-token", { source: "all", mode: "collect" });

    expect(result).toMatchObject({
      ok: false,
      dispatched: false,
      dispatchMode: "github_actions",
      run: { status: "failed", finishedAt: expect.any(String) },
    });
    expect(result.run.errors).toMatchObject({ github_actions: "HTTP 503" });
    expect(result.message).toContain("marqué en échec");
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("keeps a dispatch timeout ambiguous instead of claiming it can be retried safely", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("request timed out")));

    const result = await startAdminScroll("admin-token", { source: "all", mode: "collect" });

    expect(result).toMatchObject({ ok: false, dispatched: false, dispatchMode: "github_actions" });
    expect(result.run.status).toBe("queued");
    expect(result.run.errors).toMatchObject({ github_actions: "request timed out" });
    expect(result.run.summary).toMatchObject({ github_actions: { outcome: "unknown" } });
    expect(result.message).toContain("indéterminé");
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a run already claimed by a worker after an HTTP rejection", async () => {
    let updateQuery: { eq: ReturnType<typeof vi.fn> } | undefined;
    mocks.update.mockImplementation(() => {
      const query = {
        eq: vi.fn(),
        select: vi.fn(),
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve({ error: null }).then(resolve, reject),
      };
      query.eq.mockReturnValue(query);
      query.select.mockReturnValue({ limit: () => Promise.resolve({ data: [], error: null }) });
      updateQuery = query;
      return query;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 })),
    );

    const result = await startAdminScroll("admin-token", { source: "all", mode: "collect" });

    expect(result.run.status).toBe("running");
    expect(result.run.finishedAt).toBeNull();
    expect(updateQuery?.eq).toHaveBeenNthCalledWith(2, "status", "queued");
  });

  it("dispatches an AI description backfill with its dedicated run source and limit", async () => {
    const result = await startAdminScroll("admin-token", {
      source: "all",
      mode: "llm_backfill",
      limit: 7,
    });

    expect(result.dispatched).toBe(true);
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({ source: "llm-description-backfill", use_llm: true }),
    );
    const [, options] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(options?.body))).toMatchObject({
      inputs: { source: "all", llm_backfill: "true", limit: "7", run_id: "run-test" },
    });
  });

  it("rejects an AI description backfill scoped to a source the worker ignores", async () => {
    await expect(
      startAdminScroll("admin-token", {
        source: "avoventes",
        mode: "llm_backfill",
      }),
    ).rejects.toThrow("backfill LLM doit cibler la source all");
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("dispatches through the configured webhook when GitHub Actions is unavailable", async () => {
    vi.stubEnv("GITHUB_SCROLL_TOKEN", "");
    vi.stubEnv("IMMOJUDIS_GITHUB_ACTIONS_TOKEN", "");
    vi.stubEnv("GITHUB_ACTIONS_DISPATCH_TOKEN", "");
    vi.stubEnv("SCROLL_WEBHOOK_URL", "https://runner.example/collect");
    vi.stubEnv("SCROLL_WEBHOOK_SECRET", "webhook-secret");

    const result = await startAdminScroll("admin-token", {
      source: "petites_affiches",
      mode: "collect",
    });

    expect(result).toMatchObject({ ok: true, dispatched: true, dispatchMode: "webhook" });
    expect(fetch).toHaveBeenCalledWith(
      "https://runner.example/collect",
      expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
          "X-Immojudis-Secret": "webhook-secret",
        },
        body: expect.stringContaining('"source":"petites_affiches"'),
      }),
    );
  });

  it("marks a deterministic webhook rejection as failed", async () => {
    vi.stubEnv("GITHUB_SCROLL_TOKEN", "");
    vi.stubEnv("IMMOJUDIS_GITHUB_ACTIONS_TOKEN", "");
    vi.stubEnv("GITHUB_ACTIONS_DISPATCH_TOKEN", "");
    vi.stubEnv("SCROLL_WEBHOOK_URL", "https://runner.example/collect");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 502 })),
    );

    const result = await startAdminScroll("admin-token", { source: "all" });

    expect(result).toMatchObject({
      ok: false,
      dispatched: false,
      dispatchMode: "webhook",
      run: { status: "failed", finishedAt: expect.any(String) },
    });
    expect(result.run.errors).toMatchObject({ webhook: "HTTP 502" });
  });

  it("uses a non-empty legacy token when the preferred variable is blank", async () => {
    vi.stubEnv("GITHUB_SCROLL_TOKEN", "");
    vi.stubEnv("IMMOJUDIS_GITHUB_ACTIONS_TOKEN", "legacy-dispatch-test-token");

    const result = await startAdminScroll("admin-token", { source: "all", mode: "collect" });

    expect(result.dispatched).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, options] = vi.mocked(fetch).mock.calls[0];
    expect(options?.headers).toMatchObject({
      Authorization: "Bearer legacy-dispatch-test-token",
    });
  });

  it("rejects unknown launch fields before creating a queued run", async () => {
    await expect(
      startAdminScroll("admin-token", {
        source: "all",
        mode: "collect",
        unexpected: true,
      }),
    ).rejects.toThrow();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not create an unexecutable queued run without a runner", async () => {
    vi.stubEnv("GITHUB_SCROLL_TOKEN", "");
    vi.stubEnv("IMMOJUDIS_GITHUB_ACTIONS_TOKEN", "");
    vi.stubEnv("GITHUB_ACTIONS_DISPATCH_TOKEN", "");
    vi.stubEnv("SCROLL_WEBHOOK_URL", "");
    vi.stubEnv("IMMOJUDIS_SCROLL_WEBHOOK_URL", "");

    await expect(startAdminScroll("admin-token", { source: "all" })).rejects.toThrow(
      "Aucun runner de collecte n'est configuré",
    );
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("denies non-admin callers before creating or dispatching a run", async () => {
    mocks.auth.mockResolvedValue({ userId: "member", isAdmin: false });
    await expect(startAdminScroll("user-token", { source: "all" })).rejects.toThrow("Forbidden");
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows actual transport and errors without inventing historical transport", () => {
    expect(
      collectionSourceResults({
        scrape_coverage: {
          petites_affiches: { fetch_transport: "supabase", listings_emitted: 10, errors: 0 },
          cessions_etat: { fetch_transport: "supabase", listings_emitted: 0, errors: 1 },
          licitor: { listings_emitted: 3 },
        },
      }),
    ).toEqual([
      { source: "petites_affiches", transport: "Supabase", listings: 10, failed: false },
      { source: "cessions_etat", transport: "Supabase", listings: 0, failed: true },
      { source: "licitor", transport: "Non renseigné", listings: 3, failed: false },
    ]);
  });
});
