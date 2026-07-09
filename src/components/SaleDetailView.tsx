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
import Rotate3D from "lucide-react/dist/esm/icons/rotate-3d.js";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import Send from "lucide-react/dist/esm/icons/send.js";
import Share2 from "lucide-react/dist/esm/icons/share-2.js";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.js";
import Target from "lucide-react/dist/esm/icons/target.js";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert.js";
import Users from "lucide-react/dist/esm/icons/users.js";
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
import { getDisplaySurface, getSaleSurface } from "@/lib/surface";
import { parseDocs } from "@/lib/documents";
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
  fetchMarketEstimate,
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
  computeMarketCeiling,
  DEFAULTS,
  MARKET_CEILING_SCENARIOS,
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

const SECTION_NAV = [
  { id: "summary", label: "Résumé" },
  { id: "verdict", label: "Verdict" },
  { id: "figures", label: "Chiffres" },
  { id: "risks", label: "Risques" },
  { id: "calculation", label: "Calcul" },
  { id: "proofs", label: "Preuves" },
  { id: "steps", label: "Étapes" },
  { id: "faq", label: "FAQ" },
  { id: "technical-details", label: "Détails" },
] as const;

/**
 * Presentational detail view. Split out from the route so it can be rendered
 * with any AuctionSale (route data, previews, tests). Organised around the maximum
 * bid the investor should not exceed, with sources and context below the decision.
 */
export function SaleDetailView({
  sale,
  marketEstimateOverride,
}: {
  sale: AuctionSale;
  marketEstimateOverride?: MarketEstimate | null;
}) {
  const location = saleLocation(sale.address, sale.postal_code, sale.city);
  const referenceLabel = saleDisplayTitle(sale);
  const saleSurface = getSaleSurface(sale).value;
  const media = saleImages(sale.media);
  const marketQuery = useQuery({
    queryKey: [
      "market-estimate",
      sale.id,
      sale.latitude,
      sale.longitude,
      sale.property_type,
      Math.round(saleSurface ?? 0),
    ],
    queryFn: () =>
      fetchMarketEstimate({
        data: {
          lat: sale.latitude!,
          lng: sale.longitude!,
          propertyType: sale.property_type,
          surfaceM2: saleSurface,
        },
      }),
    enabled:
      marketEstimateOverride == null &&
      sale.latitude != null &&
      sale.longitude != null &&
      saleSurface != null &&
      saleSurface > 0,
    staleTime: 24 * 60 * 60_000,
  });
  const marketEstimate = marketEstimateOverride ?? marketQuery.data?.estimate ?? null;
  const marketLoading = marketEstimateOverride == null && marketQuery.isLoading;
  const marketError =
    marketEstimateOverride == null &&
    Boolean(marketQuery.isError || marketQuery.data?.ok === false);
  const [environmentRequested, setEnvironmentRequested] = useState(
    () => typeof window !== "undefined" && window.location.hash === "#context",
  );
  const environmentalQuery = useQuery({
    queryKey: ["environmental-context", sale.id, location, sale.latitude, sale.longitude],
    queryFn: () =>
      fetchEnvironmentalContext({
        data: {
          address: location,
          lat: sale.latitude,
          lng: sale.longitude,
        },
      }),
    enabled:
      environmentRequested &&
      Boolean(location || (sale.latitude != null && sale.longitude != null)),
    staleTime: 7 * 24 * 60 * 60_000,
  });
  const environmentalContext: EnvironmentalContext | null =
    environmentalQuery.data?.context ?? null;
  const environmentalLoading = environmentalQuery.isLoading;
  const environmentalError = Boolean(
    environmentalQuery.isError || environmentalQuery.data?.ok === false,
  );
  const decision = buildDecisionSummary(sale, marketEstimate);
  const acquisitionCost = computeAcquisitionCosts({
    price: decision.ceiling?.available
      ? decision.ceiling.maxBid
      : Math.max(0, sale.starting_price_eur ?? 0),
    works: DEFAULTS.works,
    fpt: DEFAULTS.fpt,
  });
  const product = buildSaleProductSources({
    sale,
    ceiling: decision.ceiling,
    primaryCheck: decision.primaryCheck,
    primaryDocument: decision.primaryDocument,
    action: decision.action,
    acquisitionCost,
    marketEstimate,
    marketLoading,
    marketError,
    environmentalContext,
    environmentalLoading,
    environmentalError,
  });
  const documentCount = countDocuments(sale);

  return (
    <main className="min-h-screen bg-[#eef7ff] pb-28 text-foreground lg:pb-20">
      <ListingActionBar
        sale={sale}
        title={referenceLabel}
        decision={decision}
        location={location}
      />

      <DecisionHero
        sale={sale}
        title={referenceLabel}
        location={location}
        media={media}
        decision={decision}
        acquisitionCost={acquisitionCost}
        marketEstimate={marketEstimate}
        marketLoading={marketLoading}
        marketError={marketError}
      />

      <div className="mx-auto grid max-w-[1360px] gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_300px] lg:px-8">
        <div className="min-w-0 space-y-6">
          <AiPropertyDescriptionCard sale={sale} decision={decision} />

          <DecisionIntroGrid
            sale={sale}
            decision={decision}
            acquisitionCost={acquisitionCost}
            marketEstimate={marketEstimate}
            marketLoading={marketLoading}
            marketError={marketError}
          />

          <VerdictSection
            sale={sale}
            decision={decision}
            marketEstimate={marketEstimate}
            marketLoading={marketLoading}
            marketError={marketError}
          />

          <KeyFiguresSection
            sale={sale}
            decision={decision}
            acquisitionCost={acquisitionCost}
            marketEstimate={marketEstimate}
            marketLoading={marketLoading}
            marketError={marketError}
          />

          <PriceChangingRisksSection sale={sale} decision={decision} />

          <CeilingCalculationSection
            sale={sale}
            decision={decision}
            acquisitionCost={acquisitionCost}
            marketEstimate={marketEstimate}
            marketLoading={marketLoading}
            marketError={marketError}
          />

          <ProofsSection sale={sale} decision={decision} product={product} />

          <BeforeAuctionSection sale={sale} decision={decision} acquisitionCost={acquisitionCost} />

          <FAQSection />

          <TechnicalDetailsSection sale={sale} product={product} documentCount={documentCount} />
        </div>

        <DecisionActionRail
          sale={sale}
          decision={decision}
          acquisitionCost={acquisitionCost}
          documentCount={documentCount}
        />
      </div>

      <MobileActionBar sale={sale} decision={decision} />
    </main>
  );
}

function ReferenceListingCard({
  sale,
  product,
  title,
  decision,
  acquisitionCost,
}: {
  sale: AuctionSale;
  product: SaleProductSources;
  title: string;
  decision: DecisionSummary;
  acquisitionCost: AcquisitionCost;
}) {
  const displaySurface = getDisplaySurface(sale);
  const mapTitle = product.addressLabel || title;
  const lat = sale.latitude;
  const lng = sale.longitude;
  const hasLocation = lat != null && lng != null;
  const mapHref = hasLocation ? openStreetMapUrl(lat, lng, 16) : "#details";
  const headlineStats = [
    sale.rooms_count != null ? `${sale.rooms_count} pièces` : null,
    sale.bedrooms_count != null ? `${sale.bedrooms_count} ch.` : null,
    displaySurface.value ? displaySurface.label : null,
  ].filter(Boolean);
  const judicialMeta = [
    `Consignation ${sourceBlockMoney(sale, "consignation") ?? "à vérifier"}`,
    `Coût complet estimé ${formatPrice(acquisitionCost.totalCost)}`,
    `Audience ${formatDateTime(sale.sale_date)}`,
  ];

  return (
    <article className="rounded-lg border border-border bg-white p-5 shadow-sm">
      <div className="grid gap-4 sm:grid-cols-[1fr_122px]">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-normal text-foreground">
            <span className="h-2 w-2 rounded-full bg-emerald-700" />
            Vente judiciaire
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Mise à prix
              </div>
              <h1 className="mt-1 text-[28px] font-bold leading-none tracking-normal text-foreground">
                {product.priceLabel}
              </h1>
            </div>
            <span className="rounded-md bg-emerald-50 px-2 py-1 text-sm font-semibold text-emerald-700">
              {decision.ceiling.available
                ? `Plafond estimé ${formatPrice(decision.ceiling.maxBid)}`
                : "Plafond à compléter"}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-lg font-semibold text-foreground">
            {headlineStats.map((stat, index) => (
              <span key={stat}>
                {index > 0 && <span className="mr-2 text-muted-foreground">•</span>}
                {stat}
              </span>
            ))}
          </div>
          <p className="mt-3 text-base leading-relaxed text-foreground">
            {product.addressLabel || product.subtitle}
          </p>
          <p className="mt-4 flex flex-wrap gap-x-2 gap-y-1 border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
            {judicialMeta.map((item, index) => (
              <span key={item}>
                {index > 0 && <span className="mr-2">•</span>}
                {item}
              </span>
            ))}
          </p>
        </div>
        <div className="relative hidden overflow-hidden rounded-md border border-border bg-muted sm:block">
          <MapThumbnail
            lat={sale.latitude}
            lng={sale.longitude}
            zoom={16}
            className="h-full min-h-[122px]"
            alt={mapTitle}
          />
          {hasLocation && (
            <a
              href={mapHref}
              target="_blank"
              rel="noopener noreferrer"
              className="absolute left-2 top-2 z-10 inline-flex min-h-9 items-center rounded-md border border-white/70 bg-white/95 px-2.5 py-1 text-[11px] font-semibold text-foreground shadow-sm backdrop-blur transition-colors hover:bg-white"
              aria-label={`Voir la carte pour ${mapTitle}`}
            >
              Carte
            </a>
          )}
        </div>
      </div>
    </article>
  );
}

function PriorityDecisionCard({
  sale,
  decision,
  acquisitionCost,
}: {
  sale: AuctionSale;
  decision: DecisionSummary;
  acquisitionCost: AcquisitionCost;
}) {
  const documentCount = countDocuments(sale);
  const priorityOccurrence = findOccurrence(
    sale,
    /occupation|occupe|occupant|bail|locataire|travaux|renov|etat|état/,
  );
  const actionHref = primaryActionHref(decision.action);
  const actionLabel = primaryActionLabel(decision.action);
  const facts = [
    {
      label: "Point bloquant",
      value: decision.primaryCheck,
      detail: decision.primaryDocument,
    },
    {
      label: "Plafond à valider",
      value: decision.ceiling.available ? formatPrice(decision.ceiling.maxBid) : "À compléter",
      detail: "Avant consigne à l'avocat",
    },
    {
      label: "Coût complet estimé",
      value: formatPrice(acquisitionCost.totalCost),
      detail: "Frais et hypothèses inclus",
    },
    {
      label: "Pièces disponibles",
      value: String(documentCount),
      detail: "À relire avant audience",
    },
  ];

  return (
    <article className="rounded-lg border border-amber-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <div className="inline-flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-800">
            <TriangleAlert className="h-3.5 w-3.5" />
            Décision à sécuriser
          </div>
          <h2 className="mt-3 text-lg font-semibold leading-tight text-foreground">
            {decision.primaryCheck}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Ce point peut modifier le plafond, le calendrier de possession ou les frais. Il doit
            être confirmé avant de transmettre une consigne d'enchère.
          </p>
        </div>
        <a
          href={actionHref}
          className="inline-flex min-h-11 items-center justify-center rounded-md bg-foreground px-4 py-2 text-sm font-semibold text-background transition-colors hover:bg-foreground/90"
        >
          {actionLabel}
        </a>
      </div>

      <dl className="mt-4 grid gap-2 sm:grid-cols-2">
        {facts.map((fact) => (
          <div key={fact.label} className="rounded-md border border-border bg-muted/30 p-3">
            <dt className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              {fact.label}
            </dt>
            <dd className="mt-1 text-sm font-semibold text-foreground">{fact.value}</dd>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{fact.detail}</p>
          </div>
        ))}
      </dl>

      {priorityOccurrence?.excerpt && (
        <blockquote className="mt-4 border-l-2 border-amber-300 bg-amber-50/60 py-2 pl-3 text-xs leading-relaxed text-muted-foreground">
          <span className="font-semibold text-foreground">
            {priorityOccurrence.document_label ?? decision.primaryDocument} :{" "}
          </span>
          {priorityOccurrence.excerpt}
        </blockquote>
      )}
    </article>
  );
}

function LawyerPreparationCard({
  product,
  sale,
}: {
  product: SaleProductSources;
  sale: AuctionSale;
}) {
  const sourceHref = cleanHref(sale.source_url);
  const lawyerName = saleLawyerName(sale);
  const contact = cleanContactValue(saleLawyerContact(sale));
  const contactHref = lawyerContactHref(contact);

  return (
    <div className="rounded-lg border border-border bg-white p-4 shadow-sm">
      <div className="grid gap-3 sm:grid-cols-[1fr_250px]">
        <RedfinFactList facts={product.openHouseRows} />
        <div className="rounded-md border border-border bg-muted/30 p-3">
          <div className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            Contact source
          </div>
          <div className="mt-2 text-sm font-semibold text-foreground">
            {lawyerName ?? "Avocat à confirmer"}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {contact ?? "Coordonnées à vérifier dans l'annonce ou auprès du greffe."}
          </p>
          <div className="mt-3 grid gap-2">
            {contactHref ? (
              <a
                href={contactHref}
                className="inline-flex items-center justify-center gap-2 rounded-md bg-gold-soft px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-gold"
              >
                Contacter le contact source <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ) : (
              <span className="inline-flex items-center justify-center rounded-md border border-border bg-white px-3 py-2 text-xs font-semibold text-muted-foreground">
                Contact à compléter
              </span>
            )}
            <a
              href={sourceHref ?? "#documents"}
              target={sourceHref && isExternalHref(sourceHref) ? "_blank" : undefined}
              rel={sourceHref && isExternalHref(sourceHref) ? "noopener noreferrer" : undefined}
              className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft"
            >
              Vérifier la source <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      </div>
      <p className="mt-3 border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
        Cette fiche met en avant les coordonnées disponibles dans les sources officielles. La mise
        en relation ImmoJudis utilise un annuaire séparé d'avocats référencés.
      </p>
    </div>
  );
}

function LawyerContactPanel({ sale }: { sale: AuctionSale }) {
  const lawyerName = saleLawyerName(sale);
  const contact = cleanContactValue(saleLawyerContact(sale));
  const contactHref = lawyerContactHref(contact);
  const sourceHref = cleanHref(sale.source_url);
  const questions = lawyerQuestions(sale);

  return (
    <div className="rounded-lg border border-border bg-white p-4 shadow-sm">
      <div className="grid gap-4 sm:grid-cols-[1fr_240px]">
        <div>
          <p className="text-sm leading-relaxed text-foreground">
            Préparez un échange court avec l'avocat poursuivant ou votre avocat adjudication :
            consignation, conditions de vente, occupation, frais particuliers et pièces
            prioritaires.
          </p>
          <dl className="mt-4 grid gap-2 text-sm">
            <CostRow label="Avocat identifié" value={lawyerName ?? "À confirmer"} />
            <CostRow label="Contact" value={contact ?? "À récupérer"} />
            <CostRow
              label="Tribunal"
              value={sale.tribunal ?? sale.tribunal_name ?? "À confirmer"}
            />
          </dl>
        </div>
        <div className="rounded-md border border-border bg-muted/30 p-3">
          <div className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            Actions
          </div>
          <div className="mt-3 grid gap-2">
            {contactHref ? (
              <a
                href={contactHref}
                className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft"
              >
                Contacter le contact source <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ) : (
              <span className="inline-flex items-center justify-center rounded-md border border-border bg-white px-3 py-2 text-xs font-semibold text-muted-foreground">
                Contact à vérifier
              </span>
            )}
            <a
              href={sourceHref ?? "#documents"}
              target={sourceHref && isExternalHref(sourceHref) ? "_blank" : undefined}
              rel={sourceHref && isExternalHref(sourceHref) ? "noopener noreferrer" : undefined}
              className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft"
            >
              Vérifier l'annonce <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            Les contacts source proviennent des annonces collectées. Les avocats référencés
            ImmoJudis seront gérés dans un annuaire séparé.
          </p>
        </div>
      </div>
      <LawyerQuestionsList questions={questions} />
    </div>
  );
}

function LawyerQuestionsBlock({
  sale,
  decision,
  acquisitionCost,
}: {
  sale: AuctionSale;
  decision: DecisionSummary;
  acquisitionCost: AcquisitionCost;
}) {
  return (
    <div className="rounded-lg border border-border bg-white p-4 shadow-sm">
      <dl className="grid gap-3 rounded-md border border-border bg-muted/30 p-3 text-sm sm:grid-cols-2">
        <CostRow label="Audience" value={formatDate(sale.sale_date)} />
        <CostRow label="Tribunal" value={sale.tribunal ?? sale.tribunal_name ?? "À confirmer"} />
        <CostRow
          label="Plafond"
          value={decision.ceiling.available ? formatPrice(decision.ceiling.maxBid) : "À compléter"}
        />
        <CostRow label="Coût complet" value={formatPrice(acquisitionCost.totalCost)} />
      </dl>
      <LawyerQuestionsList questions={lawyerQuestions(sale)} />
    </div>
  );
}

