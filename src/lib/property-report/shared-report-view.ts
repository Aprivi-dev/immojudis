import type { AudienceReadinessAnalysis } from "@/lib/audience-readiness-analysis";
import type { DemographicAnalysis } from "@/lib/demographic-analysis";
import type { DpeAnalysis } from "@/lib/dpe-analysis";
import {
  formatDate,
  formatPrice,
  formatPricePerM2,
  formatStartingPrice,
  formatSurface,
} from "@/lib/format";
import { asRecord, numberValue, stringOrNumberValue } from "@/lib/guards";
import type { LegalAttentionAnalysis } from "@/lib/legal-attention-analysis";
import type { NearbyServicesAnalysis } from "@/lib/nearby-services";
import type { NeighborhoodAnalysis } from "@/lib/neighborhood-analysis";
import type { RenovationAnalysis } from "@/lib/renovation-analysis";
import type { UrbanPlanningItem } from "@/lib/urban-planning-analysis";
import type { ValuationAudit } from "@/lib/valuation-audit";

/**
 * Lecture, pour la page du rapport partagé, des listes de l'analyse figée dans `report_snapshot`
 * (écrite par `./analysis.ts` à partir des modules `*-analysis.ts`). Les clés des tables de
 * libellés sont typées sur ces modules : un code renommé à l'écriture casse la compilation ici.
 *
 * Le PDF lit le même JSON dans `./serialization.ts` avec d'autres mots et un autre séparateur
 * (« | ») : un champ renommé à l'écriture se corrige dans les deux fichiers.
 *
 * Un rapport partagé peut être ancien (le lien n'a pas toujours d'échéance et l'instantané est
 * figé à l'enregistrement) : chaque entrée est lue comme un objet quelconque, et un code absent
 * des tables s'affiche tel quel au lieu de faire disparaître la ligne.
 */

type Priority =
  | LegalAttentionAnalysis["items"][number]["priority"]
  | UrbanPlanningItem["priority"]
  | AudienceReadinessAnalysis["checklist"][number]["priority"];

const PRIORITY_LABELS: Record<Priority, string> = {
  high: "Prioritaire",
  medium: "À vérifier",
  low: "Contrôle",
};

const AUDIENCE_CHECKLIST_STATUS_LABELS: Record<
  AudienceReadinessAnalysis["checklist"][number]["status"],
  string
> = {
  done: "OK",
  to_do: "À faire",
  watch: "À vérifier",
};

const URBAN_PLANNING_STATUS_LABELS: Record<UrbanPlanningItem["status"], string> = {
  documented: "Documenté",
  to_verify: "À confirmer",
  missing: "Manquant",
};

const RENOVATION_PRIORITY_LABELS: Record<
  RenovationAnalysis["priority"] | DpeAnalysis["renovationPriority"],
  string
> = {
  low: "Faible",
  medium: "À calibrer",
  high: "Prioritaire",
  unknown: "À qualifier",
};

// « ademe » (diagnostic retrouvé dans la base ADEME) n'a pas encore de libellé sur cette page : il
// s'affiche « À confirmer ».
const DPE_SOURCE_LABELS: Partial<Record<NonNullable<DpeAnalysis["source"]>, string>> = {
  source_blocks: "Données source",
  documents: "Pièces du dossier",
  risk_evidence: "Preuves de risques",
};

const LOCATION_QUALITY_LABELS: Record<NearbyServicesAnalysis["locationQuality"], string> = {
  coordinates: "Coordonnées disponibles",
  address: "Adresse disponible",
  commune: "Commune disponible",
  missing: "À géocoder",
};

const NEIGHBORHOOD_SIGNAL_STATUS_LABELS: Record<
  NeighborhoodAnalysis["signals"][number]["status"],
  string
> = {
  positive: "Atout",
  watch: "À vérifier",
  to_enrich: "À enrichir",
};

const DEMOGRAPHIC_SIGNAL_STATUS_LABELS: Record<
  DemographicAnalysis["signals"][number]["status"],
  string
> = {
  source_signal: "Signal source",
  proxy: "Proxy",
};

const VALUATION_CHECKPOINT_STATUS_LABELS: Record<
  ValuationAudit["checkpoints"][number]["status"],
  string
> = {
  ok: "OK",
  watch: "À surveiller",
  risk: "Risque",
  missing: "Manquant",
};

function labelOf(labels: Partial<Record<string, string>>, code: string, fallback: string): string {
  return (Object.hasOwn(labels, code) ? labels[code] : undefined) ?? fallback;
}

function textOf(record: Record<string, unknown>, key: string): string {
  return stringOrNumberValue(record[key], "");
}

function lines(value: unknown, line: (record: Record<string, unknown>) => string): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => line(asRecord(item))).filter(Boolean);
}

function joinParts(parts: Array<string | null>): string {
  return parts.filter(Boolean).join(" · ");
}

function actionPart(record: Record<string, unknown>): string | null {
  const action = textOf(record, "action");
  return action ? `Action : ${action}` : null;
}

