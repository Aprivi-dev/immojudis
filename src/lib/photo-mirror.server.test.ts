import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, unknown>());
const declarations = vi.hoisted(() => [] as Array<{ keyParts: string[]; options: unknown }>);

vi.mock("next/cache", () => ({
  // Un cache de données minimal : garde ce que la fonction renvoie, jamais ce qu'elle lève.
  unstable_cache: (load: () => Promise<unknown>, keyParts: string[], options: unknown) => {
    declarations.push({ keyParts, options });
    return async () => {
      const key = keyParts.join("|");
      if (store.has(key)) return store.get(key);
      const value = await load();
      store.set(key, value);
      return value;
    };
  },
}));

import { cachedPhotoMirrorFetcher, photoMirrorUrlsHash } from "./photo-mirror.server";
import type { PhotoMirrorClient } from "./photo-mirror";

const A = "https://www.licitor.com/photos/a.jpg";
const B = "https://www.vench.fr/vignettes/b.jpg";

function row(sourceUrl: string) {
  return {
    source_url: sourceUrl,
    path_640: "sale-1/abc-640.webp",
    path_1600: "sale-1/abc-1600.webp",
    width: 1600,
    height: 1200,
  };
}

function clientWith(...responses: Array<{ data: unknown; error?: unknown }>) {
  const rpc = vi.fn();
  for (const response of responses) rpc.mockResolvedValueOnce({ error: null, ...response });
  return { client: { rpc } as PhotoMirrorClient, rpc };
}

describe("cache serveur des copies de photos", () => {
  beforeEach(() => {
    store.clear();
    declarations.length = 0;
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("garde un résultat positif 5 minutes : le second appel ne touche pas la base", async () => {
    const { client, rpc } = clientWith({ data: [row(A)] });
    const fetchMirrors = cachedPhotoMirrorFetcher(client);

    const first = await fetchMirrors([A]);
    const second = await fetchMirrors([A]);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(first.get(A)?.path640).toBe("sale-1/abc-640.webp");
    expect(second.get(A)).toEqual(first.get(A));
    expect(declarations[0]!.options).toMatchObject({ revalidate: 300 });
  });

  it("la clé est le hachage des URL triées : l'ordre ne change rien", async () => {
    const { client, rpc } = clientWith({ data: [row(A), row(B)] });
    const fetchMirrors = cachedPhotoMirrorFetcher(client);

    await fetchMirrors([A, B]);
    await fetchMirrors([B, A]);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(photoMirrorUrlsHash([A, B])).toBe(photoMirrorUrlsHash([B, A]));
    expect(photoMirrorUrlsHash([A])).not.toBe(photoMirrorUrlsHash([A, B]));
    expect(declarations[0]!.keyParts.at(-1)).toBe(photoMirrorUrlsHash([A, B]));
  });

  it("ne garde jamais une erreur : l'appel suivant réessaie", async () => {
    const { client, rpc } = clientWith(
      { data: null, error: { message: "boom" } },
      { data: [row(A)] },
    );
    const fetchMirrors = cachedPhotoMirrorFetcher(client);

    expect((await fetchMirrors([A])).size).toBe(0);
    expect(console.warn).toHaveBeenCalled();
    expect((await fetchMirrors([A])).size).toBe(1);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("ne garde jamais un délai dépassé", async () => {
    vi.useFakeTimers();
    try {
      const rpc = vi
        .fn()
        .mockImplementationOnce(() => new Promise(() => undefined))
        .mockResolvedValueOnce({ data: [row(A)], error: null });
      const fetchMirrors = cachedPhotoMirrorFetcher({ rpc } as unknown as PhotoMirrorClient, {
        timeoutMs: 300,
      });

      const pending = fetchMirrors([A]);
      await vi.advanceTimersByTimeAsync(300);
      expect((await pending).size).toBe(0);

      expect((await fetchMirrors([A])).size).toBe(1);
      expect(rpc).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ne garde pas une réponse vide (aucune copie) ni une réponse inattendue", async () => {
    const { client, rpc } = clientWith(
      { data: [] },
      { data: { not: "an array" } },
      { data: [row(A)] },
    );
    const fetchMirrors = cachedPhotoMirrorFetcher(client);

    expect((await fetchMirrors([A])).size).toBe(0);
    expect((await fetchMirrors([A])).size).toBe(0);
    expect((await fetchMirrors([A])).size).toBe(1);
    expect(rpc).toHaveBeenCalledTimes(3);
    // Une réponse vide n'est pas une panne : pas de journal pour elle.
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("sans client ni URL, aucun appel ni entrée de cache", async () => {
    const { client, rpc } = clientWith();

    expect((await cachedPhotoMirrorFetcher(null)([A])).size).toBe(0);
    expect((await cachedPhotoMirrorFetcher(client)([])).size).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
    expect(declarations).toHaveLength(0);
  });
});
