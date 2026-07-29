import { useEffect, useState } from "react";
import type * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@/lib/router-compat";
import { toast } from "sonner";
import BadgeEuro from "lucide-react/dist/esm/icons/badge-euro.js";
import Camera from "lucide-react/dist/esm/icons/camera.js";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import CircleHelp from "lucide-react/dist/esm/icons/circle-help.js";
import ClipboardCheck from "lucide-react/dist/esm/icons/clipboard-check.js";
import Clock3 from "lucide-react/dist/esm/icons/clock-3.js";
import Download from "lucide-react/dist/esm/icons/download.js";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import FileCheck2 from "lucide-react/dist/esm/icons/file-check-2.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import MessageSquare from "lucide-react/dist/esm/icons/message-square.js";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import Send from "lucide-react/dist/esm/icons/send.js";
import Share2 from "lucide-react/dist/esm/icons/share-2.js";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.js";
import Target from "lucide-react/dist/esm/icons/target.js";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert.js";
import Users from "lucide-react/dist/esm/icons/users.js";
import Wrench from "lucide-react/dist/esm/icons/wrench.js";
import {
  formatPrice,
  formatDate,
  formatDateTime,
  formatNumber,
  documentTypeLabel,
  formatPricePerM2,
  occupancyLabel,
  propertyTypeLabel,
  saleStatusLabel,
} from "@/lib/format";
import { getDisplaySurface, getMarketValuationSurfaces, getSaleSurface } from "@/lib/surface";
import { isEmbeddableDocumentUrl, parseDocs } from "@/lib/documents";
import { safeExternalHttpUrl } from "@/lib/external-url";
import { BidCeilingAssistant } from "@/components/BidCeilingAssistant";
import { FavoriteButton } from "@/components/FavoriteButton";
import { FeaturedLawyerPlacement } from "@/components/FeaturedLawyerPlacement";
import { PropertyReportActions } from "@/components/PropertyReportActions";
import { SaleCountdown } from "@/components/SaleCountdown";
import { SaleLocationHero } from "@/components/SaleLocationHero";
import { MapThumbnail } from "@/components/MapThumbnail";
import { BrandMark } from "@/components/BrandLogo";
import { EvidenceTrail } from "@/components/EvidenceTrail";
import { MapboxPreviewButton } from "@/components/MapboxPreviewButton";
import { PhotoCarouselDialog, type CarouselImage } from "@/components/PhotoCarouselDialog";
import { RotatingCamera360 } from "@/components/RotatingCamera360";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  createSaleAnalysisSet,
  createSaleWorkspaceAnnotationClient,
  fetchEnvironmentalContext,
  fetchPrecomputedMarketEstimate,
  fetchMarketAnalytics,
  fetchSaleHistory,
  fetchSaleWorkspace,
  fetchSaleWorkspaceCollaboration,
  fetchValuationBacktest,
  inviteSaleWorkspaceCollaboratorClient,
  saveSaleWorkspace,
  updateSaleWorkspaceAnnotationClient,
} from "@/lib/client-api";
import type { EnvironmentalContext } from "@/lib/environment.functions";
import type { MarketEstimate } from "@/lib/market.functions";
import {
  DEFAULT_DOCUMENT_REVIEW,
  DEFAULT_SALE_CHECKLIST,
  DOCUMENT_REVIEW_STATUS_LABELS,
  SALE_WORKSPACE_STATUS_LABELS,
  isUuid,
  type SaleWorkspaceDocumentReview,
  type SaleWorkspaceDocumentReviewStatus,
  type SaleWorkspaceDocumentReviews,
  type SaleWorkspaceStatus,
} from "@/lib/sale-workspace-shared";
import { openStreetMapQueryUrl, openStreetMapUrl } from "@/lib/tiles";
import { cn } from "@/lib/utils";
import { propertyImages } from "@/lib/sale-media";
import { saleSourceLinks } from "@/lib/sale-source-links";
import {
  computeAcquisitionCosts,
  computeRecommendedCeilings,
  DEFAULT_MARKET_CEILING_SCENARIO,
  DEFAULTS,
  REFRESH_WORKS_PRICE_PER_M2,
  type MarketCeilingResult,
} from "@/lib/profitability";
import {
  buildSaleProductSources,
  type ProductFact,
  type ProductGroup,
  type ProductHistoryRow,
  type ProductRisk,
  type ProductWeatherMonth,
  type SaleProductSources,
} from "@/lib/sale-detail-sources";
import { getSaleDisplayDescription, hasSaleAiDescription } from "@/lib/sale-description";
import { saleDisplayTitle } from "@/lib/sale-title";
import type { AuctionSale, SaleDocumentRich, SaleMedia, SaleRiskOccurrence } from "@/lib/types";
import {
  cleanContactValue,
  findOccurrence,
  hasWorksRisk,
  isUnknownOccupation,
  lawyerContactHref,
  printAnalysis,
  saleLawyerContact,
  shareCurrentPage,
  sourceBlockMoney,
} from "./detail-helpers";
import {
  LawyerQuestionsBlock,
  RedfinPropertyDetailsBlock,
  SourcesAndDocumentsBlock,
  saleMapboxLocation,
  saleMediaCarouselImages,
} from "./detail-primitives";
import { AdvancedAssumptionsBlock, DossierAssistant } from "./document-workspace";
export type DecisionSummary = {
  ceiling: MarketCeilingResult;
  ceilingWithoutWorks: MarketCeilingResult;
  ceilingWithRefreshWorks: MarketCeilingResult;
  refreshWorksBudget: number;
  primaryCheck: string;
  primaryDocument: string;
  action: string;
};

export type AcquisitionCost = ReturnType<typeof computeAcquisitionCosts>;

