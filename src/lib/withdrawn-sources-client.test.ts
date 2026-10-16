import { afterEach, describe, expect, it, vi } from "vitest";
import { createWithdrawnSourcesClient } from "./withdrawn-sources-client";

afterEach(() => vi.unstubAllEnvs());

function configure() {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co/");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
}

describe("createWithdrawnSourcesClient", () => {
  it("appelle la fonction en REST avec la seule clé publique", async () => {
    configure();
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(["licitor"])));

    const result = await createWithdrawnSourcesClient(fetcher).rpc(
      "get_withdrawn_catalogue_sources",
    );

    expect(result).toEqual({ data: ["licitor"], error: null });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://project.supabase.co/rest/v1/rpc/get_withdrawn_catalogue_sources");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      apikey: "sb_publishable_test",
      Authorization: "Bearer sb_publishable_test",
    });
  });

  it("rend une erreur (donc « aucune source retirée ») quand la base répond mal", async () => {
    configure();
    const notFound = vi.fn().mockResolvedValue(new Response("{}", { status: 404 }));
    expect(
      (await createWithdrawnSourcesClient(notFound).rpc("get_withdrawn_catalogue_sources")).error,
    ).toBeTruthy();

    const offline = vi.fn().mockRejectedValue(new Error("réseau"));
    expect(
      (await createWithdrawnSourcesClient(offline).rpc("get_withdrawn_catalogue_sources")).error,
    ).toBeTruthy();
  });

  it("n'appelle rien quand Supabase n'est pas configuré", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    const fetcher = vi.fn();

    const result = await createWithdrawnSourcesClient(fetcher).rpc(
      "get_withdrawn_catalogue_sources",
    );

    expect(result.error).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