function LawyerQuestionsList({ questions }: { questions: string[] }) {
  return (
    <div className="mt-4 rounded-md border border-border bg-muted/30 p-3">
      <div className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        Questions à préparer
      </div>
      <ul className="mt-3 grid gap-2 text-sm leading-relaxed text-muted-foreground">
        {questions.map((question) => (
          <li key={question} className="flex gap-2">
            <ClipboardCheck className="mt-0.5 h-4 w-4 shrink-0 text-gold-soft" />
            <span>{question}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReferenceInput({
  id,
  label,
  type = "text",
  placeholder,
}: {
  id: string;
  label: string;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label htmlFor={id} className="block">
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <input
        id={id}
        type={type}
        placeholder={placeholder}
        className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
      />
    </label>
  );
}

function RedfinListingHeader({ product, title }: { product: SaleProductSources; title: string }) {
  return (
    <div className="min-w-0">
      <div className="grid gap-5 sm:flex sm:flex-wrap sm:items-end sm:gap-x-8 sm:gap-y-4">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-gold-soft">
            Mise à prix
          </div>
          <div className="mt-1 text-4xl font-bold leading-none tracking-normal text-foreground sm:text-5xl">
            {product.priceLabel}
          </div>
        </div>
        <dl className="grid w-full grid-cols-2 gap-x-5 gap-y-3 sm:flex-1 sm:grid-cols-4">
          {product.mainStats.map((stat) => (
            <div key={stat.label} className="min-w-0">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {stat.label}
              </dt>
              <dd className="mt-1 text-xl font-semibold leading-none text-foreground sm:text-2xl">
                {stat.value}
              </dd>
              {stat.detail && (
                <p className="mt-1 truncate text-xs text-muted-foreground">{stat.detail}</p>
              )}
            </div>
          ))}
        </dl>
      </div>

      <h1 className="mt-5 font-sans text-2xl font-semibold leading-tight text-foreground sm:text-3xl">
        {title}
      </h1>
      <p className="mt-2 flex max-w-3xl items-start gap-2 text-sm leading-relaxed text-muted-foreground">
        <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-gold-soft" />
        <span>{product.addressLabel || product.subtitle}</span>
      </p>
    </div>
  );
}

function ListingNeighborhoodCard({
  sale,
  product,
}: {
  sale: AuctionSale;
  product: SaleProductSources;
}) {
  const lat = sale.latitude;
  const lng = sale.longitude;
  const hasLocation = lat != null && lng != null;
  const mapHref = hasLocation ? openStreetMapUrl(lat, lng, 15) : "#details";

  return (
    <aside className="hidden overflow-hidden rounded-lg border border-border bg-white shadow-sm xl:block">
      <div className="group block">
        <MapThumbnail
          lat={sale.latitude}
          lng={sale.longitude}
          zoom={15}
          className="h-[126px] border-b border-border"
          alt={product.addressLabel || product.subtitle}
        />
        <div className="p-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <MapPin className="h-3.5 w-3.5 text-gold-soft" />
            Quartier
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {product.addressLabel || product.subtitle}
          </p>
          {hasLocation ? (
            <a
              href={mapHref}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex min-h-9 items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-gold-soft hover:text-gold"
            >
              Voir la carte <ChevronRight className="h-3 w-3" />
            </a>
          ) : (
            <a
              href="#details"
              className="mt-2 inline-flex min-h-9 items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-gold-soft hover:text-gold"
            >
              Voir les détails <ChevronRight className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
    </aside>
  );
}

function RedfinTourCard({
  sale,
  decision,
  acquisitionCost,
}: {
  sale: AuctionSale;
  decision: DecisionSummary;
  acquisitionCost: AcquisitionCost;
}) {
  const actionHref = primaryActionHref(decision.action);
  const actionLabel = primaryActionLabel(decision.action);

  return (
    <aside className="hidden rounded-lg border border-border bg-white p-4 shadow-sm lg:sticky lg:top-[7.25rem] lg:block">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gold-soft">
        Action prioritaire
      </div>
      <h2 className="mt-2 text-base font-semibold leading-tight text-foreground">
        {decision.action}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {decision.primaryCheck}. Validez ce point avant de fixer ou transmettre votre plafond.
      </p>
      <a
        href={actionHref}
        className="mt-4 flex min-h-11 w-full items-center justify-center rounded-md bg-foreground px-4 py-3 text-sm font-semibold text-background transition-colors hover:bg-foreground/90"
      >
        {actionLabel}
      </a>
      <a
        href="#offer-insights"
        className="mt-2 flex min-h-11 w-full items-center justify-center rounded-md border border-border bg-white px-4 py-3 text-sm font-semibold text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft"
      >
        Ajuster le plafond
      </a>
      <PropertyReportActions saleId={sale.id} compact />
      <FeaturedLawyerPlacement saleId={sale.id} placementSlot="sale_detail_sticky_lawyer" />
      <div className="mt-4 rounded-md border border-border bg-muted/30 p-3">
        <SaleCountdown date={sale.sale_date} variant="block" />
      </div>
      <Dialog>
        <DialogTrigger asChild>
          <button
            type="button"
            className="mt-4 w-full cursor-pointer border-t border-border pt-4 text-left text-sm font-semibold text-gold-soft transition-colors hover:text-gold"
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
          <LawyerQuestionsBlock sale={sale} decision={decision} acquisitionCost={acquisitionCost} />
        </DialogContent>
      </Dialog>
    </aside>
  );
}

function RedfinStickyRail(props: {
  sale: AuctionSale;
  title: string;
  product: SaleProductSources;
  decision: DecisionSummary;
  acquisitionCost: AcquisitionCost;
}) {
  return (
    <div className="space-y-4">
      <RedfinTourCard {...props} />
      <div className="rounded-lg border border-border bg-white p-4 shadow-sm">
        <div className="text-sm font-semibold text-foreground">Sources de l'annonce</div>
        <dl className="mt-3 grid gap-2">
          {props.product.sourceFacts.map((fact) => (
            <div key={fact.label} className="flex items-baseline justify-between gap-3 text-xs">
              <dt className="text-muted-foreground">{fact.label}</dt>
              <dd className="text-right font-medium text-foreground">{fact.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

function RedfinOverviewPanel({ product }: { product: SaleProductSources }) {
  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
      <RedfinFactGrid facts={product.overviewFacts} />
    </div>
  );
}

function RedfinFactGrid({ facts }: { facts: ProductFact[] }) {
  return (
    <dl className="grid gap-2 sm:grid-cols-2">
      {facts.map((fact) => (
        <div key={fact.label} className="rounded-md border border-border bg-muted/30 p-3">
          <dt className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            {fact.label}
          </dt>
          <dd className="mt-1 text-sm font-semibold tabular-nums text-foreground">{fact.value}</dd>
          {fact.detail && (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{fact.detail}</p>
          )}
        </div>
      ))}
    </dl>
  );
}

function RedfinOpenHousesBlock({ product }: { product: SaleProductSources }) {
  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
      <RedfinFactGrid facts={product.openHouseRows} />
    </div>
  );
}

function RedfinAroundBlock({ product }: { product: SaleProductSources }) {
  return (
    <div className="mt-5 rounded-lg border border-border bg-white p-5 shadow-sm">
      <RedfinFactGrid facts={product.aroundFacts} />
    </div>
  );
}

function RedfinPropertyDetailsBlock({ groups }: { groups: ProductGroup[] }) {
  return (
    <div>
      <div className="grid gap-6 md:grid-cols-2">
        {groups.map((group) => (
          <section key={group.title}>
            <h3 className="text-base font-semibold text-foreground">{group.title}</h3>
            <dl className="mt-3 divide-y divide-border">
              {group.facts.map((fact) => (
                <div
                  key={`${group.title}-${fact.label}`}
                  className="grid grid-cols-[150px_1fr] gap-4 py-2 text-sm"
                >
                  <dt className="text-muted-foreground">{fact.label}</dt>
                  <dd className="font-medium text-foreground">{fact.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}

function RedfinHistoryTable({ rows }: { rows: ProductHistoryRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-white shadow-sm">
      <table className="w-full min-w-[620px] text-left text-sm">
        <thead className="bg-muted/50 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          <tr>
            <th className="px-4 py-3">Événement</th>
            <th className="px-4 py-3">Date</th>
            <th className="px-4 py-3">Prix</th>
            <th className="px-4 py-3">Source</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row, index) => (
            <tr key={`${row.event}-${index}`}>
              <td className="px-4 py-3 font-medium text-foreground">{row.event}</td>
              <td className="px-4 py-3 text-muted-foreground">{row.date}</td>
              <td className="px-4 py-3 tabular-nums text-foreground">{row.amount}</td>
              <td className="px-4 py-3 text-muted-foreground">{row.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RedfinRiskGrid({ risks }: { risks: ProductRisk[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-white shadow-sm">
      {risks.map((risk) => (
        <Dialog key={risk.label}>
          <DialogTrigger asChild>
            <button
              type="button"
              aria-label={`Voir le détail du risque ${risk.label}`}
              className="flex w-full cursor-pointer items-center gap-3 border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-muted/30"
            >
              <RiskToneBadge risk={risk} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-foreground">{risk.label}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                  {risk.detail}
                </span>
                <span className="mt-1 block text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                  Source : {risk.source}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>{risk.label}</DialogTitle>
              <DialogDescription>{risk.detail}</DialogDescription>
            </DialogHeader>
            <dl className="grid gap-3 rounded-md border border-border bg-muted/30 p-4 text-sm">
              <CostRow label="Niveau" value={risk.value} />
              <CostRow label="Source" value={risk.source} />
            </dl>
            <p className="text-sm leading-relaxed text-muted-foreground">
              À traiter avant l'audience : relire la pièce source, vérifier l'impact sur le prix
              plafond et transmettre le point à l'avocat si le risque modifie les conditions
              d'acquisition.
            </p>
          </DialogContent>
        </Dialog>
      ))}
    </div>
  );
}

function RiskToneBadge({ risk }: { risk: ProductRisk }) {
  return (
    <span
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
        risk.tone === "high"
          ? "bg-red-50 text-red-700"
          : risk.tone === "medium"
            ? "bg-amber-50 text-amber-800"
            : risk.tone === "low"
              ? "bg-emerald-50 text-emerald-700"
              : "bg-muted text-muted-foreground"
      }`}
    >
      {risk.value.split(" ")[0]}
    </span>
  );
}

function RedfinInsightsBlock({ product }: { product: SaleProductSources }) {
  return (
    <div className="rounded-lg border border-border bg-white p-4 shadow-sm">
      <RedfinFactGrid facts={product.insightFacts} />
    </div>
  );
}

function RedfinSchoolsBlock({ product }: { product: SaleProductSources }) {
  return (
    <div className="mt-5 rounded-lg border border-border bg-white p-5 shadow-sm">
      <RedfinMiniTabs labels={["Écoles", "Rattachement", "À proximité"]} />
      <h3 className="mt-4 text-lg font-semibold text-foreground">Écoles</h3>
      <RedfinFactList facts={product.schoolFacts} />
    </div>
  );
}

function RedfinLifestyleBlock({ product }: { product: SaleProductSources }) {
  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
      <RedfinMiniTabs labels={["Marche", "Transports", "Vélo"]} />
      <RedfinFactList facts={product.lifestyleFacts} />
    </div>
  );
}

function RedfinPropertyDetailsSection({
  product,
  media,
}: {
  product: SaleProductSources;
  media: SaleMedia[];
}) {
  const preview = media.slice(0, 5);
  const tabs = product.propertyGroups.map((group) => group.title);
  const [activeTab, setActiveTab] = useState(tabs[0] ?? "Détails");
  const visibleGroups = product.propertyGroups.filter((group) => group.title === activeTab);

  return (
    <div className="space-y-3 rounded-lg border border-border bg-white p-4 shadow-sm">
      <RedfinMiniTabs labels={tabs} value={activeTab} onChange={setActiveTab} />
      {preview.length > 0 && (
        <div className="grid grid-cols-5 gap-1 overflow-hidden rounded-md">
          {preview.map((image, index) => (
            <div key={`${image.url}-${index}`}>
              <img
                src={image.url}
                alt={`Vue du bien ${index + 1}`}
                className="aspect-square w-full object-cover"
                loading="lazy"
                referrerPolicy="no-referrer"
              />
              <div className="truncate bg-white py-1 text-center text-[10px] text-muted-foreground">
                Photo {index + 1}
              </div>
            </div>
          ))}
        </div>
      )}
      <RedfinPropertyDetailsBlock
        groups={visibleGroups.length ? visibleGroups : product.propertyGroups}
      />
    </div>
  );
}

function RedfinPublicRecordSection({
  product,
  sale,
}: {
  product: SaleProductSources;
  sale: AuctionSale;
}) {
  const publicRecordFacts = [
    {
      label: "Zonage",
      value: "À vérifier",
      detail: "PLU, servitudes et règlement local",
    },
    {
      label: "Permis",
      value: "À vérifier",
      detail: "Autorisations et travaux connus",
    },
    {
      label: "Fiscalité",
      value: sale.tribunal ?? sale.tribunal_name ?? "Tribunal à confirmer",
      detail: "Source judiciaire",
    },
  ];
  const groups = [
    ...product.publicRecordGroups,
    { title: "Zonage et permis", facts: publicRecordFacts },
  ];
  const [activeTab, setActiveTab] = useState(groups[0]?.title ?? "Dossier public");
  const visibleGroups = groups.filter((group) => group.title === activeTab);

  return (
    <div className="space-y-3 rounded-lg border border-border bg-white p-4 shadow-sm">
      <RedfinMiniTabs
        labels={groups.map((group) => group.title)}
        value={activeTab}
        onChange={setActiveTab}
      />
      <RedfinPropertyDetailsBlock groups={visibleGroups.length ? visibleGroups : groups} />
    </div>
  );
}

function SourcesAndDocumentsBlock({
  sale,
  product,
}: {
  sale: AuctionSale;
  product: SaleProductSources;
}) {
  const links = saleSourceLinks(sale);

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border bg-white p-4 shadow-sm">
        <div className="grid gap-4 sm:grid-cols-[1fr_240px]">
          <dl className="grid gap-2 sm:grid-cols-2">
            {product.sourceFacts.map((fact) => (
              <div key={fact.label} className="rounded-md border border-border bg-muted/30 p-3">
                <dt className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  {fact.label}
                </dt>
                <dd className="mt-1 text-sm font-semibold text-foreground">{fact.value}</dd>
                {fact.detail && (
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {fact.detail}
                  </p>
                )}
              </div>
            ))}
          </dl>
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <div className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Liens source
            </div>
            {links.length > 0 ? (
              <div className="mt-3 grid gap-2">
                {links.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    target={isExternalHref(link.href) ? "_blank" : undefined}
                    rel={isExternalHref(link.href) ? "noopener noreferrer" : undefined}
                    className="inline-flex items-center justify-between gap-2 rounded-md border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft"
                  >
                    <span className="truncate">{link.label}</span>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                  </a>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                Aucun lien source n'est encore attaché à cette annonce.
              </p>
            )}
          </div>
        </div>
      </div>
      <DocumentsWorkspace sale={sale} />
      <EvidenceTrail sale={sale} />
    </div>
  );
}

function RedfinWeatherBlock({ product }: { product: SaleProductSources }) {
  const temperatures = product.weatherMonthly.flatMap((month) =>
    [month.avgLowC, month.avgHighC].filter((value): value is number => value != null),
  );
  const minTemp = temperatures.length ? Math.min(...temperatures) : 0;
  const maxTemp = temperatures.length ? Math.max(...temperatures) : 30;
  const tempRange = Math.max(1, maxTemp - minTemp);
  const hasWeather = temperatures.length > 0;
  const [activeMetric, setActiveMetric] = useState("Température");

  return (
    <div className="rounded-lg border border-border bg-white p-4 shadow-sm">
      <RedfinMiniTabs
        labels={["Température", "Pluie", "Vent"]}
        value={activeMetric}
        onChange={setActiveMetric}
      />
      {activeMetric === "Température" && (
        <>
          <p className="mt-4 text-xs font-semibold text-foreground">
            Moyenne basse et haute des températures
          </p>
          <div className="mt-4 grid h-40 grid-cols-12 gap-2 border-b border-border px-1">
            {product.weatherMonthly.map((month) => {
              const low = month.avgLowC;
              const high = month.avgHighC;
              const bottom = low == null ? 0 : ((low - minTemp) / tempRange) * 92;
              const height =
                low == null || high == null ? 18 : Math.max(12, ((high - low) / tempRange) * 92);
              return (
                <div
                  key={month.label}
                  className="flex h-full min-w-0 flex-col items-center justify-end gap-1"
                >
                  <span className="text-[10px] font-semibold text-muted-foreground">
                    {high == null ? "—" : `${Math.round(high)}°`}
                  </span>
                  <div className="relative h-28 w-5">
                    <span
                      className={`absolute left-1/2 w-3 -translate-x-1/2 rounded-full ${
                        hasWeather ? "bg-foreground" : "bg-muted"
                      }`}
                      style={{ bottom: `${bottom}px`, height: `${height}px` }}
                    />
                  </div>
                  <span className="text-[9px] text-muted-foreground">{month.label}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
      {activeMetric === "Pluie" && (
        <MonthlyMetricList
          months={product.weatherMonthly}
          getValue={(month) => month.avgPrecipitationMm}
          unit="mm"
        />
      )}
      {activeMetric === "Vent" && (
        <MonthlyMetricList
          months={product.weatherMonthly}
          getValue={(month) => month.avgWindKmh}
          unit="km/h"
        />
      )}
      <RedfinFactList facts={product.weatherFacts} />
    </div>
  );
}

function MonthlyMetricList({
  months,
  getValue,
  unit,
}: {
  months: ProductWeatherMonth[];
  getValue: (month: ProductWeatherMonth) => number | null;
  unit: string;
}) {
  return (
    <div className="mt-4 grid gap-2 sm:grid-cols-2">
      {months.slice(0, 12).map((month) => {
        const value = getValue(month);
        return (
          <div
            key={`${month.label}-${unit}`}
            className="flex items-center justify-between border-b border-border py-1 text-[11px]"
          >
            <span className="font-medium text-foreground">{month.label}</span>
            <span className="text-muted-foreground">
              {value == null ? "—" : `${Math.round(value)} ${unit}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function RedfinSunBlock({ product }: { product: SaleProductSources }) {
  const june = product.sunMonthly[5]?.sunshineRatioPct ?? null;
  const december = product.sunMonthly[11]?.sunshineRatioPct ?? null;
  const annual = averageKnownProductMetric(
    product.sunMonthly.map((month) => month.sunshineRatioPct),
  );
  const bars = [
    ["Juin", june],
    ["Décembre", december],
    ["Annuel", annual],
  ] as const;

  return (
    <div className="rounded-lg border border-border bg-white p-4 shadow-sm">
      <p className="text-sm leading-relaxed text-muted-foreground">
        Estimation d'ensoleillement par adresse à partir des séries historiques. L'orientation et
        les ombres précises du bâtiment restent à confirmer par les plans, photos et dossier
        technique.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        {bars.map(([label, value]) => (
          <div key={label}>
            <div className="mb-1 flex justify-between text-xs font-semibold">
              <span>{label}</span>
              <span className="text-gold-soft">{value == null ? "—" : `${value}%`}</span>
            </div>
            <div className="h-8 rounded bg-muted">
              <div
                className="h-full rounded bg-gold"
                style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <RedfinFactList facts={product.sunFacts} />
    </div>
  );
}

function averageKnownProductMetric(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value != null);
  if (known.length === 0) return null;
  return Math.round(known.reduce((sum, value) => sum + value, 0) / known.length);
}

function RedfinPendingBlock({ sale, product }: { sale: AuctionSale; product: SaleProductSources }) {
  return (
    <div className="mb-5 rounded-lg border border-border bg-white p-5 shadow-sm">
      <div className="grid gap-5 lg:grid-cols-[1fr_240px] lg:items-start">
        <div>
          <div className="text-base font-semibold text-foreground">
            Préparation de l'audience en cours
          </div>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Cette fiche est structurée comme une page d'annonce complète : état du dossier, contact
            légal, points à valider et mise plafond avant l'audience.
          </p>
          <RedfinFactList facts={product.agentFacts} />
        </div>
        <a
          href={sale.source_url ?? "#public-record"}
          target={sale.source_url ? "_blank" : undefined}
          rel={sale.source_url ? "noopener noreferrer" : undefined}
          className="inline-flex items-center justify-center rounded-md bg-gold-soft px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-gold"
        >
          Contacter / vérifier la source
        </a>
      </div>
    </div>
  );
}

function RedfinResourcesBlock({ product }: { product: SaleProductSources }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {product.resourceLinks.map((link) => (
        <a
          key={link.label}
          href={link.href}
          className="rounded-lg border border-border bg-white p-4 shadow-sm transition-colors hover:border-gold/50"
        >
          <div className="text-sm font-semibold text-foreground">{link.label}</div>
          <p className="mt-1 text-sm text-muted-foreground">{link.detail}</p>
        </a>
      ))}
    </div>
  );
}

function RedfinFactList({ facts }: { facts: ProductFact[] }) {
  return (
    <dl className="mt-4 divide-y divide-border">
      {facts.map((fact) => (
        <div key={fact.label} className="grid gap-2 py-3 text-sm sm:grid-cols-[150px_1fr]">
          <dt className="font-medium text-muted-foreground">{fact.label}</dt>
          <dd className="font-semibold text-foreground">
            {fact.value}
            {fact.detail && (
              <p className="mt-1 text-xs font-normal leading-relaxed text-muted-foreground">
                {fact.detail}
              </p>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function RedfinMiniTabs({
  labels,
  value,
  onChange,
}: {
  labels: string[];
  value?: string;
  onChange?: (label: string) => void;
}) {
  const [internalValue, setInternalValue] = useState(labels[0] ?? "");
  const selected = value ?? internalValue;
  const active = labels.includes(selected) ? selected : (labels[0] ?? "");
  const select = (label: string) => {
    setInternalValue(label);
    onChange?.(label);
  };

  return (
    <div
      role="tablist"
      className="flex gap-1 overflow-x-auto rounded-lg bg-muted/50 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {labels.map((label) => (
        <button
          key={label}
          type="button"
          role="tab"
          aria-selected={active === label}
          onClick={() => select(label)}
          className={`shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold ${
            active === label
              ? "bg-white text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ListingActionBar({
  sale,
  title,
  decision,
  location,
}: {
  sale: AuctionSale;
  title: string;
  decision: DecisionSummary;
  location: string;
}) {
  return (
    <nav className="sticky top-16 z-40 border-b border-border bg-white/95 backdrop-blur">
      <div className="flex min-h-11 w-full items-center justify-between gap-3 px-4 py-1.5 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/sales"
            className="inline-flex min-h-11 shrink-0 items-center gap-1 text-[11px] font-semibold text-gold-soft hover:text-gold"
          >
            <ChevronRight className="h-3 w-3 rotate-180" />
            Retour
          </Link>
          <div className="hidden items-center gap-4 overflow-x-auto text-[11px] font-semibold text-muted-foreground md:flex">
            {SECTION_NAV.map((s) => (
              <a key={s.id} href={`#${s.id}`} className="shrink-0 hover:text-foreground">
                {s.label}
              </a>
            ))}
          </div>
          <span className="truncate text-[11px] text-muted-foreground md:hidden">
            {location || title}
          </span>
        </div>
        <div className="hidden shrink-0 items-center gap-2 sm:flex">
          <a
            href="#calculation"
            className="inline-flex min-h-11 items-center justify-center rounded-md bg-foreground px-3 py-1.5 text-xs font-semibold text-background transition-colors hover:bg-foreground/90"
          >
            Ajuster mon plafond
          </a>
          <FavoriteButton
            saleId={sale.id}
            className="min-h-11 border border-border bg-white px-3 py-1.5 text-xs shadow-none"
          />
        </div>
      </div>
    </nav>
  );
}

function ListingHeroSummary({
  sale,
  title,
  location,
  surfaceLabel,
  surfaceMetric,
  documentCount,
  decision,
  acquisitionCost,
}: {
  sale: AuctionSale;
  title: string;
  location: string;
  surfaceLabel: string;
  surfaceMetric: string;
  documentCount: number;
  decision: DecisionSummary;
  acquisitionCost: AcquisitionCost;
}) {
  const stats = [
    {
      label: "Plafond recommandé",
      value: decision.ceiling.available ? formatPrice(decision.ceiling.maxBid) : "À compléter",
      detail: "à ne pas dépasser",
      accent: true,
    },
    { label: surfaceMetric, value: surfaceLabel, detail: "surface retenue" },
    {
      label: "Pièces",
      value: sale.rooms_count != null ? String(sale.rooms_count) : "—",
      detail: "donnée source",
    },
    {
      label: "Chambres",
      value: sale.bedrooms_count != null ? String(sale.bedrooms_count) : "—",
      detail: "donnée source",
    },
    {
      label: "Audience",
      value: formatDate(sale.sale_date),
      detail: timeRemainingLabel(sale.sale_date),
    },
    { label: "Occupation", value: occupancyLabel(sale.occupancy_status), detail: "à vérifier" },
    {
      label: "Documents",
      value: `${documentCount}`,
      detail: `pièce${documentCount > 1 ? "s" : ""} disponible${documentCount > 1 ? "s" : ""}`,
    },
    { label: "Coût complet", value: formatPrice(acquisitionCost.totalCost), detail: "simulation" },
  ];

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
            <div className="text-4xl font-semibold leading-none tabular-nums text-foreground sm:text-5xl">
              {formatPrice(sale.starting_price_eur)}
            </div>
            <span className="rounded-full border border-border bg-muted/40 px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Vente judiciaire
            </span>
          </div>
          <h1 className="mt-3 font-sans text-2xl font-semibold leading-tight text-foreground sm:text-3xl">
            {title}
          </h1>
          {location && (
            <p className="mt-2 flex max-w-3xl items-start gap-2 text-sm leading-relaxed text-muted-foreground sm:text-base">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-gold-soft" />
              <span>{location}</span>
            </p>
          )}
        </div>
      </div>

      <dl className="mt-7 grid grid-cols-2 divide-x-0 divide-y divide-border border-y border-border sm:grid-cols-4 sm:divide-x sm:divide-y-0">
        {stats.map((stat) => (
          <ListingStat key={stat.label} {...stat} />
        ))}
      </dl>
    </div>
  );
}

function ListingStat({
  label,
  value,
  detail,
  accent = false,
}: {
  label: string;
  value: string;
  detail: string;
  accent?: boolean;
}) {
  return (
    <div className="min-w-0 px-3 py-4 first:pl-0 sm:last:pr-0">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </dt>
      <dd
        className={`mt-1 truncate text-xl font-semibold tabular-nums ${
          accent ? "text-gold-soft" : "text-foreground"
        }`}
      >
        {value}
      </dd>
      <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function RedfinOverviewGrid({
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
  const marketValue = marketLoading
    ? "Recherche..."
    : marketError
      ? "Indisponible"
      : formatPricePerM2(marketEstimate?.medianPricePerM2);
  const items = [
    ["Mise à prix", formatPrice(sale.starting_price_eur), "Prix de départ"],
    [
      "Plafond Immojudis",
      decision.ceiling.available ? formatPrice(decision.ceiling.maxBid) : "À compléter",
      "Bloc conservé à la place du calculateur",
    ],
    [surface.metricLabel, surface.value ? surface.label : "Non précisée", "Surface retenue"],
    ["Coût complet", formatPrice(acquisitionCost.totalCost), "Frais estimés inclus"],
    ["Marché local", marketValue, "Référence comparable"],
    ["Audience", formatDate(sale.sale_date), timeRemainingLabel(sale.sale_date)],
  ];

  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(([label, value, detail]) => (
          <div key={label} className="rounded-md border border-border bg-muted/30 p-4">
            <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {label}
            </dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">{value}</dd>
            <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
          </div>
        ))}
      </dl>
    </div>
  );
}

function AboutThisSale({
  sale,
  decision,
  acquisitionCost,
}: {
  sale: AuctionSale;
  decision: DecisionSummary;
  acquisitionCost: AcquisitionCost;
}) {
  const displayDescription = getSaleDisplayDescription(sale);
  const descriptionLabel = hasSaleAiDescription(sale)
    ? "Synthèse rédigée par IA"
    : "Description du bien";
  const detailRows = [
    { label: "Type", value: propertyTypeLabel(sale.property_type) },
    { label: "Mise à prix", value: formatPrice(sale.starting_price_eur) },
    { label: "Audience", value: formatDate(sale.sale_date) },
    {
      label: "Plafond",
      value: decision.ceiling.available ? formatPrice(decision.ceiling.maxBid) : "À compléter",
    },
    { label: "Coût complet", value: formatPrice(acquisitionCost.totalCost) },
    { label: "Document", value: decision.primaryDocument },
  ];

  return (
    <div className="rounded-lg border border-border bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start gap-3">
        <div className="inline-flex items-center gap-2 rounded-md border border-gold/20 bg-gold/[0.08] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-gold-soft">
          <Sparkles className="h-3.5 w-3.5" />
          {descriptionLabel}
        </div>
      </div>

      <p className="mt-4 text-sm leading-relaxed text-foreground" aria-live="polite">
        {displayDescription}
      </p>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-4">
        {detailRows.map((row) => (
          <div key={row.label} className="min-w-0">
            <dt className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              {row.label}
            </dt>
            <dd className="mt-1 truncate text-sm font-semibold text-foreground">{row.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
        {decision.action}
      </div>
    </div>
  );
}

function ReviewedByBlock({
  sale,
  decision,
  marketEstimate,
}: {
  sale: AuctionSale;
  decision: DecisionSummary;
  marketEstimate?: MarketEstimate | null;
}) {
  const reviewers = [
    {
      name: "Analyse juridique",
      role: primaryDocumentLabel(sale, decision.primaryCheck),
      detail: `${countDocuments(sale)} pièce${countDocuments(sale) > 1 ? "s" : ""} au dossier`,
    },
    {
      name: "Analyse marché",
      role: marketEstimate?.qualityLabel
        ? `Fiabilité ${marketEstimate.qualityLabel}`
        : "DVF à compléter",
      detail: marketEstimate
        ? `${marketEstimate.sampleSize} comparable${marketEstimate.sampleSize > 1 ? "s" : ""} retenu${marketEstimate.sampleSize > 1 ? "s" : ""}`
        : "Référence locale à confirmer",
    },
    {
      name: "Analyse enchère",
      role: decision.ceiling.available
        ? formatPrice(decision.ceiling.maxBid)
        : "Plafond à compléter",
      detail: decision.action,
    },
  ];

  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
      <div className="grid gap-3 md:grid-cols-3">
        {reviewers.map((reviewer) => (
          <div key={reviewer.name} className="rounded-md border border-border bg-muted/30 p-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-foreground text-sm font-semibold text-background">
              {reviewer.name.slice(8, 9) || "I"}
            </div>
            <div className="mt-3 text-sm font-semibold text-foreground">{reviewer.name}</div>
            <div className="mt-1 text-sm text-muted-foreground">{reviewer.role}</div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{reviewer.detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function OpenHousesBlock({ sale }: { sale: AuctionSale }) {
  const location = sale.tribunal ?? sale.tribunal_name ?? "Tribunal à confirmer";
  const lawyerName = cleanContactValue(saleLawyerName(sale));
  const lawyerContact = cleanContactValue(saleLawyerContact(sale));
  const rows = [
    ["Audience", formatDate(sale.sale_date), location],
    [
      "Avocat",
      lawyerName ?? lawyerContact ?? "À identifier",
      "Identifier le contact avant audience",
    ],
    [
      "Consignation",
      sourceBlockMoney(sale, "consignation") ?? "À vérifier",
      "Montant et forme à valider avec l'avocat",
    ],
  ];

  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
      <div className="grid gap-3 md:grid-cols-3">
        {rows.map(([label, value, detail]) => (
          <div key={label} className="rounded-md border border-border bg-muted/30 p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gold-soft">
              {label}
            </div>
            <div className="mt-2 text-lg font-semibold text-foreground">{value}</div>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{detail}</p>
          </div>
        ))}
      </div>
      <a
        href="#lawyer"
        className="mt-5 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft hover:text-gold"
      >
        Voir la checklist avant audience <ChevronRight className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}

function AroundThisHomeBlock({ sale }: { sale: AuctionSale }) {
  const location = saleLocation(sale.address, sale.postal_code, sale.city) || "Adresse à confirmer";
  const items = [
    ["Adresse", location],
    ["Secteur", [sale.city, sale.department].filter(Boolean).join(" · ") || "À confirmer"],
    ["Transport", "À vérifier sur la carte ou dans le dossier"],
    ["Vie locale", "À recouper avec le marché local et les contraintes du dossier"],
  ];

  return (
    <div className="mt-5 rounded-lg border border-border bg-white p-5 shadow-sm">
      <div className="grid gap-3 md:grid-cols-4">
        {items.map(([label, value]) => (
          <div key={label} className="rounded-md border border-border bg-muted/30 p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {label}
            </div>
            <p className="mt-2 text-sm leading-relaxed text-foreground">{value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function SaleMediaGallery({
  media,
  sale,
  location,
}: {
  media: SaleMedia[];
  sale: AuctionSale;
  location: string;
}) {
  const featured = media[0];
  const thumbnails = media.slice(1, 7);
  const source = featured.source ?? media.find((item) => item.source)?.source;
  const mapLocation = saleMapboxLocation(sale);
  const mapDescription =
    location || [sale.address, sale.postal_code, sale.city].filter(Boolean).join(", ");
  const thumbnailGridClass =
    thumbnails.length <= 1
      ? "hidden h-full grid-cols-1 gap-1 md:grid"
      : thumbnails.length === 2
        ? "hidden h-full grid-cols-2 gap-1 md:grid"
        : thumbnails.length === 3
          ? "hidden h-full grid-cols-3 gap-1 md:grid"
          : "hidden h-full grid-cols-3 grid-rows-2 gap-1 md:grid";

  return (
    <section className="relative mt-3 overflow-hidden rounded-md border border-border bg-muted shadow-sm md:h-[clamp(360px,29vw,548px)]">
      {mapLocation && (
        <div className="absolute left-3 top-3 z-20 flex max-w-[calc(100%-7.5rem)] flex-col items-start gap-2 sm:max-w-none md:bottom-3 md:top-auto md:flex-row md:flex-wrap">
          <MapboxPreviewButton
            mode="aerial3d"
            lat={mapLocation.lat}
            lng={mapLocation.lng}
            label="Vue 3D"
            title="Vue 3D Mapbox"
            description={mapDescription || "Adresse de l'annonce"}
            ariaLabel="Afficher la vue 3D Mapbox de l'annonce"
            icon={Rotate3D}
            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-white/70 bg-white/95 px-3 py-2 text-xs font-semibold text-foreground shadow-sm backdrop-blur transition-colors hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
          />
          <MapboxPreviewButton
            mode="streetLevel"
            lat={mapLocation.lat}
            lng={mapLocation.lng}
            label="Vue rue"
            title="Vue rue Mapbox"
            description={mapDescription || "Adresse de l'annonce"}
            ariaLabel="Afficher la vue rue Mapbox pour l'annonce"
            icon={MapPin}
            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-white/70 bg-white/95 px-3 py-2 text-xs font-semibold text-foreground shadow-sm backdrop-blur transition-colors hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
          />
        </div>
      )}
      <a
        href={featured.url}
        target="_blank"
        rel="noopener noreferrer"
        className="absolute bottom-3 right-3 z-10 inline-flex min-h-11 items-center gap-2 rounded-md border border-white/70 bg-white px-3 py-2 text-xs font-semibold text-foreground shadow-sm transition-colors hover:bg-white/90"
      >
        {media.length} photo{media.length > 1 ? "s" : ""} <Camera className="h-3.5 w-3.5" />
      </a>
      {source && (
        <span className="absolute right-3 top-3 z-10 rounded-md border border-white/60 bg-white/90 px-3 py-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground backdrop-blur">
          Source · {source}
        </span>
      )}
      <div className="flex h-[22rem] snap-x snap-mandatory overflow-x-auto bg-white [-webkit-overflow-scrolling:touch] [scrollbar-width:none] md:hidden [&::-webkit-scrollbar]:hidden">
        {media.map((item, index) => (
          <SaleMediaImage
            key={`${item.url}-${index}`}
            media={item}
            featured={index === 0}
            alt={index === 0 ? "Photo principale du bien" : `Photo ${index + 1} du bien`}
            className="h-full min-w-full shrink-0 snap-center"
          />
        ))}
      </div>
      <div
        className={
          thumbnails.length > 0
            ? "hidden h-full gap-1 bg-white md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
            : "hidden h-full bg-white md:block"
        }
      >
        <SaleMediaImage media={featured} featured alt="Photo principale du bien" />
        {thumbnails.length > 0 && (
          <div className={thumbnailGridClass}>
            {thumbnails.map((item, index) => (
              <SaleMediaImage
                key={`${item.url}-${index}`}
                media={item}
                alt={`Photo ${index + 2} du bien`}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function saleMapboxLocation(sale: AuctionSale): { lat: number; lng: number } | null {
  if (sale.latitude != null && sale.longitude != null) {
    return { lat: sale.latitude, lng: sale.longitude };
  }
  return null;
}

function SaleMediaImage({
  media,
  featured = false,
  alt,
  className,
}: {
  media: SaleMedia;
  featured?: boolean;
  alt: string;
  className?: string;
}) {
  return (
    <a
      href={media.url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "group relative block aspect-[4/3] cursor-pointer overflow-hidden bg-muted md:h-full md:aspect-auto",
        className,
      )}
    >
      <img
        src={media.url}
        alt={alt}
        loading={featured ? "eager" : "lazy"}
        decoding="async"
        referrerPolicy="no-referrer"
        className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.03]"
      />
      <span className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/45 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-white opacity-0 backdrop-blur transition-opacity group-hover:opacity-100">
        Ouvrir <ExternalLink className="h-3 w-3" />
      </span>
    </a>
  );
}

function saleImages(media: AuctionSale["media"] | undefined): SaleMedia[] {
  return propertyImages(media);
}

type DecisionSummary = {
  ceiling: MarketCeilingResult;
  primaryCheck: string;
  primaryDocument: string;
  action: string;
};

type AcquisitionCost = ReturnType<typeof computeAcquisitionCosts>;

function DecisionHero({
  sale,
  title,
  location,
  media,
  decision,
  acquisitionCost,
  marketEstimate,
  marketLoading = false,
  marketError = false,
}: {
  sale: AuctionSale;
  title: string;
  location: string;
  media: SaleMedia[];
  decision: DecisionSummary;
  acquisitionCost: AcquisitionCost;
  marketEstimate?: MarketEstimate | null;
  marketLoading?: boolean;
  marketError?: boolean;
}) {
  const city = sale.city ?? location.split(",").at(-1)?.trim() ?? "ce secteur";
  const propertyLabel = shortPropertyLabel(sale);
  const ceilingLabel = ceilingValueLabel(decision);
  const marginLabel = marginTargetLabel(decision, marketEstimate, marketLoading, marketError);
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
              label="Plafond conseillé"
              value={ceilingLabel}
              detail={decision.ceiling.available ? "À ne pas dépasser" : "Marché à compléter"}
              accent
            />
            <DecisionMetricCard
              icon={<Scale className="h-4 w-4" />}
              label="Marge visée"
              value={marginLabel}
              detail="Sous le marché local"
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

function DecisionMediaFrame({
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
    <div className="min-w-0 rounded-lg border border-white/80 bg-white/85 p-2 shadow-[0_26px_70px_rgba(72,104,132,0.18)]">
      <div className="relative overflow-hidden rounded-md border border-border bg-muted">
        <a href={featured.url} target="_blank" rel="noopener noreferrer" className="block">
          <img
            src={featured.url}
            alt={`Photo principale - ${title}`}
            className="aspect-[16/9] w-full object-cover"
            loading="eager"
            decoding="async"
            referrerPolicy="no-referrer"
          />
        </a>
        <span className="absolute right-3 top-3 rounded-md bg-brand-navy/78 px-3 py-1 text-xs font-semibold text-white">
          1 / {Math.max(media.length, 1)}
        </span>
        {mapLocation && (
          <div className="absolute bottom-3 left-3 flex flex-wrap gap-2">
            <MapboxPreviewButton
              mode="aerial3d"
              lat={mapLocation.lat}
              lng={mapLocation.lng}
              label="Vue 3D"
              title="Vue 3D Mapbox"
              description={mapDescription || "Adresse de l'annonce"}
              ariaLabel="Afficher la vue 3D Mapbox de l'annonce"
              icon={Rotate3D}
              className="inline-flex min-h-10 items-center gap-2 rounded-md border border-white/70 bg-white/95 px-3 py-2 text-xs font-semibold text-foreground shadow-sm backdrop-blur transition-colors hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
            />
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
        <div className="mt-2 grid grid-cols-4 gap-2">
          {thumbnails.map((item, index) => (
            <a
              key={`${item.url}-${index}`}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="overflow-hidden rounded-md border border-border bg-muted"
            >
              <img
                src={item.url}
                alt={`Photo ${index + 2} du bien`}
                className="aspect-[4/3] w-full object-cover transition duration-500 hover:scale-[1.03]"
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
              />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function DecisionMetricCard({
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

function DecisionIntroGrid({
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
              Notre plafond conseillé est de {ceilingValueLabel(decision)} pour rester environ{" "}
              {marginTargetLabel(decision, marketEstimate, marketLoading, marketError)} sous le
              marché local, après prise en compte des frais, des travaux estimés et d'une marge de
              sécurité.
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

function AiPropertyDescriptionCard({
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
    [
      "Plafond conseillé",
      decision.ceiling.available ? formatPrice(decision.ceiling.maxBid) : "À compléter",
    ],
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
        <dl className="mt-5 grid gap-3 border-t border-border/70 pt-4 sm:grid-cols-2 lg:grid-cols-4">
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

function VerdictSection({
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

function KeyFiguresSection({
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
      "Plafond conseillé",
      ceilingValueLabel(decision),
      "Après frais, travaux estimés et marge de sécurité",
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

function PriceChangingRisksSection({
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
            Plafond actuel : {ceilingValueLabel(decision)}. {impact}
          </p>
        </div>
      </div>
    </section>
  );
}

function ActionableRiskCard({
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

function CeilingCalculationSection({
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
      "Frais et travaux retirés",
      formatPrice(acquisitionCost.acquisitionFeesTotal + acquisitionCost.works),
      "Nous retirons les frais et les travaux estimés pour obtenir le montant maximum à enchérir.",
    ],
    ["Plafond d'enchère conseillé", ceilingValueLabel(decision), decision.action],
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

function CeilingSimulatorCard({
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
    ["Travaux estimés", formatPrice(acquisitionCost.works)],
    ["Plafond actuel", ceilingValueLabel(decision)],
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

function ProofsSection({
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

function BeforeAuctionSection({
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
      `Ne pas dépasser ${ceilingValueLabel(decision)} sans élément nouveau.`,
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

function FAQSection() {
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

function TechnicalDetailsSection({
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

function DecisionActionRail({
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
            Plafond conseillé
          </div>
          <div className="mt-2 text-4xl font-semibold tabular-nums text-gold-soft">
            {ceilingValueLabel(decision)}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-brand-navy/62">
            Coût complet simulé : {formatPrice(acquisitionCost.totalCost)}. {decision.primaryCheck}.
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

function DecisionPanel({
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

function DecisionSectionHeader({ title }: { title: string }) {
  return (
    <header className="mb-3">
      <h2 className="font-display text-2xl font-medium leading-tight text-brand-navy sm:text-3xl">
        {title}
      </h2>
    </header>
  );
}

function shortPropertyLabel(sale: AuctionSale): string {
  if (sale.property_type === "apartment" && sale.rooms_count) return `T${sale.rooms_count}`;
  if (sale.property_type === "house" && sale.rooms_count) return `Maison T${sale.rooms_count}`;
  return propertyTypeLabel(sale.property_type);
}

function ceilingValueLabel(decision: DecisionSummary): string {
  return decision.ceiling.available ? formatPrice(decision.ceiling.maxBid) : "À compléter";
}

function marginTargetLabel(
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

function marketReferenceValue(
  marketEstimate?: MarketEstimate | null,
  marketLoading = false,
  marketError = false,
): string {
  if (marketLoading) return "Recherche...";
  if (marketError) return "Indisponible";
  return formatPricePerM2(marketEstimate?.medianPricePerM2);
}

function marketEvidenceShort(
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

function marketEvidenceSentence(
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

function HeroActionCard({
  sale,
  decision,
  acquisitionCost,
  title,
}: {
  sale: AuctionSale;
  decision: DecisionSummary;
  acquisitionCost: AcquisitionCost;
  title: string;
}) {
  const ceilingLabel = decision.ceiling.available
    ? formatPrice(decision.ceiling.maxBid)
    : "À compléter";
  const secondaryClass =
    "inline-flex cursor-pointer items-center justify-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.1em] text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft";

  return (
    <aside className="rounded-lg border border-border bg-surface p-5 shadow-sm">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gold-soft">
        À retenir
      </div>
      <dl className="mt-4 grid gap-3 text-sm">
        <CostRow label="Plafond conseillé" value={ceilingLabel} strong />
        <CostRow label="Coût complet estimé" value={formatPrice(acquisitionCost.totalCost)} />
        <CostRow label="Point à vérifier" value={decision.primaryCheck} />
        <CostRow label="Action suivante" value={decision.action} />
      </dl>
      <a
        href="#offer-insights"
        className="mt-5 flex items-center justify-center gap-2 rounded-md bg-foreground px-4 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-background transition-colors hover:bg-foreground/90"
      >
        Préparer mon enchère <Target className="h-3.5 w-3.5" />
      </a>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <FavoriteButton
          saleId={sale.id}
          className="justify-center border border-border bg-white px-3 py-2"
        />
        <Dialog>
          <DialogTrigger asChild>
            <button type="button" className={secondaryClass}>
              Comparer
            </button>
          </DialogTrigger>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>Comparer cette vente</DialogTitle>
              <DialogDescription>
                Les repères essentiels de cette fiche pour la comparaison.
              </DialogDescription>
            </DialogHeader>
            <ComparisonBlock sale={sale} ceiling={decision.ceiling} cost={acquisitionCost} />
          </DialogContent>
        </Dialog>
        <button
          type="button"
          aria-label="Imprimer ou enregistrer l'analyse"
          onClick={printAnalysis}
          className={secondaryClass}
        >
          Imprimer <Download className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="Partager cette vente"
          onClick={() => void shareCurrentPage(title)}
          className={secondaryClass}
        >
          Partager <Share2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </aside>
  );
}

function QuickStat({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-md border border-border bg-white p-3">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        <span className="text-gold-soft">{icon}</span>
        {label}
      </div>
      <div className="mt-2 truncate text-sm font-semibold tabular-nums text-foreground">
        {value}
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

function QuickDecision({
  sale,
  decision,
  marketEstimate,
  marketLoading = false,
  marketError = false,
  acquisitionCost,
}: {
  sale: AuctionSale;
  decision: DecisionSummary;
  marketEstimate?: MarketEstimate | null;
  marketLoading?: boolean;
  marketError?: boolean;
  acquisitionCost: AcquisitionCost;
}) {
  const ceilingAvailable = decision.ceiling.available;
  const surface = getSaleSurface(sale).value;
  const costPerM2 = surface ? acquisitionCost.totalCost / surface : null;
  const referencePerM2 = marketEstimate?.medianPricePerM2 ?? null;
  const reason = marketLoading
    ? "Lecture de la référence locale DVF en cours."
    : marketError
      ? "Référence locale temporairement indisponible."
      : costPerM2 != null && referencePerM2 != null
        ? costPerM2 <= referencePerM2
          ? "Le coût complet reste sous la référence locale retenue."
          : "Le coût complet dépasse la référence locale retenue."
        : "La référence locale reste à compléter.";
  const rows = [
    {
      label: "Plafond conseillé",
      value: ceilingAvailable ? formatPrice(decision.ceiling.maxBid) : "À compléter",
      detail: "",
    },
    {
      label: "Pourquoi",
      value: reason,
      detail: "",
    },
    {
      label: "Point bloquant",
      value: decision.primaryCheck,
      detail: decision.primaryDocument,
    },
    {
      label: "Prochaine action",
      value: decision.action,
      detail: "Avant de fixer l'enchère.",
    },
  ];

  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm sm:p-6">
      <div className="grid gap-3">
        {rows.map((row) => (
          <div
            key={row.label}
            className="grid gap-2 rounded-md border border-border bg-muted/30 p-4 sm:grid-cols-[180px_1fr]"
          >
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gold-soft">
              {row.label}
            </div>
            <div>
              <div className="text-base font-semibold text-foreground">{row.value}</div>
              {row.detail && (
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{row.detail}</p>
              )}
            </div>
          </div>
        ))}
      </div>
      <a
        href="#offer-insights"
        className="mt-4 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft transition-colors hover:text-gold"
      >
        Voir le détail du raisonnement <ChevronRight className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}

function BidBudgetBlock({
  sale,
  cost,
  ceiling,
  marketEstimate,
  marketLoading = false,
  marketError = false,
}: {
  sale: AuctionSale;
  cost: AcquisitionCost;
  ceiling: MarketCeilingResult;
  marketEstimate?: MarketEstimate | null;
  marketLoading?: boolean;
  marketError?: boolean;
}) {
  const surface = getSaleSurface(sale).value;
  const costPerM2 = surface ? cost.totalCost / surface : null;
  const referenceValue = marketLoading
    ? "Recherche DVF..."
    : marketError
      ? "Indisponible"
      : formatPricePerM2(marketEstimate?.medianPricePerM2);

  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
      <dl className="grid gap-3 text-sm md:grid-cols-2">
        <CostRow
          label="Plafond conseillé"
          value={ceiling.available ? formatPrice(ceiling.maxBid) : "À compléter"}
          strong
        />
        <CostRow label="Mise à prix" value={formatPrice(sale.starting_price_eur)} />
        <CostRow label="Coût complet estimé" value={formatPrice(cost.totalCost)} strong />
        <CostRow label="Référence locale" value={referenceValue} />
        <CostRow label="Coût complet au m²" value={formatPricePerM2(costPerM2)} />
      </dl>
      <Dialog>
        <DialogTrigger asChild>
          <button
            type="button"
            className="mt-5 inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft"
          >
            Modifier les hypothèses <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </DialogTrigger>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Modifier les hypothèses</DialogTitle>
            <DialogDescription>
              Travaux, frais, marge de sécurité, revente et loyer potentiel.
            </DialogDescription>
          </DialogHeader>
          <AdvancedAssumptionsBlock sale={sale} ceiling={ceiling} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function VerificationPoints({
  sale,
  ceiling,
}: {
  sale: AuctionSale;
  ceiling: MarketCeilingResult;
}) {
  const points = buildVerificationPoints(sale);
  const visible = points.slice(0, 4);
  const extra = points.slice(4);
  const unknownOccupation = isUnknownOccupation(sale.occupancy_status);
  const worksRisk = hasWorksRisk(sale);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
        <ul className="divide-y divide-border/60">
          {visible.map((point) => (
            <li
              key={point.label}
              className="grid gap-3 py-4 sm:grid-cols-[1fr_auto] sm:items-start"
            >
              <div>
                <div className="font-medium text-foreground">{point.label}</div>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{point.detail}</p>
              </div>
              <StatusBadge status={point.status} tone={point.tone} />
            </li>
          ))}
        </ul>
        {extra.length > 0 && (
          <details className="mt-3 border-t border-border pt-3">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft">
              Voir tous les points de contrôle
            </summary>
            <ul className="mt-3 divide-y divide-border/60">
              {extra.map((point) => (
                <li
                  key={point.label}
                  className="grid gap-3 py-3 sm:grid-cols-[1fr_auto] sm:items-start"
                >
                  <div>
                    <div className="font-medium text-foreground">{point.label}</div>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                      {point.detail}
                    </p>
                  </div>
                  <StatusBadge status={point.status} tone={point.tone} />
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
          <div className="font-medium text-foreground">Occupation</div>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {unknownOccupation
              ? "Situation non confirmée dans les données. Relire le PV descriptif avant de fixer l'enchère."
              : `${occupancyLabel(sale.occupancy_status)}. Vérifier le titre et le délai de libération dans les pièces.`}
          </p>
          <Dialog>
            <DialogTrigger asChild>
              <button
                type="button"
                className="mt-4 inline-flex cursor-pointer items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft transition-colors hover:text-gold"
              >
                Voir le détail occupation <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
              <DialogHeader>
                <DialogTitle>Occupation</DialogTitle>
                <DialogDescription>Résumé, source et scénarios à vérifier.</DialogDescription>
              </DialogHeader>
              <OccupationBlock sale={sale} ceiling={ceiling} />
            </DialogContent>
          </Dialog>
        </div>

        <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
          <div className="font-medium text-foreground">Travaux</div>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {worksRisk
              ? "Un point travaux est détecté. Il doit devenir une enveloppe chiffrée avant audience."
              : "Aucun poste travaux fiable n'est chiffré. Prévoir une estimation artisan ou une enveloppe prudente."}
          </p>
          <Dialog>
            <DialogTrigger asChild>
              <button
                type="button"
                className="mt-4 inline-flex cursor-pointer items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft transition-colors hover:text-gold"
              >
                Chiffrer les travaux <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
              <DialogHeader>
                <DialogTitle>Travaux à prévoir</DialogTitle>
                <DialogDescription>Postes à chiffrer et éléments détectés.</DialogDescription>
              </DialogHeader>
              <WorksBlock sale={sale} />
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}

function DocumentsWorkspace({ sale }: { sale: AuctionSale }) {
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const canSyncWorkspace = Boolean(user) && isUuid(sale.id);
  const richDocs = sale.documents_rich ?? [];
  const [state, setState] = useLocalState<DocumentWorkspaceState>(
    saleStorageKey(sale.id, "documents-workspace"),
    {
      notes: {},
      readPages: {},
      highlighted: null,
      reviews: {},
    },
  );
  const [remoteHydrated, setRemoteHydrated] = useState(false);
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const workspaceQuery = useQuery({
    queryKey: ["sale-workspace", sale.id],
    queryFn: () => fetchSaleWorkspace({ saleId: sale.id }),
    enabled: canSyncWorkspace,
    staleTime: 30_000,
  });

  useEffect(() => {
    const remoteReviews = workspaceQuery.data?.workspace?.document_reviews;
    if (remoteHydrated || !remoteReviews) return;
    setState((current) =>
      hasDocumentWorkspaceState(current)
        ? current
        : hydrateDocumentReviewState(current, remoteReviews),
    );
    setRemoteHydrated(true);
  }, [remoteHydrated, setState, workspaceQuery.data?.workspace?.document_reviews]);

  async function syncDocumentReviews() {
    if (loading) return;
    if (!user) {
      toast.error("Connectez-vous pour synchroniser les annotations");
      return;
    }
    if (!isUuid(sale.id)) {
      toast.error("Ce dossier d'exemple ne peut pas être synchronisé");
      return;
    }

    setSavingWorkspace(true);
    try {
      await saveSaleWorkspace({
        data: {
          saleId: sale.id,
          documentReviews: buildSaleDocumentReviews(sale, state),
        },
      });
      await queryClient.invalidateQueries({ queryKey: ["sale-workspace", sale.id] });
      toast.success("Annotations synchronisées");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Synchronisation impossible");
    } finally {
      setSavingWorkspace(false);
    }
  }

  function updateReview(
    key: string,
    metadata: DocumentReviewMetadata,
    patch: Partial<SaleWorkspaceDocumentReview>,
  ) {
    setState((current) => updateDocumentWorkspaceReview(current, key, metadata, patch));
  }

  const reviewedCount = countReviewedDocuments(state.reviews);
  const reviewCount = Object.keys(state.reviews).length;
  const actionClass =
    "inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.1em] text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft";
  const syncFooter = (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
      <span className="text-xs text-muted-foreground">
        {reviewedCount}/{Math.max(reviewCount, countDocuments(sale))} pièce
        {Math.max(reviewCount, countDocuments(sale)) > 1 ? "s" : ""} relue
        {reviewedCount > 1 ? "s" : ""}
      </span>
      <button
        type="button"
        onClick={() => void syncDocumentReviews()}
        disabled={savingWorkspace || loading}
        className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-background hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {savingWorkspace ? "Synchronisation..." : "Synchroniser les annotations"}
      </button>
    </div>
  );

  if (richDocs.length === 0) {
    const basicDocs = parseDocs(sale.documents);
    if (basicDocs.length === 0) {
      return (
        <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
          <p className="text-sm text-muted-foreground">Aucune pièce attachée pour le moment.</p>
        </div>
      );
    }

    return (
      <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
        <ul className="divide-y divide-border/60">
          {basicDocs.map((document, index) => {
            const key = `${document.type ?? "document"}:${document.name ?? document.url}`;
            const name = document.name ?? document.url.split("/").pop() ?? `Pièce ${index + 1}`;
            const metadata = {
              documentLabel: name,
              documentType: document.type ?? null,
              documentUrl: document.url,
            };
            const review = enrichDocumentReview(state.reviews[key], metadata);
            return (
              <li
                key={`${document.url}-${index}`}
                className="grid gap-4 py-4 lg:grid-cols-[1fr_auto] lg:items-center"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft">
                      <FileCheck2 className="h-4 w-4" />
                      {documentTypeLabel(document.type)}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {DOCUMENT_REVIEW_STATUS_LABELS[review.status]}
                    </span>
                  </div>
                  <h3 className="mt-2 truncate text-base font-semibold text-foreground">{name}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Pièce à ouvrir pour confirmer les informations sensibles du dossier.
                  </p>
                </div>
                <Dialog>
                  <div className="flex flex-wrap gap-2 lg:justify-end">
                    <a
                      href={document.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={actionClass}
                    >
                      Ouvrir <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                    <DialogTrigger asChild>
                      <button type="button" className={actionClass}>
                        Résumer et annoter
                      </button>
                    </DialogTrigger>
                  </div>
                  <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
                    <DialogHeader>
                      <DialogTitle>{name}</DialogTitle>
                      <DialogDescription>
                        Résumé rapide et note personnelle pour cette pièce.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="rounded-md border border-border bg-muted/30 p-3">
                      <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                        Résumé
                      </div>
                      <p className="mt-2 text-sm leading-relaxed text-foreground">
                        Ouvrir la pièce pour confirmer occupation, conditions, diagnostics ou frais
                        particuliers.
                      </p>
                    </div>
                    <div className="grid gap-3 rounded-md border border-border bg-white p-3 sm:grid-cols-[1fr_auto]">
                      <label className="block">
                        <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                          État
                        </span>
                        <select
                          value={review.status}
                          onChange={(event) =>
                            updateReview(key, metadata, {
                              status: event.target.value as SaleWorkspaceDocumentReviewStatus,
                            })
                          }
                          className="form-input mt-1 h-10 w-full bg-white text-sm"
                        >
                          {Object.entries(DOCUMENT_REVIEW_STATUS_LABELS).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="inline-flex items-center gap-2 self-end text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={review.priority}
                          onChange={(event) =>
                            updateReview(key, metadata, { priority: event.target.checked })
                          }
                          className="h-4 w-4 accent-[var(--gold)]"
                        />
                        Prioritaire
                      </label>
                    </div>
                    <label className="block rounded-md border border-border bg-white p-3">
                      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                        Note personnelle
                      </span>
                      <textarea
                        rows={4}
                        value={review.note || state.notes[key] || ""}
                        onChange={(event) =>
                          updateReview(key, metadata, { note: event.target.value })
                        }
                        className="mt-2 w-full resize-none rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                        placeholder="Point à demander à l'avocat..."
                      />
                    </label>
                    <label className="block rounded-md border border-border bg-white p-3">
                      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                        Question à lever
                      </span>
                      <textarea
                        rows={3}
                        value={review.question}
                        onChange={(event) =>
                          updateReview(key, metadata, { question: event.target.value })
                        }
                        className="mt-2 w-full resize-none rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                        placeholder="Question pour l'avocat ou le greffe..."
                      />
                    </label>
                  </DialogContent>
                </Dialog>
              </li>
            );
          })}
        </ul>
        {syncFooter}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
      <ul className="divide-y divide-border/60">
        {richDocs.map((document, index) => {
          const pages = documentPagesToReview(sale, document);
          const key = documentKey(document);
          const occurrences = documentOccurrences(sale, document);
          const name = document.label ?? document.url.split("/").pop() ?? `Pièce ${index + 1}`;
          const metadata = {
            documentLabel: name,
            documentType: document.document_type ?? document.type ?? null,
            documentUrl: document.url,
          };
          const review = enrichDocumentReview(state.reviews[key], metadata);
          const readCount = Object.keys(state.readPages).filter((pageKey) =>
            pageKey.startsWith(`${key}:`),
          ).length;
          const canEmbedDocument = isEmbeddableDocumentUrl(document.url);

          return (
            <li
              key={`${document.url}-${index}`}
              className="grid gap-4 py-4 lg:grid-cols-[1fr_auto] lg:items-center"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft">
                    <FileCheck2 className="h-4 w-4" />
                    {documentTypeLabel(document.document_type ?? document.type)}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {DOCUMENT_REVIEW_STATUS_LABELS[review.status]}
                  </span>
                </div>
                <h3 className="mt-2 truncate text-base font-semibold text-foreground">{name}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {documentReviewPrompt(document)}
                  {pages ? ` Pages signalées : ${pages}.` : ""}
                  {readCount
                    ? ` ${readCount} page${readCount > 1 ? "s" : ""} relue${readCount > 1 ? "s" : ""}.`
                    : ""}
                </p>
              </div>

              <Dialog>
                <div className="flex flex-wrap gap-2 lg:justify-end">
                  <DialogTrigger asChild>
                    <button type="button" className={actionClass}>
                      {canEmbedDocument ? "Lire et annoter" : "Analyser la source"}{" "}
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                  </DialogTrigger>
                </div>
                <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
                  <DialogHeader>
                    <DialogTitle>{name}</DialogTitle>
                    <DialogDescription>
                      Résumé, lecteur et note personnelle pour cette pièce.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(280px,0.9fr)]">
                    {canEmbedDocument ? (
                      <div className="min-h-[420px] overflow-hidden rounded-lg border border-border bg-muted/30">
                        <iframe
                          title={`Lecteur ${name}`}
                          src={document.url}
                          className="h-[420px] w-full bg-white"
                        />
                      </div>
                    ) : (
                      <div className="flex min-h-[420px] flex-col justify-between rounded-lg border border-border bg-muted/30 p-5">
                        <div>
                          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-gold-soft">
                            <FileCheck2 className="h-5 w-5" />
                          </div>
                          <h3 className="mt-4 text-base font-semibold text-foreground">
                            Source non intégrable
                          </h3>
                          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                            Cette URL pointe vers une page ou une source externe. Ouvrez-la dans un
                            nouvel onglet pour consulter la pièce originale, puis utilisez le résumé
                            et les notes ci-contre.
                          </p>
                        </div>
                        <a
                          href={document.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-5 inline-flex items-center justify-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.1em] text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft"
                        >
                          Ouvrir la source <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </div>
                    )}
                    <div className="space-y-4">
                      <div className="rounded-md border border-border bg-muted/30 p-3">
                        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                          Résumé
                        </div>
                        <p className="mt-2 text-sm leading-relaxed text-foreground">
                          {documentReviewPrompt(document)}
                        </p>
                        {pages && (
                          <p className="mt-2 text-xs text-muted-foreground">
                            Pages signalées : {pages}
                          </p>
                        )}
                      </div>
                      <div className="grid gap-3 rounded-md border border-border bg-white p-3 sm:grid-cols-[1fr_auto]">
                        <label className="block">
                          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                            État
                          </span>
                          <select
                            value={review.status}
                            onChange={(event) =>
                              updateReview(key, metadata, {
                                status: event.target.value as SaleWorkspaceDocumentReviewStatus,
                              })
                            }
                            className="form-input mt-1 h-10 w-full bg-white text-sm"
                          >
                            {Object.entries(DOCUMENT_REVIEW_STATUS_LABELS).map(([value, label]) => (
                              <option key={value} value={value}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="inline-flex items-center gap-2 self-end text-xs text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={review.priority}
                            onChange={(event) =>
                              updateReview(key, metadata, { priority: event.target.checked })
                            }
                            className="h-4 w-4 accent-[var(--gold)]"
                          />
                          Prioritaire
                        </label>
                      </div>
                      <label className="block rounded-md border border-border bg-white p-3">
                        <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                          Note personnelle
                        </span>
                        <textarea
                          rows={4}
                          value={review.note || state.notes[key] || ""}
                          onChange={(event) =>
                            updateReview(key, metadata, { note: event.target.value })
                          }
                          className="mt-2 w-full resize-none rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                          placeholder="Point à demander à l'avocat..."
                        />
                      </label>
                      <label className="block rounded-md border border-border bg-white p-3">
                        <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                          Question à lever
                        </span>
                        <textarea
                          rows={3}
                          value={review.question}
                          onChange={(event) =>
                            updateReview(key, metadata, { question: event.target.value })
                          }
                          className="mt-2 w-full resize-none rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                          placeholder="Question pour l'avocat ou le greffe..."
                        />
                      </label>
                      <div className="space-y-3">
                        {occurrences.length ? (
                          occurrences.map((occurrence, occurrenceIndex) => {
                            const page = occurrence.page_number ?? occurrenceIndex + 1;
                            const pageKey = `${key}:${page}`;
                            return (
                              <div
                                key={`${pageKey}-${occurrenceIndex}`}
                                className={`rounded-md border p-3 ${
                                  state.highlighted === occurrence.excerpt
                                    ? "border-gold/50 bg-gold/[0.08]"
                                    : "border-border bg-muted/30"
                                }`}
                              >
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                                    Page {page}
                                  </span>
                                  <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                                    <input
                                      type="checkbox"
                                      checked={Boolean(state.readPages[pageKey])}
                                      onChange={(event) =>
                                        updateReview(key, metadata, {
                                          status:
                                            event.target.checked && review.status === "todo"
                                              ? "reviewing"
                                              : review.status,
                                          readPages: {
                                            ...review.readPages,
                                            [pageKey]: event.target.checked,
                                          },
                                        })
                                      }
                                      className="h-4 w-4 accent-[var(--gold)]"
                                    />
                                    Page relue
                                  </label>
                                </div>
                                <p className="mt-2 text-sm leading-relaxed text-foreground">
                                  {occurrence.excerpt ?? "Extrait à relire dans la pièce."}
                                </p>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setState((current) => {
                                      const highlightedExcerpt =
                                        current.highlighted === occurrence.excerpt
                                          ? null
                                          : (occurrence.excerpt ?? null);
                                      return updateDocumentWorkspaceReview(current, key, metadata, {
                                        highlightedExcerpt,
                                      });
                                    });
                                  }}
                                  className="mt-3 cursor-pointer text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft hover:text-gold"
                                >
                                  Surligner l'élément sensible
                                </button>
                              </div>
                            );
                          })
                        ) : (
                          <p className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
                            Aucun extrait sensible n'est associé automatiquement à cette pièce.
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            </li>
          );
        })}
      </ul>
      {syncFooter}
    </div>
  );
}

function PreparationBeforeHearing({ sale }: { sale: AuctionSale }) {
  const actions = [
    "Mandater un avocat",
    isUnknownOccupation(sale.occupancy_status) ? "Confirmer l'occupation" : "Relire les conditions",
    "Préparer la consignation",
  ];

  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
      <div className="grid gap-5 lg:grid-cols-[1fr_260px]">
        <div>
          <div className="text-sm font-semibold text-foreground">3 actions restantes</div>
          <ul className="mt-4 grid gap-3">
            {actions.map((action) => (
              <li key={action} className="flex items-start gap-3 text-sm text-muted-foreground">
                <ClipboardCheck className="mt-0.5 h-4 w-4 shrink-0 text-gold-soft" />
                <span>{action}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-md border border-border bg-muted/30 p-4">
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Rappel audience
          </div>
          <div className="mt-2 text-lg font-semibold text-foreground">
            {formatDate(sale.sale_date)}
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            {timeRemainingLabel(sale.sale_date)}
          </div>
        </div>
      </div>
      <Dialog>
        <DialogTrigger asChild>
          <button
            type="button"
            className="mt-5 inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft"
          >
            Voir ma checklist complète <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </DialogTrigger>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Checklist avant audience</DialogTitle>
            <DialogDescription>
              Checklist, statut et rappels synchronisables dans votre dossier.
            </DialogDescription>
          </DialogHeader>
          <SaleAlertsBlock sale={sale} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CostRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${strong ? "font-semibold" : ""}`}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

function StatusBadge({
  status,
  tone,
}: {
  status: string;
  tone: "verified" | "watch" | "missing" | "risk";
}) {
  const className =
    tone === "verified"
      ? "chip chip-verified"
      : tone === "risk"
        ? "chip chip-risk"
        : tone === "missing"
          ? "chip chip-neutral"
          : "chip chip-watch";
  return (
    <span className={`${className} justify-self-start sm:justify-self-end`}>
      <span aria-hidden className="chip-dot" />
      {status}
    </span>
  );
}

type AdvancedAssumptions = {
  works: number;
  lawyerFees: number;
  adjudicationFees: number;
  publicationFees: number;
  otherFees: number;
  safetyMarginPct: number;
  resalePrice: number;
  monthlyRent: number;
  holdingMonths: number;
  totalBudget: number;
};

type StoredNotes = {
  general: string;
  occupation: string;
  works: string;
  market: string;
  privateMode: boolean;
};

type DocumentWorkspaceState = {
  notes: Record<string, string>;
  readPages: Record<string, boolean>;
  highlighted: string | null;
  reviews: SaleWorkspaceDocumentReviews;
};

type DocumentReviewMetadata = Pick<
  SaleWorkspaceDocumentReview,
  "documentLabel" | "documentType" | "documentUrl"
>;

type LocalStateSetter<T> = (next: T | ((current: T) => T)) => void;

function useLocalState<T>(key: string, initialValue: T): [T, LocalStateSetter<T>] {
  const initialSerialized = JSON.stringify(initialValue);
  const [value, setValue] = useState<T>(initialValue);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  useEffect(() => {
    const fallback = JSON.parse(initialSerialized) as T;
    setValue(readLocalState(key, fallback));
    setLoadedKey(key);
  }, [key, initialSerialized]);

  useEffect(() => {
    if (loadedKey !== key || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Local storage can be unavailable in private browsing; the UI remains usable.
    }
  }, [key, loadedKey, value]);

  const update: LocalStateSetter<T> = (next) => {
    setValue((current) =>
      typeof next === "function" ? (next as (current: T) => T)(current) : next,
    );
  };

  return [value, update];
}

function readLocalState<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(fallback) && isRecord(parsed)) return { ...fallback, ...parsed } as T;
    return parsed as T;
  } catch {
    return fallback;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function saleStorageKey(saleId: string, scope: string): string {
  return `immojudis:sale:${saleId}:${scope}`;
}

function hasStoredNotes(notes: StoredNotes): boolean {
  return Boolean(
    notes.general.trim() || notes.occupation.trim() || notes.works.trim() || notes.market.trim(),
  );
}

function hasSelectedRecord(values: Record<string, boolean>): boolean {
  return Object.values(values).some(Boolean);
}

function hasDocumentWorkspaceState(state: DocumentWorkspaceState): boolean {
  return Boolean(
    Object.keys(state.reviews).length ||
    Object.values(state.notes).some((note) => note.trim()) ||
    Object.values(state.readPages).some(Boolean) ||
    state.highlighted,
  );
}

function hydrateDocumentReviewState(
  current: DocumentWorkspaceState,
  reviews: SaleWorkspaceDocumentReviews,
): DocumentWorkspaceState {
  const notes = { ...current.notes };
  const readPages = { ...current.readPages };
  let highlighted = current.highlighted;

  Object.entries(reviews).forEach(([key, review]) => {
    if (review.note && !notes[key]) notes[key] = review.note;
    Object.assign(readPages, review.readPages);
    if (!highlighted && review.highlightedExcerpt) highlighted = review.highlightedExcerpt;
  });

  return {
    ...current,
    notes,
    readPages,
    highlighted,
    reviews,
  };
}

function enrichDocumentReview(
  review: SaleWorkspaceDocumentReview | undefined,
  metadata: DocumentReviewMetadata,
): SaleWorkspaceDocumentReview {
  return {
    ...DEFAULT_DOCUMENT_REVIEW,
    ...review,
    ...metadata,
    readPages: {
      ...DEFAULT_DOCUMENT_REVIEW.readPages,
      ...(review?.readPages ?? {}),
    },
  };
}

function updateDocumentWorkspaceReview(
  current: DocumentWorkspaceState,
  key: string,
  metadata: DocumentReviewMetadata,
  patch: Partial<SaleWorkspaceDocumentReview>,
): DocumentWorkspaceState {
  const previous = enrichDocumentReview(current.reviews[key], metadata);
  const status = patch.status ?? previous.status;
  const reviewedAt =
    patch.reviewedAt !== undefined
      ? patch.reviewedAt
      : status === "reviewed"
        ? (previous.reviewedAt ?? new Date().toISOString())
        : previous.reviewedAt;
  const nextReview: SaleWorkspaceDocumentReview = {
    ...previous,
    ...patch,
    ...metadata,
    status,
    reviewedAt,
    readPages: {
      ...previous.readPages,
      ...(patch.readPages ?? {}),
    },
  };

  return {
    notes:
      patch.note !== undefined
        ? {
            ...current.notes,
            [key]: patch.note,
          }
        : current.notes,
    readPages: patch.readPages ? { ...current.readPages, ...patch.readPages } : current.readPages,
    highlighted:
      patch.highlightedExcerpt !== undefined ? patch.highlightedExcerpt : current.highlighted,
    reviews: {
      ...current.reviews,
      [key]: nextReview,
    },
  };
}

function buildSaleDocumentReviews(
  sale: AuctionSale,
  state: DocumentWorkspaceState,
): SaleWorkspaceDocumentReviews {
  const reviews: SaleWorkspaceDocumentReviews = { ...state.reviews };
  const mergeReview = (key: string, metadata: DocumentReviewMetadata) => {
    const existing = enrichDocumentReview(reviews[key], metadata);
    reviews[key] = {
      ...existing,
      note: state.notes[key] ?? existing.note,
      readPages: {
        ...existing.readPages,
        ...documentReadPagesForKey(state.readPages, key),
      },
    };
  };

  const richDocs = sale.documents_rich ?? [];
  if (richDocs.length) {
    richDocs.forEach((document, index) => {
      const name = document.label ?? document.url.split("/").pop() ?? `Pièce ${index + 1}`;
      mergeReview(documentKey(document), {
        documentLabel: name,
        documentType: document.document_type ?? document.type ?? null,
        documentUrl: document.url,
      });
    });
    return reviews;
  }

  parseDocs(sale.documents).forEach((document, index) => {
    const name = document.name ?? document.url.split("/").pop() ?? `Pièce ${index + 1}`;
    mergeReview(`${document.type ?? "document"}:${document.name ?? document.url}`, {
      documentLabel: name,
      documentType: document.type ?? null,
      documentUrl: document.url,
    });
  });

  return reviews;
}

function documentReadPagesForKey(
  readPages: Record<string, boolean>,
  documentKeyValue: string,
): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(readPages).filter(([pageKey]) => pageKey.startsWith(`${documentKeyValue}:`)),
  );
}

function countReviewedDocuments(reviews: SaleWorkspaceDocumentReviews): number {
  return Object.values(reviews).filter((review) => review.status === "reviewed").length;
}

function parsePositiveNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function signedAmount(value: number): string {
  const rounded = Math.round(value);
  return `${rounded >= 0 ? "+" : "-"}${formatPrice(Math.abs(rounded))}`;
}

function riskOccurrences(sale: AuctionSale): SaleRiskOccurrence[] {
  return (sale.risks ?? []).flatMap((risk) => risk.occurrences ?? []);
}

function documentKey(document: SaleDocumentRich): string {
  return [document.document_type ?? document.type, document.label, document.url]
    .filter(Boolean)
    .join(":");
}

function documentOccurrences(sale: AuctionSale, document: SaleDocumentRich): SaleRiskOccurrence[] {
  const documentType = document.document_type ?? document.type;
  return riskOccurrences(sale).filter((occurrence) => {
    const sameType = documentType && occurrence.document_type === documentType;
    const sameLabel = document.label && occurrence.document_label === document.label;
    const sameUrl = document.url && occurrence.document_url === document.url;
    return Boolean(sameType || sameLabel || sameUrl);
  });
}

function ScenarioCard({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-md border border-border bg-white p-3">
      <div className="text-sm font-semibold text-foreground">{title}</div>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{text}</p>
    </div>
  );
}

function AdvancedAssumptionsBlock({
  sale,
  ceiling,
}: {
  sale: AuctionSale;
  ceiling: MarketCeilingResult;
}) {
  const [assumptions, setAssumptions] = useLocalState<AdvancedAssumptions>(
    saleStorageKey(sale.id, "advanced-assumptions"),
    {
      works: DEFAULTS.works,
      lawyerFees: 0,
      adjudicationFees: 0,
      publicationFees: 0,
      otherFees: 0,
      safetyMarginPct: DEFAULTS.safetyDiscountPct,
      resalePrice: 0,
      monthlyRent: 0,
      holdingMonths: 0,
      totalBudget: 0,
    },
  );
  const extraFees = assumptions.lawyerFees + assumptions.adjudicationFees + assumptions.otherFees;
  const simulatedCost = computeAcquisitionCosts({
    price: ceiling.available ? ceiling.maxBid : Math.max(0, sale.starting_price_eur ?? 0),
    works: assumptions.works,
    fpt: DEFAULTS.fpt + extraFees,
  });
  const safetyReserve = Math.round(simulatedCost.totalCost * (assumptions.safetyMarginPct / 100));
  const adjustedTotal = simulatedCost.totalCost + safetyReserve;
  const resaleMargin = assumptions.resalePrice ? assumptions.resalePrice - adjustedTotal : null;

  const update = (key: keyof AdvancedAssumptions, value: number) =>
    setAssumptions((current) => ({ ...current, [key]: Math.max(0, value || 0) }));

  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        <MoneyField
          label="Budget travaux"
          value={assumptions.works}
          onChange={(v) => update("works", v)}
        />
        <MoneyField
          label="Frais d'avocat"
          value={assumptions.lawyerFees}
          onChange={(v) => update("lawyerFees", v)}
        />
        <MoneyField
          label="Frais d'adjudication"
          value={assumptions.adjudicationFees}
          onChange={(v) => update("adjudicationFees", v)}
        />
        <MoneyField
          label="Frais divers"
          value={assumptions.otherFees}
          onChange={(v) => update("otherFees", v)}
        />
        <MoneyField
          label="Prix de revente estimé"
          value={assumptions.resalePrice}
          onChange={(v) => update("resalePrice", v)}
        />
        <MoneyField
          label="Loyer potentiel mensuel"
          value={assumptions.monthlyRent}
          onChange={(v) => update("monthlyRent", v)}
        />
      </div>
      <label className="mt-4 block">
        <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Marge de sécurité souhaitée : {assumptions.safetyMarginPct}%
        </span>
        <input
          type="range"
          min={0}
          max={40}
          value={assumptions.safetyMarginPct}
          onChange={(event) => update("safetyMarginPct", Number(event.target.value))}
          className="mt-2 w-full accent-[var(--gold)]"
        />
      </label>
      <dl className="mt-5 grid gap-3 rounded-lg border border-border bg-muted/30 p-4 text-sm md:grid-cols-3">
        <CostRow label="Coût complet ajusté" value={formatPrice(adjustedTotal)} strong />
        <CostRow label="Marge de sécurité" value={formatPrice(safetyReserve)} />
        <CostRow label="Frais personnalisés" value={formatPrice(extraFees)} />
        <CostRow
          label="Marge à la revente"
          value={resaleMargin == null ? "À compléter" : signedAmount(resaleMargin)}
        />
        <CostRow
          label="Loyer potentiel"
          value={assumptions.monthlyRent ? formatPrice(assumptions.monthlyRent) : "À compléter"}
        />
        <CostRow
          label="Plafond actuel"
          value={ceiling.available ? formatPrice(ceiling.maxBid) : "À compléter"}
        />
      </dl>
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        Ce plafond dépend des hypothèses de travaux, frais, occupation, documents et marché. Il doit
        être validé avec les professionnels compétents avant toute enchère.
      </p>
    </div>
  );
}

function MoneyField({
  label,
  value,
  onChange,
  suffix = "€",
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  suffix?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="mt-1 flex items-center rounded-md border border-border bg-white focus-within:ring-1 focus-within:ring-ring">
        <input
          type="number"
          min={0}
          inputMode="decimal"
          value={value || ""}
          onChange={(event) => onChange(Number(event.target.value))}
          className="w-full bg-transparent px-3 py-2 text-sm tabular-nums outline-none"
        />
        <span className="pr-3 text-xs text-muted-foreground">{suffix}</span>
      </div>
    </label>
  );
}

function OccupationBlock({ sale, ceiling }: { sale: AuctionSale; ceiling: MarketCeilingResult }) {
  const occurrence = riskOccurrences(sale).find((item) =>
    `${item.document_type ?? ""} ${item.excerpt ?? ""}`.toLowerCase().includes("occupation"),
  );
  const unknown = isUnknownOccupation(sale.occupancy_status);
  const adjusted = ceiling.available ? Math.max(0, ceiling.maxBid - 8_000) : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
      <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
        <dl className="grid gap-3 text-sm">
          <CostRow label="Statut actuel" value={occupancyLabel(sale.occupancy_status)} strong />
          <CostRow label="Source consultée" value={primaryDocumentLabel(sale, "occupation")} />
          <CostRow
            label="Information disponible"
            value={unknown ? "Non précisée ou partielle" : "À vérifier dans les pièces"}
          />
          <CostRow
            label="Impact plafond"
            value={adjusted == null ? "À compléter" : `Prudence : ${formatPrice(adjusted)}`}
          />
        </dl>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          Impact potentiel : délai de libération, travaux différés, absence de jouissance immédiate
          et coût de sortie. Faire confirmer la situation avant audience.
        </p>
      </div>
      <div className="rounded-lg border border-border bg-muted/30 p-5">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft">
          Extrait et scénarios
        </div>
        <blockquote className="mt-3 rounded-md border border-border bg-white p-3 text-sm leading-relaxed text-foreground">
          {occurrence?.excerpt ??
            "Aucun extrait d'occupation n'est relié à ce dossier. Relire le PV descriptif avant décision."}
        </blockquote>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <ScenarioCard
            title="Si le bien est libre"
            text="Hypothèse favorable : prise de possession plus simple, travaux et revente/location plus prévisibles."
          />
          <ScenarioCard
            title="Si le bien est occupé"
            text="Prévoir délai, coût de sortie et impossibilité de travaux immédiats dans le plafond."
          />
        </div>
      </div>
    </div>
  );
}

function WorksBlock({ sale }: { sale: AuctionSale }) {
  const [budgets, setBudgets] = useLocalState<Record<string, number>>(
    saleStorageKey(sale.id, "works-budgets"),
    {},
  );
  const categories = [
    "Peinture",
    "Sols",
    "Électricité",
    "Plomberie",
    "Cuisine",
    "Salle de bain",
    "Menuiseries",
    "Chauffage",
    "Copropriété",
    "Parties communes",
  ];
  const total = categories.reduce((sum, category) => sum + (budgets[category] || 0), 0);
  const high = Math.round(total * 1.25);
  const low = Math.round(total * 0.85);
  const worksRisks = (sale.risks ?? []).filter((risk) =>
    `${risk.risk_label ?? ""} ${risk.risk_type ?? ""}`
      .toLowerCase()
      .match(/travaux|renov|etat|état/),
  );

  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
      <div className="grid gap-3 md:grid-cols-3">
        <QuickStat
          icon={<TriangleAlert className="h-4 w-4" />}
          label="Hypothèse basse"
          value={formatPrice(low)}
          detail="À confirmer devis"
        />
        <QuickStat
          icon={<BadgeEuro className="h-4 w-4" />}
          label="Hypothèse médiane"
          value={formatPrice(total)}
          detail="Budget saisi"
        />
        <QuickStat
          icon={<TriangleAlert className="h-4 w-4" />}
          label="Hypothèse haute"
          value={formatPrice(high)}
          detail="Marge travaux +25%"
        />
      </div>
      <div className="mt-5 grid gap-3 md:grid-cols-2">
        {categories.map((category) => (
          <MoneyField
            key={category}
            label={category}
            value={budgets[category] || 0}
            onChange={(value) => setBudgets((current) => ({ ...current, [category]: value }))}
          />
        ))}
      </div>
      <div className="mt-5 rounded-lg border border-border bg-muted/30 p-4">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Éléments détectés
        </div>
        {worksRisks.length ? (
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            {worksRisks.map((risk) => (
              <li key={risk.risk_type}>
                {risk.risk_label || risk.risk_type} : {risk.evidence ?? "à relire dans les pièces"}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            Aucun poste travaux fiable n'est encore détecté. Ajouter des devis ou une estimation
            artisan avant l'audience.
          </p>
        )}
      </div>
    </div>
  );
}

function MarketLocalSection({
  sale,
  marketEstimate,
  marketLoading = false,
  marketError = false,
}: {
  sale: AuctionSale;
  marketEstimate?: MarketEstimate | null;
  marketLoading?: boolean;
  marketError?: boolean;
}) {
  const [filters, setFilters] = useLocalState(saleStorageKey(sale.id, "market-filters"), {
    distance: "rayon actuel",
    period: "6 ans",
    surface: "surface proche",
  });
  const transactions = marketEstimate?.recentTransactions ?? [];
  const lat = sale.latitude;
  const lng = sale.longitude;
  const hasLocation = lat != null && lng != null;
  const mapHref = hasLocation ? openStreetMapUrl(lat, lng, 16) : null;
  const excluded = marketEstimate
    ? Math.max(0, marketEstimate.totalNearbySampleSize - marketEstimate.sampleSize)
    : 0;
  const missingLabel = marketLoading
    ? "Recherche DVF..."
    : marketError
      ? "Indisponible"
      : "À compléter";
  const range =
    marketEstimate?.p25PricePerM2 && marketEstimate.p75PricePerM2
      ? `${formatPricePerM2(marketEstimate.p25PricePerM2)} à ${formatPricePerM2(
          marketEstimate.p75PricePerM2,
        )}`
      : missingLabel;
  const referenceValue = marketEstimate?.medianPricePerM2
    ? formatPricePerM2(marketEstimate.medianPricePerM2)
    : missingLabel;
  const sampleValue = marketEstimate
    ? String(marketEstimate.sampleSize)
    : marketLoading
      ? "Recherche..."
      : marketError
        ? "Indisponible"
        : "À compléter";
  const dialogDescription = marketLoading
    ? "Lecture des ventes DVF proches en cours."
    : marketError
      ? "L'estimation DVF est temporairement indisponible."
      : `${excluded} vente${excluded > 1 ? "s" : ""} exclue${
          excluded > 1 ? "s" : ""
        } de l'échantillon retenu.`;

  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
      <dl className="grid gap-3 text-sm md:grid-cols-2">
        <CostRow label="Référence retenue" value={referenceValue} strong />
        <CostRow label="Fourchette observée" value={range} />
        <CostRow label="Transactions DVF retenues" value={sampleValue} />
        <CostRow
          label="Méthode"
          value="Ventes proches, surfaces similaires, biens atypiques exclus"
        />
      </dl>
      <Dialog>
        <DialogTrigger asChild>
          <button
            type="button"
            className="mt-5 inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft"
          >
            Voir les transactions DVF <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </DialogTrigger>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Transactions DVF du marché local</DialogTitle>
            <DialogDescription>{dialogDescription}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 md:grid-cols-3">
            <FilterSelect
              label="Distance"
              value={filters.distance}
              values={["rayon actuel", "100 m", "300 m", "1 km"]}
              onChange={(distance) => setFilters((current) => ({ ...current, distance }))}
            />
            <FilterSelect
              label="Période"
              value={filters.period}
              values={["6 ans", "3 ans", "12 mois"]}
              onChange={(period) => setFilters((current) => ({ ...current, period }))}
            />
            <FilterSelect
              label="Surface"
              value={filters.surface}
              values={[
                "surface proche",
                "toutes surfaces",
                "surface inférieure",
                "surface supérieure",
              ]}
              onChange={(surface) => setFilters((current) => ({ ...current, surface }))}
            />
          </div>
          <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_1.2fr]">
            <div className="rounded-lg border border-border bg-muted/30 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Carte du secteur
              </div>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                {hasLocation
                  ? "Ouvrir la carte pour inspecter le secteur autour de l'adresse."
                  : "Coordonnées manquantes : carte indisponible pour ce dossier."}
              </p>
              {mapHref && (
                <a
                  href={mapHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-4 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft hover:text-gold"
                >
                  Ouvrir la carte <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/50 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Surface</th>
                    <th className="px-3 py-2">Prix</th>
                    <th className="px-3 py-2">Prix/m²</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {transactions.length ? (
                    transactions.slice(0, 6).map((transaction, index) => (
                      <tr key={`${transaction.date}-${index}`}>
                        <td className="px-3 py-2 text-muted-foreground">
                          {formatDate(transaction.date)}
                        </td>
                        <td className="px-3 py-2">
                          {transaction.surface ? `${Math.round(transaction.surface)} m²` : "—"}
                        </td>
                        <td className="px-3 py-2 tabular-nums">
                          {formatPrice(transaction.totalPrice)}
                        </td>
                        <td className="px-3 py-2 tabular-nums">
                          {formatPricePerM2(transaction.pricePerM2)}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={4} className="px-3 py-4 text-sm text-muted-foreground">
                        {marketLoading
                          ? "Lecture des transactions DVF en cours."
                          : marketError
                            ? "Estimation DVF temporairement indisponible."
                            : "Les transactions DVF détaillées apparaîtront quand l'estimation DVF sera disponible."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  values,
  onChange,
}: {
  label: string;
  value: string;
  values: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
      >
        {values.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
    </label>
  );
}

function DossierAssistant({
  sale,
  cost,
  ceiling,
}: {
  sale: AuctionSale;
  cost: AcquisitionCost;
  ceiling: MarketCeilingResult;
}) {
  const questions = [
    "Le bien est-il occupé ?",
    "Quels documents relire en priorité ?",
    "Quels frais prévoir ?",
    "Quels éléments peuvent modifier mon plafond ?",
    "Quels points demander à l'avocat ?",
    "Quels travaux sont mentionnés ?",
    "Quel est le coût complet estimé ?",
    "À quel prix l'opération devient moins intéressante ?",
  ];
  const [question, setQuestion] = useState(questions[0]);
  const answer = answerDossierQuestion(question, sale, cost, ceiling);

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <div className="rounded-lg border border-border bg-white p-4 shadow-sm">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft">
          Questions rapides
        </div>
        <div className="mt-3 grid gap-2">
          {questions.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setQuestion(item)}
              className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                item === question
                  ? "border-gold/50 bg-gold/[0.08] text-foreground"
                  : "border-border bg-white text-muted-foreground hover:border-gold/40 hover:text-foreground"
              }`}
            >
              {item}
            </button>
          ))}
        </div>
      </div>
      <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft">
          Réponse sourcée
        </div>
        <h3 className="mt-2 text-lg font-semibold text-foreground">{question}</h3>
        <p className="mt-3 text-sm leading-relaxed text-foreground">{answer.text}</p>
        <div className="mt-4 rounded-md border border-border bg-muted/30 p-3 text-sm">
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Source
          </div>
          <p className="mt-2 text-muted-foreground">{answer.source}</p>
          {answer.excerpt && (
            <blockquote className="mt-2 text-foreground">{answer.excerpt}</blockquote>
          )}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          L'assistant aide à lire le dossier ; il ne remplace pas la validation par l'avocat, le
          courtier ou l'artisan.
        </p>
      </div>
    </div>
  );
}

function NotesAndSharingBlock({ sale }: { sale: AuctionSale }) {
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const canSyncWorkspace = Boolean(user) && isUuid(sale.id);
  const [notes, setNotes] = useLocalState<StoredNotes>(saleStorageKey(sale.id, "notes"), {
    general: "",
    occupation: "",
    works: "",
    market: "",
    privateMode: true,
  });
  const [remoteHydrated, setRemoteHydrated] = useState(false);
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const workspaceQuery = useQuery({
    queryKey: ["sale-workspace", sale.id],
    queryFn: () => fetchSaleWorkspace({ saleId: sale.id }),
    enabled: canSyncWorkspace,
    staleTime: 30_000,
  });
  const inviteText = `Peux-tu vérifier ce dossier Immojudis ? ${saleDisplayTitle(sale, "Vente judiciaire")} - ${typeof window !== "undefined" ? window.location.href : ""}`;

  useEffect(() => {
    const remoteNotes = workspaceQuery.data?.workspace?.private_notes;
    if (remoteHydrated || !remoteNotes) return;
    setNotes((current) =>
      hasStoredNotes(current)
        ? current
        : {
            ...current,
            general: remoteNotes.general,
            occupation: remoteNotes.occupation,
            works: remoteNotes.works,
            market: remoteNotes.market,
            privateMode: remoteNotes.privateMode,
          },
    );
    setRemoteHydrated(true);
  }, [remoteHydrated, setNotes, workspaceQuery.data?.workspace?.private_notes]);

  async function syncNotes() {
    if (loading) return;
    if (!user) {
      toast.error("Connectez-vous pour synchroniser ce dossier");
      return;
    }
    if (!isUuid(sale.id)) {
      toast.error("Ce dossier d'exemple ne peut pas être synchronisé");
      return;
    }

    setSavingWorkspace(true);
    try {
      await saveSaleWorkspace({
        data: {
          saleId: sale.id,
          trackingStatus: "reviewing",
          privateNotes: {
            general: notes.general,
            occupation: notes.occupation,
            works: notes.works,
            market: notes.market,
            privateMode: notes.privateMode,
          },
        },
      });
      await queryClient.invalidateQueries({ queryKey: ["sale-workspace", sale.id] });
      toast.success("Notes synchronisées");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Synchronisation impossible");
    } finally {
      setSavingWorkspace(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_0.9fr]">
      <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft">
            Notes personnelles
          </div>
          <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={notes.privateMode}
              onChange={(event) =>
                setNotes((current) => ({ ...current, privateMode: event.target.checked }))
              }
              className="h-4 w-4 accent-[var(--gold)]"
            />
            Notes privées
          </label>
        </div>
        <div className="mt-4 grid gap-3">
          <NoteField
            label="Note générale"
            value={notes.general}
            onChange={(general) => setNotes((current) => ({ ...current, general }))}
          />
          <NoteField
            label="Occupation"
            value={notes.occupation}
            onChange={(occupation) => setNotes((current) => ({ ...current, occupation }))}
          />
          <NoteField
            label="Travaux"
            value={notes.works}
            onChange={(works) => setNotes((current) => ({ ...current, works }))}
          />
          <NoteField
            label="Marché local"
            value={notes.market}
            onChange={(market) => setNotes((current) => ({ ...current, market }))}
          />
        </div>
        <button
          type="button"
          onClick={() => downloadText(`notes-${sale.id}.txt`, notesToText(sale, notes))}
          className="mt-4 inline-flex items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-foreground hover:border-gold/50 hover:text-gold-soft"
        >
          Exporter les notes <Download className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void syncNotes()}
          disabled={savingWorkspace || loading}
          className="ml-2 mt-4 inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-background hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {savingWorkspace ? "Synchronisation..." : "Synchroniser"}
        </button>
      </div>
      <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft">
          Partage privé
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Préparez un message à transmettre à un avocat, associé, artisan ou courtier.
        </p>
        <div className="mt-4 grid gap-2">
          {[
            "Inviter un avocat",
            "Inviter un associé",
            "Inviter un artisan",
            "Inviter un courtier",
          ].map((label) => (
            <button
              key={label}
              type="button"
              onClick={() => void copyText(`${label} : ${inviteText}`)}
              className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-foreground transition-colors hover:border-gold/50"
            >
              <span>{label}</span>
              <Share2 className="h-3.5 w-3.5 text-gold-soft" />
            </button>
          ))}
        </div>
        <textarea
          readOnly
          value={inviteText}
          className="mt-4 h-24 w-full resize-none rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
        />
      </div>
    </div>
  );
}

function NoteField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <textarea
        rows={3}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full resize-none rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        placeholder="Ajouter une note..."
      />
    </label>
  );
}

function SaleAlertsBlock({ sale }: { sale: AuctionSale }) {
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const canSyncWorkspace = Boolean(user) && isUuid(sale.id);
  const alertOptions = [
    "Rappel avant audience",
    "Rappel contact avocat",
    "Ajout d'un document",
    "Modification de la date",
    "Modification de la mise à prix",
    "Information d'occupation ajoutée",
    "Nouvelle vente similaire dans le secteur",
    "Changement sur les hypothèses de marché",
    "Rappel pour transmettre les consignes à l'avocat",
  ];
  const [alerts, setAlerts] = useLocalState<Record<string, boolean>>(
    saleStorageKey(sale.id, "sale-alerts"),
    {},
  );
  const [checklist, setChecklist] = useLocalState<Record<string, boolean>>(
    saleStorageKey(sale.id, "sale-checklist"),
    {},
  );
  const [trackingStatus, setTrackingStatus] = useLocalState<SaleWorkspaceStatus>(
    saleStorageKey(sale.id, "tracking-status"),
    "watching",
  );
  const [userMaxBid, setUserMaxBid] = useLocalState<string>(
    saleStorageKey(sale.id, "user-max-bid"),
    "",
  );
  const [nextAction, setNextAction] = useLocalState<string>(
    saleStorageKey(sale.id, "next-action"),
    "",
  );
  const [remoteHydrated, setRemoteHydrated] = useState(false);
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const workspaceQuery = useQuery({
    queryKey: ["sale-workspace", sale.id],
    queryFn: () => fetchSaleWorkspace({ saleId: sale.id }),
    enabled: canSyncWorkspace,
    staleTime: 30_000,
  });

  useEffect(() => {
    const workspace = workspaceQuery.data?.workspace;
    if (remoteHydrated || !workspace) return;
    setAlerts((current) =>
      hasSelectedRecord(current) ? current : { ...current, ...workspace.alert_preferences },
    );
    setChecklist((current) =>
      hasSelectedRecord(current) ? current : { ...current, ...workspace.checklist },
    );
    setTrackingStatus(workspace.tracking_status);
    setUserMaxBid(
      workspace.user_max_bid_eur == null ? "" : String(Math.round(workspace.user_max_bid_eur)),
    );
    setNextAction(workspace.next_action ?? "");
    setRemoteHydrated(true);
  }, [
    remoteHydrated,
    setAlerts,
    setChecklist,
    setNextAction,
    setTrackingStatus,
    setUserMaxBid,
    workspaceQuery.data?.workspace,
  ]);

  const selectedChecklistCount = DEFAULT_SALE_CHECKLIST.filter((item) => checklist[item]).length;

  async function syncWorkspace() {
    if (loading) return;
    if (!user) {
      toast.error("Connectez-vous pour synchroniser ce dossier");
      return;
    }
    if (!isUuid(sale.id)) {
      toast.error("Ce dossier d'exemple ne peut pas être synchronisé");
      return;
    }

    setSavingWorkspace(true);
    try {
      await saveSaleWorkspace({
        data: {
          saleId: sale.id,
          trackingStatus,
          userMaxBidEur: parsePositiveNumber(userMaxBid),
          checklist,
          alertPreferences: alerts,
          nextAction: nextAction.trim() || null,
        },
      });
      await queryClient.invalidateQueries({ queryKey: ["sale-workspace", sale.id] });
      toast.success("Suivi du dossier synchronisé");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Synchronisation impossible");
    } finally {
      setSavingWorkspace(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
      <div className="grid gap-3 rounded-md border border-border bg-muted/30 p-3 md:grid-cols-3">
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Statut
          </span>
          <select
            value={trackingStatus}
            onChange={(event) => setTrackingStatus(event.target.value as SaleWorkspaceStatus)}
            className="form-input mt-1 h-10 w-full bg-white text-sm"
          >
            {Object.entries(SALE_WORKSPACE_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <MoneyField
          label="Plafond personnel"
          value={Number(userMaxBid) || 0}
          onChange={(value) => setUserMaxBid(value ? String(Math.round(value)) : "")}
        />
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Prochaine action
          </span>
          <input
            value={nextAction}
            onChange={(event) => setNextAction(event.target.value)}
            className="mt-1 h-10 w-full rounded-md border border-border bg-white px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
            placeholder="Appeler l'avocat"
          />
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft">
          Checklist avant audience
        </div>
        <span className="text-xs font-medium text-muted-foreground">
          {selectedChecklistCount}/{DEFAULT_SALE_CHECKLIST.length} validé
        </span>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {DEFAULT_SALE_CHECKLIST.map((label) => (
          <label
            key={label}
            className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 p-3 text-sm"
          >
            <span className="font-medium text-foreground">{label}</span>
            <input
              type="checkbox"
              checked={Boolean(checklist[label])}
              onChange={(event) =>
                setChecklist((current) => ({ ...current, [label]: event.target.checked }))
              }
              className="h-4 w-4 accent-[var(--gold)]"
            />
          </label>
        ))}
      </div>

      <div className="mt-5 text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft">
        Rappels et changements
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {alertOptions.map((label) => (
          <label
            key={label}
            className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 p-3 text-sm"
          >
            <span className="font-medium text-foreground">{label}</span>
            <input
              type="checkbox"
              checked={Boolean(alerts[label])}
              onChange={(event) =>
                setAlerts((current) => ({ ...current, [label]: event.target.checked }))
              }
              className="h-4 w-4 accent-[var(--gold)]"
            />
          </label>
        ))}
      </div>
      <button
        type="button"
        onClick={() => void syncWorkspace()}
        disabled={savingWorkspace || loading}
        className="mt-4 inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-background hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {savingWorkspace ? "Synchronisation..." : "Synchroniser le suivi"}
      </button>

      <WorkspaceCollaborationPanel sale={sale} />
    </div>
  );
}

function WorkspaceCollaborationPanel({ sale }: { sale: AuctionSale }) {
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const canUseRemote = Boolean(user) && isUuid(sale.id);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"viewer" | "commenter" | "editor">("commenter");
  const [annotationBody, setAnnotationBody] = useState("");
  const [savingInvite, setSavingInvite] = useState(false);
  const [savingAnnotation, setSavingAnnotation] = useState(false);

  const collaborationQuery = useQuery({
    queryKey: ["sale-workspace-collaboration", sale.id],
    queryFn: () => fetchSaleWorkspaceCollaboration({ saleId: sale.id }),
    enabled: canUseRemote,
    staleTime: 30_000,
  });

  const collaboration = collaborationQuery.data;
  const collaborationLocked =
    collaboration?.plan.features.workspaceCollaboration === "locked" ||
    collaboration?.plan.limits.workspaceCollaborators === 0;
  const annotations = collaboration?.annotations ?? [];
  const collaborators = collaboration?.collaborators ?? [];

  async function refreshCollaboration() {
    await queryClient.invalidateQueries({ queryKey: ["sale-workspace-collaboration", sale.id] });
    await queryClient.invalidateQueries({ queryKey: ["sale-workspace", sale.id] });
  }

  async function inviteCollaborator(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    if (!user) {
      toast.error("Connectez-vous pour inviter un collaborateur");
      return;
    }
    if (!isUuid(sale.id)) {
      toast.error("Ce dossier d'exemple ne peut pas être partagé");
      return;
    }

    setSavingInvite(true);
    try {
      await inviteSaleWorkspaceCollaboratorClient({
        data: {
          saleId: sale.id,
          invitedEmail: inviteEmail,
          role: inviteRole,
        },
      });
      setInviteEmail("");
      await refreshCollaboration();
      toast.success("Invitation ajoutée");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Invitation impossible");
    } finally {
      setSavingInvite(false);
    }
  }

  async function createAnnotation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    if (!user) {
      toast.error("Connectez-vous pour annoter ce dossier");
      return;
    }
    if (!isUuid(sale.id)) {
      toast.error("Ce dossier d'exemple ne peut pas être annoté");
      return;
    }

    setSavingAnnotation(true);
    try {
      await createSaleWorkspaceAnnotationClient({
        data: {
          saleId: sale.id,
          targetKind: "general",
          body: annotationBody,
        },
      });
      setAnnotationBody("");
      await refreshCollaboration();
      toast.success("Annotation ajoutée");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Annotation impossible");
    } finally {
      setSavingAnnotation(false);
    }
  }

  async function resolveAnnotation(annotationId: string) {
    try {
      await updateSaleWorkspaceAnnotationClient({
        data: {
          annotationId,
          status: "resolved",
        },
      });
      await refreshCollaboration();
      toast.success("Annotation résolue");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Mise à jour impossible");
    }
  }

  return (
    <div className="mt-5 border-t border-border/70 pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft">
            <Users className="h-4 w-4" />
            Collaboration
          </div>
          <div className="mt-1 text-sm font-medium text-foreground">
            {collaboration?.role === "owner"
              ? "Dossier propriétaire"
              : collaboration?.role
                ? `Accès ${collaboration.role}`
                : "Dossier non partagé"}
          </div>
        </div>
        <span className="rounded-full border border-border bg-white px-2 py-1 text-xs font-medium text-muted-foreground">
          {collaborators.length} membre{collaborators.length > 1 ? "s" : ""}
        </span>
      </div>

      {collaborationLocked ? (
        <div className="mt-4 text-sm text-muted-foreground">
          Collaboration disponible avec le plan Investisseur / Marchand.
        </div>
      ) : null}

      <form
        onSubmit={(event) => void inviteCollaborator(event)}
        className="mt-4 grid gap-3 md:grid-cols-[1fr_150px_auto]"
      >
        <input
          type="email"
          value={inviteEmail}
          onChange={(event) => setInviteEmail(event.target.value)}
          className="h-10 rounded-md border border-border bg-white px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
          placeholder="email@exemple.fr"
          disabled={savingInvite || loading || collaborationLocked}
        />
        <select
          value={inviteRole}
          onChange={(event) => setInviteRole(event.target.value as typeof inviteRole)}
          className="form-input h-10 bg-white text-sm"
          disabled={savingInvite || loading || collaborationLocked}
        >
          <option value="viewer">Lecture</option>
          <option value="commenter">Commentaire</option>
          <option value="editor">Édition</option>
        </select>
        <button
          type="submit"
          disabled={savingInvite || loading || collaborationLocked || !inviteEmail.trim()}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-foreground px-3 text-xs font-semibold uppercase tracking-[0.12em] text-background hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Send className="h-3.5 w-3.5" />
          Inviter
        </button>
      </form>

      {collaborators.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {collaborators.slice(0, 8).map((collaborator) => (
            <span
              key={collaborator.id}
              className="rounded-full border border-border bg-white px-2 py-1 text-xs text-muted-foreground"
            >
              {collaborator.invited_email} · {collaborator.role} · {collaborator.status}
            </span>
          ))}
        </div>
      ) : null}

      <form onSubmit={(event) => void createAnnotation(event)} className="mt-4">
        <label className="block">
          <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            <MessageSquare className="h-3.5 w-3.5" />
            Annotation partagée
          </span>
          <textarea
            value={annotationBody}
            onChange={(event) => setAnnotationBody(event.target.value)}
            className="mt-2 min-h-24 w-full resize-none rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            placeholder="Point à vérifier avant audience..."
            disabled={savingAnnotation || loading || collaborationLocked}
          />
        </label>
        <button
          type="submit"
          disabled={savingAnnotation || loading || collaborationLocked || !annotationBody.trim()}
          className="mt-2 inline-flex items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-foreground hover:border-gold/50 hover:text-gold-soft disabled:cursor-not-allowed disabled:opacity-60"
        >
          Ajouter l'annotation
        </button>
      </form>

      {annotations.length ? (
        <ul className="mt-4 divide-y divide-border/70 border-y border-border/70">
          {annotations.slice(0, 5).map((annotation) => (
            <li key={annotation.id} className="p-3">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm leading-relaxed text-foreground">{annotation.body}</p>
                <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                  {annotation.status}
                </span>
              </div>
              {annotation.status === "open" ? (
                <button
                  type="button"
                  onClick={() => void resolveAnnotation(annotation.id)}
                  className="mt-2 text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft hover:text-gold"
                >
                  Marquer résolu
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ComparisonBlock({
  sale,
  ceiling,
  cost,
}: {
  sale: AuctionSale;
  ceiling: MarketCeilingResult;
  cost: AcquisitionCost;
}) {
  const { user, loading } = useAuth();
  const [comparison, setComparison] = useLocalState<string[]>("immojudis:comparison-list", []);
  const [savingAnalysis, setSavingAnalysis] = useState(false);
  const included = comparison.includes(sale.id);
  const comparisonSaleIds = (included ? comparison : [...comparison, sale.id])
    .filter(isUuid)
    .slice(-6);
  const toggle = () => {
    setComparison((current) =>
      current.includes(sale.id)
        ? current.filter((id) => id !== sale.id)
        : [...current, sale.id].slice(-6),
    );
    toast.success(included ? "Vente retirée" : "Vente ajoutée à la comparaison");
  };
  const syncAnalysis = async () => {
    if (loading) return;
    if (!user) {
      toast.error("Connectez-vous pour synchroniser l'analyse multi-biens");
      return;
    }
    if (!isUuid(sale.id) || comparisonSaleIds.length === 0) {
      toast.error("Aucune vente synchronisable dans cette comparaison");
      return;
    }

    setSavingAnalysis(true);
    try {
      await createSaleAnalysisSet({
        data: {
          name: "Analyse multi-biens",
          analysisKind: "comparison",
          notes: "Comparaison créée depuis une fiche de vente ImmoJudis.",
          assumptions: {
            source: "sale_detail_comparison",
            primarySaleId: sale.id,
            primaryCheck: primaryCheckLabel(sale),
            recommendedCeilingEur: ceiling.available ? Math.round(ceiling.maxBid) : null,
            estimatedTotalCostEur: Math.round(cost.totalCost),
          },
          summarySnapshot: {
            savedAt: new Date().toISOString(),
            localComparisonCount: comparisonSaleIds.length,
          },
          items: comparisonSaleIds.map((saleId) => ({
            saleId,
            decisionStatus: saleId === sale.id ? "shortlisted" : "watching",
            userMaxBidEur:
              saleId === sale.id && ceiling.available ? Math.round(ceiling.maxBid) : null,
            notes: saleId === sale.id ? primaryCheckLabel(sale) : null,
          })),
        },
      });
      toast.success("Analyse multi-biens synchronisée");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Synchronisation impossible");
    } finally {
      setSavingAnalysis(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={toggle}
          className="inline-flex items-center gap-2 rounded-md bg-foreground px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-background hover:bg-foreground/90"
        >
          {included ? "Retirer de la comparaison" : "Comparer cette vente"}
        </button>
        <button
          type="button"
          onClick={() => void syncAnalysis()}
          disabled={savingAnalysis || loading}
          className="inline-flex items-center gap-2 rounded-md border border-border bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-foreground hover:border-gold/50 hover:text-gold-soft disabled:cursor-not-allowed disabled:opacity-60"
        >
          {savingAnalysis ? "Synchronisation..." : "Synchroniser l'analyse"}
        </button>
      </div>
      <div className="mt-5 overflow-hidden rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <tbody className="divide-y divide-border">
            {[
              ["Mise à prix", formatPrice(sale.starting_price_eur)],
              [
                "Plafond recommandé",
                ceiling.available ? formatPrice(ceiling.maxBid) : "À compléter",
              ],
              ["Coût complet estimé", formatPrice(cost.totalCost)],
              ["Surface", getDisplaySurface(sale).label],
              ["Date d'audience", formatDate(sale.sale_date)],
              ["Tribunal", sale.tribunal ?? sale.tribunal_name ?? "À confirmer"],
              ["Occupation", occupancyLabel(sale.occupancy_status)],
              ["Documents disponibles", String(countDocuments(sale))],
              ["Point prioritaire", primaryCheckLabel(sale)],
            ].map(([label, value]) => (
              <tr key={label}>
                <th className="bg-muted/30 px-3 py-2 text-xs uppercase tracking-[0.12em] text-muted-foreground">
                  {label}
                </th>
                <td className="px-3 py-2 font-medium text-foreground">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Dossiers dans la comparaison : {comparisonSaleIds.length}. La synchronisation crée ou met à
        jour une analyse multi-biens dans votre espace investisseur.
      </p>
    </div>
  );
}

function SimilarPropertiesBlock({
  sale,
  marketEstimate,
}: {
  sale: AuctionSale;
  marketEstimate?: MarketEstimate | null;
}) {
  const transactions = marketEstimate?.recentTransactions ?? [];
  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
      {transactions.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {transactions.slice(0, 3).map((transaction, index) => (
            <div
              key={`${transaction.date}-${index}`}
              className="rounded-md border border-border bg-muted/30 p-3"
            >
              <div className="text-sm font-semibold text-foreground">
                Vente comparable · {formatDate(transaction.date)}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {transaction.surface ? `${Math.round(transaction.surface)} m²` : "Surface inconnue"}{" "}
                · {formatPrice(transaction.totalPrice)} · {formatPricePerM2(transaction.pricePerM2)}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Les transactions DVF similaires seront affichées quand elles seront disponibles pour{" "}
          {sale.city ?? "ce secteur"}.
        </p>
      )}
    </div>
  );
}

function ValuationBacktestBlock({ sale }: { sale: AuctionSale }) {
  const [requested, setRequested] = useState(false);
  const canFetchBacktest = isUuid(sale.id) && sale.latitude != null && sale.longitude != null;
  const backtestQuery = useQuery({
    queryKey: ["valuation-backtest", sale.id],
    queryFn: () =>
      fetchValuationBacktest({
        saleId: sale.id,
        radiusM: 1_000,
        months: 48,
        maxTests: 30,
      }),
    enabled: requested && canFetchBacktest,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  const backtest = backtestQuery.data?.backtest ?? null;
  const summary = backtest?.summary ?? null;
  const points = backtest?.points.slice(0, 5) ?? [];

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Target className="h-4 w-4 text-gold-soft" />
            Backtest DVF
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {backtest
              ? `${backtest.scope.radiusM} m · ${backtest.scope.months} mois · ${backtest.scope.maxTests} tests max`
              : "Erreur historique observée sur les ventes DVF comparables"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setRequested(true);
            if (requested) void backtestQuery.refetch();
          }}
          disabled={!canFetchBacktest || backtestQuery.isFetching}
          className="inline-flex items-center rounded-md border border-border bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-foreground hover:border-gold/50 hover:text-gold-soft disabled:cursor-not-allowed disabled:opacity-60"
        >
          {backtestQuery.isFetching
            ? "Chargement..."
            : requested
              ? "Actualiser"
              : "Lancer le backtest"}
        </button>
      </div>

      {summary ? (
        <>
          <div className="grid gap-3 border-b border-border bg-muted/20 px-4 py-3 sm:grid-cols-2 lg:grid-cols-4">
            <HistoryMetric label="Statut" value={summary.confidenceLabel} />
            <HistoryMetric
              label="Erreur médiane"
              value={formatPercentValue(summary.medianAbsoluteErrorPct)}
            />
            <HistoryMetric label="Tests" value={formatNumber(summary.usableTests)} />
            <HistoryMetric label="À moins de 20%" value={formatPercentValue(summary.within20Pct)} />
          </div>
          <p className="border-b border-border px-4 py-3 text-sm leading-relaxed text-muted-foreground">
            {summary.interpretation}
          </p>
          <div className="overflow-x-auto px-4 py-4">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                <tr>
                  <th className="border-b border-border px-3 py-2">Vente testée</th>
                  <th className="border-b border-border px-3 py-2 text-right">Réel</th>
                  <th className="border-b border-border px-3 py-2 text-right">Prédit</th>
                  <th className="border-b border-border px-3 py-2 text-right">Écart</th>
                  <th className="border-b border-border px-3 py-2 text-right">Échantillon</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {points.map((point) => (
                  <tr key={point.transactionId}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-foreground">
                        {formatDate(point.saleDate)}
                      </div>
                      <div className="text-muted-foreground">
                        {point.city ?? "Secteur"} · {formatNumber(point.surfaceM2)} m²
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <div className="font-medium text-foreground">
                        {formatPrice(point.actualPriceEur)}
                      </div>
                      <div className="text-muted-foreground">
                        {formatPricePerM2(point.actualPricePerM2)}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <div className="font-medium text-foreground">
                        {formatPrice(point.predictedPriceEur)}
                      </div>
                      <div className="text-muted-foreground">
                        {formatPricePerM2(point.predictedPricePerM2)}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-foreground">
                      {formatPercentValue(point.absoluteErrorPct)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {formatNumber(point.comparableSampleSize)}
                    </td>
                  </tr>
                ))}
                {points.length === 0 ? (
                  <tr>
                    <td className="px-3 py-3 text-muted-foreground" colSpan={5}>
                      Pas assez de transactions passées comparables pour tester le moteur.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {!canFetchBacktest ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Backtest indisponible tant que la vente n'est pas géocodée.
        </p>
      ) : null}
      {backtestQuery.isError ? (
        <p className="border-t border-border px-4 py-3 text-sm text-destructive">
          {backtestQuery.error instanceof Error
            ? backtestQuery.error.message
            : "Backtest de valorisation indisponible"}
        </p>
      ) : null}
      {requested && !backtestQuery.isFetching && !backtestQuery.isError && !summary ? (
        <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">
          Aucun backtest exploitable sur ce périmètre.
        </p>
      ) : null}
    </div>
  );
}

function MarketAnalyticsBlock({ sale }: { sale: AuctionSale }) {
  const [requested, setRequested] = useState(false);
  const canFetchAnalytics = isUuid(sale.id);
  const analyticsQuery = useQuery({
    queryKey: ["market-analytics", sale.id],
    queryFn: () =>
      fetchMarketAnalytics({ saleId: sale.id, months: 36, futureMonths: 6, limit: 500 }),
    enabled: requested && canFetchAnalytics,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  const analytics = analyticsQuery.data;
  const summary = analytics?.summary;
  const rotation = analytics?.rotationRate;
  const recentPeriods = analytics?.volumeEvolution.slice(-6) ?? [];
  const recentDelayPeriods = analytics?.saleDelayEvolution.slice(-6) ?? [];
  const communeSegments = analytics?.communeComparison.slice(0, 5) ?? [];
  const marketTrends = analytics?.marketTrends ?? [];

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Analyse locale</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {analytics?.scope.label ?? "Distribution, volumes, prix/m² et délais d'audience"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setRequested(true);
            if (requested) void analyticsQuery.refetch();
          }}
          disabled={!canFetchAnalytics || analyticsQuery.isFetching}
          className="inline-flex items-center rounded-md border border-border bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-foreground hover:border-gold/50 hover:text-gold-soft disabled:cursor-not-allowed disabled:opacity-60"
        >
          {analyticsQuery.isFetching
            ? "Chargement..."
            : requested
              ? "Actualiser"
              : "Charger l'analyse"}
        </button>
      </div>

      {summary ? (
        <>
          <div className="grid gap-3 border-b border-border bg-muted/20 px-4 py-3 sm:grid-cols-2 lg:grid-cols-4">
            <HistoryMetric label="Échantillon" value={formatNumber(summary.sampleSize)} />
            <HistoryMetric
              label="Mise à prix médiane"
              value={formatPrice(summary.medianStartingPriceEur)}
            />
            <HistoryMetric label="Prix médian" value={formatPricePerM2(summary.medianPricePerM2)} />
            <HistoryMetric label="Délai moyen" value={formatDays(summary.averageDaysToSale)} />
            <HistoryMetric label="Rotation" value={rotation?.label ?? "À qualifier"} />
            <HistoryMetric label="Liquidité" value={rotation?.liquidityLabel ?? "À qualifier"} />
            <HistoryMetric
              label="Pipeline"
              value={formatPercentValue(rotation?.pipelineRatioPct)}
            />
            <HistoryMetric
              label="Cadence"
              value={
                rotation?.monthlyVolume != null
                  ? `${formatNumber(rotation.monthlyVolume)} / mois`
                  : "—"
              }
            />
          </div>
          <div className="grid gap-4 px-4 py-4 lg:grid-cols-2">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Répartition des mises à prix
              </div>
              <div className="mt-3 space-y-2">
                {analytics.priceDistribution.map((bucket) => (
                  <div
                    key={bucket.label}
                    className="grid grid-cols-[84px_1fr_48px] items-center gap-2"
                  >
                    <span className="text-xs text-muted-foreground">{bucket.label}</span>
                    <span className="h-2 overflow-hidden rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full bg-foreground"
                        style={{ width: `${Math.min(100, bucket.sharePct)}%` }}
                      />
                    </span>
                    <span className="text-right text-xs tabular-nums text-foreground">
                      {bucket.count}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Volumes et prix récents
              </div>
              <div className="mt-3 overflow-hidden rounded-md border border-border">
                <table className="w-full text-left text-xs">
                  <tbody className="divide-y divide-border">
                    {recentPeriods.map((period) => (
                      <tr key={period.period}>
                        <td className="px-3 py-2 font-medium text-foreground">{period.period}</td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {formatNumber(period.count)} vente{period.count > 1 ? "s" : ""}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatPrice(period.medianStartingPriceEur)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatPricePerM2(period.medianPricePerM2)}
                        </td>
                      </tr>
                    ))}
                    {recentPeriods.length === 0 ? (
                      <tr>
                        <td className="px-3 py-3 text-muted-foreground" colSpan={4}>
                          Pas assez de données mensuelles sur ce périmètre.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Délais d'audience
              </div>
              <div className="mt-3 overflow-hidden rounded-md border border-border">
                <table className="w-full text-left text-xs">
                  <tbody className="divide-y divide-border">
                    {recentDelayPeriods.map((period) => (
                      <tr key={period.period}>
                        <td className="px-3 py-2 font-medium text-foreground">{period.period}</td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {formatNumber(period.count)} dossier{period.count > 1 ? "s" : ""}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatDays(period.averageDaysToSale)}
                        </td>
                      </tr>
                    ))}
                    {recentDelayPeriods.length === 0 ? (
                      <tr>
                        <td className="px-3 py-3 text-muted-foreground" colSpan={3}>
                          Délais insuffisamment renseignés sur ce périmètre.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Comparaison communes
              </div>
              <div className="mt-3 overflow-hidden rounded-md border border-border">
                <table className="w-full text-left text-xs">
                  <tbody className="divide-y divide-border">
                    {communeSegments.map((segment) => (
                      <tr key={segment.label}>
                        <td className="px-3 py-2 font-medium text-foreground">{segment.label}</td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {formatNumber(segment.count)} vente{segment.count > 1 ? "s" : ""}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatPricePerM2(segment.medianPricePerM2)}
                        </td>
                      </tr>
                    ))}
                    {communeSegments.length === 0 ? (
                      <tr>
                        <td className="px-3 py-3 text-muted-foreground" colSpan={3}>
                          Comparaison commune à enrichir sur un périmètre plus large.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="lg:col-span-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Synthèse des tendances
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {marketTrends.map((trend) => (
                  <div
                    key={trend.metric}
                    className="rounded-md border border-border bg-muted/20 p-3"
                  >
                    <div className="text-xs font-semibold text-foreground">{trend.label}</div>
                    <div className="mt-1 text-sm font-semibold text-foreground">
                      {trendDirectionLabel(trend.direction)} · {formatPercentValue(trend.changePct)}
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                      {trend.interpretation}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
          {rotation?.interpretation ? (
            <p className="border-t border-border px-4 py-3 text-sm leading-relaxed text-muted-foreground">
              {rotation.interpretation}
            </p>
          ) : null}
        </>
      ) : null}

      {analyticsQuery.isError ? (
        <p className="border-t border-border px-4 py-3 text-sm text-destructive">
          {analyticsQuery.error instanceof Error
            ? analyticsQuery.error.message
            : "Analyse de marché indisponible"}
        </p>
      ) : null}
      {requested &&
      !analyticsQuery.isFetching &&
      !analyticsQuery.isError &&
      summary?.sampleSize === 0 ? (
        <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">
          Pas encore assez de ventes comparables sur ce périmètre.
        </p>
      ) : null}
    </div>
  );
}

function SaleAndTaxHistoryBlock({
  sale,
  marketEstimate,
}: {
  sale: AuctionSale;
  marketEstimate?: MarketEstimate | null;
}) {
  const [historyRequested, setHistoryRequested] = useState(false);
  const canFetchHistory = isUuid(sale.id);
  const judicialHistoryQuery = useQuery({
    queryKey: ["sale-history", sale.id],
    queryFn: () => fetchSaleHistory({ saleId: sale.id, months: 60, limit: 8 }),
    enabled: historyRequested && canFetchHistory,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  const rows = [
    [
      "Publication dossier",
      formatDateTime(sale.created_at),
      formatPrice(sale.starting_price_eur),
      sale.source_name ?? "Source",
    ],
    ["Mise à jour", formatDateTime(sale.updated_at), "—", sale.primary_source ?? "Immojudis"],
    [
      "Audience prévue",
      formatDate(sale.sale_date),
      formatPrice(sale.starting_price_eur),
      sale.tribunal ?? sale.tribunal_name ?? "Tribunal",
    ],
  ];
  const history = marketEstimate?.addressHistory ?? [];
  const judicialHistory = judicialHistoryQuery.data?.items ?? [];
  const summary = judicialHistoryQuery.data?.summary ?? null;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Historique judiciaire</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {judicialHistoryQuery.data?.scope.label ?? "Ventes passées du secteur"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setHistoryRequested(true);
            if (historyRequested) void judicialHistoryQuery.refetch();
          }}
          disabled={!canFetchHistory || judicialHistoryQuery.isFetching}
          className="inline-flex items-center rounded-md border border-border bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-foreground hover:border-gold/50 hover:text-gold-soft disabled:cursor-not-allowed disabled:opacity-60"
        >
          {judicialHistoryQuery.isFetching
            ? "Chargement..."
            : historyRequested
              ? "Actualiser"
              : "Charger l'historique"}
        </button>
      </div>
      {summary ? (
        <div className="grid gap-3 border-b border-border bg-muted/20 px-4 py-3 sm:grid-cols-4">
          <HistoryMetric label="Ventes" value={formatNumber(summary.itemCount)} />
          <HistoryMetric
            label="Mise à prix médiane"
            value={formatPrice(summary.medianStartingPriceEur)}
          />
          <HistoryMetric
            label="Adjudication moyenne"
            value={formatPrice(summary.averageAdjudicationPriceEur)}
          />
          <HistoryMetric label="Prix moyen" value={formatPricePerM2(summary.averagePricePerM2)} />
        </div>
      ) : null}
      <table className="w-full text-left text-sm">
        <thead className="bg-muted/50 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          <tr>
            <th className="px-4 py-3">Événement</th>
            <th className="px-4 py-3">Date</th>
            <th className="px-4 py-3">Montant</th>
            <th className="px-4 py-3">Source</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map(([event, date, amount, source]) => (
            <tr key={event}>
              <td className="px-4 py-3 font-medium text-foreground">{event}</td>
              <td className="px-4 py-3 text-muted-foreground">{date}</td>
              <td className="px-4 py-3 tabular-nums">{amount}</td>
              <td className="px-4 py-3 text-muted-foreground">{source}</td>
            </tr>
          ))}
          {history.slice(0, 3).map((item, index) => (
            <tr key={`${item.date}-${index}`}>
              <td className="px-4 py-3 font-medium text-foreground">Vente comparable adresse</td>
              <td className="px-4 py-3 text-muted-foreground">{formatDate(item.date)}</td>
              <td className="px-4 py-3 tabular-nums">{formatPrice(item.totalPrice)}</td>
              <td className="px-4 py-3 text-muted-foreground">
                {formatPricePerM2(item.pricePerM2)}
              </td>
            </tr>
          ))}
          {judicialHistory.map((item) => (
            <tr key={item.id}>
              <td className="px-4 py-3 font-medium text-foreground">
                <Link className="hover:text-gold-soft" to={`/sales/${item.id}`}>
                  Vente passée · {propertyTypeLabel(item.propertyType)}
                </Link>
                <div className="mt-1 text-xs font-normal text-muted-foreground">
                  {[item.city, saleStatusLabel(item.status)].filter(Boolean).join(" · ")}
                </div>
              </td>
              <td className="px-4 py-3 text-muted-foreground">{formatDate(item.saleDate)}</td>
              <td className="px-4 py-3 tabular-nums">
                {item.adjudicationPriceEur
                  ? formatPrice(item.adjudicationPriceEur)
                  : formatPrice(item.startingPriceEur)}
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {item.pricePerM2
                  ? formatPricePerM2(item.pricePerM2)
                  : (item.sourceName ?? "Source")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {judicialHistoryQuery.isError ? (
        <p className="border-t border-border px-4 py-3 text-sm text-destructive">
          {judicialHistoryQuery.error instanceof Error
            ? judicialHistoryQuery.error.message
            : "Historique indisponible"}
        </p>
      ) : null}
      {historyRequested &&
      !judicialHistoryQuery.isFetching &&
      !judicialHistoryQuery.isError &&
      judicialHistory.length === 0 ? (
        <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">
          Aucune vente passée comparable trouvée sur ce périmètre.
        </p>
      ) : null}
    </div>
  );
}

function HistoryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold text-foreground">{value}</div>
    </div>
  );
}

function formatDays(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Math.round(value)} j`;
}

function formatPercentValue(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${formatNumber(value)} %`;
}

function trendDirectionLabel(value: string): string {
  const labels: Record<string, string> = {
    up: "Hausse",
    down: "Baisse",
    stable: "Stable",
    missing: "À enrichir",
  };
  return labels[value] ?? "À qualifier";
}

function PublicRecordBlock({ sale }: { sale: AuctionSale }) {
  const surface = getDisplaySurface(sale);
  const visitDates = saleVisitDates(sale);
  const facts = [
    ["Type", propertyTypeLabel(sale.property_type)],
    ["Surface", surface.value ? surface.label : "Non précisée"],
    ["Pièces", sale.rooms_count != null ? String(sale.rooms_count) : "Non précisé"],
    ["Chambres", sale.bedrooms_count != null ? String(sale.bedrooms_count) : "Non précisé"],
    ["Tribunal", sale.tribunal ?? sale.tribunal_name ?? "À confirmer"],
    ["Visites", visitDates.length ? visitDates.slice(0, 2).join(" · ") : "À vérifier"],
    ["Consignation", sourceBlockMoney(sale, "consignation") ?? "À vérifier"],
    ["Occupation", occupancyLabel(sale.occupancy_status)],
    ["Documents", `${countDocuments(sale)} pièce${countDocuments(sale) > 1 ? "s" : ""}`],
  ];

  return (
    <div className="mb-5 rounded-lg border border-border bg-white p-5 shadow-sm">
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {facts.map(([label, value]) => (
          <div key={label} className="border-b border-border pb-3">
            <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {label}
            </dt>
            <dd className="mt-1 text-sm font-medium text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ClimateRisksBlock({ sale, ceiling }: { sale: AuctionSale; ceiling: MarketCeilingResult }) {
  const risks = sale.risks ?? [];
  const fallback: NonNullable<AuctionSale["risks"]> = [
    {
      risk_type: "occupation",
      risk_label: "Occupation",
      severity: isUnknownOccupation(sale.occupancy_status) ? 2 : 1,
      evidence: primaryCheckLabel(sale),
    },
    {
      risk_type: "works",
      risk_label: "Travaux",
      severity: hasWorksRisk(sale) ? 2 : 1,
      evidence: "Enveloppe à confirmer avant audience.",
    },
  ];
  const visible = risks.length ? risks : fallback;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
        <div className="grid gap-3 md:grid-cols-2">
          {visible.slice(0, 4).map((risk, index) => (
            <div
              key={`${risk.risk_label}-${index}`}
              className="rounded-md border border-border bg-muted/30 p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium text-foreground">
                    {risk.risk_label || risk.risk_type}
                  </div>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    {risk.evidence || "À vérifier dans les pièces."}
                  </p>
                </div>
                <StatusBadge
                  status={severityLabel(risk.severity)}
                  tone={risk.severity && risk.severity >= 3 ? "risk" : "watch"}
                />
              </div>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          Ces risques remplacent le bloc climat de Redfin pour une vente judiciaire : ils peuvent
          déplacer la valeur, le délai de possession et la mise plafond.
        </p>
      </div>
      <VerificationPoints sale={sale} ceiling={ceiling} />
    </div>
  );
}

function OfferInsightsBlock({
  sale,
  decision,
  acquisitionCost,
  marketEstimate,
}: {
  sale: AuctionSale;
  decision: DecisionSummary;
  acquisitionCost: AcquisitionCost;
  marketEstimate?: MarketEstimate | null;
}) {
  const surface = getSaleSurface(sale).value;
  const allInPerM2 = surface ? acquisitionCost.totalCost / surface : null;
  const deltaPct =
    allInPerM2 && marketEstimate?.medianPricePerM2
      ? Math.round((1 - allInPerM2 / marketEstimate.medianPricePerM2) * 100)
      : null;
  const rows = [
    [
      "Mise maximum",
      decision.ceiling.available ? formatPrice(decision.ceiling.maxBid) : "À compléter",
    ],
    ["Coût complet", formatPrice(acquisitionCost.totalCost)],
    ["Écart marché", deltaPct == null ? "À compléter" : `${deltaPct > 0 ? "+" : ""}${deltaPct}%`],
    ["Consigne", decision.action],
  ];

  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map(([label, value]) => (
          <div key={label} className="rounded-md border border-border bg-muted/30 p-4">
            <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {label}
            </dt>
            <dd className="mt-2 text-lg font-semibold tabular-nums text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
        Si un nouveau document change l'occupation, les travaux ou les frais particuliers, le
        plafond doit être recalculé avant de transmettre les consignes à l'avocat.
      </p>
    </div>
  );
}

function DecisionRail({
  sale,
  decision,
  acquisitionCost,
}: {
  sale: AuctionSale;
  decision: DecisionSummary;
  acquisitionCost: AcquisitionCost;
}) {
  const documentCount = countDocuments(sale);
  const ceilingLabel = decision.ceiling.available
    ? formatPrice(decision.ceiling.maxBid)
    : "À compléter";

  return (
    <div className="space-y-6">
      <div className="relative rounded-lg border border-border bg-white p-6 shadow-xl shadow-slate-900/10">
        <div className="text-[10px] uppercase tracking-[0.16em] text-gold-soft">
          Dossier à suivre
        </div>
        <div className="mt-4 rounded-lg border border-gold/20 bg-gold/[0.06] p-4">
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Plafond d'enchère recommandé
          </div>
          <div className="mt-2 text-4xl font-semibold leading-none tabular-nums text-foreground">
            {ceilingLabel}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {decision.primaryCheck}. À valider avec les pièces et les professionnels compétents.
          </p>
          <a
            href="#offer-insights"
            className="mt-3 inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-[0.12em] text-gold-soft transition-colors hover:text-gold"
          >
            Préparer mon enchère <ChevronRight className="h-3 w-3" />
          </a>
        </div>

        <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-border pt-5">
          <RailMeta label="Mise à prix" value={formatPrice(sale.starting_price_eur)} />
          <RailMeta label="Coût complet" value={formatPrice(acquisitionCost.totalCost)} />
          <RailMeta label="Audience" value={formatDate(sale.sale_date)} />
          <RailMeta label="Occupation" value={occupancyLabel(sale.occupancy_status)} />
          <RailMeta
            label="Pièces"
            value={`${documentCount} disponible${documentCount > 1 ? "s" : ""}`}
          />
          <RailMeta label="Point à vérifier" value={decision.primaryDocument} />
        </dl>
        <div className="mt-5">
          <SaleCountdown date={sale.sale_date} variant="block" />
        </div>

        <div className="mt-5 grid gap-3 border-t border-border pt-5">
          <div className="grid grid-cols-2 gap-2">
            <FavoriteButton saleId={sale.id} className="w-full justify-center" />
            <Dialog>
              <DialogTrigger asChild>
                <button
                  type="button"
                  className="group flex w-full cursor-pointer items-center justify-between rounded-lg border border-border bg-white px-3 py-2 text-[11px] font-medium uppercase tracking-[0.12em] text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft"
                >
                  <span>Comparer</span>
                  <Scale className="h-3.5 w-3.5" />
                </button>
              </DialogTrigger>
              <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
                <DialogHeader>
                  <DialogTitle>Comparer cette vente</DialogTitle>
                  <DialogDescription>
                    Les repères essentiels de cette fiche pour la comparaison.
                  </DialogDescription>
                </DialogHeader>
                <ComparisonBlock sale={sale} ceiling={decision.ceiling} cost={acquisitionCost} />
              </DialogContent>
            </Dialog>
          </div>
          <a
            href="#offer-insights"
            className="group flex w-full items-center justify-between rounded-lg bg-foreground px-4 py-3 text-[11px] font-medium uppercase tracking-[0.12em] text-background transition-colors hover:bg-foreground/90"
          >
            <span>Préparer mon enchère</span>
            <Target className="h-3.5 w-3.5" />
          </a>
          <button
            type="button"
            aria-label="Imprimer ou enregistrer l'analyse"
            onClick={printAnalysis}
            className="group flex w-full items-center justify-between rounded-lg border border-border bg-white px-4 py-3 text-[11px] font-medium uppercase tracking-[0.12em] text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft"
          >
            <span>Imprimer l'analyse</span>
            <Download className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Partager cette vente"
            onClick={() => void shareCurrentPage(saleDisplayTitle(sale, "Dossier Immojudis"))}
            className="group flex w-full items-center justify-between rounded-lg border border-border bg-white px-4 py-3 text-[11px] font-medium uppercase tracking-[0.12em] text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft"
          >
            <span>Partager le dossier</span>
            <Share2 className="h-3.5 w-3.5" />
          </button>
          <div className="grid grid-cols-2 gap-2">
            <Dialog>
              <DialogTrigger asChild>
                <button
                  type="button"
                  className="group flex w-full cursor-pointer items-center justify-between rounded-lg border border-border bg-white px-3 py-2 text-[11px] font-medium uppercase tracking-[0.12em] text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft"
                >
                  <span>Notes</span>
                  <FileCheck2 className="h-3.5 w-3.5" />
                </button>
              </DialogTrigger>
              <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
                <DialogHeader>
                  <DialogTitle>Notes personnelles</DialogTitle>
                  <DialogDescription>Notes privées et partage ciblé.</DialogDescription>
                </DialogHeader>
                <NotesAndSharingBlock sale={sale} />
              </DialogContent>
            </Dialog>
            <Dialog>
              <DialogTrigger asChild>
                <button
                  type="button"
                  className="group flex w-full cursor-pointer items-center justify-between rounded-lg border border-border bg-white px-3 py-2 text-[11px] font-medium uppercase tracking-[0.12em] text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft"
                >
                  <span>Suivi</span>
                  <Clock3 className="h-3.5 w-3.5" />
                </button>
              </DialogTrigger>
              <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
                <DialogHeader>
                  <DialogTitle>Suivi et rappels</DialogTitle>
                  <DialogDescription>
                    Checklist, rappels et statut avant audience.
                  </DialogDescription>
                </DialogHeader>
                <SaleAlertsBlock sale={sale} />
              </DialogContent>
            </Dialog>
          </div>
          {sale.source_url && (
            <a
              href={sale.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex w-full items-center justify-between rounded-lg border border-border bg-white px-4 py-3 text-[11px] font-medium uppercase tracking-[0.12em] text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft"
            >
              <span>Source{sale.source_name ? ` · ${sale.source_name}` : ""}</span>
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function FloatingDossierAssistant({
  sale,
  cost,
  ceiling,
}: {
  sale: AuctionSale;
  cost: AcquisitionCost;
  ceiling: MarketCeilingResult;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="fixed bottom-6 right-4 z-40 hidden cursor-pointer items-center gap-2 rounded-full border border-border bg-foreground px-4 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-background shadow-xl shadow-slate-900/20 transition-colors hover:bg-foreground/90 lg:inline-flex"
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
        <DossierAssistant sale={sale} cost={cost} ceiling={ceiling} />
      </DialogContent>
    </Dialog>
  );
}

function RailMeta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-medium tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

function MobileActionBar({ sale, decision }: { sale: AuctionSale; decision: DecisionSummary }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-white/95 px-3 py-2 shadow-[0_-8px_24px_rgb(19_34_56/10%)] backdrop-blur lg:hidden">
      <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <a
          href="#calculation"
          className="min-h-12 min-w-0 rounded-md bg-foreground px-3 py-2 text-xs text-background"
        >
          <span className="block text-[10px] uppercase tracking-[0.12em] text-background/70">
            Plafond conseillé
          </span>
          <span className="block truncate font-semibold">
            {decision.ceiling.available
              ? formatPrice(decision.ceiling.maxBid)
              : "Ajuster mon plafond"}
          </span>
        </a>
        <FavoriteButton saleId={sale.id} className="min-h-12 justify-center px-3 text-xs" />
      </div>
    </div>
  );
}

function buildDecisionSummary(
  sale: AuctionSale,
  marketEstimate: MarketEstimate | null | undefined,
): DecisionSummary {
  const balancedScenario =
    MARKET_CEILING_SCENARIOS.find((scenario) => scenario.key === "equilibre") ??
    MARKET_CEILING_SCENARIOS[1];
  const ceiling = computeMarketCeiling({
    surface: getSaleSurface(sale).value,
    price: Math.max(0, sale.starting_price_eur ?? 0),
    works: DEFAULTS.works,
    fpt: DEFAULTS.fpt,
    scenario: balancedScenario.key,
    medianPricePerM2: marketEstimate?.medianPricePerM2,
    p25PricePerM2: marketEstimate?.p25PricePerM2,
    p75PricePerM2: marketEstimate?.p75PricePerM2,
  });

  const primaryCheck = primaryCheckLabel(sale);
  return {
    ceiling,
    primaryCheck,
    primaryDocument: primaryDocumentLabel(sale, primaryCheck),
    action: recommendedAction(sale, ceiling),
  };
}

function primaryCheckLabel(sale: AuctionSale): string {
  if (isUnknownOccupation(sale.occupancy_status)) return "Occupation du bien non confirmée";
  if (hasWorksRisk(sale)) return "Budget travaux à confirmer";
  if (!hasDocumentType(sale, /cahier|conditions/)) return "Cahier des conditions à récupérer";
  if (!hasDocumentType(sale, /diagnostic|dpe|amiante|plomb/)) return "Diagnostics à rechercher";
  return "Frais et conditions à relire avant consignes";
}

function primaryDocumentLabel(sale: AuctionSale, primaryCheck: string): string {
  const normalized = primaryCheck.toLowerCase();
  if (normalized.includes("occupation")) return "PV descriptif";
  if (normalized.includes("travaux")) return "PV descriptif ou diagnostics";
  if (normalized.includes("diagnostic")) return "Diagnostics techniques";
  if (hasDocumentType(sale, /cahier|conditions/)) return "Cahier des conditions de vente";
  return "Cahier des conditions";
}

function recommendedAction(sale: AuctionSale, ceiling: MarketCeilingResult): string {
  if (!ceiling.available) return "Renseigner le marché local";
  if (isUnknownOccupation(sale.occupancy_status)) return "Faire confirmer l'occupation";
  if (hasWorksRisk(sale)) return "Chiffrer les travaux";
  if (!hasDocumentType(sale, /cahier|conditions/)) return "Obtenir le cahier des conditions";
  return "Faire relire les conditions de vente";
}

function primaryActionHref(action: string): string {
  const normalized = normalizeLocation(action);
  if (/occupation|avocat|conditions/.test(normalized)) return "#steps";
  if (/document|cahier|diagnostic|piece/.test(normalized)) return "#proofs";
  if (/marche|plafond|travaux|renseigner|chiffrer/.test(normalized)) return "#calculation";
  return "#steps";
}

function primaryActionLabel(action: string): string {
  const normalized = normalizeLocation(action);
  if (/occupation/.test(normalized)) return "Confirmer l'occupation";
  if (/travaux|chiffrer/.test(normalized)) return "Chiffrer les travaux";
  if (/cahier|document|piece/.test(normalized)) return "Relire les pièces";
  if (/marche|plafond|renseigner/.test(normalized)) return "Ajuster le plafond";
  return action;
}

function buildVerificationPoints(sale: AuctionSale): Array<{
  label: string;
  detail: string;
  status: string;
  tone: "verified" | "watch" | "missing" | "risk";
}> {
  const unknownOccupation = isUnknownOccupation(sale.occupancy_status);
  const hasDiagnostics = hasDocumentType(sale, /diagnostic|dpe|amiante|plomb|termite/);
  const hasConditions = hasDocumentType(sale, /cahier|conditions/);
  const hasPv = hasDocumentType(sale, /pv|descriptif|huissier|commissaire/);
  const worksRisk = hasWorksRisk(sale);

  return [
    {
      label: "Occupation",
      detail: unknownOccupation
        ? "À confirmer dans le PV descriptif."
        : `${occupancyLabel(sale.occupancy_status)} : vérifier le titre et le délai.`,
      status: unknownOccupation ? "À confirmer" : "À vérifier",
      tone: unknownOccupation ? "watch" : "verified",
    },
    {
      label: "Travaux",
      detail: worksRisk ? "À chiffrer avant audience." : "À estimer avant audience.",
      status: worksRisk ? "À chiffrer" : "À confirmer",
      tone: worksRisk ? "risk" : "watch",
    },
    {
      label: "Conditions de vente",
      detail: "À faire relire par l'avocat.",
      status: hasConditions ? "À faire relire" : "Document manquant",
      tone: hasConditions ? "watch" : "missing",
    },
    {
      label: "Financement / avocat",
      detail: "À valider avant enchère.",
      status: "À valider",
      tone: "watch",
    },
    {
      label: "Diagnostics",
      detail: "Contrôler amiante, plomb, DPE, termites et contraintes techniques.",
      status: hasDiagnostics ? "Document disponible" : "Document manquant",
      tone: hasDiagnostics ? "verified" : "missing",
    },
    {
      label: "PV descriptif",
      detail: "Source prioritaire pour occupation, accès au bien, état visible et équipements.",
      status: hasPv ? "Document disponible" : "Document manquant",
      tone: hasPv ? "verified" : "missing",
    },
  ];
}

function hasWorksRisk(sale: AuctionSale): boolean {
  return (sale.risks ?? []).some((risk) =>
    `${risk.risk_label ?? ""} ${risk.risk_type ?? ""}`
      .toLowerCase()
      .match(/travaux|renov|état|etat/),
  );
}

function isUnknownOccupation(status: string | null | undefined): boolean {
  const normalized = (status ?? "").toLowerCase();
  return !status || normalized === "unknown" || normalized === "inconnu";
}

function hasDocumentType(sale: AuctionSale, pattern: RegExp): boolean {
  return documentSearchParts(sale).some((part) => pattern.test(part.toLowerCase()));
}

function documentSearchParts(sale: AuctionSale): string[] {
  const rich = (sale.documents_rich ?? []).flatMap((document) => [
    document.label,
    document.type,
    document.document_type,
    document.url,
  ]);
  const basic = parseDocs(sale.documents).flatMap((document) => [
    document.name,
    document.type,
    document.url,
  ]);
  return [...rich, ...basic].filter((part): part is string => Boolean(part));
}

function countDocuments(sale: AuctionSale): number {
  const richCount = sale.documents_rich?.length ?? 0;
  return richCount > 0 ? richCount : parseDocs(sale.documents).length;
}

function documentReviewPrompt(document: SaleDocumentRich): string {
  const type = `${document.document_type ?? ""} ${document.type ?? ""}`.toLowerCase();
  if (/pv|descriptif|huissier|commissaire/.test(type)) {
    return "Relire l'occupation, l'accès, l'état intérieur, les travaux apparents et les équipements visibles.";
  }
  if (/cahier|conditions/.test(type)) {
    return "Vérifier les clauses particulières, frais, consignation, délai de paiement, servitudes et surenchère.";
  }
  if (/diagnostic|dpe|amiante|plomb|termite/.test(type)) {
    return "Identifier les contraintes techniques qui peuvent modifier les travaux, le délai ou la revente.";
  }
  if (/bail|occupation/.test(type)) {
    return "Vérifier le titre d'occupation, le loyer, la durée, les conditions de sortie et les impayés éventuels.";
  }
  return "Relire les passages qui peuvent modifier le plafond, les frais, l'occupation ou les travaux.";
}

function documentPagesToReview(sale: AuctionSale, document: SaleDocumentRich): string | null {
  const documentType = document.document_type ?? document.type;
  const pages = new Set<number>();
  for (const risk of sale.risks ?? []) {
    for (const occurrence of risk.occurrences ?? []) {
      const sameType = documentType && occurrence.document_type === documentType;
      const sameLabel = occurrence.document_label && occurrence.document_label === document.label;
      if ((sameType || sameLabel) && occurrence.page_number != null) {
        pages.add(occurrence.page_number);
      }
    }
  }
  return pages.size ? [...pages].sort((a, b) => a - b).join(", ") : null;
}

function answerDossierQuestion(
  question: string,
  sale: AuctionSale,
  cost: AcquisitionCost,
  ceiling: MarketCeilingResult,
): { text: string; source: string; excerpt?: string } {
  const normalized = normalizeLocation(question);
  const priorityDocument = primaryDocumentLabel(sale, primaryCheckLabel(sale));

  if (/occupe|occupation/.test(normalized)) {
    const occurrence = findOccurrence(sale, /occupation|occupe|occupant|bail|locataire/);
    return {
      text: `Statut lu : ${occupancyLabel(sale.occupancy_status)}. Si l'information reste imprécise, c'est un point bloquant pour le plafond, car l'occupation peut déplacer le calendrier, les travaux et la jouissance.`,
      source: occurrence?.document_label ?? priorityDocument,
      excerpt: occurrence?.excerpt ?? undefined,
    };
  }

  if (/document|piece|relire/.test(normalized)) {
    const documents = documentNames(sale).slice(0, 4);
    return {
      text: documents.length
        ? `Relire en priorité : ${documents.join(", ")}. Commencer par ce qui confirme l'occupation, les conditions de vente, les diagnostics et les travaux.`
        : "Aucune pièce structurée n'est encore disponible. Le dossier doit être complété avant de fixer une enchère.",
      source: documents.length ? "Pièces indexées du dossier" : "Aucune pièce indexée",
    };
  }

  if (/frais|prevoir|avocat|adjudication/.test(normalized)) {
    return {
      text: `À ce stade, les frais simulés représentent ${formatPrice(cost.acquisitionFeesTotal)} : émoluments, droits, taxes et frais de procédure estimés. Ajouter les frais spécifiques du cahier des conditions dans la simulation.`,
      source: "Simulation de coût complet",
    };
  }

  if (/plafond|modifier|element/.test(normalized)) {
    return {
      text: ceiling.available
        ? `Le plafond actuel est ${formatPrice(ceiling.maxBid)}. Il peut bouger avec l'occupation, les travaux, les frais particuliers, la surface retenue et le prix/m² local.`
        : "Le plafond n'est pas encore disponible : il manque une surface exploitable ou une référence de marché local.",
      source: "Assistant de mise plafond",
    };
  }

  if (/avocat|demander/.test(normalized)) {
    return {
      text: "Demander confirmation de la consignation, des frais particuliers, du délai de paiement, du délai de surenchère, des clauses du cahier des conditions et de toute incertitude d'occupation.",
      source: "Checklist avant audience",
    };
  }

  if (/travaux|etat|renovation/.test(normalized)) {
    const risk = (sale.risks ?? []).find((item) =>
      `${item.risk_label ?? ""} ${item.risk_type ?? ""}`
        .toLowerCase()
        .match(/travaux|renov|etat|état/),
    );
    return {
      text: risk
        ? `${risk.risk_label || "Travaux à prévoir"} : ${risk.evidence ?? "un point travaux est détecté, à transformer en budget."}`
        : "Aucun poste travaux fiable n'est détecté. Saisir une enveloppe basse, médiane et haute avant l'audience.",
      source: risk?.occurrences?.[0]?.document_label ?? "Bloc travaux",
      excerpt: risk?.occurrences?.[0]?.excerpt ?? undefined,
    };
  }

  if (/cout|complet|total/.test(normalized)) {
    return {
      text: `Le coût complet estimé ressort à ${formatPrice(cost.totalCost)}, dont ${formatPrice(cost.acquisitionFeesTotal)} de frais d'acquisition et ${formatPrice(cost.works)} de travaux saisis.`,
      source: "Coût complet d'acquisition",
    };
  }

  if (/prix|interessante|interessant/.test(normalized)) {
    return {
      text: ceiling.available
        ? `L'opération devient moins intéressante au-dessus de ${formatPrice(ceiling.maxBid)}, hors nouvelle information favorable sur le marché, les travaux ou l'occupation.`
        : "Impossible de fixer ce seuil sans plafond calculable. Compléter le marché local et les hypothèses de travaux/frais.",
      source: "Plafond recommandé",
    };
  }

  return {
    text: `Point prioritaire : ${primaryCheckLabel(sale)}. Relire ${priorityDocument} avant de figer les consignes.`,
    source: priorityDocument,
  };
}

function findOccurrence(sale: AuctionSale, pattern: RegExp): SaleRiskOccurrence | undefined {
  return riskOccurrences(sale).find((occurrence) =>
    `${occurrence.document_label ?? ""} ${occurrence.document_type ?? ""} ${occurrence.excerpt ?? ""}`
      .toLowerCase()
      .match(pattern),
  );
}

function documentNames(sale: AuctionSale): string[] {
  const rich = sale.documents_rich ?? [];
  if (rich.length) return rich.map((document) => documentName(document));
  return parseDocs(sale.documents).map((document) => document.name ?? document.url);
}

function documentName(document: SaleDocumentRich): string {
  return (
    document.label ??
    document.url.split("/").filter(Boolean).pop() ??
    documentTypeLabel(document.document_type ?? document.type)
  );
}

function notesToText(sale: AuctionSale, notes: StoredNotes): string {
  const title = saleDisplayTitle(sale);
  return [
    `Dossier Immojudis : ${title}`,
    `Lieu : ${saleLocation(sale.address, sale.postal_code, sale.city) || "À confirmer"}`,
    `Audience : ${formatDate(sale.sale_date)}`,
    `Notes privées : ${notes.privateMode ? "oui" : "non"}`,
    "",
    "Note générale",
    notes.general || "—",
    "",
    "Occupation",
    notes.occupation || "—",
    "",
    "Travaux",
    notes.works || "—",
    "",
    "Marché local",
    notes.market || "—",
  ].join("\n");
}

async function copyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    toast.success("Texte copié");
    return;
  }
  if (typeof document === "undefined") return;
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.left = "-9999px";
  document.body.appendChild(field);
  field.select();
  document.execCommand("copy");
  document.body.removeChild(field);
  toast.success("Texte copié");
}

function downloadText(filename: string, text: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
  toast.success("Fichier préparé");
}

function timeRemainingLabel(value: string | null | undefined): string {
  if (!value) return "À confirmer";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "À confirmer";
  const diff = date.getTime() - Date.now();
  const day = 24 * 60 * 60 * 1000;
  if (diff < -day) return "Audience passée";
  if (diff <= 0) return "Aujourd'hui";
  const days = Math.ceil(diff / day);
  if (days === 1) return "Demain";
  return `${days} jours`;
}

function printAnalysis() {
  if (typeof window === "undefined") return;
  toast.message("Ouverture de l'impression");
  window.print();
}

async function shareCurrentPage(title: string) {
  if (typeof window === "undefined") return;
  const url = window.location.href;
  try {
    if (navigator.share) {
      await navigator.share({ title, url });
      toast.success("Partage ouvert");
      return;
    }
    await copyText(url);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    toast.error("Impossible de partager ce lien");
  }
}

function saleLocation(
  address: string | null | undefined,
  postalCode: string | null | undefined,
  city: string | null | undefined,
): string {
  const cleanedAddress = cleanLocationPart(address);
  const normalizedAddress = normalizeLocation(cleanedAddress);
  const postalAndCity = [postalCode, city].filter(Boolean).join(" ").trim();
  const parts: string[] = [];

  if (cleanedAddress) parts.push(cleanedAddress);
  if (postalAndCity && !normalizedAddress.includes(normalizeLocation(postalCode))) {
    parts.push(postalAndCity);
  } else if (city && !normalizedAddress.includes(normalizeLocation(city))) {
    parts.push(city);
  }

  return parts
    .filter(Boolean)
    .filter((part, index, values) => {
      const normalized = normalizeLocation(part);
      return values.findIndex((candidate) => normalizeLocation(candidate) === normalized) === index;
    })
    .join(", ");
}

function cleanLocationPart(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\s*,?\s*France\s*$/i, "")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLocation(value: string | null | undefined): string {
  return cleanLocationPart(value)
    .toLocaleLowerCase("fr-FR")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

function sourceBlockText(sale: AuctionSale, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = sourceBlockValue(sale, key);
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function sourceBlockMoney(sale: AuctionSale, key: string): string | null {
  const value = sourceBlockValue(sale, key);
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) && amount > 0 ? formatPrice(amount) : null;
}

function sourceBlockValue(sale: AuctionSale, key: string): unknown {
  const direct = sale.source_blocks?.[key];
  if (direct != null && direct !== "") return direct;
  for (const blocks of Object.values(sale.source_blocks_by_source ?? {})) {
    if (!blocks || typeof blocks !== "object") continue;
    const value = blocks[key];
    if (value != null && value !== "") return value;
  }
  return null;
}

function saleLawyerName(sale: AuctionSale): string | null {
  return (
    sale.lawyer_name ?? sourceBlockText(sale, "avocat", "lawyer_name", "notary_name", "organizer")
  );
}

function saleLawyerContact(sale: AuctionSale): string | null {
  return (
    sale.lawyer_contact ??
    sourceBlockText(sale, "contact_avocat", "lawyer_contact", "contact", "telephone", "phone")
  );
}

function saleVisitDates(sale: AuctionSale): string[] {
  const raw = Array.isArray(sale.visit_dates) ? sale.visit_dates : [];
  const collected = raw.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  const blockVisit = sourceBlockText(
    sale,
    "visites",
    "visite",
    "date_de_visite",
    "detail_date_de_visite",
    "visit_dates",
  );
  return [...collected, ...(blockVisit ? [blockVisit] : [])].filter(
    (value, index, values) => values.indexOf(value) === index,
  );
}

function cleanHref(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

function isEmbeddableDocumentUrl(href: string): boolean {
  return /\.(pdf|png|jpe?g|webp)(?:[?#].*)?$/i.test(href);
}

function cleanContactValue(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function lawyerContactHref(contact: string | null): string | null {
  if (!contact) return null;
  if (/^https?:\/\//i.test(contact)) return contact;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) return `mailto:${contact}`;
  const phone = contact.replace(/[^\d+]/g, "");
  return phone.length >= 8 ? `tel:${phone}` : null;
}

function lawyerQuestions(sale: AuctionSale): string[] {
  const questions = [
    "Quel montant exact de consignation et quelle forme de paiement sont exigés ?",
    "Quels frais particuliers du cahier des conditions doivent être ajoutés au coût complet ?",
    "Quel délai de paiement, délai de surenchère et calendrier post-adjudication retenir ?",
  ];

  if (isUnknownOccupation(sale.occupancy_status)) {
    questions.unshift("Le bien est-il libre, occupé, loué ou seulement partiellement décrit ?");
  }
  if (!hasDocumentType(sale, /cahier|conditions/)) {
    questions.push("Comment récupérer le cahier des conditions de vente avant l'audience ?");
  }
  if (!hasDocumentType(sale, /diagnostic|dpe|amiante|plomb|termite/)) {
    questions.push("Quels diagnostics techniques sont disponibles et lesquels manquent encore ?");
  }
  if (!sourceBlockMoney(sale, "consignation")) {
    questions.push("La consignation est-elle confirmée par la source ou encore à vérifier ?");
  }

  return questions;
}

function severityLabel(severity: number | null | undefined): string {
  if (severity == null) return "À vérifier";
  if (severity >= 3) return "Élevé";
  if (severity >= 2) return "Modéré";
  return "Faible";
}

function HeroMeta({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</dt>
      <dd
        className={
          accent
            ? "mt-1.5 text-2xl font-semibold tabular-nums text-foreground"
            : "mt-2 text-base font-medium tabular-nums text-foreground"
        }
      >
        {value}
      </dd>
    </div>
  );
}

function Section({
  id,
  eyebrow,
  title,
  wide = false,
  children,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={`scroll-mt-28 ${wide ? "max-w-full" : "max-w-[728px]"}`}>
      <header className="mb-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gold-soft">
          {eyebrow}
        </span>
        <h2 className="mt-1 font-sans text-base font-semibold text-foreground">{title}</h2>
      </header>
      {children}
    </section>
  );
}

function FoldableSection({
  id,
  eyebrow,
  title,
  summary,
  onOpen,
  children,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  summary: string;
  onOpen?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <details
        className="group rounded-lg border border-border bg-white p-5 shadow-sm"
        onToggle={(event) => {
          if (event.currentTarget.open) onOpen?.();
        }}
      >
        <summary className="flex cursor-pointer list-none items-start justify-between gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.16em] text-gold-soft">{eyebrow}</div>
            <h2 className="mt-3 font-sans text-2xl font-semibold text-foreground sm:text-[1.75rem]">
              {title}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{summary}</p>
          </div>
          <ChevronRight className="mt-3 h-5 w-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        </summary>
        <div className="mt-5 border-t border-border pt-5">{children}</div>
      </details>
    </section>
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

export function SaleDetailSkeleton() {
  return (
    <main className="min-h-screen bg-white px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-7xl">
        <Skeleton className="h-4 w-20 bg-muted" />
        <Skeleton className="mt-4 h-8 w-2/3 bg-muted" />
        <Skeleton className="mt-2 h-4 w-1/2 bg-muted" />
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <Skeleton className="h-96 w-full rounded-lg bg-muted" />
            <Skeleton className="h-40 w-full rounded-lg bg-muted" />
            <Skeleton className="h-32 w-full rounded-lg bg-muted" />
          </div>
          <aside className="space-y-4">
            <Skeleton className="h-48 w-full rounded-lg bg-muted" />
            <Skeleton className="h-32 w-full rounded-lg bg-muted" />
          </aside>
        </div>
      </div>
    </main>
  );
}

export function SaleNotFoundComponent() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-white px-4 py-16 text-center">
      <div className="max-w-2xl rounded-lg border border-border bg-white p-8 shadow-xl shadow-slate-900/10">
        <BrandMark className="mx-auto h-14 w-14" />
        <h1 className="mt-5 font-sans text-2xl font-semibold text-foreground">
          Annonce introuvable
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Cette vente n'existe plus ou a été retirée. Elle peut avoir été adjugée ou supprimée par
          la source.
        </p>
        <Link
          to="/sales"
          className="mt-6 inline-flex items-center rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-foreground/90"
        >
          ← Retour aux annonces
        </Link>
      </div>
    </main>
  );
}

export function SaleErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <main className="flex min-h-screen items-center justify-center bg-white px-4 py-16 text-center">
      <div className="max-w-2xl rounded-lg border border-border bg-white p-8 shadow-xl shadow-slate-900/10">
        <h1 className="font-sans text-2xl font-semibold text-foreground">
          Impossible d'afficher cette annonce
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-foreground/90"
          >
            Réessayer
          </button>
          <Link
            to="/sales"
            className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium hover:border-gold"
          >
            ← Retour aux annonces
          </Link>
        </div>
      </div>
    </main>
  );
}