export function DecisionHero({
  sale,
  title,
  location,
  media,
  decision,
  acquisitionCost,
}: {
  sale: AuctionSale;
  title: string;
  location: string;
  media: SaleMedia[];
  decision: DecisionSummary;
  acquisitionCost: AcquisitionCost;
}) {
  const city = sale.city ?? location.split(",").at(-1)?.trim() ?? "ce secteur";
  const propertyLabel = shortPropertyLabel(sale);
  const vigilance = [
    isUnknownOccupation(sale.occupancy_status) ? "Occupation à confirmer" : null,
    hasWorksRisk(sale) ? "Travaux à chiffrer" : "Travaux à estimer",
  ]
    .filter(Boolean)
    .join(" · ");
  const saleMeta = [
    `Mis à prix ${formatPrice(sale.starting_price_eur)}`,
    sale.sale_date ? `Vente judiciaire le ${formatDate(sale.sale_date)}` : "Date à confirmer",
    sale.tribunal ?? sale.tribunal_name ?? "Tribunal à confirmer",
  ].join(". ");

  return (
    <section className="relative overflow-hidden border-b border-border bg-[#eef7ff]">
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.78),rgba(238,247,255,0.92)_48%,rgba(255,255,255,0.98))]" />
      <div className="absolute inset-0 bg-[linear-gradient(rgba(19,34,56,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(19,34,56,0.025)_1px,transparent_1px)] [background-size:52px_52px]" />
      <div className="relative mx-auto grid max-w-[1360px] gap-7 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(430px,0.95fr)] lg:px-8 lg:py-11">
        <div className="flex min-w-0 flex-col justify-center">
          <h1 className="max-w-[780px] font-display text-[clamp(2.65rem,5.1vw,5.45rem)] font-medium leading-[0.98] text-brand-navy">
            {propertyLabel} à {city} en vente judiciaire
          </h1>
          <p className="mt-5 max-w-3xl text-base leading-relaxed text-brand-navy/80 sm:text-lg">
            {saleMeta}. Immojudis analyse le dossier, le marché local, les frais et les travaux pour
            vous aider à savoir jusqu'où enchérir sans surpayer.
          </p>

          <dl className="mt-7 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <DecisionMetricCard
              icon={<BadgeEuro className="h-4 w-4" />}
              label="Mise à prix"
              value={formatPrice(sale.starting_price_eur)}
              detail="Prix de départ judiciaire"
            />
            <DecisionMetricCard
              icon={<Target className="h-4 w-4" />}
              label="Plafond conseillé sans travaux"
              value={ceilingWithoutWorksLabel(decision)}
              detail={
                decision.ceilingWithoutWorks.available
                  ? "Profil Prudent · marge 8 %"
                  : "Marché à compléter"
              }
              accent
            />
            <DecisionMetricCard
              icon={<Wrench className="h-4 w-4" />}
              label="Plafond conseillé avec rafraîchissement"
              value={ceilingWithRefreshWorksLabel(decision)}
              detail={`${formatPrice(decision.refreshWorksBudget)} de travaux · ${REFRESH_WORKS_PRICE_PER_M2} €/m²`}
              accent
            />
            <DecisionMetricCard
              icon={<TriangleAlert className="h-4 w-4" />}
              label="Points de vigilance"
              value={vigilance || decision.primaryCheck}
              detail={decision.primaryDocument}
            />
          </dl>

          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            <a
              href="#calculation"
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-gold-soft px-5 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-gold"
            >
              <Target className="h-4 w-4" />
              Ajuster mon plafond
            </a>
            <a
              href="#risks"
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md border border-brand-navy/25 bg-white/80 px-5 py-3 text-sm font-semibold text-brand-navy transition-colors hover:border-gold/60 hover:text-gold-soft"
            >
              <TriangleAlert className="h-4 w-4" />
              Voir les risques
            </a>
          </div>
        </div>

        <DecisionMediaFrame sale={sale} media={media} title={title} location={location} />
      </div>
    </section>
  );
}

export function DecisionMediaFrame({
  sale,
  media,
  title,
  location,
}: {
  sale: AuctionSale;
  media: SaleMedia[];
  title: string;
  location: string;
}) {
  const featured = media[0];
  const thumbnails = media.slice(1, 5);
  const thumbnailGridClass =
    thumbnails.length <= 1
      ? "mt-2 grid grid-cols-1 gap-2"
      : thumbnails.length === 2
        ? "mt-2 grid grid-cols-2 gap-2"
        : thumbnails.length === 3
          ? "mt-2 grid grid-cols-3 gap-2"
          : "mt-2 grid grid-cols-4 gap-2";
  const [carouselIndex, setCarouselIndex] = useState<number | null>(null);
  const carouselImages = saleMediaCarouselImages(media, title);
  const mapLocation = saleMapboxLocation(sale);
  const mapDescription =
    location || [sale.address, sale.postal_code, sale.city].filter(Boolean).join(", ");

  if (!featured) {
    return (
      <div className="overflow-hidden rounded-lg border border-border bg-white shadow-sm">
        <SaleLocationHero sale={sale} />
      </div>
    );
  }

  return (
    <div className="min-w-0 self-start rounded-lg border border-white/80 bg-white/85 p-2 shadow-[0_26px_70px_rgba(72,104,132,0.18)]">
      <div className="relative overflow-hidden rounded-md border border-border bg-muted">
        <button
          type="button"
          onClick={() => setCarouselIndex(0)}
          aria-label="Ouvrir la photo principale dans la galerie"
          className="group block w-full cursor-pointer overflow-hidden text-left"
        >
          <img
            src={featured.url}
            alt={`Photo principale - ${title}`}
            className="aspect-[16/9] w-full object-cover transition duration-500 group-hover:scale-[1.02] group-hover:brightness-95"
            loading="eager"
            decoding="async"
            referrerPolicy="no-referrer"
          />
        </button>
        <span className="absolute right-3 top-3 rounded-md bg-brand-navy/78 px-3 py-1 text-xs font-semibold text-white">
          1 / {Math.max(media.length, 1)}
        </span>
        {media.length > 1 && <RotatingCamera360 className="absolute left-3 top-3" />}
        {mapLocation && (
          <div className="absolute bottom-3 left-3 flex flex-wrap gap-2">
            <MapboxPreviewButton
              mode="streetLevel"
              lat={mapLocation.lat}
              lng={mapLocation.lng}
              label="Vue rue"
              title="Vue rue Mapbox"
              description={mapDescription || "Adresse de l'annonce"}
              ariaLabel="Afficher la vue rue Mapbox pour l'annonce"
              icon={MapPin}
              className="inline-flex min-h-10 items-center gap-2 rounded-md border border-white/70 bg-white/95 px-3 py-2 text-xs font-semibold text-foreground shadow-sm backdrop-blur transition-colors hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
            />
          </div>
        )}
      </div>
      {thumbnails.length > 0 && (
        <div className={thumbnailGridClass}>
          {thumbnails.map((item, index) => (
            <button
              key={`${item.url}-${index}`}
              type="button"
              onClick={() => setCarouselIndex(index + 1)}
              className="group cursor-pointer overflow-hidden rounded-md border border-border bg-muted text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
            >
              <img
                src={item.url}
                alt={`Photo ${index + 2} du bien`}
                className="aspect-[4/3] w-full object-cover transition duration-500 group-hover:scale-[1.03] group-hover:brightness-95"
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
              />
            </button>
          ))}
        </div>
      )}
      {carouselIndex != null && (
        <PhotoCarouselDialog
          images={carouselImages}
          initialIndex={carouselIndex}
          title={title}
          onClose={() => setCarouselIndex(null)}
        />
      )}
    </div>
  );
}

