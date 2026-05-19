import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { getSalesWithCoords } from "@/lib/queries";
import type { AuctionSale } from "@/lib/types";
import { SaleMap } from "@/components/SaleMap";

export const Route = createFileRoute("/map")({
  head: () => ({ meta: [{ title: "Carte — Enchères Immo" }] }),
  component: MapPage,
});

function MapPage() {
  const [sales, setSales] = useState<AuctionSale[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSalesWithCoords(500)
      .then(setSales)
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="text-2xl font-bold text-foreground">Carte des ventes</h1>
        <p className="text-sm text-muted-foreground">
          {loading ? "Chargement…" : `${sales.length} annonce${sales.length > 1 ? "s" : ""} géolocalisée${sales.length > 1 ? "s" : ""}`}
        </p>
      </div>
      <SaleMap sales={sales} />
    </main>
  );
}