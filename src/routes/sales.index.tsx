import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getSales } from "@/lib/queries";
import type { SaleFilters, SortKey } from "@/lib/types";
import { SaleCard } from "@/components/SaleCard";
import { SaleFilters as SaleFiltersForm } from "@/components/SaleFilters";
import { Skeleton } from "@/components/ui/skeleton";

type Search = {
  department?: string;
  city?: string;
  type?: string;
  max_price?: number;
  min_surface?: number;
  occupancy?: string;
  min_score?: number;
  sort?: string;
};

export const Route = createFileRoute("/sales/")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    department: search.department as string | undefined,
    city: search.city as string | undefined,
    type: search.type as string | undefined,
    max_price: search.max_price ? Number(search.max_price) : undefined,
    min_surface: search.min_surface ? Number(search.min_surface) : undefined,
    occupancy: search.occupancy as string | undefined,
    min_score: search.min_score ? Number(search.min_score) : undefined,
    sort: search.sort as string | undefined,
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
  const filters: SaleFilters = {
    department: search.department,
    city: search.city,
    property_type: search.type,
    max_price: search.max_price,
    min_surface: search.min_surface,
    occupancy_status: search.occupancy,
    min_score: search.min_score,
  };
  const sort = (search.sort as SortKey) || "date_asc";
  const { data: sales = [], isLoading, error } = useQuery({
    queryKey: ["sales", filters, sort],
    queryFn: () => getSales(filters, 100, sort),
    staleTime: 60_000,
  });

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-foreground">Annonces</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {isLoading ? "Chargement…" : `${sales.length} résultat${sales.length > 1 ? "s" : ""}`}
        </p>
      </div>

      <div className="mb-6">
        <SaleFiltersForm />
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
          {error instanceof Error ? error.message : "Erreur de chargement"}
        </div>
      )}

      {!isLoading && sales.length === 0 && !error && (
        <div className="rounded-lg border border-dashed border-border p-12 text-center text-muted-foreground">
          Aucune annonce ne correspond à vos critères.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {isLoading
          ? Array.from({ length: 8 }).map((_, i) => <SaleCardSkeleton key={i} />)
          : sales.map((s) => <SaleCard key={s.id} sale={s} />)}
      </div>
    </main>
  );
}

function SaleCardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-6 w-10 rounded-full" />
      </div>
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-3 w-2/3" />
      <div className="flex gap-2">
        <Skeleton className="h-5 w-14 rounded-md" />
        <Skeleton className="h-5 w-14 rounded-md" />
      </div>
      <Skeleton className="mt-auto h-9 w-full rounded-md" />
    </div>
  );
}