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
import { AcquisitionCost, DecisionSummary } from "./decision-view";
import { isExternalHref, lawyerQuestions } from "./detail-helpers";
import { CostRow, DocumentsWorkspace } from "./document-workspace";
export const SECTION_NAV = [
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

export function LawyerQuestionsBlock({
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

export function LawyerQuestionsList({ questions }: { questions: string[] }) {
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

export function RedfinPropertyDetailsBlock({ groups }: { groups: ProductGroup[] }) {
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

export function SourcesAndDocumentsBlock({
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

export function ListingActionBar({
  sale,
  title,
  decision,
  location,
  returnTo,
}: {
  sale: AuctionSale;
  title: string;
  decision: DecisionSummary;
  location: string;
  returnTo: string;
}) {
  return (
    <nav className="sticky top-16 z-40 border-b border-border bg-white/95 backdrop-blur">
      <div className="flex min-h-11 w-full items-center justify-between gap-3 px-4 py-1.5 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to={returnTo}
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

export function saleMapboxLocation(sale: AuctionSale): { lat: number; lng: number } | null {
  if (sale.latitude != null && sale.longitude != null) {
    return { lat: sale.latitude, lng: sale.longitude };
  }
  return null;
}

export function saleMediaCarouselImages(media: SaleMedia[], title: string): CarouselImage[] {
  return media.map((item, index) => ({
    id: `${item.url}-${index}`,
    url: item.url,
    alt: index === 0 ? `Photo principale de ${title}` : `Photo ${index + 1} de ${title}`,
    source: item.source,
  }));
}

export function saleImages(media: AuctionSale["media"] | undefined): SaleMedia[] {
  return propertyImages(media);
}
