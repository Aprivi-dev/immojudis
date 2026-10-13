import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { parseDocs } from "@/lib/documents";
import { sanitizeAuctionSaleForDisplay } from "@/lib/listing-data-cleanup";
import { isLikelyPropertyImageUrl, propertyImages } from "@/lib/sale-media";
import { saleRows } from "@/lib/sale-rows";
import { saleSourceLinks } from "@/lib/sale-source-links";
import type { AuctionSale } from "@/lib/types";
import {
  getWithdrawnSources,
  loadWithdrawnSources,
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

describe("source retirée du catalogue : état livré", () => {
  it("part de l'état « Licitor retiré » sans rien lire en base", () => {
    expect([...getWithdrawnSources()]).toEqual(["licitor"]);
  });

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

describe("retrait levé", () => {
  it("le contenu Licitor réapparaît quand la base ne retire plus rien", () => {
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

  it("une base injoignable ou sans la fonction laisse la source retirée", async () => {
    setWithdrawnSources([]);
    await loadWithdrawnSources(
      { rpc: () => Promise.resolve({ data: null, error: { code: "PGRST202" } }) },
      1_000,
    );
    expect([...getWithdrawnSources()]).toEqual(["licitor"]);

    resetWithdrawnSources();
    setWithdrawnSources([]);
    await loadWithdrawnSources({ rpc: () => Promise.reject(new Error("réseau")) }, 1_000);
    expect([...getWithdrawnSources()]).toEqual(["licitor"]);
  });
});

describe("migration 20261021110000_licitor_source_withdrawal.sql", () => {
  const sql = readFileSync(
    "supabase/migrations/20261021110000_licitor_source_withdrawal.sql",
    "utf8",
  );

  it("pose un interrupteur unique, retire Licitor par défaut et ne supprime rien", () => {
    expect(sql).toContain(
      "add column if not exists catalogue_withdrawn boolean not null default false",
    );
    expect(sql).toContain("check (not (catalogue_withdrawn and enabled))");
    expect(sql).toMatch(/set_catalogue_source_withdrawal\(\s*'licitor',\s*true,/);
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
