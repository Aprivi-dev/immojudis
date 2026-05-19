import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ExternalLink, MapPin, Calendar, Home, Ruler, Scale } from "lucide-react";
import { getSaleById } from "@/lib/queries";
import type { AuctionSale } from "@/lib/types";
import { formatPrice, formatDate, formatSurface, occupancyLabel, propertyTypeLabel } from "@/lib/format";
import { ScoreBadge } from "@/components/ScoreBadge";
import { FeatureBadges } from "@/components/FeatureBadges";
import { DocumentsList } from "@/components/DocumentsList";
import { FavoriteButton } from "@/components/FavoriteButton";

export const Route = createFileRoute("/sales/$id")({
  component: SaleDetailPage,
});

function SaleDetailPage() {
  const { id } = Route.useParams();
  const [sale, setSale] = useState<AuctionSale | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    getSaleById(id)
      .then(setSale)
      .catch((e) => setError(e.message ?? "Erreur"))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <main className="mx-auto max-w-5xl px-4 py-10 text-muted-foreground">Chargement…</main>;
  if (error || !sale)
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <p className="text-destructive">{error ?? "Annonce introuvable"}</p>
        <Link to="/sales" className="mt-4 inline-block text-sm text-primary hover:underline">← Retour aux annonces</Link>
      </main>
    );

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <Link to="/sales" className="text-sm text-muted-foreground hover:text-foreground">← Retour</Link>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold text-foreground sm:text-3xl">{sale.title ?? propertyTypeLabel(sale.property_type)}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{[sale.address, sale.postal_code, sale.city].filter(Boolean).join(", ")}</span>
            {sale.tribunal && <span className="inline-flex items-center gap-1"><Scale className="h-3.5 w-3.5" />{sale.tribunal}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ScoreBadge score={sale.investment_score} />
          <FavoriteButton saleId={sale.id} />
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section className="rounded-lg border border-border bg-card p-5">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Stat icon={<Calendar className="h-4 w-4" />} label="Date de vente" value={formatDate(sale.sale_date)} />
              <Stat icon={<Home className="h-4 w-4" />} label="Type" value={propertyTypeLabel(sale.property_type)} />
              <Stat icon={<Ruler className="h-4 w-4" />} label="Surface habitable" value={formatSurface(sale.habitable_surface_m2)} />
              <Stat label="Surface Carrez" value={formatSurface(sale.carrez_surface_m2)} />
              <Stat label="Terrain" value={formatSurface(sale.land_surface_m2)} />
              <Stat label="Pièces" value={sale.rooms_count != null ? String(sale.rooms_count) : "—"} />
              <Stat label="Chambres" value={sale.bedrooms_count != null ? String(sale.bedrooms_count) : "—"} />
              <Stat label="Occupation" value={occupancyLabel(sale.occupancy_status)} />
            </div>
            <div className="mt-4">
              <FeatureBadges sale={sale} />
            </div>
          </section>

          {(sale.investment_summary || sale.risk_notes) && (
            <section className="rounded-lg border border-border bg-card p-5">
              <h2 className="text-lg font-semibold">Analyse d'investissement</h2>
              {sale.investment_summary && (
                <p className="mt-2 whitespace-pre-line text-sm text-foreground">{sale.investment_summary}</p>
              )}
              {sale.risk_notes && (
                <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
                  <strong>Risques : </strong>{sale.risk_notes}
                </div>
              )}
            </section>
          )}

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-lg font-semibold">Documents</h2>
            <div className="mt-3">
              <DocumentsList documents={sale.documents} />
            </div>
          </section>
        </div>

        <aside className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-5">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Mise à prix</div>
            <div className="mt-1 text-3xl font-bold tabular-nums text-foreground">{formatPrice(sale.starting_price_eur)}</div>
          </div>
          {sale.source_url && (
            <a href={sale.source_url} target="_blank" rel="noopener noreferrer" className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-border bg-background px-4 py-2.5 text-sm font-medium hover:bg-accent">
              Source {sale.source_name ? `(${sale.source_name})` : ""} <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </aside>
      </div>
    </main>
  );
}

function Stat({ icon, label, value }: { icon?: React.ReactNode; label: string; value: string }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
        {icon}{label}
      </div>
      <div className="mt-0.5 text-sm font-medium text-foreground">{value}</div>
    </div>
  );
}