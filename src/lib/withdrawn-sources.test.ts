import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocs } from "@/lib/documents";
import { sanitizeAuctionSaleForDisplay } from "@/lib/listing-data-cleanup";
import { withPhotoMirrors } from "@/lib/photo-mirror";
import { isLikelyPropertyImageUrl, propertyImages } from "@/lib/sale-media";
import { saleRows } from "@/lib/sale-rows";
import { saleSourceLinks } from "@/lib/sale-source-links";
import type { AuctionSale } from "@/lib/types";
import {
  DEFAULT_WITHDRAWN_SOURCES,
  getWithdrawnSources,
  isWithdrawnSourceUrl,
  loadWithdrawnSources,
  loadWithdrawnSourcesOncePerSession,
  resetWithdrawnSources,
  setWithdrawnSources,
  stripWithdrawnSourceContent,
} from "@/lib/withdrawn-sources";

const LICITOR_PHOTO = "https://www.licitor.com/photos/annonce-1/photo-1.jpg";
const OTHER_PHOTO = "https://www.vench.fr/upload/photo/maison.jpg";

/** Vente fusionnée : principale Licitor, aussi vue chez Info-Enchères. */
function mergedSale(): AuctionSale {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    source_name: "licitor",
    source_url: "https://www.licitor.com/annonce/1/2/3/vente.html",
    source_urls: [
      "https://www.licitor.com/annonce/1/2/3/vente.html",
      "https://www.info-encheres.com/vente/42",
    ],
    media: [
      { type: "image", url: LICITOR_PHOTO },
      { type: "image", url: OTHER_PHOTO },
    ],
    documents: [
      { url: "https://www.licitor.com/documents/cahier.pdf", name: "Cahier des charges" },
      { url: "https://www.info-encheres.com/pdf/cahier.pdf", name: "Cahier (Info-Enchères)" },
    ],
    documents_rich: [
      {
        url: "https://www.licitor.com/documents/cahier.pdf",
        label: "Cahier",
        type: null,
        extraction_status: null,
      },
    ],
  } as unknown as AuctionSale;
}

afterEach(() => resetWithdrawnSources());

describe("état livré : aucune source retirée", () => {
  it("part de l'état « aucune source retirée » sans rien lire en base", () => {
    expect(DEFAULT_WITHDRAWN_SOURCES).toEqual([]);
    expect([...getWithdrawnSources()]).toEqual([]);
  });

  it("Licitor reste affiché : liens, photos et pièces d'une vente fusionnée", () => {
    const sale = sanitizeAuctionSaleForDisplay(mergedSale());
    expect(sale.source_name).toBe("licitor");
    expect(sale.source_url).toBe("https://www.licitor.com/annonce/1/2/3/vente.html");
    expect(sale.source_urls).toHaveLength(2);
    expect(sale.media).toHaveLength(2);
    expect(sale.documents).toHaveLength(2);
    expect(sale.documents_rich).toHaveLength(1);
    expect(isLikelyPropertyImageUrl(LICITOR_PHOTO)).toBe(true);
    expect(saleSourceLinks(sale).map((link) => link.label)).toContain("Licitor");
    expect(stripWithdrawnSourceContent(mergedSale())).toEqual(mergedSale());
  });
});

