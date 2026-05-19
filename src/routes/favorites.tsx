import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { getFavorites } from "@/lib/queries";
import type { AuctionSale } from "@/lib/types";
import { SaleCard } from "@/components/SaleCard";

export const Route = createFileRoute("/favorites")({
  component: FavoritesPage,
});

function FavoritesPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [sales, setSales] = useState<AuctionSale[]>([]);
  const [fetching, setFetching] = useState(true);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate({ to: "/login" });
      return;
    }
    getFavorites(user.id).then(setSales).finally(() => setFetching(false));
  }, [user, loading, navigate]);

  if (loading || !user) return <main className="mx-auto max-w-7xl px-4 py-10 text-muted-foreground">Chargement…</main>;

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <h1 className="text-2xl font-bold text-foreground">Mes favoris</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {fetching ? "Chargement…" : `${sales.length} favori${sales.length > 1 ? "s" : ""}`}
      </p>
      {!fetching && sales.length === 0 && (
        <div className="mt-6 rounded-lg border border-dashed border-border p-12 text-center text-muted-foreground">
          Aucun favori pour le moment.{" "}
          <Link to="/sales" className="text-primary hover:underline">Parcourir les annonces</Link>
        </div>
      )}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {sales.map((s) => <SaleCard key={s.id} sale={s} />)}
      </div>
    </main>
  );
}