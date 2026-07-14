"use client";

import { useMemo, useRef, useState } from "react";
import type { ReactNode, UIEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.js";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import BadgeEuro from "lucide-react/dist/esm/icons/badge-euro.js";
import Building2 from "lucide-react/dist/esm/icons/building-2.js";
import CalendarDays from "lucide-react/dist/esm/icons/calendar-days.js";
import Camera from "lucide-react/dist/esm/icons/camera.js";
import ChartNoAxesCombined from "lucide-react/dist/esm/icons/chart-no-axes-combined.js";
import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import Ruler from "lucide-react/dist/esm/icons/ruler.js";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.js";
import Target from "lucide-react/dist/esm/icons/target.js";
import Wrench from "lucide-react/dist/esm/icons/wrench.js";
import { BillingActions } from "@/components/BillingActions";
import { DocumentsList } from "@/components/DocumentsList";
import { LawyerReferralButton } from "@/components/LawyerReferralButton";
import { MapboxPreviewButton } from "@/components/MapboxPreviewButton";
import { RotatingCamera360 } from "@/components/RotatingCamera360";
import { fetchPrecomputedMarketEstimate } from "@/lib/client-api";
import { formatDate, formatPrice, formatPricePerM2, propertyTypeLabel } from "@/lib/format";
import type { MarketEstimate } from "@/lib/market.functions";
import {
  computeRecommendedCeilings,
  DEFAULT_MARKET_CEILING_SCENARIO,
  DEFAULTS,
  estimateWorksBudget,
  REFRESH_WORKS_PRICE_PER_M2,
} from "@/lib/profitability";
import { Link } from "@/lib/router-compat";
import { getSaleDisplayDescription, hasSaleAiDescription } from "@/lib/sale-description";
import { propertyImages } from "@/lib/sale-media";
import { saleDisplayTitle } from "@/lib/sale-title";
import { getDisplaySurface, getMarketValuationSurfaces } from "@/lib/surface";
import type { AuctionSale, SaleRisk } from "@/lib/types";

const BidCeilingAssistant = dynamic(
  () => import("@/components/BidCeilingAssistant").then((module) => module.BidCeilingAssistant),
  { loading: () => <div className="h-80 animate-pulse rounded-lg bg-muted" /> },
);
const PhotoCarouselDialog = dynamic(
  () => import("@/components/PhotoCarouselDialog").then((module) => module.PhotoCarouselDialog),
  { ssr: false },
);

type SaleDetailProps = {
  sale: AuctionSale;
  marketEstimateOverride?: MarketEstimate | null;
  returnTo?: string;
};

export function AnalysisSaleDetailView({
  sale,
  marketEstimateOverride = null,
  returnTo = "/sales",
}: SaleDetailProps) {
  return (
    <SimplifiedSaleDetailView
      sale={sale}
      marketEstimateOverride={marketEstimateOverride}
      returnTo={returnTo}
      access="analysis"
    />
  );
}

export function FreeSaleDetailView({ sale, returnTo = "/sales" }: SaleDetailProps) {
  return <SimplifiedSaleDetailView sale={sale} returnTo={returnTo} access="discovery" />;
}

function SimplifiedSaleDetailView({
  sale,
  marketEstimateOverride = null,
  returnTo,
  access,
}: SaleDetailProps & { access: "discovery" | "analysis" }) {
  const [calculationOpen, setCalculationOpen] = useState(false);
  const marketSurfaces = getMarketValuationSurfaces(sale);
  const surface = marketSurfaces.builtSurfaceM2;
  const marketQuery = useQuery({
    queryKey: ["precomputed-market-estimate", sale.id],
    queryFn: () => fetchPrecomputedMarketEstimate({ saleId: sale.id }),
    enabled: access === "analysis" && marketEstimateOverride == null,
    staleTime: 24 * 60 * 60_000,
  });
  const marketEstimate = marketEstimateOverride ?? marketQuery.data?.estimate ?? null;
  const recommendations = useMemo(
    () =>
      computeRecommendedCeilings({
        surface,
        price: Math.max(0, sale.starting_price_eur ?? 0),
        fpt: DEFAULTS.fpt,
        scenario: DEFAULT_MARKET_CEILING_SCENARIO,
        medianPricePerM2:
          marketEstimate?.actionable === true ? marketEstimate.medianPricePerM2 : null,
        p25PricePerM2: marketEstimate?.actionable === true ? marketEstimate.p25PricePerM2 : null,
        p75PricePerM2: marketEstimate?.actionable === true ? marketEstimate.p75PricePerM2 : null,
      }),
    [marketEstimate, sale.starting_price_eur, surface],
  );
  const worksBudget = estimateWorksBudget(surface, "rafraichissement");

  return (
    <main className="min-h-screen bg-[#eef7ff] text-brand-navy">
      <div className="mx-auto max-w-[1460px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <Link
          to={returnTo ?? "/sales"}
          className="inline-flex min-h-10 items-center gap-2 rounded-md text-sm font-semibold text-brand-navy transition-colors hover:text-gold-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Retour aux ventes
        </Link>

        <section className="mt-4 grid gap-6 xl:grid-cols-[minmax(0,1.08fr)_minmax(430px,0.92fr)] xl:items-start">
          <PropertyIdentity sale={sale} />
          {access === "analysis" ? (
            <AnalysisDecisionPanel
              sale={sale}
              marketEstimate={marketEstimate}
              marketLoading={marketQuery.isLoading && marketEstimate == null}
              worksBudget={worksBudget}
              recommendedCeiling={recommendations.withRefreshWorks.maxBid}
              ceilingAvailable={recommendations.withRefreshWorks.available}
              onAdjust={() => setCalculationOpen(true)}
            />
          ) : (
            <DiscoveryDecisionPanel worksBudget={worksBudget} />
          )}
        </section>

        <PropertyDescription sale={sale} />
      </div>

      {access === "analysis" ? (
        <AnalysisContent
          sale={sale}
          marketEstimate={marketEstimate}
          marketLoading={marketQuery.isLoading && marketEstimate == null}
          recommendations={recommendations}
          surface={surface}
          calculationOpen={calculationOpen}
          onCalculationOpenChange={setCalculationOpen}
        />
      ) : (
        <DiscoveryContinuation />
      )}
    </main>
  );
}

function PropertyDescription({ sale }: { sale: AuctionSale }) {
  const description = getSaleDisplayDescription(sale);
  const isAiDescription = hasSaleAiDescription(sale);

  return (
    <section
      id="description-ia"
      className="mt-6 scroll-mt-36 rounded-lg border border-brand-navy/12 bg-white p-5 shadow-[0_18px_45px_rgba(72,104,132,0.1)] sm:p-7 lg:p-8"
    >
      <div className="flex items-start gap-4">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-md border border-gold/25 bg-gold/10 text-gold-soft">
          <Sparkles className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="font-display text-2xl font-semibold leading-tight text-brand-navy sm:text-3xl">
            {isAiDescription ? "Description du bien rédigée par IA" : "Description du bien"}
          </h2>
          <p className="mt-4 max-w-5xl text-base leading-8 text-brand-navy/78 sm:text-lg">
            {description}
          </p>
        </div>
      </div>
    </section>
  );
}

function PropertyIdentity({ sale }: { sale: AuctionSale }) {
  const images = propertyImages(sale.media);
  const [galleryIndex, setGalleryIndex] = useState<number | null>(null);
  const [mobilePhotoIndex, setMobilePhotoIndex] = useState(0);
  const mobileCarouselRef = useRef<HTMLDivElement>(null);
  const title = saleDisplayTitle(sale, propertyTypeLabel(sale.property_type));
  const address = [sale.address, sale.postal_code, sale.city].filter(Boolean).join(", ");
  const displaySurface = getDisplaySurface(sale);
  const mapLocation =
    sale.latitude != null && sale.longitude != null
      ? { lat: sale.latitude, lng: sale.longitude }
      : null;

  const handleMobileCarouselScroll = (event: UIEvent<HTMLDivElement>) => {
    const carousel = event.currentTarget;
    if (!carousel.clientWidth) return;
    const nextIndex = Math.round(carousel.scrollLeft / carousel.clientWidth);
    setMobilePhotoIndex(Math.min(Math.max(nextIndex, 0), images.length - 1));
  };

  const goToMobilePhoto = (nextIndex: number) => {
    const carousel = mobileCarouselRef.current;
    if (!carousel || !images.length) return;
    const clampedIndex = Math.min(Math.max(nextIndex, 0), images.length - 1);
    carousel.scrollTo({ left: clampedIndex * carousel.clientWidth, behavior: "smooth" });
    setMobilePhotoIndex(clampedIndex);
  };

  return (
    <div className="min-w-0">
      <div className="relative overflow-hidden rounded-lg border border-brand-navy/10 bg-white shadow-[0_22px_60px_rgba(72,104,132,0.14)]">
        {images[0] ? (
          <>
            <div
              ref={mobileCarouselRef}
              role="region"
              aria-roledescription="carrousel"
              aria-label={`Photos de ${title}`}
              onScroll={handleMobileCarouselScroll}
              className="flex h-[clamp(16rem,78vw,22rem)] snap-x snap-mandatory scroll-smooth overflow-x-auto overscroll-x-contain bg-muted [-webkit-overflow-scrolling:touch] [scrollbar-width:none] md:hidden [&::-webkit-scrollbar]:hidden"
            >
              {images.map((image, index) => (
                <button
                  key={`${image.url}-${index}`}
                  type="button"
                  onClick={() => setGalleryIndex(index)}
                  className="group relative block h-full w-full max-w-full flex-none snap-start snap-always overflow-hidden bg-muted text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold"
                  aria-label={`Ouvrir la photo ${index + 1} sur ${images.length}`}
                >
                  <img
                    src={image.url}
                    alt={
                      index === 0
                        ? `Photo principale de ${title}`
                        : `Photo ${index + 1} de ${title}`
                    }
                    className="h-full w-full object-cover"
                    loading={index === 0 ? "eager" : "lazy"}
                    decoding="async"
                    draggable={false}
                    referrerPolicy="strict-origin-when-cross-origin"
                  />
                </button>
              ))}
            </div>
            {images.length > 1 ? (
              <>
                <button
                  type="button"
                  onClick={() => goToMobilePhoto(mobilePhotoIndex - 1)}
                  disabled={mobilePhotoIndex === 0}
                  className="absolute left-3 top-1/2 z-20 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full border border-white/70 bg-white/92 text-brand-navy shadow-lg backdrop-blur transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:pointer-events-none disabled:opacity-35 md:hidden"
                  aria-label="Photo précédente"
                >
                  <ArrowLeft className="h-5 w-5" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => goToMobilePhoto(mobilePhotoIndex + 1)}
                  disabled={mobilePhotoIndex === images.length - 1}
                  className="absolute right-3 top-1/2 z-20 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full border border-white/70 bg-white/92 text-brand-navy shadow-lg backdrop-blur transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:pointer-events-none disabled:opacity-35 md:hidden"
                  aria-label="Photo suivante"
                >
                  <ArrowRight className="h-5 w-5" aria-hidden />
                </button>
              </>
            ) : null}
            <button
              type="button"
              onClick={() => setGalleryIndex(0)}
              className="group relative hidden h-[430px] w-full overflow-hidden bg-muted text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold md:block"
              aria-label="Ouvrir la galerie photos"
            >
              <img
                src={images[0].url}
                alt={`Photo principale de ${title}`}
                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.015]"
                referrerPolicy="strict-origin-when-cross-origin"
              />
            </button>
            {images.length > 1 ? (
              <RotatingCamera360 className="absolute right-3 top-3 sm:right-4 sm:top-4" />
            ) : null}
            {mapLocation ? (
              <div className="absolute bottom-3 left-3 z-10 sm:bottom-4 sm:left-4">
                <MapboxPreviewButton
                  mode="streetLevel"
                  lat={mapLocation.lat}
                  lng={mapLocation.lng}
                  label="Vue rue"
                  title="Vue rue Mapbox"
                  description={address || "Adresse de l'annonce"}
                  ariaLabel="Afficher la vue rue Mapbox de l'annonce"
                  icon={MapPin}
                  className="inline-flex min-h-10 items-center gap-2 rounded-md border border-white/70 bg-white/95 px-3 py-2 text-xs font-semibold text-brand-navy shadow-lg backdrop-blur transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
                />
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => setGalleryIndex(mobilePhotoIndex)}
              className="absolute bottom-3 right-3 z-10 inline-flex min-h-10 items-center gap-2 rounded-md border border-white/70 bg-white/95 px-3 py-2 text-xs font-semibold text-brand-navy shadow-lg backdrop-blur transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold sm:bottom-4 sm:right-4"
              aria-label={`Ouvrir la galerie de ${images.length} photos`}
            >
              <Camera className="h-4 w-4" aria-hidden />
              <span className="md:hidden" aria-live="polite">
                {mobilePhotoIndex + 1} / {images.length}
              </span>
              <span className="hidden md:inline">
                {images.length} photo{images.length > 1 ? "s" : ""}
              </span>
            </button>
          </>
        ) : (
          <div className="grid h-[250px] place-items-center bg-[linear-gradient(145deg,#e5f1fb,#fffaf2)] sm:h-[430px]">
            <div className="text-center text-brand-navy/54">
              <Camera className="mx-auto h-8 w-8" aria-hidden />
              <p className="mt-3 text-sm font-medium">Photos à confirmer</p>
            </div>
          </div>
        )}
      </div>

      {images.length > 1 ? (
        <div className="mt-2 hidden grid-cols-3 gap-2 md:grid">
          {images.slice(1, 4).map((image, index) => (
            <button
              key={image.url}
              type="button"
              onClick={() => setGalleryIndex(index + 1)}
              className="h-16 overflow-hidden rounded-md border border-brand-navy/10 bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold sm:h-28"
              aria-label={`Ouvrir la photo ${index + 2}`}
            >
              <img
                src={image.url}
                alt={`Photo ${index + 2} de ${title}`}
                className="h-full w-full object-cover transition-transform duration-300 hover:scale-[1.03]"
                loading="lazy"
                referrerPolicy="strict-origin-when-cross-origin"
              />
            </button>
          ))}
        </div>
      ) : null}

      <div className="pt-5">
        <h1 className="font-display text-3xl font-medium leading-[1.02] text-brand-navy sm:text-5xl">
          {title}
        </h1>
        <p className="mt-3 flex items-start gap-2 text-sm text-brand-navy/70 sm:text-base">
          <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-gold-soft" aria-hidden />
          {address || "Localisation à confirmer"}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm font-medium text-brand-navy/76">
          <Fact icon={<Ruler className="h-4 w-4" />}>
            {displaySurface.value ? displaySurface.label : "Surface à confirmer"}
          </Fact>
          <Fact icon={<Building2 className="h-4 w-4" />}>
            {sale.rooms_count != null
              ? `${sale.rooms_count} pièce${sale.rooms_count > 1 ? "s" : ""}`
              : propertyTypeLabel(sale.property_type)}
          </Fact>
          <Fact icon={<CalendarDays className="h-4 w-4" />}>
            Audience {formatDate(sale.sale_date)}
          </Fact>
        </div>
        <p className="mt-4 flex flex-wrap items-baseline gap-x-2 text-sm text-brand-navy/72">
          <span className="font-semibold text-brand-navy">Mise à prix :</span>
          <strong className="font-display text-3xl font-medium text-gold-soft">
            {formatPrice(sale.starting_price_eur)}
          </strong>
          <span>— prix de départ judiciaire</span>
        </p>
      </div>

      {galleryIndex != null ? (
        <PhotoCarouselDialog
          images={images.map((image, index) => ({
            id: `${image.url}-${index}`,
            url: image.url,
            alt: index === 0 ? `Photo principale de ${title}` : `Photo ${index + 1} de ${title}`,
            source: image.source,
          }))}
          initialIndex={galleryIndex}
          title={title}
          onClose={() => setGalleryIndex(null)}
        />
      ) : null}
    </div>
  );
}

