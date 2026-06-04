import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { getFavorites } from "@/lib/queries";
import { SaleCard } from "@/components/SaleCard";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/favorites")({
  component: FavoritesPage,
});

function FavoritesPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [loading, user, navigate]);

  const { data: sales = [], isLoading: fetching } = useQuery({
    queryKey: ["favorites", user?.id],
    queryFn: () => getFavorites(user!.id),
    enabled: !!user,
    staleTime: 30_000,
  });

  if (loading || !user)
    return <main className="mx-auto max-w-7xl px-4 py-10 text-muted-foreground">Chargement…</main>;

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <h1 className="text-2xl font-bold text-foreground">Mes favoris</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {fetching ? "Chargement…" : `${sales.length} favori${sales.length > 1 ? "s" : ""}`}
      </p>
      {!fetching && sales.length === 0 && (
        <div className="mt-6 rounded-lg border border-dashed border-border p-12 text-center text-muted-foreground">
          Aucun favori pour le moment.{" "}
          <Link to="/sales" className="text-primary hover:underline">
            Parcourir les annonces
          </Link>
        </div>
      )}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {fetching
          ? Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-64 w-full rounded-lg" />
            ))
          : sales.map((s) => <SaleCard key={s.id} sale={s} />)}
      </div>
    </main>
  );
}