describe("source retirée par l'interrupteur (usage futur)", () => {
  beforeEach(() => setWithdrawnSources(["licitor"]));

  it("une vente fusionnée n'affiche aucun contenu propre à Licitor", () => {
    const sale = sanitizeAuctionSaleForDisplay(mergedSale());

    expect(sale.source_url).toBe("https://www.info-encheres.com/vente/42");
    expect(sale.source_name).toBeNull();
    expect(sale.source_urls).toEqual(["https://www.info-encheres.com/vente/42"]);
    expect(sale.media).toEqual([{ type: "image", url: OTHER_PHOTO }]);
    expect(sale.documents).toEqual([
      { url: "https://www.info-encheres.com/pdf/cahier.pdf", name: "Cahier (Info-Enchères)" },
    ]);
    expect(sale.documents_rich).toEqual([]);
    expect(saleSourceLinks(sale)).toEqual([
      { label: "Info-Enchères", href: "https://www.info-encheres.com/vente/42" },
    ]);
  });

  it("les photos, liens et pièces Licitor sont écartés même sans passer par la vente", () => {
    expect(isLikelyPropertyImageUrl(LICITOR_PHOTO)).toBe(false);
    expect(
      isLikelyPropertyImageUrl(
        `https://immojudis.test/_next/image?url=${encodeURIComponent(LICITOR_PHOTO)}&w=640&q=75`,
      ),
    ).toBe(false);
    expect(isLikelyPropertyImageUrl(OTHER_PHOTO)).toBe(true);
    expect(propertyImages(mergedSale().media).map((image) => image.url)).toEqual([OTHER_PHOTO]);
    expect(parseDocs(mergedSale().documents).map((document) => document.url)).toEqual([
      "https://www.info-encheres.com/pdf/cahier.pdf",
    ]);
    expect(saleSourceLinks(mergedSale()).map((link) => link.href)).toEqual([
      "https://www.info-encheres.com/vente/42",
    ]);
  });

  it("les lignes du catalogue sont nettoyées au passage", () => {
    const [row] = saleRows([mergedSale()]);
    expect(row.media).toEqual([{ type: "image", url: OTHER_PHOTO }]);
  });

  it("gère les liens de source rangés dans un objet", () => {
    const sale = stripWithdrawnSourceContent({
      source_name: "licitor",
      source_url: "https://www.licitor.com/annonce/9.html",
      source_urls: {
        Licitor: "https://www.licitor.com/annonce/9.html",
        "Info-Enchères": "https://www.info-encheres.com/vente/9",
      },
    } as unknown as AuctionSale);
    expect(sale.source_urls).toEqual({ "Info-Enchères": "https://www.info-encheres.com/vente/9" });
    expect(sale.source_url).toBe("https://www.info-encheres.com/vente/9");
  });

  it("ne touche pas une vente d'une autre source", () => {
    const sale = {
      id: "22222222-2222-2222-2222-222222222222",
      source_name: "vench",
      source_url: "https://www.vench.fr/vente/1",
      media: [{ type: "image", url: OTHER_PHOTO }],
    } as unknown as AuctionSale;
    expect(stripWithdrawnSourceContent(sale)).toEqual(sale);
  });
});

describe("photo copiée par Immojudis d'une source retirée", () => {
  const MIRROR = {
    path640: "11111111-1111-1111-1111-111111111111/abc-640.webp",
    path1600: "11111111-1111-1111-1111-111111111111/abc-1600.webp",
    width: 1600,
    height: 1200,
  };
  const MIRROR_URL = `https://ci.supabase.co/storage/v1/object/public/sale-photos/${MIRROR.path640}`;

  function mirroredSale(): AuctionSale {
    const sale = mergedSale();
    sale.media = [
      { type: "image", url: LICITOR_PHOTO, mirror: MIRROR },
      { type: "image", url: OTHER_PHOTO },
    ];
    return sale;
  }

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ci.supabase.co");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("l'URL de la copie n'est pas celle de la source : c'est l'origine qui décide", () => {
    setWithdrawnSources(["licitor"]);
    expect(isWithdrawnSourceUrl(MIRROR_URL)).toBe(false);
    expect(isWithdrawnSourceUrl(LICITOR_PHOTO)).toBe(true);
  });

  it("la photo copiée d'une source retirée est masquée à l'affichage", () => {
    setWithdrawnSources(["licitor"]);
    const images = propertyImages(mirroredSale().media);
    expect(images.map((image) => image.url)).toEqual([OTHER_PHOTO]);
    expect(images.some((image) => image.mirror)).toBe(false);
  });

  it("elle est aussi retirée de la vente, copie comprise", () => {
    setWithdrawnSources(["licitor"]);
    const sale = sanitizeAuctionSaleForDisplay(mirroredSale());
    expect(sale.media).toEqual([{ type: "image", url: OTHER_PHOTO }]);
    expect(JSON.stringify(sale)).not.toContain("sale-photos");
  });

  it("une source retirée après l'enrichissement masque la photo déjà enrichie", async () => {
    vi.stubEnv("NEXT_PUBLIC_PHOTO_MIRROR", "on");
    const client = {
      rpc: vi.fn().mockResolvedValue({
        data: [
          {
            source_url: LICITOR_PHOTO,
            path_640: MIRROR.path640,
            path_1600: MIRROR.path1600,
            width: 1600,
            height: 1200,
          },
        ],
        error: null,
      }),
    };
    const [enriched] = await withPhotoMirrors([mergedSale()], client);
    expect(enriched!.media![0]!.mirror?.path640).toBe(MIRROR.path640);
    expect(propertyImages(enriched!.media).map((image) => image.url)).toEqual([
      LICITOR_PHOTO,
      OTHER_PHOTO,
    ]);

    setWithdrawnSources(["licitor"]);
    expect(propertyImages(enriched!.media).map((image) => image.url)).toEqual([OTHER_PHOTO]);
  });
});