function Fact({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-gold-soft" aria-hidden>
        {icon}
      </span>
      {children}
    </span>
  );
}

function AnalysisDecisionPanel({
  sale,
  marketEstimate,
  marketLoading,
  worksBudget,
  recommendedCeiling,
  ceilingAvailable,
  onAdjust,
}: {
  sale: AuctionSale;
  marketEstimate: MarketEstimate | null;
  marketLoading: boolean;
  worksBudget: number;
  recommendedCeiling: number;
  ceilingAvailable: boolean;
  onAdjust: () => void;
}) {
  const ceiling = ceilingAvailable ? recommendedCeiling : null;
  const marketValue = marketEstimate?.estimatedValueEur ?? null;
  const markers = comparisonMarkerPositions({
    start: sale.starting_price_eur,
    ceiling,
    market: marketValue,
  });

  return (
    <aside className="rounded-lg border border-brand-navy/12 bg-white p-5 shadow-[0_22px_60px_rgba(72,104,132,0.14)] sm:p-7 lg:p-8">
      <h2 className="text-center font-display text-3xl font-medium text-brand-navy sm:text-4xl">
        Votre mise plafond recommandée
      </h2>
      <div className="mt-5 text-center font-display text-[clamp(3.8rem,7vw,6.9rem)] font-medium leading-none text-brand-navy">
        {ceiling != null ? formatPrice(ceiling) : "À compléter"}
      </div>

      <div className="mt-6 rounded-lg border border-gold/45 bg-[#fff8ef] p-4 sm:p-5">
        <div className="flex items-start gap-4">
          <Wrench className="mt-1 h-8 w-8 shrink-0 text-gold-soft" aria-hidden />
          <div>
            <p className="font-display text-2xl font-semibold leading-tight text-gold-soft sm:text-3xl">
              Travaux inclus par défaut : {formatPrice(worksBudget)}
            </p>
            <p className="mt-1 text-sm text-brand-navy/68 sm:text-base">
              Rafraîchissement estimé à {REFRESH_WORKS_PRICE_PER_M2} €/m²
            </p>
          </div>
        </div>
      </div>

      <p className="mt-5 text-center text-sm leading-relaxed text-brand-navy/76 sm:text-base">
        Le plafond protège votre marge face au marché local, aux frais et aux travaux.
      </p>

      <div className="mt-7">
        <div className="relative mx-3 h-7" aria-hidden>
          <div className="absolute left-0 right-0 top-3 h-px bg-brand-navy/25" />
          {markers.map((marker) => (
            <span
              key={marker.label}
              className={`absolute top-[7px] h-3 w-3 -translate-x-1/2 rounded-full border-2 border-white ${
                marker.label === "Mise plafond" ? "scale-150 bg-gold" : "bg-brand-navy/35"
              }`}
              style={{ left: `${marker.position}%` }}
            />
          ))}
        </div>
        <dl className="grid grid-cols-3 gap-2 text-center">
          {markers.map((marker) => (
            <div key={marker.label}>
              <dt className="text-[11px] font-semibold text-brand-navy/54 sm:text-xs">
                {marker.label}
              </dt>
              <dd
                className={`mt-1 font-display text-lg font-medium sm:text-2xl ${
                  marker.label === "Mise plafond" ? "text-gold-soft" : "text-brand-navy"
                }`}
              >
                {marker.value == null
                  ? marker.label === "Valeur estimée" && marketLoading
                    ? "Calcul…"
                    : "À compléter"
                  : formatPrice(marker.value)}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="mt-8 grid gap-3 sm:grid-cols-[1fr_auto]">
        <a
          href="#calculation"
          onClick={onAdjust}
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-gold-soft px-5 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2"
        >
          <Target className="h-4 w-4" aria-hidden />
          Ajuster mes hypothèses
        </a>
        <a
          href="#why-this-ceiling"
          className="inline-flex min-h-12 items-center justify-center px-4 py-3 text-sm font-semibold text-gold-soft underline decoration-gold/45 underline-offset-8 hover:text-gold"
        >
          Voir le calcul
        </a>
      </div>
    </aside>
  );
}

function DiscoveryDecisionPanel({ worksBudget }: { worksBudget: number }) {
  return (
    <aside className="rounded-lg border border-brand-navy/12 bg-white p-5 shadow-[0_22px_60px_rgba(72,104,132,0.14)] sm:p-7 lg:p-8">
      <h2 className="font-display text-3xl font-medium text-brand-navy sm:text-4xl">
        L'essentiel, gratuitement
      </h2>
      <p className="mt-6 font-display text-2xl font-medium text-brand-navy">Travaux estimés :</p>
      <div className="mt-1 font-display text-6xl font-medium leading-none text-gold-soft sm:text-7xl">
        {formatPrice(worksBudget)}
      </div>
      <p className="mt-4 text-sm leading-relaxed text-brand-navy/72 sm:text-base">
        Enveloppe globale de rafraîchissement. Le détail des postes est réservé à l'offre Analyse.
      </p>

      <div className="my-6 h-px bg-brand-navy/12" />

      <div className="rounded-lg border border-gold/35 bg-[#fffaf4] p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <LockKeyhole className="mt-1 h-6 w-6 shrink-0 text-brand-navy" aria-hidden />
          <div>
            <h3 className="font-display text-2xl font-semibold leading-tight text-brand-navy sm:text-3xl">
              Ne confondez pas mise à prix et bon prix
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-brand-navy/76 sm:text-base">
              Le prix de départ peut être supérieur au niveau du marché. Immojudis calcule la mise
              plafond qui protège votre marge, frais et travaux inclus.
            </p>
          </div>
        </div>

        <div className="mt-5 flex items-center gap-3 rounded-md border border-gold/55 bg-white px-4 py-3">
          <LockKeyhole className="h-5 w-5 shrink-0 text-brand-navy/65" aria-hidden />
          <div>
            <p className="text-sm font-medium text-brand-navy">Mise plafond avec travaux</p>
            <p className="font-display text-2xl font-semibold text-gold-soft">
              Réservée à l'offre Analyse
            </p>
          </div>
        </div>

        <p className="mt-4 text-sm leading-relaxed text-brand-navy/66">
          Estimation du bien · ventes comparables · détail du calcul · annuaire d'avocats
        </p>
        <BillingActions hideHelper className="mt-5 [&>button]:w-full" />
        <p className="mt-3 text-center text-xs font-medium text-brand-navy/55">
          30 jours · paiement unique · sans abonnement
        </p>
      </div>
    </aside>
  );
}

function comparisonMarkerPositions({
  start,
  ceiling,
  market,
}: {
  start: number | null;
  ceiling: number | null;
  market: number | null;
}) {
  const values = [start, ceiling, market].filter((value): value is number => value != null);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const span = Math.max(1, max - min);
  const position = (value: number | null, fallback: number) =>
    value == null ? fallback : 8 + ((value - min) / span) * 84;

  return [
    { label: "Mise à prix", value: start, position: position(start, 8) },
    { label: "Mise plafond", value: ceiling, position: position(ceiling, 50) },
    { label: "Valeur estimée", value: market, position: position(market, 92) },
  ];
}

function DiscoveryContinuation() {
  return (
    <section className="mx-auto max-w-[1460px] px-4 pb-16 sm:px-6 lg:px-8">
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="flex min-h-16 items-center gap-3 rounded-lg border border-brand-navy/12 bg-white px-5 py-4 shadow-sm">
          <Camera className="h-5 w-5 text-gold-soft" aria-hidden />
          <span className="font-display text-xl font-semibold text-brand-navy">Photos du bien</span>
          <CheckCircle2 className="ml-auto h-5 w-5 text-[#2f855a]" aria-hidden />
        </div>
        <Link
          to="/accompagnement"
          className="flex min-h-16 items-center gap-3 rounded-lg border border-gold/35 bg-[#fff9f1] px-5 py-4 text-brand-navy/65 shadow-sm transition-colors hover:border-gold hover:text-brand-navy"
        >
          <LockKeyhole className="h-5 w-5" aria-hidden />
          <span className="font-display text-xl font-semibold">
            Analyse complète réservée à l'offre Analyse
          </span>
          <ArrowRight className="ml-auto h-5 w-5" aria-hidden />
        </Link>
      </div>
    </section>
  );
}

type Recommendations = ReturnType<typeof computeRecommendedCeilings>;

function AnalysisContent({
  sale,
  marketEstimate,
  marketLoading,
  recommendations,
  surface,
  calculationOpen,
  onCalculationOpenChange,
}: {
  sale: AuctionSale;
  marketEstimate: MarketEstimate | null;
  marketLoading: boolean;
  recommendations: Recommendations;
  surface: number | null;
  calculationOpen: boolean;
  onCalculationOpenChange: (open: boolean) => void;
}) {
  return (
    <>
      <nav className="sticky top-16 z-30 border-y border-brand-navy/10 bg-white/95 shadow-sm backdrop-blur">
        <div className="mx-auto flex max-w-5xl justify-between overflow-x-auto px-4 sm:px-6">
          {[
            ["#summary", "Synthèse"],
            ["#market", "Marché local"],
            ["#risks", "Risques & pièces"],
            ["#lawyer", "Avocat"],
          ].map(([href, label]) => (
            <a
              key={href}
              href={href}
              className="whitespace-nowrap border-b-2 border-transparent px-3 py-4 text-sm font-semibold text-brand-navy/68 transition-colors hover:border-gold hover:text-brand-navy sm:px-6"
            >
              {label}
            </a>
          ))}
        </div>
      </nav>

      <section id="summary" className="scroll-mt-36 border-b border-brand-navy/10 bg-[#eef7ff]">
        <div className="mx-auto grid max-w-[1260px] gap-10 px-4 py-12 sm:px-6 lg:grid-cols-2 lg:px-8 lg:py-16">
          <CeilingExplanation recommendations={recommendations} surface={surface} />
          <MarketEvidence marketEstimate={marketEstimate} marketLoading={marketLoading} />
        </div>
      </section>

      <RisksAndDocuments sale={sale} />
      <LawyerSection sale={sale} />

      <section className="mx-auto max-w-[1260px] px-4 py-12 sm:px-6 lg:px-8">
        <details
          id="calculation"
          open={calculationOpen}
          className="group scroll-mt-36 rounded-lg border border-brand-navy/12 bg-white shadow-sm"
          onToggle={(event) => onCalculationOpenChange(event.currentTarget.open)}
        >
          <summary className="flex cursor-pointer list-none items-center gap-4 px-5 py-5 sm:px-7">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-gold/10 text-gold-soft">
              <Target className="h-5 w-5" aria-hidden />
            </span>
            <span>
              <span className="block font-display text-2xl font-semibold text-brand-navy">
                Ajuster les hypothèses
              </span>
              <span className="mt-1 block text-sm text-brand-navy/62">
                Travaux, profil de marge, frais et prix de marché au m².
              </span>
            </span>
            <ChevronDown className="ml-auto h-5 w-5 transition-transform group-open:rotate-180" />
          </summary>
          {calculationOpen ? (
            <div className="border-t border-brand-navy/10 p-4 sm:p-7">
              <BidCeilingAssistant sale={sale} marketEstimateOverride={marketEstimate} />
            </div>
          ) : null}
        </details>

        <details className="group mt-4 rounded-lg border border-brand-navy/12 bg-white shadow-sm">
          <summary className="flex cursor-pointer list-none items-center gap-4 px-5 py-5 sm:px-7">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-gold/10 text-gold-soft">
              <FileText className="h-5 w-5" aria-hidden />
            </span>
            <span>
              <span className="block font-display text-2xl font-semibold text-brand-navy">
                Consulter les pièces du dossier
              </span>
              <span className="mt-1 block text-sm text-brand-navy/62">
                Annonce, procès-verbal, cahier des conditions et diagnostics disponibles.
              </span>
            </span>
            <ChevronDown className="ml-auto h-5 w-5 transition-transform group-open:rotate-180" />
          </summary>
          <div className="border-t border-brand-navy/10 px-5 py-3 sm:px-7">
            <DocumentsList documents={sale.documents} />
          </div>
        </details>
      </section>
    </>
  );
}

function CeilingExplanation({
  recommendations,
  surface,
}: {
  recommendations: Recommendations;
  surface: number | null;
}) {
  const result = recommendations.withRefreshWorks;
  const marketBase = result.available
    ? Math.round(result.marketReferencePricePerM2 * Math.max(0, surface ?? 0))
    : null;
  const safetyMargin =
    marketBase != null ? Math.round(marketBase * (result.safetyDiscountPct / 100)) : null;
  const rows = [
    ["Valeur de marché prudente", marketBase],
    ["Marge de sécurité", safetyMargin == null ? null : -safetyMargin],
    ["Frais estimés", result.available ? -Math.round(result.simulated.acquisitionFeesTotal) : null],
    ["Travaux inclus", -recommendations.refreshWorksBudget],
  ] as const;

  return (
    <div id="why-this-ceiling" className="min-w-0 scroll-mt-36 lg:pr-10">
      <h2 className="font-display text-4xl font-medium text-brand-navy sm:text-5xl">
        Pourquoi {result.available ? formatPrice(result.maxBid) : "ce plafond"} ?
      </h2>
      <dl className="mt-7 border-y border-brand-navy/18">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex items-baseline justify-between gap-4 border-b border-brand-navy/12 py-3.5 last:border-b-0"
          >
            <dt className="text-sm font-medium text-brand-navy sm:text-base">{label}</dt>
            <dd
              className={`font-display text-xl font-semibold sm:text-2xl ${
                value != null && value < 0 ? "text-gold-soft" : "text-brand-navy"
              }`}
            >
              {value == null ? "À compléter" : signedPrice(value)}
            </dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-4 border-t border-brand-navy/50 py-5">
          <dt className="font-display text-2xl font-semibold text-brand-navy">
            Mise plafond recommandée
          </dt>
          <dd className="font-display text-3xl font-semibold text-brand-navy sm:text-4xl">
            {result.available ? formatPrice(result.maxBid) : "À compléter"}
          </dd>
        </div>
      </dl>
      <p className="mt-6 max-w-2xl text-sm leading-relaxed text-brand-navy/70 sm:text-base">
        Par défaut, Immojudis intègre un rafraîchissement car les biens judiciaires sont rarement
        livrés en état neuf.
      </p>
    </div>
  );
}

function signedPrice(value: number) {
  if (value < 0) return `− ${formatPrice(Math.abs(value))}`;
  return formatPrice(value);
}

function MarketEvidence({
  marketEstimate,
  marketLoading,
}: {
  marketEstimate: MarketEstimate | null;
  marketLoading: boolean;
}) {
  const comparables = marketEstimate?.recentTransactions?.slice(0, 4) ?? [];
  const usesAggregateStatistics = marketEstimate?.comparableMode === "geographic_aggregate";
  const usesParkingSales = marketEstimate?.comparableMode === "unit_sales";
  const sampleCount = marketEstimate?.sampleSize ?? 0;
  const sampleLabel = usesParkingSales
    ? `${sampleCount} vente${sampleCount > 1 ? "s" : ""} de stationnement`
    : usesAggregateStatistics
      ? `${sampleCount} vente${sampleCount > 1 ? "s" : ""} de référence`
      : `${sampleCount} vente${sampleCount > 1 ? "s" : ""} comparable${sampleCount > 1 ? "s" : ""}`;

  return (
    <div
      id="market"
      className="min-w-0 scroll-mt-36 border-t border-brand-navy/18 pt-8 lg:border-l lg:border-t-0 lg:pl-10 lg:pt-0"
    >
      <h2 className="font-display text-4xl font-medium text-brand-navy sm:text-5xl">
        Marché local
      </h2>
      <dl className="mt-7 grid gap-4">
        <MarketFact
          icon={<BadgeEuro className="h-5 w-5" />}
          label="Valeur estimée"
          value={
            marketEstimate?.estimatedValueEur
              ? formatPrice(marketEstimate.estimatedValueEur)
              : marketLoading
                ? "Calcul…"
                : "À compléter"
          }
        />
        <MarketFact
          icon={<ChartNoAxesCombined className="h-5 w-5" />}
          label={sampleLabel}
          value={
            marketEstimate?.medianUnitPriceEur
              ? `Médiane ${formatPrice(marketEstimate.medianUnitPriceEur)} / place`
              : marketEstimate?.medianPricePerM2
                ? `Médiane ${formatPricePerM2(marketEstimate.medianPricePerM2)}`
                : "Échantillon à compléter"
          }
        />
        <MarketFact
          icon={<ShieldCheck className="h-5 w-5" />}
          label="Niveau de confiance"
          value={marketEstimate?.qualityLabel ?? "À confirmer"}
        />
      </dl>

      {comparables.length ? (
        <div className="mt-7 overflow-x-auto border-y border-brand-navy/14">
          <table className="w-full min-w-[540px] text-left text-sm">
            <thead className="text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-navy/52">
              <tr>
                <th className="py-3 pr-4">Date</th>
                <th className="px-4 py-3">Surface</th>
                <th className="px-4 py-3">Distance</th>
                <th className="py-3 pl-4 text-right">Prix de vente</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-brand-navy/10">
              {comparables.map((item, index) => (
                <tr key={`${item.date}-${item.totalPrice}-${index}`}>
                  <td className="py-3 pr-4">{formatDate(item.date)}</td>
                  <td className="px-4 py-3">
                    {usesParkingSales
                      ? `${item.unitCount ?? 1} place${(item.unitCount ?? 1) > 1 ? "s" : ""}`
                      : item.surface
                        ? `${item.surface} m²`
                        : "—"}
                  </td>
                  <td className="px-4 py-3">
                    {item.distanceM != null ? `${item.distanceM} m` : "—"}
                  </td>
                  <td className="py-3 pl-4 text-right font-semibold">
                    {formatPrice(item.totalPrice)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-7 border-y border-brand-navy/12 py-5 text-sm leading-relaxed text-brand-navy/64">
          {usesAggregateStatistics
            ? `Estimation indicative fondée sur la médiane DVF à l’échelle ${aggregateScopeLabel(marketEstimate?.geographyLevel)}. Les ventes détaillées apparaîtront dès qu’un échantillon local homogène sera disponible.`
            : "Les ventes comparables seront affichées ici dès qu'un échantillon homogène est disponible."}
        </p>
      )}
    </div>
  );
}

function aggregateScopeLabel(level: MarketEstimate["geographyLevel"]): string {
  if (level === "commune") return "de la commune";
  if (level === "epci") return "de l’intercommunalité";
  return "du département";
}

function MarketFact({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-3">
      <span className="text-gold-soft" aria-hidden>
        {icon}
      </span>
      <dt className="text-sm font-medium text-brand-navy sm:text-base">{label}</dt>
      <dd className="text-right text-sm font-semibold text-brand-navy sm:text-base">{value}</dd>
    </div>
  );
}

function RisksAndDocuments({ sale }: { sale: AuctionSale }) {
  const risks = (sale.risks ?? []).slice(0, 2);
  const rows = [
    ...risks.map((risk) => riskRow(risk)),
    {
      key: "documents",
      icon: <FileText className="h-5 w-5" />,
      label: "Cahier des conditions à relire",
      source: "Cahier des conditions de vente",
      status: sale.documents ? "Document disponible" : "À récupérer",
      complete: Boolean(sale.documents),
    },
  ].slice(0, 3);

  return (
    <section id="risks" className="scroll-mt-36 border-b border-brand-navy/10 bg-white">
      <div className="mx-auto max-w-[1260px] px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
        <h2 className="font-display text-4xl font-medium text-brand-navy sm:text-5xl">
          Les points à sécuriser avant l'audience
        </h2>
        <div className="mt-7 divide-y divide-brand-navy/12 border-y border-brand-navy/14">
          {rows.map((row) => (
            <div
              key={row.key}
              className="grid gap-2 py-4 sm:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_13rem] sm:items-center sm:gap-5"
            >
              <div className="flex items-center gap-3 font-semibold text-brand-navy">
                <span className="text-gold-soft" aria-hidden>
                  {row.icon}
                </span>
                {row.label}
              </div>
              <div className="pl-8 text-sm text-brand-navy/66 sm:pl-0">{row.source}</div>
              <div
                className={`flex items-center gap-2 pl-8 text-sm font-medium sm:pl-0 ${
                  row.complete ? "text-[#237a4b]" : "text-[#9a5d15]"
                }`}
              >
                {row.complete ? (
                  <CheckCircle2 className="h-4 w-4" aria-hidden />
                ) : (
                  <CircleAlert className="h-4 w-4" aria-hidden />
                )}
                {row.status}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function riskRow(risk: SaleRisk) {
  const evidence = asRecord(risk.evidence_json);
  const source =
    typeof evidence.document_label === "string"
      ? evidence.document_label
      : typeof evidence.document_type === "string"
        ? evidence.document_type
        : "Pièce du dossier";

  return {
    key: `${risk.risk_type}-${risk.risk_label}`,
    icon: risk.risk_type.toLowerCase().includes("work") ? (
      <Wrench className="h-5 w-5" />
    ) : (
      <CircleAlert className="h-5 w-5" />
    ),
    label: risk.risk_label,
    source,
    status: risk.severity != null && risk.severity >= 4 ? "Prioritaire" : "À vérifier",
    complete: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function LawyerSection({ sale }: { sale: AuctionSale }) {
  const isPersistedSale =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sale.id);
  const directoryHref = isPersistedSale
    ? `/avocats?saleId=${encodeURIComponent(sale.id)}&city=${encodeURIComponent(sale.city ?? "")}`
    : `/avocats?city=${encodeURIComponent(sale.city ?? "")}`;

  return (
    <section id="lawyer" className="scroll-mt-36 bg-white">
      <div className="mx-auto max-w-[1380px] px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
        <div className="grid gap-7 rounded-lg border border-[#a9c9df] bg-[#eef7ff] p-6 sm:p-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(420px,1.15fr)] lg:items-center">
          <div>
            <h2 className="font-display text-3xl font-medium leading-tight text-brand-navy sm:text-4xl">
              Prêt à enchérir ? Faites-vous accompagner.
            </h2>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-brand-navy/70 sm:text-base">
              Trouvez un avocat inscrit au barreau compétent pour vérifier le dossier et porter vos
              enchères.
            </p>
          </div>
          <div className="rounded-lg border border-brand-navy/14 bg-white p-5 shadow-sm sm:flex sm:items-center sm:gap-5">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-md bg-gold/10 text-gold-soft">
              <Scale className="h-6 w-6" aria-hidden />
            </span>
            <div className="mt-3 min-w-0 flex-1 sm:mt-0">
              <p className="font-display text-2xl font-semibold text-brand-navy">
                {sale.city ?? sale.tribunal_city ?? "Barreau compétent"}
              </p>
              <p className="mt-1 text-sm text-brand-navy/60">Avocats référencés par Immojudis</p>
            </div>
            <a
              href={directoryHref}
              className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-brand-navy px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-gold-soft sm:mt-0"
            >
              Voir les avocats disponibles
              <ArrowRight className="h-4 w-4" aria-hidden />
            </a>
          </div>
          {isPersistedSale ? (
            <div className="lg:col-start-2">
              <LawyerReferralButton saleId={sale.id} className="min-h-11 w-full sm:w-auto" />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
