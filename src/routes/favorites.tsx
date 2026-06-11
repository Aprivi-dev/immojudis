import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import Heart from "lucide-react/dist/esm/icons/heart.js";
import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right.js";
import { useAuth } from "@/hooks/use-auth";
import { getFavorites } from "@/lib/queries";
import { SaleCard } from "@/components/SaleCard";
import { Skeleton } from "@/components/ui/skeleton";
import { BrandMark } from "@/components/BrandLogo";

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
    return (
      <main className="liquid-page min-h-screen px-4 py-10 text-muted-foreground sm:px-6">
        <div className="mx-auto max-w-7xl">Chargement…</div>
      </main>
    );

  return (
    <main className="liquid-page min-h-screen px-4 py-8 text-foreground sm:px-6 lg:py-10">
      <div className="mx-auto max-w-7xl">
        <header className="glass-shell mb-6 rounded-lg p-6 sm:p-8">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
                <Heart className="h-4 w-4" />
                Sélection personnelle
              </div>
              <h1 className="mt-4 font-display text-4xl leading-tight text-foreground sm:text-5xl">
                Mes favoris
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                Gardez les dossiers que vous voulez relire, comparer ou suivre avant l'audience.
              </p>
            </div>
            <div className="liquid-panel-soft rounded-lg p-4">
              <div className="font-display text-3xl tabular-nums text-gold-soft">
                {fetching ? "..." : sales.length}
              </div>
              <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Favoris
              </div>
            </div>
          </div>
        </header>

        {!fetching && sales.length === 0 && (
          <div className="glass-shell rounded-lg p-10 text-center">
            <BrandMark className="mx-auto h-16 w-16" />
            <h2 className="mt-5 font-display text-2xl text-foreground">
              Aucun dossier en shortlist.
            </h2>
            <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
              Ajoutez des annonces en favoris pour construire votre shortlist avant enchère.
            </p>
            <Link
              to="/sales"
              className="liquid-button mt-6 inline-flex items-center justify-center gap-2 rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.18em] text-background"
            >
              Parcourir les annonces <ArrowUpRight className="h-4 w-4" />
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
      </div>
    </main>
  );
}
