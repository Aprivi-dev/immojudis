import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { getSales } from "@/lib/queries";
import { filtersFromSearchParams } from "@/lib/filters";
import type { AuctionSale, SaleFilters } from "@/lib/types";
import { SaleCard } from "@/components/SaleCard";
import { SaleFilters as SaleFiltersForm } from "@/components/SaleFilters";

type Search = {
  department?: string;
  city?: string;
  type?: string;
  max_price?: number;
  min_surface?: number;
  occupancy?: string;
  min_score?: number;
};

export const Route = createFileRoute("/sales")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    department: search.department as string | undefined,
    city: search.city as string | undefined,
    type: search.type as string | undefined,
    max_price: search.max_price ? Number(search.max_price) : undefined,
    min_surface: search.min_surface ? Number(search.min_surface) : undefined,
    occupancy: search.occupancy as string | undefined,
    min_score: search.min_score ? Number(search.min_score) : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Annonces — Enchères Immo" },
      { name: "description", content: "Consultez toutes les ventes aux enchères immobilières disponibles." },
    ],
  }),
  component: SalesPage,
});

function SalesPage() {
  const search = Route.useSearch();
  const [sales, setSales] = useState<AuctionSale[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const sp = new URLSearchParams();
    Object.entries(search).forEach(([k, v]) => v != null && sp.set(k, String(v)));
    const filters: SaleFilters = filtersFromSearchParams(sp);
    getSales(filters, 100)
      .then((d) => { setSales(d); setError(null); })
      .catch((e) => setError(e.message ?? "Erreur de chargement"))
      .finally(() => setLoading(false));
  }, [search]);

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-foreground">Annonces</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {loading ? "Chargement…" : `${sales.length} résultat${sales.length > 1 ? "s" : ""}`}
        </p>
      </div>

      <div className="mb-6">
        <SaleFiltersForm />
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {!loading && sales.length === 0 && !error && (
        <div className="rounded-lg border border-dashed border-border p-12 text-center text-muted-foreground">
          Aucune annonce ne correspond à vos critères.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {sales.map((s) => (
          <SaleCard key={s.id} sale={s} />
        ))}
      </div>
    </main>
  );
}