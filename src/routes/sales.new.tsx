import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { getSales } from "@/lib/queries";
import { SaleCard } from "@/components/SaleCard";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/sales/new")({
  head: () => ({
    meta: [
      { title: "Nouveautés — Enchères Immo" },
      { name: "description", content: "Les ventes aux enchères immobilières ajoutées les 7 derniers jours." },
      { property: "og:title", content: "Nouveautés — Enchères Immo" },
      { property: "og:description", content: "Les ventes aux enchères immobilières ajoutées les 7 derniers jours." },
    ],
    links: [{ rel: "canonical", href: "/sales/new" }],
  }),
  component: NewSalesPage,
});

function NewSalesPage() {
  const { data: sales = [], isLoading, error } = useQuery({
    queryKey: ["sales-new"],
    queryFn: () => getSales({}, 200, "date_asc"),
    staleTime: 60_000,
  });

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const fresh = sales
    .filter((s) => s.created_at && new Date(s.created_at).getTime() >= sevenDaysAgo)
    .sort((a, b) => {
      const da = a.created_at ? new Date(a.created_at).getTime() : 0;
      const db = b.created_at ? new Date(b.created_at).getTime() : 0;
      return db - da;
    });

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-6 flex items-start gap-3">
        <div className="rounded-lg bg-primary/10 p-2 text-primary">
          <Sparkles className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Nouveautés</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Ventes ajoutées au cours des 7 derniers jours
            {!isLoading && ` — ${fresh.length} annonce${fresh.length > 1 ? "s" : ""}`}.
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
          {error instanceof Error ? error.message : "Erreur de chargement"}
        </div>
      )}

      {!isLoading && fresh.length === 0 && !error && (
        <div className="rounded-lg border border-dashed border-border p-12 text-center text-muted-foreground">
          Aucune nouvelle annonce sur les 7 derniers jours.
          <div className="mt-3">
            <Link to="/sales" className="text-primary underline">Voir toutes les annonces</Link>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {isLoading
          ? Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="h-8 w-1/3" />
                <Skeleton className="mt-auto h-9 w-full rounded-md" />
              </div>
            ))
          : fresh.map((s) => <SaleCard key={s.id} sale={s} />)}
      </div>
    </main>
  );
}