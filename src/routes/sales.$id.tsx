import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { ExternalLink, MapPin, Calendar, Home, Ruler, Heart, FileText, ArrowLeft, ChevronRight } from "lucide-react";
import { getSaleById } from "@/lib/queries";
import { formatPrice, formatDate, formatDateTime, formatSurface, occupancyLabel, propertyTypeLabel } from "@/lib/format";
import { ScoreBadge } from "@/components/ScoreBadge";
import { FeatureBadges } from "@/components/FeatureBadges";
import { DocumentsList } from "@/components/DocumentsList";
import { FavoriteButton } from "@/components/FavoriteButton";
import { InvestmentAnalysis } from "@/components/InvestmentAnalysis";
import { ProfitabilityCalculator } from "@/components/ProfitabilityCalculator";
import { SaleCountdown } from "@/components/SaleCountdown";
import { SaleContextMap } from "@/components/SaleContextMap";
import { MapThumbnail } from "@/components/MapThumbnail";
import { SourceImage } from "@/components/SourceImage";
import { NeighborhoodInsights } from "@/components/NeighborhoodInsights";
import { ContactNotaryDialog } from "@/components/ContactNotaryDialog";
import { markSaleViewed } from "@/hooks/use-viewed-sales";
import { Skeleton } from "@/components/ui/skeleton";
import type { SaleDocumentRich } from "@/lib/types";

export const Route = createFileRoute("/sales/$id")({
  component: SaleDetailPage,
  errorComponent: SaleErrorComponent,
  notFoundComponent: SaleNotFoundComponent,
});

