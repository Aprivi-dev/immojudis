import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  // Le cache de données de Next est remplacé par un passe-plat dans les tests unitaires.
  unstable_cache: (load: (...args: unknown[]) => unknown) => load,
}));

import { loadInitialCatalogue, loadPreviewCataloguePage } from "./public-catalogue.server";
import { resetWithdrawnSources } from "./withdrawn-sources";

describe("sources retirées du catalogue (vignettes, liens et pièces des listes)", () => {
  const LICITOR_PHOTO = "https://www.licitor.com/photos/maison.jpg";
  const VENCH_PHOTO = "https://www.vench.fr/vignettes/v1.jpg";
  const search = vi.fn();
  const firstPage = vi.fn();
  const mirrorRpc = vi.fn();
  const photoMirrorClient = { rpc: mirrorRpc };
  const withdrawnRpc = vi.fn();
  const withdrawnSourcesClient = { rpc: withdrawnRpc };

  const merged = () => ({
    items: [
      // Vente fusionnée : fiche et vignette de la source retirée, mais aussi une autre source.
      {
        id: "a",
        source_url: "https://www.licitor.com/annonce/a",
        source_name: "licitor",
        source_urls: {
          licitor: "https://www.licitor.com/annonce/a",
          vench: "https://www.vench.fr/vente/a",
        },
        media: [{ type: "image", url: LICITOR_PHOTO }],
      },
      { id: "b", media: [{ type: "image", url: VENCH_PHOTO }] },
    ] as never[],
    count: 2,
  });

  beforeEach(() => {
    resetWithdrawnSources();
    search.mockReset().mockResolvedValue(merged());
    firstPage.mockReset().mockResolvedValue(merged());
    mirrorRpc.mockReset().mockResolvedValue({ data: [], error: null });
    withdrawnRpc.mockReset().mockResolvedValue({ data: ["licitor"], error: null });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("NEXT_PUBLIC_PHOTO_MIRROR", "on");
  });
  afterEach(() => {
    resetWithdrawnSources();
    vi.unstubAllEnvs();
  });

  it("retire d'une vente fusionnée la vignette et les liens de la source retirée (première page)", async () => {
    const result = await loadInitialCatalogue(
      {},
      { search, firstPage, photoMirrorClient, withdrawnSourcesClient },
    );

    expect(withdrawnRpc).toHaveBeenCalledWith("get_withdrawn_catalogue_sources");
    const [a, b] = result!.items;
    expect(a!.media).toEqual([]);
    expect(a!.source_url).toBe("https://www.vench.fr/vente/a");
    expect(a!.source_name).toBeNull();
    expect(a!.source_urls).toEqual({ vench: "https://www.vench.fr/vente/a" });
    // Une autre source n'est pas touchée.
    expect(b!.media).toEqual([{ type: "image", url: VENCH_PHOTO }]);
    // Et la photo retirée n'est même pas cherchée parmi les copies.
    expect(mirrorRpc).toHaveBeenCalledWith("sale_photo_mirrors", { p_source_urls: [VENCH_PHOTO] });
  });

  it("applique la même règle à une recherche filtrée", async () => {
    const result = await loadInitialCatalogue(
      { city: "Pau" },
      { search, firstPage, photoMirrorClient, withdrawnSourcesClient },
    );

    expect(search).toHaveBeenCalledTimes(1);
    expect(result!.items[0]!.media).toEqual([]);
  });

  it("applique la même règle à la page d'aperçu du navigateur, avant la lecture des copies", async () => {
    const page = await loadPreviewCataloguePage(
      {},
      { search, firstPage, photoMirrorClient, withdrawnSourcesClient },
    );

    expect(page.items[0]!.media).toEqual([]);
    expect(page.items[0]!.source_urls).toEqual({ vench: "https://www.vench.fr/vente/a" });
    expect(page.items[1]!.media).toEqual([{ type: "image", url: VENCH_PHOTO }]);
    expect(mirrorRpc).toHaveBeenCalledWith("sale_photo_mirrors", { p_source_urls: [VENCH_PHOTO] });
  });

  it("n'écrit pas dans la liste partagée par le cache de données", async () => {
    const shared = merged();
    firstPage.mockResolvedValue(shared);

    await loadInitialCatalogue(
      {},
      { search, firstPage, photoMirrorClient, withdrawnSourcesClient },
    );

    expect((shared.items[0] as { media: unknown[] }).media).toHaveLength(1);
  });

  it("aucune source retirée (état par défaut) : liste identique", async () => {
    withdrawnRpc.mockResolvedValue({ data: [], error: null });

    const result = await loadInitialCatalogue(
      {},
      { search, firstPage, photoMirrorClient, withdrawnSourcesClient },
    );

    expect(result!.items).toEqual(merged().items);
  });

  it("l'interrupteur illisible ne casse pas la page : rien n'est masqué", async () => {
    withdrawnRpc.mockResolvedValue({ data: null, error: { message: "function does not exist" } });

    const result = await loadInitialCatalogue(
      {},
      { search, firstPage, photoMirrorClient, withdrawnSourcesClient },
    );
    const page = await loadPreviewCataloguePage(
      {},
      { search, firstPage, photoMirrorClient, withdrawnSourcesClient },
    );

    expect(result!.items).toEqual(merged().items);
    expect(page.items).toEqual(merged().items);
  });

  it("une panne de l'appel de l'interrupteur ne fait pas échouer l'aperçu", async () => {
    withdrawnRpc.mockRejectedValue(new Error("réseau"));

    const page = await loadPreviewCataloguePage(
      {},
      { search, firstPage, photoMirrorClient, withdrawnSourcesClient },
    );

    expect(page.items).toHaveLength(2);
  });

  it("n'attend pas indéfiniment l'interrupteur : au-delà de 1,5 s, la dernière liste connue s'applique", async () => {
    vi.useFakeTimers();
    try {
      withdrawnRpc.mockReturnValue(new Promise(() => undefined));
      let settled = false;
      const pending = loadPreviewCataloguePage(
        {},
        { search, firstPage, photoMirrorClient, withdrawnSourcesClient },
      ).then((page) => {
        settled = true;
        return page;
      });

      await vi.advanceTimersByTimeAsync(1_499);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const page = await pending;

      expect(settled).toBe(true);
      // Aucune liste n'a jamais été lue : rien n'est masqué, la page est servie.
      expect(page.items).toHaveLength(2);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("Sources retirées"),
        expect.any(String),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("sans client (base non configurée) : aucune lecture, la liste reste celle de la base", async () => {
    const result = await loadInitialCatalogue(
      {},
      { search, firstPage, photoMirrorClient, withdrawnSourcesClient: null },
    );

    expect(withdrawnRpc).not.toHaveBeenCalled();
    expect(result!.items).toEqual(merged().items);
  });
});

describe("délai de lecture des copies de photos selon l'appelant", () => {
  const PHOTO = "https://www.vench.fr/vignettes/v1.jpg";
  const firstPage = vi.fn();
  const mirrorRpc = vi.fn();
  const photoMirrorClient = { rpc: mirrorRpc };

  beforeEach(() => {
    resetWithdrawnSources();
    firstPage.mockReset().mockResolvedValue({
      items: [{ id: "a", media: [{ type: "image", url: PHOTO }] }],
      count: 1,
    });
    mirrorRpc.mockReset().mockReturnValue(new Promise(() => undefined));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("NEXT_PUBLIC_PHOTO_MIRROR", "on");
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  /** Pour chaque pas de temps, la page est-elle déjà rendue ? */
  async function settledAfter(steps: number[], options: { photoMirrorTimeoutMs?: number }) {
    let settled = false;
    const pending = loadInitialCatalogue(
      {},
      { firstPage, photoMirrorClient, withdrawnSourcesClient: null, ...options },
    ).then(() => {
      settled = true;
    });
    const states: boolean[] = [];
    for (const step of steps) {
      await vi.advanceTimersByTimeAsync(step);
      states.push(settled);
    }
    await pending;
    return states;
  }

  it("rendu à la demande : 300 ms", async () => {
    expect(await settledAfter([299, 1], {})).toEqual([false, true]);
  });

  it("régénération statique de /sales : 1,5 s", async () => {
    expect(await settledAfter([300, 1_199, 1], { photoMirrorTimeoutMs: 1_500 })).toEqual([
      false,
      false,
      true,
    ]);
  });
});
