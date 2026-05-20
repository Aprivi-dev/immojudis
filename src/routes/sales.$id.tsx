import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, MapPin, Calendar, Home, Ruler, Scale, Heart, Building2, FileText } from "lucide-react";
import { getSaleById } from "@/lib/queries";
import { formatPrice, formatDate, formatDateTime, formatSurface, occupancyLabel, propertyTypeLabel } from "@/lib/format";
import { ScoreBadge } from "@/components/ScoreBadge";
import { FeatureBadges } from "@/components/FeatureBadges";
import { DocumentsList } from "@/components/DocumentsList";
import { FavoriteButton } from "@/components/FavoriteButton";
import { InvestmentAnalysis } from "@/components/InvestmentAnalysis";
import { SaleCountdown } from "@/components/SaleCountdown";
import { Skeleton } from "@/components/ui/skeleton";
import type { SaleDocumentRich } from "@/lib/types";

export const Route = createFileRoute("/sales/$id")({
  component: SaleDetailPage,
});

function SaleDetailPage() {
  const { id } = Route.useParams();
  const { data: sale, isLoading, error } = useQuery({
    queryKey: ["sale", id],
    queryFn: () => getSaleById(id),
    staleTime: 5 * 60_000,
  });

  if (isLoading) return <SaleDetailSkeleton />;
  if (error || !sale)
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <p className="text-destructive">{error instanceof Error ? error.message : "Annonce introuvable"}</p>
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
            {sale.department && <span className="inline-flex items-center gap-1"><Building2 className="h-3.5 w-3.5" />Dépt. {sale.department}</span>}
            {sale.status && (
              <span className="rounded-full border border-border bg-secondary px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-secondary-foreground">
                {sale.status}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ScoreBadge score={sale.investment_score} />
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section className="rounded-lg border border-border bg-card p-5">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Stat icon={<Calendar className="h-4 w-4" />} label="Date de vente" value={formatDate(sale.sale_date)} />
              <Stat icon={<Home className="h-4 w-4" />} label="Type" value={propertyTypeLabel(sale.property_type)} />
              <Stat
                icon={<Ruler className="h-4 w-4" />}
                label={`Surface${sale.app_surface_kind ? ` (${sale.app_surface_kind})` : ""}`}
                value={formatSurface(sale.app_surface_m2 ?? sale.habitable_surface_m2)}
              />
              <Stat label="Surface Carrez" value={formatSurface(sale.carrez_surface_m2)} />
              <Stat label="Terrain" value={formatSurface(sale.land_surface_m2)} />
              <Stat label="Pièces" value={sale.rooms_count != null ? String(sale.rooms_count) : "—"} />
              <Stat label="Chambres" value={sale.bedrooms_count != null ? String(sale.bedrooms_count) : "—"} />
              <Stat label="Salles de bain" value={sale.bathrooms_count != null ? String(sale.bathrooms_count) : "—"} />
              <Stat label="Parkings" value={sale.parking_count != null ? String(sale.parking_count) : "—"} />
              <Stat label="Occupation" value={occupancyLabel(sale.occupancy_status)} />
            </div>
            {sale.surface_confidence != null && (
              <div className="mt-3 text-xs text-muted-foreground">
                Confiance surface : {Math.round(sale.surface_confidence * 100)}%
                {sale.surface_source ? ` · source : ${sale.surface_source}` : ""}
              </div>
            )}
            <div className="mt-4">
              <FeatureBadges sale={sale} />
            </div>
          </section>

          <InvestmentAnalysis sale={sale} />

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-lg font-semibold">Documents</h2>
            <div className="mt-3">
              {sale.documents_rich && sale.documents_rich.length > 0 ? (
                <ul className="space-y-2">
                  {sale.documents_rich.map((d: SaleDocumentRich, i: number) => (
                    <li key={i}>
                      <a
                        href={d.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm hover:bg-accent"
                      >
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <span className="flex-1 truncate">{d.label ?? d.url.split("/").pop() ?? `Document ${i + 1}`}</span>
                        {d.type && (
                          <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase text-secondary-foreground">
                            {d.type}
                          </span>
                        )}
                        <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <DocumentsList documents={sale.documents} />
              )}
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-lg font-semibold">Informations techniques</h2>
            <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <Meta label="Identifiant" value={<code className="break-all text-xs">{sale.id}</code>} />
              <Meta label="Source" value={sale.source_name ?? "—"} />
              {sale.tribunal_name && (
                <Meta label="Tribunal" value={`${sale.tribunal_name}${sale.tribunal_city ? ` — ${sale.tribunal_city}` : ""}`} />
              )}
              {sale.primary_source && (
                <Meta label="Source principale" value={sale.primary_source} />
              )}
              <Meta label="Latitude" value={sale.latitude != null ? sale.latitude.toFixed(6) : "—"} />
              <Meta label="Longitude" value={sale.longitude != null ? sale.longitude.toFixed(6) : "—"} />
              <Meta label="Ajoutée le" value={formatDateTime(sale.created_at)} />
              <Meta label="Mise à jour" value={formatDateTime(sale.updated_at)} />
            </dl>
            {sale.latitude != null && sale.longitude != null && (
              <a
                href={`https://www.google.com/maps?q=${sale.latitude},${sale.longitude}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
              >
                <MapPin className="h-3.5 w-3.5" /> Voir sur Google Maps
              </a>
            )}
          </section>
        </div>

        <aside className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-5">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Mise à prix</div>
            <div className="mt-1 text-3xl font-bold tabular-nums text-foreground">{formatPrice(sale.starting_price_eur)}</div>
            <div className="mt-3 text-xs uppercase tracking-wide text-muted-foreground">Date de vente</div>
            <div className="mt-1 text-sm font-medium text-foreground">{formatDate(sale.sale_date)}</div>
            <div className="mt-3">
              <SaleCountdown date={sale.sale_date} variant="block" />
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-5">
            <div className="flex items-center gap-2">
              <Heart className="h-4 w-4 text-red-500" />
              <h2 className="text-sm font-semibold">Suivre cette annonce</h2>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Ajoutez ce bien à vos favoris pour le retrouver facilement.
            </p>
            <div className="mt-3">
              <FavoriteButton saleId={sale.id} className="w-full justify-center" />
            </div>
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

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-foreground">{value}</dd>
    </div>
  );
}

function SaleDetailSkeleton() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <Skeleton className="h-4 w-20" />
      <Skeleton className="mt-4 h-8 w-2/3" />
      <Skeleton className="mt-2 h-4 w-1/2" />
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Skeleton className="h-48 w-full rounded-lg" />
          <Skeleton className="h-40 w-full rounded-lg" />
          <Skeleton className="h-32 w-full rounded-lg" />
        </div>
        <aside className="space-y-4">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-32 w-full rounded-lg" />
        </aside>
      </div>
    </main>
  );
}