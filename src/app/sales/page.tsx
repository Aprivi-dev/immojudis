import type { Metadata } from "next";
import { Suspense } from "react";
import { SalesPage } from "@/routes/sales.index";

export const metadata: Metadata = {
  title: "Annonces",
  description: "Consultez toutes les ventes aux encheres immobilieres disponibles.",
  alternates: { canonical: "/sales" },
};

export default function Page() {
  return (
    <Suspense fallback={<SalesCatalogFallback />}>
      <SalesPage />
    </Suspense>
  );
}

function SalesCatalogFallback() {
  return (
    <main className="min-h-screen bg-surface-muted px-4 py-10 text-brand-navy sm:px-6">
      <section className="mx-auto max-w-6xl">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-brand-navy">
          Catalogue Immojudis
        </p>
        <h1 className="mt-3 font-display text-4xl leading-tight sm:text-5xl">
          Ventes immobilières aux enchères
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-ink-soft">
          Recherchez les ventes au tribunal, notariales et domaniales référencées, par lieu et
          budget. Les filtres interactifs et la carte se chargent ensuite sans masquer ce contenu
          essentiel.
        </p>
        <form action="/sales" method="get" className="mt-7 flex max-w-2xl gap-2">
          <label htmlFor="catalog-search-fallback" className="sr-only">
            Ville, département, tribunal ou code postal
          </label>
          <input
            id="catalog-search-fallback"
            name="q"
            type="search"
            placeholder="Ville, département, tribunal ou code postal"
            className="min-w-0 flex-1 rounded-md border border-line bg-white px-4 py-3"
          />
          <button type="submit" className="rounded-md bg-brand-navy px-5 py-3 font-bold text-white">
            Rechercher
          </button>
        </form>
      </section>
    </main>
  );
}