describe("retrait levé", () => {
  it("le contenu Licitor réapparaît quand la base ne retire plus rien", () => {
    setWithdrawnSources(["licitor"]);
    setWithdrawnSources([]);
    const sale = sanitizeAuctionSaleForDisplay(mergedSale());
    expect(sale.source_url).toBe("https://www.licitor.com/annonce/1/2/3/vente.html");
    expect(sale.media).toHaveLength(2);
    expect(isLikelyPropertyImageUrl(LICITOR_PHOTO)).toBe(true);
    expect(saleSourceLinks(sale).map((link) => link.label)).toContain("Licitor");
  });

  it("la liste vient de la base, une seule lecture par minute", async () => {
    let calls = 0;
    const client = {
      rpc: () => {
        calls += 1;
        return Promise.resolve({ data: [], error: null });
      },
    };
    expect(await loadWithdrawnSources(client, 1_000)).toEqual([]);
    expect(await loadWithdrawnSources(client, 2_000)).toEqual([]);
    expect(calls).toBe(1);
    expect(getWithdrawnSources().size).toBe(0);
  });

  it("la base dit qu'une source est retirée : elle l'est, puis le retrait se lève", async () => {
    const client = { rpc: () => Promise.resolve({ data: ["licitor"], error: null }) };
    expect(await loadWithdrawnSources(client, 1_000)).toEqual(["licitor"]);
    expect(sanitizeAuctionSaleForDisplay(mergedSale()).media).toHaveLength(1);
    expect(await loadWithdrawnSources(client, 100_000)).toEqual(["licitor"]);
    resetWithdrawnSources();
    expect(sanitizeAuctionSaleForDisplay(mergedSale()).media).toHaveLength(2);
  });

  it("une base injoignable ou sans la fonction ne retire aucune source", async () => {
    setWithdrawnSources(["licitor"]);
    await loadWithdrawnSources(
      { rpc: () => Promise.resolve({ data: null, error: { code: "PGRST202" } }) },
      1_000,
    );
    expect([...getWithdrawnSources()]).toEqual([]);
    expect(sanitizeAuctionSaleForDisplay(mergedSale()).source_url).toBe(
      "https://www.licitor.com/annonce/1/2/3/vente.html",
    );

    resetWithdrawnSources();
    setWithdrawnSources(["licitor"]);
    await loadWithdrawnSources({ rpc: () => Promise.reject(new Error("réseau")) }, 1_000);
    expect([...getWithdrawnSources()]).toEqual([]);
  });
});