function SaleDetailPage() {
  const { id } = Route.useParams();
  const { data: sale, isLoading, error } = useQuery({
    queryKey: ["sale", id],
    queryFn: () => getSaleById(id),
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (sale?.id) markSaleViewed(sale.id);
  }, [sale?.id]);

  if (isLoading) return <SaleDetailSkeleton />;
  if (error) throw error;
  if (!sale) return <SaleNotFoundComponent />;

  const location = [sale.address, sale.postal_code, sale.city].filter(Boolean).join(", ");
  const referenceLabel = sale.title ?? propertyTypeLabel(sale.property_type);

  return (
    <main className="bg-background pb-24">
      {/* ───────── Hero éditorial plein écran ───────── */}
      <section className="relative isolate overflow-hidden border-b border-border">
        {sale.source_url ? (
          <div className="absolute inset-0 -z-10">
            <SourceImage
              sourceUrl={sale.source_url}
              alt={referenceLabel}
              className="h-full w-full"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-background via-background/85 to-background/40" />
            <div className="absolute inset-0 bg-gradient-to-r from-background/90 via-background/40 to-transparent" />
          </div>
        ) : (
          <div className="absolute inset-0 -z-10 bg-gradient-to-br from-surface via-background to-background" />
        )}

        <div className="mx-auto max-w-6xl px-6 pt-10 pb-16 sm:pt-14 sm:pb-24">
          {/* Fil d'Ariane */}
          <nav className="flex items-center gap-2 text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
            <Link to="/sales" className="inline-flex items-center gap-1.5 transition-colors hover:text-gold-soft">
              <ArrowLeft className="h-3 w-3" /> Annonces
            </Link>
            <ChevronRight className="h-3 w-3 opacity-40" />
            <span className="text-foreground/80">{sale.city ?? sale.department ?? "Détail"}</span>
          </nav>

          {/* Eyebrow */}
          <div className="mt-10 flex flex-wrap items-center gap-3 text-[11px] uppercase tracking-[0.3em] text-gold-soft">
            <span className="inline-flex h-px w-8 bg-gold" />
            <span>{propertyTypeLabel(sale.property_type)}</span>
            {sale.department && <span className="text-muted-foreground">· Département {sale.department}</span>}
            {sale.status && (
              <span className="rounded-none border border-gold/40 px-2 py-0.5 text-[10px] tracking-[0.2em] text-gold-soft">
                {sale.status}
              </span>
            )}
          </div>

          {/* Titre éditorial */}
          <h1 className="mt-5 max-w-3xl font-display text-4xl leading-[1.1] text-foreground sm:text-5xl md:text-6xl">
            {referenceLabel}
          </h1>

          {location && (
            <p className="mt-5 inline-flex max-w-2xl items-center gap-2 text-base text-muted-foreground">
              <MapPin className="h-4 w-4 text-gold" />
              {location}
            </p>
          )}

          {/* Rangée méta + score */}
          <div className="mt-10 flex flex-wrap items-end justify-between gap-6 border-t border-border/60 pt-6">
            <dl className="flex flex-wrap gap-x-10 gap-y-4">
              <HeroMeta label="Mise à prix" value={formatPrice(sale.starting_price_eur)} accent />
              <HeroMeta label="Date de vente" value={formatDate(sale.sale_date)} />
              <HeroMeta
                label="Surface"
                value={formatSurface(sale.app_surface_m2 ?? sale.habitable_surface_m2 ?? sale.carrez_surface_m2)}
              />
              {sale.tribunal && <HeroMeta label="Tribunal" value={sale.tribunal} />}
            </dl>
            <ScoreBadge score={sale.investment_score} confidence={sale.surface_confidence} />
          </div>
        </div>
      </section>

      {/* ───────── Corps : éditorial + colonne offre ───────── */}
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-x-12 gap-y-10 px-6 pt-14 lg:grid-cols-[1fr_360px]">
        {/* Colonne principale */}
        <div className="space-y-14">
          {/* Vignettes : carte + image secondaire */}
          {(sale.latitude != null && sale.longitude != null) || sale.source_url ? (
            <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {sale.source_url && (
                <Frame>
                  <SourceImage
                    sourceUrl={sale.source_url}
                    alt={referenceLabel}
                    className="h-56 w-full sm:h-64"
                  />
                </Frame>
              )}
              {sale.latitude != null && sale.longitude != null && (
                <Frame>
                  <MapThumbnail
                    lat={sale.latitude}
                    lng={sale.longitude}
                    zoom={16}
                    className="h-56 w-full sm:h-64"
                    alt={`Localisation ${sale.city ?? ""}`}
                  />
                </Frame>
              )}
            </section>
          ) : null}

          {/* Caractéristiques */}
          <Section eyebrow="Le bien" title="Caractéristiques">
            <div className="grid grid-cols-2 gap-x-8 gap-y-6 border-t border-border/60 pt-8 sm:grid-cols-3">
              <Stat icon={<Calendar className="h-3.5 w-3.5" />} label="Date de vente" value={formatDate(sale.sale_date)} />
              <Stat icon={<Home className="h-3.5 w-3.5" />} label="Type" value={propertyTypeLabel(sale.property_type)} />
              <Stat
                icon={<Ruler className="h-3.5 w-3.5" />}
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
              <div className="mt-6 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                Confiance surface · {Math.round(sale.surface_confidence * 100)}%
                {sale.surface_source ? ` · source ${sale.surface_source}` : ""}
              </div>
            )}
            <div className="mt-6">
              <FeatureBadges sale={sale} />
            </div>
          </Section>

          <Section eyebrow="Analyse" title="Lecture d'investissement">
            <InvestmentAnalysis sale={sale} />
          </Section>

          <Section eyebrow="Simulation" title="Rentabilité">
            <ProfitabilityCalculator sale={sale} />
          </Section>

          <Section eyebrow="Territoire" title="Contexte géographique">
            <SaleContextMap sale={sale} />
            {sale.latitude != null && sale.longitude != null && (
              <div className="mt-10">
                <NeighborhoodInsights lat={sale.latitude} lng={sale.longitude} />
              </div>
            )}
          </Section>

          <Section eyebrow="Dossier" title="Documents officiels">
            {sale.documents_rich && sale.documents_rich.length > 0 ? (
              <ul className="divide-y divide-border/60 border-y border-border/60">
                {sale.documents_rich.map((d: SaleDocumentRich, i: number) => (
                  <li key={i}>
                    <a
                      href={d.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group flex items-center gap-4 py-4 transition-colors hover:bg-surface/40"
                    >
                      <FileText className="h-4 w-4 text-gold" />
                      <span className="flex-1 truncate text-sm">{d.label ?? d.url.split("/").pop() ?? `Document ${i + 1}`}</span>
                      {d.type && (
                        <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                          {d.type}
                        </span>
                      )}
                      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground transition-colors group-hover:text-gold-soft" />
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <DocumentsList documents={sale.documents} />
            )}
          </Section>

          <Section eyebrow="Référence" title="Informations techniques">
            <dl className="grid grid-cols-1 gap-x-8 gap-y-5 border-t border-border/60 pt-8 text-sm sm:grid-cols-2">
              <Meta label="Identifiant" value={<code className="break-all text-xs text-muted-foreground">{sale.id}</code>} />
              <Meta label="Source" value={sale.source_name ?? "—"} />
              {sale.tribunal_name && (
                <Meta label="Tribunal" value={`${sale.tribunal_name}${sale.tribunal_city ? ` — ${sale.tribunal_city}` : ""}`} />
              )}
              {sale.primary_source && <Meta label="Source principale" value={sale.primary_source} />}
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
                className="mt-6 inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.25em] text-gold-soft hover:text-gold"
              >
                <MapPin className="h-3.5 w-3.5" /> Ouvrir sur Google Maps
              </a>
            )}
          </Section>
        </div>

        {/* Sidebar : carte offre */}
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="space-y-6">
            <div className="relative border border-gold/30 bg-surface/60 p-7 backdrop-blur">
              <span className="absolute -top-px left-7 h-px w-12 bg-gold" />
              <div className="text-[10px] uppercase tracking-[0.3em] text-gold-soft">Mise à prix</div>
              <div className="mt-3 font-display text-4xl leading-none tabular-nums text-foreground">
                {formatPrice(sale.starting_price_eur)}
              </div>
              <div className="mt-8 grid grid-cols-2 gap-4 border-t border-border/60 pt-5">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">Vente</div>
                  <div className="mt-1 text-sm font-medium text-foreground">{formatDate(sale.sale_date)}</div>
                </div>
                {sale.department && (
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">Département</div>
                    <div className="mt-1 text-sm font-medium text-foreground">{sale.department}</div>
                  </div>
                )}
              </div>
              <div className="mt-5">
                <SaleCountdown date={sale.sale_date} variant="block" />
              </div>
            </div>

            <div className="border border-border bg-surface/40 p-6">
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
                <Heart className="h-3.5 w-3.5 text-gold" />
                Suivre l'annonce
              </div>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                Conservez ce bien dans vos favoris pour le retrouver instantanément.
              </p>
              <div className="mt-4">
                <FavoriteButton saleId={sale.id} className="w-full justify-center" />
              </div>
            </div>

            <ContactNotaryDialog sale={sale} />

            {sale.source_url && (
              <a
                href={sale.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex w-full items-center justify-between border border-gold bg-gold px-5 py-3 text-[11px] font-medium uppercase tracking-[0.25em] text-background transition-colors hover:bg-gold-soft hover:border-gold-soft"
              >
                <span>Voir la source{sale.source_name ? ` · ${sale.source_name}` : ""}</span>
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}

function HeroMeta({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">{label}</dt>
      <dd
        className={
          accent
            ? "mt-2 font-display text-2xl tabular-nums text-gold-soft"
            : "mt-2 text-base font-medium tabular-nums text-foreground"
        }
      >
        {value}
      </dd>
    </div>
  );
}

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <header className="mb-6 flex items-baseline gap-4">
        <span className="text-[10px] uppercase tracking-[0.35em] text-gold">{eyebrow}</span>
        <span className="h-px flex-1 bg-border/60" />
      </header>
      <h2 className="font-display text-2xl text-foreground sm:text-3xl">{title}</h2>
      <div className="mt-6">{children}</div>
    </section>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden border border-border bg-surface/40">{children}</div>
  );
}

function Stat({ icon, label, value }: { icon?: React.ReactNode; label: string; value: string }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
        {icon}{label}
      </div>
      <div className="mt-2 text-base font-medium tabular-nums text-foreground">{value}</div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">{label}</dt>
      <dd className="mt-1.5 text-sm font-medium text-foreground">{value}</dd>
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

function SaleNotFoundComponent() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16 text-center">
      <h1 className="text-2xl font-bold text-foreground">Annonce introuvable</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Cette vente n'existe plus ou a été retirée. Elle peut avoir été adjugée ou supprimée par la source.
      </p>
      <Link
        to="/sales"
        className="mt-6 inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        ← Retour aux annonces
      </Link>
    </main>
  );
}

function SaleErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <main className="mx-auto max-w-2xl px-4 py-16 text-center">
      <h1 className="text-2xl font-bold text-foreground">Impossible d'afficher cette annonce</h1>
      <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <button
          onClick={() => {
            router.invalidate();
            reset();
          }}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Réessayer
        </button>
        <Link
          to="/sales"
          className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-accent"
        >
          ← Retour aux annonces
        </Link>
      </div>
    </main>
  );
}