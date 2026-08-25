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
import { riskOccurrences } from "./document-workspace";
export function buildDecisionSummary(
  sale: AuctionSale,
  marketEstimate: MarketEstimate | null | undefined,
): DecisionSummary {
  const marketSurface = getMarketValuationSurfaces(sale).builtSurfaceM2;
  const ceilings = computeRecommendedCeilings({
    surface: marketSurface,
    price: Math.max(0, sale.starting_price_eur ?? 0),
    fpt: DEFAULTS.fpt,
    scenario: DEFAULT_MARKET_CEILING_SCENARIO,
    medianPricePerM2: marketEstimate?.actionable ? marketEstimate.medianPricePerM2 : null,
    p25PricePerM2: marketEstimate?.actionable ? marketEstimate.p25PricePerM2 : null,
    p75PricePerM2: marketEstimate?.actionable ? marketEstimate.p75PricePerM2 : null,
  });
  const ceiling = ceilings.withRefreshWorks;

  const primaryCheck = primaryCheckLabel(sale);
  return {
    ceiling,
    ceilingWithoutWorks: ceilings.withoutWorks,
    ceilingWithRefreshWorks: ceilings.withRefreshWorks,
    refreshWorksBudget: ceilings.refreshWorksBudget,
    primaryCheck,
    primaryDocument: primaryDocumentLabel(sale, primaryCheck),
    action: recommendedAction(sale, ceiling),
  };
}

export function primaryCheckLabel(sale: AuctionSale): string {
  if (isUnknownOccupation(sale.occupancy_status)) return "Occupation du bien non confirmée";
  if (hasWorksRisk(sale)) return "Budget travaux à confirmer";
  if (!hasDocumentType(sale, /cahier|conditions/)) return "Cahier des conditions à récupérer";
  if (!hasDocumentType(sale, /diagnostic|dpe|amiante|plomb/)) return "Diagnostics à rechercher";
  return "Frais et conditions à relire avant consignes";
}

export function primaryDocumentLabel(sale: AuctionSale, primaryCheck: string): string {
  const normalized = primaryCheck.toLowerCase();
  if (normalized.includes("occupation")) return "PV descriptif";
  if (normalized.includes("travaux")) return "PV descriptif ou diagnostics";
  if (normalized.includes("diagnostic")) return "Diagnostics techniques";
  if (hasDocumentType(sale, /cahier|conditions/)) return "Cahier des conditions de vente";
  return "Cahier des conditions";
}

export function recommendedAction(sale: AuctionSale, ceiling: MarketCeilingResult): string {
  if (!ceiling.available) return "Renseigner le marché local";
  if (isUnknownOccupation(sale.occupancy_status)) return "Faire confirmer l'occupation";
  if (hasWorksRisk(sale)) return "Chiffrer les travaux";
  if (!hasDocumentType(sale, /cahier|conditions/)) return "Obtenir le cahier des conditions";
  return "Faire relire les conditions de vente";
}

export function hasWorksRisk(sale: AuctionSale): boolean {
  return (sale.risks ?? []).some((risk) =>
    `${risk.risk_label ?? ""} ${risk.risk_type ?? ""}`
      .toLowerCase()
      .match(/travaux|renov|état|etat/),
  );
}

export function isUnknownOccupation(status: string | null | undefined): boolean {
  const normalized = (status ?? "").toLowerCase();
  return !status || normalized === "unknown" || normalized === "inconnu";
}

export function hasDocumentType(sale: AuctionSale, pattern: RegExp): boolean {
  return documentSearchParts(sale).some((part) => pattern.test(part.toLowerCase()));
}

export function documentSearchParts(sale: AuctionSale): string[] {
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

export function countDocuments(sale: AuctionSale): number {
  const richCount = sale.documents_rich?.length ?? 0;
  return richCount > 0 ? richCount : parseDocs(sale.documents).length;
}

export function documentReviewPrompt(document: SaleDocumentRich): string {
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

export function documentPagesToReview(
  sale: AuctionSale,
  document: SaleDocumentRich,
): string | null {
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

export function answerDossierQuestion(
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

export function findOccurrence(sale: AuctionSale, pattern: RegExp): SaleRiskOccurrence | undefined {
  return riskOccurrences(sale).find((occurrence) =>
    `${occurrence.document_label ?? ""} ${occurrence.document_type ?? ""} ${occurrence.excerpt ?? ""}`
      .toLowerCase()
      .match(pattern),
  );
}

export function documentNames(sale: AuctionSale): string[] {
  const rich = sale.documents_rich ?? [];
  if (rich.length) return rich.map((document) => documentName(document));
  return parseDocs(sale.documents).map((document) => document.name ?? document.url);
}

export function documentName(document: SaleDocumentRich): string {
  return (
    document.label ??
    document.url.split("/").filter(Boolean).pop() ??
    documentTypeLabel(document.document_type ?? document.type)
  );
}

export async function copyText(text: string): Promise<void> {
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

export function printAnalysis() {
  if (typeof window === "undefined") return;
  toast.message("Ouverture de l'impression");
  window.print();
}

export async function shareCurrentPage(title: string) {
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

export function saleLocation(
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

export function cleanLocationPart(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\s*,?\s*France\s*$/i, "")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeLocation(value: string | null | undefined): string {
  return cleanLocationPart(value)
    .toLocaleLowerCase("fr-FR")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

export function sourceBlockText(sale: AuctionSale, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = sourceBlockValue(sale, key);
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

export function sourceBlockMoney(sale: AuctionSale, key: string): string | null {
  const value = sourceBlockValue(sale, key);
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) && amount > 0 ? formatPrice(amount) : null;
}

export function sourceBlockValue(sale: AuctionSale, key: string): unknown {
  const direct = sale.source_blocks?.[key];
  if (direct != null && direct !== "") return direct;
  for (const blocks of Object.values(sale.source_blocks_by_source ?? {})) {
    if (!blocks || typeof blocks !== "object") continue;
    const value = blocks[key];
    if (value != null && value !== "") return value;
  }
  return null;
}

export function saleLawyerContact(sale: AuctionSale): string | null {
  return (
    sale.lawyer_contact ??
    sourceBlockText(sale, "contact_avocat", "lawyer_contact", "contact", "telephone", "phone")
  );
}

export function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

export function cleanContactValue(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function lawyerContactHref(contact: string | null): string | null {
  if (!contact) return null;
  if (/^https?:\/\//i.test(contact)) return contact;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) return `mailto:${contact}`;
  const phone = contact.replace(/[^\d+]/g, "");
  return phone.length >= 8 ? `tel:${phone}` : null;
}

export function lawyerQuestions(sale: AuctionSale): string[] {
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