export function DecisionMetricCard({
  icon,
  label,
  value,
  detail,
  accent = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  accent?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-brand-navy/10 bg-white/82 p-4 shadow-sm">
      <dt className="flex items-center gap-2 text-[11px] font-semibold text-brand-navy/72">
        <span className={accent ? "text-gold-soft" : "text-gold"}>{icon}</span>
        {label}
      </dt>
      <dd
        className={`mt-2 text-[clamp(1.15rem,1.8vw,1.55rem)] font-semibold leading-tight tabular-nums ${
          accent ? "text-gold-soft" : "text-brand-navy"
        }`}
      >
        {value}
      </dd>
      <p className="mt-1 text-xs leading-relaxed text-brand-navy/62">{detail}</p>
    </div>
  );
}

export function DecisionIntroGrid({
  sale,
  decision,
  acquisitionCost,
  marketEstimate,
  marketLoading = false,
  marketError = false,
}: {
  sale: AuctionSale;
  decision: DecisionSummary;
  acquisitionCost: AcquisitionCost;
  marketEstimate?: MarketEstimate | null;
  marketLoading?: boolean;
  marketError?: boolean;
}) {
  const surface = getDisplaySurface(sale);
  const city = sale.city ?? "ce secteur";
  const comparableText = marketEvidenceSentence(marketEstimate, marketLoading, marketError);

  return (
    <section id="summary" className="scroll-mt-28">
      <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
        <DecisionPanel icon={<Clock3 className="h-5 w-5" />} title="Résumé en 30 secondes">
          <div className="space-y-3 text-sm leading-relaxed text-brand-navy/78 sm:text-base">
            <p>
              Ce {shortPropertyLabel(sale)} de{" "}
              {surface.value ? surface.label : "surface à confirmer"} à {city} est mis à prix{" "}
              {formatPrice(sale.starting_price_eur)}.
            </p>
            <p>
              En profil Prudent, le plafond conseillé est de {ceilingWithoutWorksLabel(decision)}{" "}
              sans travaux et de {ceilingWithRefreshWorksLabel(decision)} avec une enveloppe de
              rafraîchissement de {formatPrice(decision.refreshWorksBudget)}.
            </p>
            <p>
              Le dossier semble intéressant, mais deux points peuvent modifier fortement l'enchère
              maximale : l'occupation du bien et le montant réel des travaux.
            </p>
            <p>{comparableText}</p>
          </div>
        </DecisionPanel>

        <DecisionPanel
          icon={<Sparkles className="h-5 w-5" />}
          title="Ce qu'Immojudis fait pour vous"
        >
          <div className="grid gap-3">
            {[
              [
                "Comprendre le bien",
                "Les informations importantes sont extraites du dossier judiciaire.",
              ],
              [
                "Évaluer l'opportunité",
                "Le prix est comparé au marché local et aux ventes comparables.",
              ],
              [
                "Décider jusqu'où enchérir",
                `Un plafond est calculé avec frais, travaux et coût complet estimé à ${formatPrice(
                  acquisitionCost.totalCost,
                )}.`,
              ],
            ].map(([title, text]) => (
              <div
                key={title}
                className="grid gap-1 border-t border-border/70 pt-3 first:border-t-0 first:pt-0"
              >
                <h3 className="text-sm font-semibold text-brand-navy">{title}</h3>
                <p className="text-sm leading-relaxed text-brand-navy/68">{text}</p>
              </div>
            ))}
          </div>
        </DecisionPanel>
      </div>
    </section>
  );
}

export function AiPropertyDescriptionCard({
  sale,
  decision,
}: {
  sale: AuctionSale;
  decision: DecisionSummary;
}) {
  const displayDescription = getSaleDisplayDescription(sale);
  const descriptionLabel = hasSaleAiDescription(sale)
    ? "Description du bien rédigée par IA"
    : "Description du bien";
  const facts = [
    ["Type", propertyTypeLabel(sale.property_type)],
    [
      "Surface retenue",
      getDisplaySurface(sale).value ? getDisplaySurface(sale).label : "À confirmer",
    ],
    ["Plafond sans travaux", ceilingWithoutWorksLabel(decision)],
    ["Plafond avec rafraîchissement", ceilingWithRefreshWorksLabel(decision)],
    ["Source à relire", decision.primaryDocument],
  ];

  return (
    <section id="description-ia" className="scroll-mt-28">
      <article className="rounded-lg border border-border bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-gold/25 bg-gold/[0.08] text-gold-soft">
            <Sparkles className="h-5 w-5" />
          </span>
          <div>
            <h2 className="font-display text-2xl font-medium text-brand-navy sm:text-3xl">
              {descriptionLabel}
            </h2>
            <p className="mt-1 text-sm text-brand-navy/62">
              Lecture qualitative du bien, conservée avant les chiffres et les risques.
            </p>
          </div>
        </div>
        <p className="mt-5 text-base leading-relaxed text-brand-navy/78">{displayDescription}</p>
        <dl className="mt-5 grid gap-3 border-t border-border/70 pt-4 sm:grid-cols-2 lg:grid-cols-5">
          {facts.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-[11px] font-semibold uppercase text-brand-navy/54">{label}</dt>
              <dd className="mt-1 truncate text-sm font-semibold text-brand-navy">{value}</dd>
            </div>
          ))}
        </dl>
      </article>
    </section>
  );
}

