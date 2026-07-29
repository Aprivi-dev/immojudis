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
import { AcquisitionCost } from "./decision-view";
import {
  answerDossierQuestion,
  countDocuments,
  documentPagesToReview,
  documentReviewPrompt,
} from "./detail-helpers";
export function DocumentsWorkspace({ sale }: { sale: AuctionSale }) {
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
                          sandbox=""
                          referrerPolicy="no-referrer"
                          loading="lazy"
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

export function CostRow({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${strong ? "font-semibold" : ""}`}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

export type AdvancedAssumptions = {
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

export type DocumentWorkspaceState = {
  notes: Record<string, string>;
  readPages: Record<string, boolean>;
  highlighted: string | null;
  reviews: SaleWorkspaceDocumentReviews;
};

export type DocumentReviewMetadata = Pick<
  SaleWorkspaceDocumentReview,
  "documentLabel" | "documentType" | "documentUrl"
>;

export type LocalStateSetter<T> = (next: T | ((current: T) => T)) => void;

export function useLocalState<T>(key: string, initialValue: T): [T, LocalStateSetter<T>] {
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

export function readLocalState<T>(key: string, fallback: T): T {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function saleStorageKey(saleId: string, scope: string): string {
  return `immojudis:sale:${saleId}:${scope}`;
}

export function hasDocumentWorkspaceState(state: DocumentWorkspaceState): boolean {
  return Boolean(
    Object.keys(state.reviews).length ||
    Object.values(state.notes).some((note) => note.trim()) ||
    Object.values(state.readPages).some(Boolean) ||
    state.highlighted,
  );
}

export function hydrateDocumentReviewState(
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

export function enrichDocumentReview(
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

export function updateDocumentWorkspaceReview(
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

export function buildSaleDocumentReviews(
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

export function documentReadPagesForKey(
  readPages: Record<string, boolean>,
  documentKeyValue: string,
): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(readPages).filter(([pageKey]) => pageKey.startsWith(`${documentKeyValue}:`)),
  );
}

export function countReviewedDocuments(reviews: SaleWorkspaceDocumentReviews): number {
  return Object.values(reviews).filter((review) => review.status === "reviewed").length;
}

export function signedAmount(value: number): string {
  const rounded = Math.round(value);
  return `${rounded >= 0 ? "+" : "-"}${formatPrice(Math.abs(rounded))}`;
}

export function riskOccurrences(sale: AuctionSale): SaleRiskOccurrence[] {
  return (sale.risks ?? []).flatMap((risk) => risk.occurrences ?? []);
}

export function documentKey(document: SaleDocumentRich): string {
  return [document.document_type ?? document.type, document.label, document.url]
    .filter(Boolean)
    .join(":");
}

export function documentOccurrences(
  sale: AuctionSale,
  document: SaleDocumentRich,
): SaleRiskOccurrence[] {
  const documentType = document.document_type ?? document.type;
  return riskOccurrences(sale).filter((occurrence) => {
    const sameType = documentType && occurrence.document_type === documentType;
    const sameLabel = document.label && occurrence.document_label === document.label;
    const sameUrl = document.url && occurrence.document_url === document.url;
    return Boolean(sameType || sameLabel || sameUrl);
  });
}

export function AdvancedAssumptionsBlock({
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

export function MoneyField({
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

export function DossierAssistant({
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