function priorityLabel(code: string): string {
  return labelOf(PRIORITY_LABELS, code, code);
}

export function renovationPriorityLabel(code: unknown): string {
  return labelOf(RENOVATION_PRIORITY_LABELS, stringOrNumberValue(code, ""), "À confirmer");
}

export function dpeSourceLabel(code: unknown): string {
  return labelOf(DPE_SOURCE_LABELS, stringOrNumberValue(code, ""), "À confirmer");
}

export function locationQualityLabel(code: unknown): string {
  return labelOf(LOCATION_QUALITY_LABELS, stringOrNumberValue(code, ""), "À confirmer");
}

/** Indices d'occupation, de DPE ou de travaux : `{ label, source, excerpt }`. */
export function evidenceLines(value: unknown): string[] {
  return lines(value, (record) =>
    joinParts([textOf(record, "label"), textOf(record, "source"), textOf(record, "excerpt")]),
  );
}

export function neighborhoodSignalLines(value: unknown): string[] {
  return lines(value, (record) => {
    const status = textOf(record, "status");
    return joinParts([
      labelOf(NEIGHBORHOOD_SIGNAL_STATUS_LABELS, status, status),
      textOf(record, "label"),
      textOf(record, "source"),
      textOf(record, "detail"),
    ]);
  });
}

export function demographicSignalLines(value: unknown): string[] {
  return lines(value, (record) => {
    const status = textOf(record, "status");
    return joinParts([
      labelOf(DEMOGRAPHIC_SIGNAL_STATUS_LABELS, status, status),
      textOf(record, "label"),
      textOf(record, "source"),
      textOf(record, "detail"),
      textOf(record, "impact"),
    ]);
  });
}

export function legalAttentionLines(value: unknown): string[] {
  return lines(value, (record) =>
    joinParts([
      priorityLabel(textOf(record, "priority")),
      textOf(record, "label"),
      textOf(record, "reason"),
      actionPart(record),
    ]),
  );
}

export function urbanPlanningLines(value: unknown): string[] {
  return lines(value, (record) => {
    const status = textOf(record, "status");
    return joinParts([
      priorityLabel(textOf(record, "priority")),
      labelOf(URBAN_PLANNING_STATUS_LABELS, status, status),
      textOf(record, "label"),
      textOf(record, "source"),
      textOf(record, "detail"),
      actionPart(record),
    ]);
  });
}

/** Transactions DVF retenues et historique de l'adresse. */
export function marketComparableLines(value: unknown): string[] {
  return lines(value, (record) => {
    const date = textOf(record, "date");
    const totalPrice = numberValue(record.totalPriceEur);
    const pricePerM2 = numberValue(record.pricePerM2);
    const surface = numberValue(record.surfaceM2);
    const distance = numberValue(record.distanceM);
    return joinParts([
      date ? formatDate(date) : null,
      stringOrNumberValue(record.type, "Bien"),
      totalPrice != null ? formatPrice(totalPrice) : null,
      pricePerM2 != null ? formatPricePerM2(pricePerM2) : null,
      surface != null ? formatSurface(surface) : null,
      distance != null ? `${Math.round(distance)} m` : null,
    ]);
  });
}

export function valuationCheckpointLines(value: unknown): string[] {
  return lines(value, (record) => {
    const status = textOf(record, "status");
    return joinParts([
      labelOf(VALUATION_CHECKPOINT_STATUS_LABELS, status, status),
      textOf(record, "label"),
      textOf(record, "detail"),
      actionPart(record),
    ]);
  });
}

/** Biens comparables encore en vente. */
export function activeComparableLines(value: unknown): string[] {
  return lines(value, (record) => {
    const matchLabel = textOf(record, "matchLabel");
    const matchScore = numberValue(record.matchScore);
    const saleDate = textOf(record, "saleDate");
    const startingPrice = numberValue(record.startingPriceEur);
    const pricePerM2 = numberValue(record.pricePerM2);
    const surface = numberValue(record.surfaceM2);
    return joinParts([
      matchLabel && matchScore != null ? `${matchLabel} (${matchScore}/100)` : matchLabel,
      stringOrNumberValue(record.title, "Bien actif"),
      textOf(record, "city"),
      saleDate ? formatDate(saleDate) : null,
      startingPrice != null ? formatStartingPrice(startingPrice) : null,
      pricePerM2 != null ? formatPricePerM2(pricePerM2) : null,
      surface != null ? formatSurface(surface) : null,
    ]);
  });
}

export function audienceChecklistLines(value: unknown): string[] {
  return lines(value, (record) => {
    const status = textOf(record, "status");
    return joinParts([
      labelOf(AUDIENCE_CHECKLIST_STATUS_LABELS, status, status),
      priorityLabel(textOf(record, "priority")),
      textOf(record, "label"),
      textOf(record, "detail"),
      actionPart(record),
    ]);
  });
}