export function VerdictSection({
  sale,
  decision,
  marketEstimate,
  marketLoading = false,
  marketError = false,
}: {
  sale: AuctionSale;
  decision: DecisionSummary;
  marketEstimate?: MarketEstimate | null;
  marketLoading?: boolean;
  marketError?: boolean;
}) {
  const startPrice = Math.max(0, sale.starting_price_eur ?? 0);
  const spread = decision.ceiling.available ? decision.ceiling.maxBid - startPrice : null;
  const interesting = spread == null || spread >= 0;
  const verdict = interesting ? "Intéressant sous réserve" : "À vérifier avant enchère";
  const reason =
    spread == null
      ? "le plafond reste à compléter avec une référence de marché locale"
      : spread >= 0
        ? "la mise à prix reste nettement inférieure au plafond conseillé"
        : "la mise à prix dépasse le plafond actuellement calculé";
  const chips = [
    ["Potentiel", interesting ? "Intéressant" : "À vérifier"],
    ["Raison", reason],
    ["À surveiller", "Occupation et travaux"],
    ["Décision", "Dossier à étudier avant audience"],
  ];

  return (
    <section id="verdict" className="scroll-mt-28">
      <DecisionPanel icon={<FileCheck2 className="h-5 w-5" />} title="Verdict Immojudis">
        <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
          <div>
            <div className="font-display text-4xl font-medium leading-none text-gold-soft sm:text-5xl">
              {verdict}
            </div>
            <p className="mt-3 text-sm leading-relaxed text-brand-navy/70">
              Verdict Immojudis : intéressant, sous réserve de confirmer l'occupation et les
              travaux.
            </p>
            <p className="mt-3 text-sm leading-relaxed text-brand-navy/70">
              {marketEvidenceSentence(marketEstimate, marketLoading, marketError)}
            </p>
          </div>
          <dl className="grid gap-3 sm:grid-cols-2">
            {chips.map(([label, value]) => (
              <div key={label} className="rounded-lg border border-border bg-white/76 p-4">
                <dt className="text-[11px] font-semibold uppercase text-brand-navy/54">{label}</dt>
                <dd className="mt-2 text-sm font-semibold leading-relaxed text-brand-navy">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </DecisionPanel>
    </section>
  );
}

export function KeyFiguresSection({
  sale,
  decision,
  acquisitionCost,
  marketEstimate,
  marketLoading = false,
  marketError = false,
}: {
  sale: AuctionSale;
  decision: DecisionSummary;
  acquisitionCost: AcquisitionCost;
  marketEstimate?: MarketEstimate | null;
  marketLoading?: boolean;
  marketError?: boolean;
}) {
  const surface = getDisplaySurface(sale);
  const figures = [
    ["Mise à prix", formatPrice(sale.starting_price_eur), "Prix de départ, pas prix final"],
    [
      "Plafond conseillé sans travaux",
      ceilingWithoutWorksLabel(decision),
      "Profil Prudent · marge de sécurité 8 %",
    ],
    [
      "Plafond conseillé avec rafraîchissement",
      ceilingWithRefreshWorksLabel(decision),
      `${formatPrice(decision.refreshWorksBudget)} de travaux à ${REFRESH_WORKS_PRICE_PER_M2} €/m²`,
    ],
    [
      "Prix local de référence",
      marketReferenceValue(marketEstimate, marketLoading, marketError),
      marketEvidenceShort(marketEstimate, marketLoading, marketError),
    ],
    ["Frais estimés", formatPrice(acquisitionCost.acquisitionFeesTotal), "À confirmer au cahier"],
    ["Travaux estimés", formatPrice(acquisitionCost.works), "Chaque euro baisse le plafond"],
    [
      "Consignation",
      sourceBlockMoney(sale, "consignation") ?? "À vérifier",
      "Montant et forme à valider",
    ],
    [surface.metricLabel, surface.value ? surface.label : "À confirmer", "Source dossier"],
    ["Audience", formatDateTime(sale.sale_date), sale.tribunal ?? sale.tribunal_name ?? "Tribunal"],
  ];

  return (
    <section id="figures" className="scroll-mt-28">
      <DecisionSectionHeader title="Les chiffres clés" />
      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {figures.map(([label, value, detail]) => (
          <div key={label} className="rounded-lg border border-border bg-white p-4 shadow-sm">
            <dt className="text-[11px] font-semibold uppercase text-brand-navy/54">{label}</dt>
            <dd className="mt-2 text-lg font-semibold tabular-nums text-brand-navy">{value}</dd>
            <p className="mt-1 text-xs leading-relaxed text-brand-navy/62">{detail}</p>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function PriceChangingRisksSection({
  sale,
  decision,
}: {
  sale: AuctionSale;
  decision: DecisionSummary;
}) {
  const occupationOccurrence = findOccurrence(sale, /occupation|occupe|occupant|bail|locataire/);
  const worksOccurrence = findOccurrence(sale, /travaux|renov|etat|état|ventilation|peinture/);
  const impact = decision.ceiling.available
    ? `Si les travaux augmentent de 10 000 €, votre plafond doit baisser d'environ 10 000 € : ${formatPrice(
        Math.max(0, decision.ceiling.maxBid - 10_000),
      )}.`
    : "Dès que le plafond est calculé, toute hausse de travaux ou de frais doit être retirée de votre enchère maximale.";

  return (
    <section id="risks" className="scroll-mt-28">
      <DecisionSectionHeader title="Les 2 points qui peuvent changer votre enchère" />
      <div className="rounded-lg border border-amber-200 bg-white p-5 shadow-sm">
        <div className="grid gap-4 lg:grid-cols-2">
          <ActionableRiskCard
            icon={<Users className="h-5 w-5" />}
            title="Occupation du bien"
            text="À confirmer dans le PV descriptif. Si le bien est occupé, la récupération peut prendre plus de temps et générer des coûts. Votre plafond doit donc être plus prudent."
            source={occupationOccurrence?.document_label ?? "PV descriptif"}
            excerpt={occupationOccurrence?.excerpt ?? null}
          />
          <ActionableRiskCard
            icon={<TriangleAlert className="h-5 w-5" />}
            title="Travaux à chiffrer"
            text="Chaque euro de travaux réduit votre capacité d'enchère. Avant l'audience, transformez les diagnostics en budget travaux."
            source={worksOccurrence?.document_label ?? "Diagnostics techniques"}
            excerpt={worksOccurrence?.excerpt ?? null}
          />
        </div>
        <div className="mt-5 rounded-lg border border-gold/20 bg-gold/[0.08] p-4">
          <div className="text-sm font-semibold text-brand-navy">Impact sur le plafond</div>
          <p className="mt-1 text-sm leading-relaxed text-brand-navy/72">
            Plafond avec rafraîchissement actuel : {ceilingWithRefreshWorksLabel(decision)}.{" "}
            {impact}
          </p>
        </div>
      </div>
    </section>
  );
}

export function ActionableRiskCard({
  icon,
  title,
  text,
  source,
  excerpt,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
  source: string;
  excerpt: string | null;
}) {
  return (
    <article className="grid gap-3 rounded-lg border border-border bg-muted/20 p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md border border-gold/25 bg-white text-gold-soft">
          {icon}
        </span>
        <h3 className="text-base font-semibold text-brand-navy">{title}</h3>
      </div>
      <p className="text-sm leading-relaxed text-brand-navy/72">{text}</p>
      <div className="rounded-md border border-border bg-white p-3 text-xs leading-relaxed text-brand-navy/62">
        <span className="font-semibold text-brand-navy">Source : {source}.</span>{" "}
        {excerpt ?? "Extrait à relire dans les pièces officielles."}
      </div>
    </article>
  );
}

export function CeilingCalculationSection({
  sale,
  decision,
  acquisitionCost,
  marketEstimate,
  marketLoading = false,
  marketError = false,
}: {
  sale: AuctionSale;
  decision: DecisionSummary;
  acquisitionCost: AcquisitionCost;
  marketEstimate?: MarketEstimate | null;
  marketLoading?: boolean;
  marketError?: boolean;
}) {
  const ceiling = decision.ceiling;
  const surface = getSaleSurface(sale).value;
  const marketReference = marketReferenceValue(marketEstimate, marketLoading, marketError);
  const targetMarket =
    ceiling.available && surface ? formatPrice(ceiling.targetTotalCost) : "À compléter";
  const steps = [
    [
      "Marché local",
      marketReference,
      marketEvidenceShort(marketEstimate, marketLoading, marketError),
    ],
    [
      "Marge de sécurité",
      ceiling.available ? `${ceiling.safetyDiscountPct} %` : "À compléter",
      "Objectif : rester sous le marché local.",
    ],
    ["Valeur cible après marge", targetMarket, "Point de départ du raisonnement."],
    [
      "Frais d'acquisition retirés",
      formatPrice(acquisitionCost.acquisitionFeesTotal),
      "Les frais estimés sont retirés de la valeur cible avant de calculer l'enchère maximale.",
    ],
    [
      "Plafond conseillé sans travaux",
      ceilingWithoutWorksLabel(decision),
      "Référence haute avant toute enveloppe de rénovation.",
    ],
    [
      "Plafond conseillé avec rafraîchissement",
      ceilingWithRefreshWorksLabel(decision),
      `${formatPrice(decision.refreshWorksBudget)} de travaux retirés · ${decision.action}.`,
    ],
  ];

  return (
    <section id="calculation" className="scroll-mt-28">
      <DecisionSectionHeader title="Comment le plafond est calculé" />
      <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr] xl:items-start">
        <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
          <dl className="grid gap-3">
            {steps.map(([label, value, detail], index) => (
              <div
                key={label}
                className="grid gap-3 border-b border-border/70 pb-3 last:border-b-0 last:pb-0 sm:grid-cols-[32px_1fr]"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-navy text-xs font-semibold text-white">
                  {index + 1}
                </div>
                <div>
                  <dt className="text-sm font-semibold text-brand-navy">{label}</dt>
                  <dd className="mt-1 text-xl font-semibold tabular-nums text-brand-navy">
                    {value}
                  </dd>
                  <p className="mt-1 text-xs leading-relaxed text-brand-navy/62">{detail}</p>
                </div>
              </div>
            ))}
          </dl>
          <Dialog>
            <DialogTrigger asChild>
              <button
                type="button"
                className="mt-5 inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-md border border-gold/45 bg-white px-4 py-2 text-sm font-semibold text-gold-soft transition-colors hover:bg-gold/[0.08]"
              >
                Voir la méthode et modifier les hypothèses <ChevronRight className="h-4 w-4" />
              </button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
              <DialogHeader>
                <DialogTitle>Hypothèses du plafond</DialogTitle>
                <DialogDescription>
                  Travaux, frais, marge de sécurité, revente et loyer potentiel.
                </DialogDescription>
              </DialogHeader>
              <AdvancedAssumptionsBlock sale={sale} ceiling={ceiling} />
            </DialogContent>
          </Dialog>
        </div>

        <CeilingSimulatorCard
          sale={sale}
          decision={decision}
          acquisitionCost={acquisitionCost}
          marketEstimate={marketEstimate}
          marketLoading={marketLoading}
          marketError={marketError}
        />
      </div>
    </section>
  );
}

export function CeilingSimulatorCard({
  sale,
  decision,
  acquisitionCost,
  marketEstimate,
  marketLoading = false,
  marketError = false,
}: {
  sale: AuctionSale;
  decision: DecisionSummary;
  acquisitionCost: AcquisitionCost;
  marketEstimate?: MarketEstimate | null;
  marketLoading?: boolean;
  marketError?: boolean;
}) {
  const rows = [
    ["Prix local de référence", marketReferenceValue(marketEstimate, marketLoading, marketError)],
    [
      "Décote visée sur le marché",
      marginTargetLabel(decision, marketEstimate, marketLoading, marketError),
    ],
    ["Frais d'acquisition estimés", formatPrice(acquisitionCost.acquisitionFeesTotal)],
    ["Travaux de rafraîchissement", formatPrice(decision.refreshWorksBudget)],
    ["Plafond conseillé sans travaux", ceilingWithoutWorksLabel(decision)],
    ["Plafond conseillé avec rafraîchissement", ceilingWithRefreshWorksLabel(decision)],
  ];

  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-display text-2xl font-medium text-brand-navy">
            Simuler mon enchère maximum
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-brand-navy/68">
            Ajustez les travaux, frais ou marge de sécurité avant de transmettre une consigne
            d'enchère.
          </p>
        </div>
        <Target className="h-5 w-5 shrink-0 text-gold-soft" />
      </div>
      <dl className="mt-5 divide-y divide-border/70 rounded-lg border border-border bg-muted/20">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[1fr_auto] gap-4 px-4 py-3 text-sm">
            <dt className="text-brand-navy/64">{label}</dt>
            <dd className="font-semibold tabular-nums text-brand-navy">{value}</dd>
          </div>
        ))}
      </dl>
      <Dialog>
        <DialogTrigger asChild>
          <button
            type="button"
            className="mt-5 inline-flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-md bg-gold-soft px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-gold"
          >
            Ajuster mon plafond <ChevronRight className="h-4 w-4" />
          </button>
        </DialogTrigger>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-6xl">
          <DialogHeader>
            <DialogTitle>Ajuster le plafond d'enchère</DialogTitle>
            <DialogDescription>
              Modifiez les hypothèses et relisez le raisonnement détaillé.
            </DialogDescription>
          </DialogHeader>
          <BidCeilingAssistant sale={sale} marketEstimateOverride={marketEstimate} />
        </DialogContent>
      </Dialog>
      <p className="mt-3 text-xs leading-relaxed text-brand-navy/58">
        Le vocabulaire expert et les détails DVF restent disponibles dans la méthode, sans alourdir
        la première lecture.
      </p>
    </div>
  );
}

export function ProofsSection({
  sale,
  decision,
  product,
}: {
  sale: AuctionSale;
  decision: DecisionSummary;
  product: SaleProductSources;
}) {
  const surface = getDisplaySurface(sale);
  const proofs = [
    {
      title: `Pourquoi retenir ${surface.value ? surface.label : "cette surface"} ?`,
      source: "PV descriptif",
      text:
        sale.surface_evidence || "Source prioritaire pour la surface, l'état visible et l'accès.",
      href: "#technical-details",
    },
    {
      title: "Pourquoi l'occupation est un risque ?",
      source: "PV descriptif, page 3",
      text:
        findOccurrence(sale, /occupation|occupe|occupant|bail|locataire/)?.excerpt ??
        "L'occupation peut retarder la récupération du logement et modifier le plafond acceptable.",
      href: "#risks",
    },
    {
      title: "Pourquoi prévoir des travaux ?",
      source: "Diagnostics techniques",
      text:
        findOccurrence(sale, /travaux|renov|etat|état|ventilation|peinture/)?.excerpt ??
        "Les diagnostics et le PV doivent être transformés en budget travaux avant audience.",
      href: "#calculation",
    },
  ];

  return (
    <section id="proofs" className="scroll-mt-28">
      <DecisionSectionHeader title="Les preuves dans le dossier" />
      <div className="grid gap-4 lg:grid-cols-3">
        {proofs.map((proof) => (
          <article
            key={proof.title}
            className="rounded-lg border border-border bg-white p-5 shadow-sm"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-muted/30 text-gold-soft">
              <FileCheck2 className="h-5 w-5" />
            </div>
            <h3 className="mt-4 text-base font-semibold leading-snug text-brand-navy">
              {proof.title}
            </h3>
            <p className="mt-2 text-xs font-semibold uppercase text-gold-soft">
              Source : {proof.source}
            </p>
            <p className="mt-3 text-sm leading-relaxed text-brand-navy/70">{proof.text}</p>
            <a
              href={proof.href}
              className="mt-4 inline-flex items-center gap-2 text-xs font-semibold uppercase text-gold-soft hover:text-gold"
            >
              Relier à la décision <ChevronRight className="h-3.5 w-3.5" />
            </a>
          </article>
        ))}
      </div>
      <div className="mt-4">
        <SourcesAndDocumentsBlock sale={sale} product={product} />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-brand-navy/58">
        Les documents officiels servent de preuves, pas de simple bibliothèque : chaque pièce doit
        confirmer une hypothèse de prix, de risque ou d'action.
      </p>
    </section>
  );
}

export function BeforeAuctionSection({
  sale,
  decision,
  acquisitionCost,
}: {
  sale: AuctionSale;
  decision: DecisionSummary;
  acquisitionCost: AcquisitionCost;
}) {
  const steps = [
    ["Lire le PV descriptif", "Confirmer l'occupation, l'accès et l'état visible du bien."],
    ["Relire les diagnostics", "Transformer les contraintes techniques en budget travaux."],
    ["Vérifier le cahier des conditions", "Contrôler frais, consignation, délais et clauses."],
    [
      "Ajuster votre plafond",
      `Ne pas dépasser ${ceilingWithRefreshWorksLabel(decision)} avec l'hypothèse de rafraîchissement, sans élément nouveau.`,
    ],
  ];

  return (
    <section id="steps" className="scroll-mt-28">
      <DecisionSectionHeader title="Avant d'enchérir, faites ces 4 vérifications" />
      <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
        <ol className="grid gap-4 lg:grid-cols-4">
          {steps.map(([title, text], index) => (
            <li
              key={title}
              className="border-b border-border/70 pb-4 last:border-b-0 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-4 lg:last:border-r-0"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-brand-navy text-sm font-semibold text-white">
                {index + 1}
              </div>
              <h3 className="mt-4 text-sm font-semibold text-brand-navy">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-brand-navy/68">{text}</p>
            </li>
          ))}
        </ol>
        <div className="mt-5 flex flex-wrap gap-3 border-t border-border/70 pt-5">
          <a
            href="#calculation"
            className="inline-flex min-h-11 items-center justify-center rounded-md bg-brand-navy px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-navy/90"
          >
            Ajuster mon plafond maintenant
          </a>
          <Dialog>
            <DialogTrigger asChild>
              <button
                type="button"
                className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-md border border-border bg-white px-4 py-2 text-sm font-semibold text-brand-navy transition-colors hover:border-gold/50 hover:text-gold-soft"
              >
                Questions à poser à l'avocat
              </button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
              <DialogHeader>
                <DialogTitle>Questions à poser à l'avocat</DialogTitle>
                <DialogDescription>
                  Points concrets à clarifier avant de fixer le plafond d'enchère.
                </DialogDescription>
              </DialogHeader>
              <LawyerQuestionsBlock
                sale={sale}
                decision={decision}
                acquisitionCost={acquisitionCost}
              />
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </section>
  );
}

export function FAQSection() {
  const questions = [
    [
      "Pourquoi le prix de départ est-il si bas ?",
      "Parce qu'il s'agit d'une mise à prix judiciaire, pas forcément du prix final.",
    ],
    [
      "Puis-je enchérir à la mise à prix et acheter à ce prix ?",
      "Pas nécessairement. Le prix final dépend des enchères à l'audience.",
    ],
    [
      "Pourquoi fixer un plafond d'enchère ?",
      "Pour éviter de surpayer sous l'effet de la concurrence ou de l'urgence.",
    ],
    [
      "Que se passe-t-il si le bien est occupé ?",
      "La récupération peut être plus longue et le risque doit être intégré au prix.",
    ],
    [
      "Le plafond Immojudis remplace-t-il un avocat ou un professionnel ?",
      "Non. C'est une aide à la décision qui doit être complétée par la lecture des pièces et les conseils adaptés.",
    ],
  ];

  return (
    <section id="faq" className="scroll-mt-28">
      <DecisionSectionHeader title="FAQ" />
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-white shadow-sm">
        {questions.map(([question, answer]) => (
          <details key={question} className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-sm font-semibold text-brand-navy">
              <span>{question}</span>
              <ChevronRight className="h-4 w-4 shrink-0 text-brand-navy/45 transition-transform group-open:rotate-90" />
            </summary>
            <p className="px-5 pb-4 text-sm leading-relaxed text-brand-navy/68">{answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

export function TechnicalDetailsSection({
  sale,
  product,
  documentCount,
}: {
  sale: AuctionSale;
  product: SaleProductSources;
  documentCount: number;
}) {
  const details = [
    ["Identifiant", sale.id],
    ["Source principale", sale.primary_source ?? sale.source_name ?? "À confirmer"],
    ["Latitude", sale.latitude == null ? "À confirmer" : String(sale.latitude)],
    ["Longitude", sale.longitude == null ? "À confirmer" : String(sale.longitude)],
    ["Ajout", formatDateTime(sale.created_at)],
    ["Mise à jour", formatDateTime(sale.updated_at)],
    ["Documents", `${documentCount} pièce${documentCount > 1 ? "s" : ""}`],
  ];

  return (
    <section id="technical-details" className="scroll-mt-28">
      <details className="group rounded-lg border border-border bg-white p-5 shadow-sm">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
          <div>
            <h2 className="font-display text-2xl font-medium text-brand-navy">
              Détails techniques
            </h2>
            <p className="mt-1 text-sm text-brand-navy/62">
              Traçabilité, données brutes et éléments secondaires du dossier.
            </p>
          </div>
          <ChevronRight className="h-5 w-5 shrink-0 text-brand-navy/45 transition-transform group-open:rotate-90" />
        </summary>
        <div className="mt-5 grid gap-5 border-t border-border pt-5 lg:grid-cols-2">
          <dl className="grid gap-3 sm:grid-cols-2">
            {details.map(([label, value]) => (
              <div key={label} className="rounded-md border border-border bg-muted/30 p-3">
                <dt className="text-[11px] font-semibold uppercase text-brand-navy/54">{label}</dt>
                <dd className="mt-1 truncate text-sm font-medium text-brand-navy">{value}</dd>
              </div>
            ))}
          </dl>
          <div>
            <h3 className="text-sm font-semibold text-brand-navy">Données du dossier</h3>
            <div className="mt-3">
              <RedfinPropertyDetailsBlock groups={product.propertyGroups} />
            </div>
          </div>
        </div>
      </details>
    </section>
  );
}

export function DecisionActionRail({
  sale,
  decision,
  acquisitionCost,
  documentCount,
}: {
  sale: AuctionSale;
  decision: DecisionSummary;
  acquisitionCost: AcquisitionCost;
  documentCount: number;
}) {
  const lawyerContact = cleanContactValue(saleLawyerContact(sale));
  const lawyerHref = lawyerContactHref(lawyerContact);

  return (
    <aside className="hidden lg:block">
      <div className="sticky top-32 space-y-4">
        <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
          <div className="text-[11px] font-semibold uppercase text-brand-navy/54">
            Plafonds conseillés · Prudent 8 %
          </div>
          <dl className="mt-3 grid gap-3">
            <div>
              <dt className="text-[10px] uppercase tracking-[0.1em] text-brand-navy/54">
                Sans travaux
              </dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums text-gold-soft">
                {ceilingWithoutWorksLabel(decision)}
              </dd>
            </div>
            <div className="border-t border-border/70 pt-3">
              <dt className="text-[10px] uppercase tracking-[0.1em] text-brand-navy/54">
                Avec rafraîchissement
              </dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums text-gold-soft">
                {ceilingWithRefreshWorksLabel(decision)}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-xs leading-relaxed text-brand-navy/62">
            Rafraîchissement retenu : {formatPrice(decision.refreshWorksBudget)}.{" "}
            {decision.primaryCheck}.
          </p>
          <div className="mt-4 rounded-md border border-border bg-muted/30 p-3">
            <SaleCountdown date={sale.sale_date} variant="block" />
          </div>
          <div className="mt-4 grid gap-2">
            <a
              href="#calculation"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-brand-navy px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-navy/90"
            >
              Ajuster mon plafond
            </a>
            {lawyerHref ? (
              <a
                href={lawyerHref}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border bg-white px-4 py-2 text-sm font-semibold text-brand-navy transition-colors hover:border-gold/50 hover:text-gold-soft"
              >
                Être accompagné par un avocat
              </a>
            ) : (
              <a
                href="#steps"
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border bg-white px-4 py-2 text-sm font-semibold text-brand-navy transition-colors hover:border-gold/50 hover:text-gold-soft"
              >
                Préparer l'avocat
              </a>
            )}
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-border bg-white shadow-sm">
          <FavoriteButton
            saleId={sale.id}
            className="w-full justify-start rounded-none border-0 border-b border-border bg-white px-4 py-3 text-sm shadow-none"
          />
          <button
            type="button"
            onClick={() => void shareCurrentPage(saleDisplayTitle(sale, "Dossier Immojudis"))}
            className="flex min-h-11 w-full cursor-pointer items-center gap-3 border-b border-border px-4 py-3 text-left text-sm font-semibold text-brand-navy hover:bg-muted/30"
          >
            <Share2 className="h-4 w-4 text-gold-soft" />
            Partager le bien
          </button>
          <button
            type="button"
            onClick={printAnalysis}
            className="flex min-h-11 w-full cursor-pointer items-center gap-3 border-b border-border px-4 py-3 text-left text-sm font-semibold text-brand-navy hover:bg-muted/30"
          >
            <Download className="h-4 w-4 text-gold-soft" />
            Imprimer la synthèse
          </button>
          <a
            href="#proofs"
            className="flex min-h-11 w-full items-center gap-3 px-4 py-3 text-sm font-semibold text-brand-navy hover:bg-muted/30"
          >
            <FileCheck2 className="h-4 w-4 text-gold-soft" />
            {documentCount} pièce{documentCount > 1 ? "s" : ""} à relire
          </a>
        </div>

        <div className="rounded-lg border border-gold/25 bg-gold/[0.07] p-4">
          <div className="text-sm font-semibold text-brand-navy">Une question sur ce bien ?</div>
          <p className="mt-1 text-xs leading-relaxed text-brand-navy/66">
            Interrogez le dossier ou préparez les points à transmettre à votre conseil.
          </p>
          <Dialog>
            <DialogTrigger asChild>
              <button
                type="button"
                className="mt-4 inline-flex min-h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-gold/45 bg-white px-3 py-2 text-xs font-semibold text-gold-soft hover:bg-white/80"
              >
                <CircleHelp className="h-4 w-4" />
                Interroger le dossier
              </button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
              <DialogHeader>
                <DialogTitle>Interroger le dossier</DialogTitle>
                <DialogDescription>
                  Questions rapides sourcées par les données de la fiche.
                </DialogDescription>
              </DialogHeader>
              <DossierAssistant sale={sale} cost={acquisitionCost} ceiling={decision.ceiling} />
            </DialogContent>
          </Dialog>
        </div>

        <PropertyReportActions saleId={sale.id} compact />
        {isUuid(sale.id) && (
          <FeaturedLawyerPlacement saleId={sale.id} placementSlot="sale_detail_sticky_lawyer" />
        )}
      </div>
    </aside>
  );
}

export function DecisionPanel({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <article className="rounded-lg border border-border bg-white/92 p-5 shadow-sm">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-muted/30 text-gold-soft">
          {icon}
        </span>
        <h2 className="font-display text-2xl font-medium text-brand-navy sm:text-3xl">{title}</h2>
      </div>
      <div className="mt-4">{children}</div>
    </article>
  );
}

export function DecisionSectionHeader({ title }: { title: string }) {
  return (
    <header className="mb-3">
      <h2 className="font-display text-2xl font-medium leading-tight text-brand-navy sm:text-3xl">
        {title}
      </h2>
    </header>
  );
}

export function shortPropertyLabel(sale: AuctionSale): string {
  if (sale.property_type === "apartment" && sale.rooms_count) return `T${sale.rooms_count}`;
  if (sale.property_type === "house" && sale.rooms_count) return `Maison T${sale.rooms_count}`;
  return propertyTypeLabel(sale.property_type);
}

export function ceilingWithoutWorksLabel(decision: DecisionSummary): string {
  return decision.ceilingWithoutWorks.available
    ? formatPrice(decision.ceilingWithoutWorks.maxBid)
    : "À compléter";
}

export function ceilingWithRefreshWorksLabel(decision: DecisionSummary): string {
  return decision.ceilingWithRefreshWorks.available
    ? formatPrice(decision.ceilingWithRefreshWorks.maxBid)
    : "À compléter";
}

export function marginTargetLabel(
  decision: DecisionSummary,
  marketEstimate?: MarketEstimate | null,
  marketLoading = false,
  marketError = false,
): string {
  if (decision.ceiling.available) return `${decision.ceiling.safetyDiscountPct} %`;
  if (marketLoading) return "calcul en cours";
  if (marketError) return "marché indisponible";
  if (marketEstimate?.medianPricePerM2) return "à ajuster";
  return "à compléter";
}

export function marketReferenceValue(
  marketEstimate?: MarketEstimate | null,
  marketLoading = false,
  marketError = false,
): string {
  if (marketLoading) return "Recherche...";
  if (marketError) return "Indisponible";
  return formatPricePerM2(marketEstimate?.medianPricePerM2);
}

export function marketEvidenceShort(
  marketEstimate?: MarketEstimate | null,
  marketLoading = false,
  marketError = false,
): string {
  if (marketLoading) return "Lecture des comparables en cours.";
  if (marketError) return "Référence locale à vérifier manuellement.";
  if (!marketEstimate) return "Référence à compléter.";
  return `${marketEstimate.sampleSize} vente${marketEstimate.sampleSize > 1 ? "s" : ""} comparable${
    marketEstimate.sampleSize > 1 ? "s" : ""
  } autour du bien.`;
}

export function marketEvidenceSentence(
  marketEstimate?: MarketEstimate | null,
  marketLoading = false,
  marketError = false,
): string {
  if (marketLoading) return "Notre estimation locale est en cours de lecture.";
  if (marketError) return "Notre estimation locale doit être recoupée manuellement pour ce bien.";
  if (!marketEstimate)
    return "Notre estimation sera renforcée dès que les comparables seront disponibles.";
  return `Notre estimation s'appuie sur ${marketEstimate.sampleSize} vente${
    marketEstimate.sampleSize > 1 ? "s" : ""
  } comparable${marketEstimate.sampleSize > 1 ? "s" : ""} autour du bien.`;
}

export function MobileActionBar({
  sale,
  decision,
}: {
  sale: AuctionSale;
  decision: DecisionSummary;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-white/95 px-3 py-2 shadow-[0_-8px_24px_rgb(19_34_56/10%)] backdrop-blur lg:hidden">
      <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <a
          href="#calculation"
          className="min-h-12 min-w-0 rounded-md bg-foreground px-3 py-2 text-xs text-background"
        >
          <span className="block text-[10px] uppercase tracking-[0.12em] text-background/70">
            Plafonds conseillés · Prudent
          </span>
          <span className="mt-1 grid grid-cols-2 gap-2 tabular-nums">
            <span className="min-w-0">
              <span className="block text-[9px] uppercase tracking-wide text-background/65">
                Sans travaux
              </span>
              <strong className="block truncate text-xs">
                {ceilingWithoutWorksLabel(decision)}
              </strong>
            </span>
            <span className="min-w-0 border-l border-background/20 pl-2">
              <span className="block text-[9px] uppercase tracking-wide text-background/65">
                Avec travaux
              </span>
              <strong className="block truncate text-xs">
                {ceilingWithRefreshWorksLabel(decision)}
              </strong>
            </span>
          </span>
        </a>
        <FavoriteButton
          saleId={sale.id}
          className="min-h-12 w-12 justify-center gap-0 px-0 text-[0px] [&_svg]:h-4 [&_svg]:w-4"
        />
      </div>
    </div>
  );
}
