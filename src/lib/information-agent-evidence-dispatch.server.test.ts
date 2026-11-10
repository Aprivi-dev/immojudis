import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Base simulée : la file des analyses (`information_agent_evidence_extractions`, lecture d'un compte) et le
 * compteur global à fenêtre fixe de `consume_ip_rate_limit`, rejoué sur une horloge contrôlée par le test.
 */
const db = vi.hoisted(() => ({
  pendingCount: 0,
  countError: null as { message: string } | null,
  rpcError: null as { message: string } | null,
  clockMs: 0,
  buckets: new Map<string, number>(),
  filters: [] as Array<[string, ...unknown[]]>,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const query = {
    select: (...args: unknown[]) => (db.filters.push(["select", ...args]), query),
    lt: (...args: unknown[]) => (db.filters.push(["lt", ...args]), query),
    lte: (...args: unknown[]) => (db.filters.push(["lte", ...args]), query),
    or: (...args: unknown[]) => {
      db.filters.push(["or", ...args]);
      return Promise.resolve({ count: db.pendingCount, error: db.countError });
    },
  };
  return {
    supabaseAdmin: {
      from: (table: string) => {
        db.filters.push(["from", table]);
        return query;
      },
      rpc: async (
        name: string,
        args: { p_bucket_key: string; p_limit: number; p_window_seconds: number },
      ) => {
        if (name !== "consume_ip_rate_limit") throw new Error(`RPC inattendue : ${name}`);
        if (db.rpcError) return { data: null, error: db.rpcError };
        const window = Math.floor(db.clockMs / 1000 / args.p_window_seconds);
        const key = `${args.p_bucket_key}:${window}`;
        const count = (db.buckets.get(key) ?? 0) + 1;
        db.buckets.set(key, count);
        if (count > args.p_limit) return { data: null, error: { message: "Rate limit exceeded." } };
        return { data: count, error: null };
      },
    },
  };
});

import {
  INFORMATION_AGENT_EVIDENCE_DISPATCH_LIMIT,
  dispatchPendingInformationAgentEvidence,
} from "@/lib/information-agent-evidence-dispatch.server";

const accepted = () => vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));

beforeEach(() => {
  db.pendingCount = 0;
  db.countError = null;
  db.rpcError = null;
  db.clockMs = Date.parse("2026-11-10T10:00:30Z");
  db.buckets.clear();
  db.filters.length = 0;
  vi.stubEnv("GITHUB_SCROLL_TOKEN", "jeton-de-test");
  vi.stubEnv("GITHUB_SCROLL_REPOSITORY", "Owner/repo");
  // Une autre branche configurée pour le pipeline ne change pas la cible : le workflow refuse tout sauf main.
  vi.stubEnv("GITHUB_SCROLL_REF", "feature/autre");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("déclenchement de l'analyse des réponses de l'agent", () => {
  it("déclenche information-agent-evidence.yml sur main quand une analyse attend", async () => {
    db.pendingCount = 2;
    const fetcher = accepted();

    await expect(
      dispatchPendingInformationAgentEvidence({ now: new Date(db.clockMs), fetcher }),
    ).resolves.toEqual({
      status: "dispatched",
      workflow: "information-agent-evidence.yml",
      ref: "main",
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe(
      "https://api.github.com/repos/Owner/repo/actions/workflows/information-agent-evidence.yml/dispatches",
    );
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer jeton-de-test");
    expect(JSON.parse(String(init?.body))).toEqual({ ref: "main" });
  });

  it("lit la file avec les conditions de la RPC de prise en charge", async () => {
    db.pendingCount = 1;
    const now = new Date("2026-11-10T10:00:30Z");

    await dispatchPendingInformationAgentEvidence({ now, fetcher: accepted() });

    expect(db.filters).toEqual([
      ["from", "information_agent_evidence_extractions"],
      ["select", "id", { count: "exact", head: true }],
      ["lt", "attempts", 3],
      ["lte", "available_at", "2026-11-10T10:00:30.000Z"],
      [
        "or",
        "status.in.(queued,failed),and(status.eq.processing,locked_at.lt.2026-11-10T09:15:30.000Z)",
      ],
    ]);
  });

  it("ne déclenche rien ni ne consomme le compteur quand aucune analyse n'attend", async () => {
    const fetcher = accepted();

    await expect(dispatchPendingInformationAgentEvidence({ fetcher })).resolves.toEqual({
      status: "not_pending",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(db.buckets.size).toBe(0);
  });

  it("au plus un déclenchement par tranche de 10 minutes", async () => {
    expect(INFORMATION_AGENT_EVIDENCE_DISPATCH_LIMIT).toEqual({ limit: 1, windowSeconds: 600 });
    db.pendingCount = 1;
    const fetcher = accepted();
    const pass = () => dispatchPendingInformationAgentEvidence({ fetcher });

    // 10:00:30 : premier déclenchement, puis les passes de 10:02, 10:04… 10:08 sont retenues.
    expect((await pass()).status).toBe("dispatched");
    for (const minute of [2, 4, 6, 8]) {
      db.clockMs = Date.parse(`2026-11-10T10:0${minute}:30Z`);
      expect((await pass()).status).toBe("throttled");
    }
    expect(fetcher).toHaveBeenCalledTimes(1);

    // 10:10:30 : nouvelle tranche, nouveau déclenchement.
    db.clockMs = Date.parse("2026-11-10T10:10:30Z");
    expect((await pass()).status).toBe("dispatched");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("un refus de GitHub est rendu, pas levé, et ne trace que le statut", async () => {
    db.pendingCount = 1;
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ message: "Bad credentials avocat@example.fr" }), {
          status: 401,
        }),
    );

    await expect(dispatchPendingInformationAgentEvidence({ fetcher })).resolves.toEqual({
      status: "failed",
      reason: "http_401",
    });
    expect(console.warn).toHaveBeenCalledWith(
      "[Information agent] Evidence analysis dispatch skipped",
      { status: "failed", reason: "http_401" },
    );
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("avocat@");
  });

  it("une coupure réseau, une base ou un compteur indisponibles ne lèvent jamais", async () => {
    db.pendingCount = 1;
    const network = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed avocat@example.fr");
    });
    await expect(dispatchPendingInformationAgentEvidence({ fetcher: network })).resolves.toEqual({
      status: "failed",
      reason: "dispatch_error",
    });

    db.clockMs += 600_000;
    db.rpcError = { message: "connection refused" };
    await expect(dispatchPendingInformationAgentEvidence({ fetcher: accepted() })).resolves.toEqual(
      { status: "failed", reason: "rate_limit_unavailable" },
    );

    db.countError = { message: "relation unavailable" };
    await expect(dispatchPendingInformationAgentEvidence({ fetcher: accepted() })).resolves.toEqual(
      { status: "failed", reason: "pending_check_failed" },
    );
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("avocat@");
  });

  it("sans jeton, rien n'est appelé et le compteur n'est pas consommé", async () => {
    db.pendingCount = 1;
    vi.stubEnv("GITHUB_SCROLL_TOKEN", "");
    vi.stubEnv("IMMOJUDIS_GITHUB_ACTIONS_TOKEN", "");
    vi.stubEnv("GITHUB_ACTIONS_DISPATCH_TOKEN", "");
    const fetcher = accepted();

    await expect(dispatchPendingInformationAgentEvidence({ fetcher })).resolves.toEqual({
      status: "token_missing",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(db.buckets.size).toBe(0);
  });
});
