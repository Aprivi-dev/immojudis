import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SALE_FLOOD_RISK_WORKFLOW,
  dispatchSaleFloodRiskWorkflow,
  saleFloodRiskRunsOnVercel,
} from "./sale-flood-risk-dispatch.server";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("déclenchement du workflow d'inondation", () => {
  it("part de GitHub Actions par défaut ; SALE_FLOOD_RISK_RUNNER=vercel revient à la route", () => {
    vi.stubEnv("SALE_FLOOD_RISK_RUNNER", "");
    expect(saleFloodRiskRunsOnVercel()).toBe(false);
    vi.stubEnv("SALE_FLOOD_RISK_RUNNER", " Vercel ");
    expect(saleFloodRiskRunsOnVercel()).toBe(true);
    vi.stubEnv("SALE_FLOOD_RISK_RUNNER", "github");
    expect(saleFloodRiskRunsOnVercel()).toBe(false);
  });

  it("déclenche sale-flood-risk.yml sur la branche du pipeline, avec le jeton du pipeline", async () => {
    vi.stubEnv("GITHUB_SCROLL_TOKEN", "jeton-de-test");
    vi.stubEnv("GITHUB_SCROLL_REPOSITORY", "Owner/repo");
    vi.stubEnv("GITHUB_SCROLL_REF", "main");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(null, { status: 204 });
    };

    await expect(dispatchSaleFloodRiskWorkflow(fetcher)).resolves.toEqual({
      dispatched: true,
      workflow: SALE_FLOOD_RISK_WORKFLOW,
      ref: "main",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://api.github.com/repos/Owner/repo/actions/workflows/sale-flood-risk.yml/dispatches",
    );
    expect(calls[0].init?.method).toBe("POST");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer jeton-de-test",
    );
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ ref: "main" });
  });

  it("un refus de GitHub ne remonte que son statut", async () => {
    vi.stubEnv("GITHUB_SCROLL_TOKEN", "jeton-de-test");
    const fetcher: typeof fetch = async () =>
      new Response(JSON.stringify({ message: "Bad credentials jeton-de-test" }), { status: 401 });

    const failure = await dispatchSaleFloodRiskWorkflow(fetcher).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "Déclenchement du workflow d'inondation refusé : HTTP 401",
    );
  });

  it("sans jeton, rien n'est appelé", async () => {
    vi.stubEnv("GITHUB_SCROLL_TOKEN", "");
    vi.stubEnv("IMMOJUDIS_GITHUB_ACTIONS_TOKEN", "");
    vi.stubEnv("GITHUB_ACTIONS_DISPATCH_TOKEN", "");
    const fetcher = vi.fn<typeof fetch>();

    await expect(dispatchSaleFloodRiskWorkflow(fetcher)).rejects.toThrow(/Jeton de déclenchement/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