describe("une lecture par session de navigation", () => {
  function memoryStorage() {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
  }
  function countingClient(data: unknown, error: unknown = null) {
    const client = { calls: 0, rpc: () => (client.calls++, Promise.resolve({ data, error })) };
    return client;
  }

  it("lit la base à la première page puis plus du tout pendant la session", async () => {
    const storage = memoryStorage();
    const client = countingClient([]);
    await loadWithdrawnSourcesOncePerSession(client, { storage, now: 1_000 });
    // Page suivante : le module est rechargé (état vierge) mais la session se souvient.
    resetWithdrawnSources();
    await loadWithdrawnSourcesOncePerSession(client, { storage, now: 120_000 });
    expect(client.calls).toBe(1);
  });

  it("applique la liste mémorisée sans interroger la base", async () => {
    const storage = memoryStorage();
    await loadWithdrawnSourcesOncePerSession(countingClient(["licitor"]), { storage, now: 1_000 });
    resetWithdrawnSources();

    const client = countingClient([]);
    const names = await loadWithdrawnSourcesOncePerSession(client, { storage, now: 120_000 });
    expect(names).toEqual(["licitor"]);
    expect([...getWithdrawnSources()]).toEqual(["licitor"]);
    expect(client.calls).toBe(0);
  });

  it("relit la base une fois la mémoire de session périmée (5 minutes)", async () => {
    const storage = memoryStorage();
    const client = countingClient([]);
    await loadWithdrawnSourcesOncePerSession(client, { storage, now: 1_000 });
    resetWithdrawnSources();
    await loadWithdrawnSourcesOncePerSession(client, { storage, now: 1_000 + 5 * 60_000 });
    expect(client.calls).toBe(2);
  });

  it("ne mémorise pas une erreur : la page suivante retente", async () => {
    const storage = memoryStorage();
    const failing = countingClient(null, { code: "PGRST202" });
    await loadWithdrawnSourcesOncePerSession(failing, { storage, now: 1_000 });
    resetWithdrawnSources();
    const healthy = countingClient(["licitor"]);
    await loadWithdrawnSourcesOncePerSession(healthy, { storage, now: 2_000 });
    expect(failing.calls).toBe(1);
    expect(healthy.calls).toBe(1);
    expect([...getWithdrawnSources()]).toEqual(["licitor"]);
  });

  it("ignore une valeur mémorisée illisible et lit la base", async () => {
    const storage = memoryStorage();
    storage.setItem("immojudis:withdrawn-sources", "{pas du json");
    const client = countingClient([]);
    await loadWithdrawnSourcesOncePerSession(client, { storage, now: 1_000 });
    expect(client.calls).toBe(1);
  });

  it("lit comme avant quand sessionStorage est inaccessible", async () => {
    const storage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    const client = countingClient(["licitor"]);
    await expect(
      loadWithdrawnSourcesOncePerSession(client, { storage, now: 1_000 }),
    ).resolves.toEqual(["licitor"]);
    expect(client.calls).toBe(1);
  });

  it("lit comme avant sans stockage de session", async () => {
    const client = countingClient([]);
    await loadWithdrawnSourcesOncePerSession(client, { storage: null, now: 1_000 });
    expect(client.calls).toBe(1);
  });
});

describe("migration 20261021110000_licitor_source_withdrawal.sql", () => {
  const sql = readFileSync(
    "supabase/migrations/20261021110000_licitor_source_withdrawal.sql",
    "utf8",
  );

  it("pose un interrupteur unique, ne retire aucune source et ne supprime rien", () => {
    expect(sql).toContain(
      "add column if not exists catalogue_withdrawn boolean not null default false",
    );
    expect(sql).toContain("check (not (catalogue_withdrawn and enabled))");
    // Aucun appel du geste : le fichier le définit, mais ne l'exécute pas (aucune source retirée).
    expect(sql).not.toMatch(/^\s*select\s+public\.set_catalogue_source_withdrawal/im);
    expect(sql).toContain("zzz_auction_sales_source_withdrawal");
    expect(sql).not.toMatch(/\bdelete\s+from\b/i);
    expect(sql).not.toMatch(/\bdrop\s+(table|column)\b/i);
    expect(sql).not.toMatch(/\btruncate\b/i);
  });

  it("réserve le geste au service_role et la lecture aux visiteurs", () => {
    expect(sql).toContain(
      "revoke all on function public.set_catalogue_source_withdrawal(text, boolean, text)\n  from public, anon, authenticated;",
    );
    expect(sql).toContain(
      "grant execute on function public.set_catalogue_source_withdrawal(text, boolean, text)\n  to service_role;",
    );
    expect(sql).toContain(
      "grant execute on function public.get_withdrawn_catalogue_sources()\n  to anon, authenticated, service_role;",
    );
  });

  it("reste dans une transaction et ne touche à aucune vue de lecture", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).not.toMatch(/create (or replace )?view/i);
  });
});
