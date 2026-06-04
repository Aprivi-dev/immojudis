import type * as React from "react";
import { useMemo } from "react";
import Activity from "lucide-react/dist/esm/icons/activity.js";
import Bug from "lucide-react/dist/esm/icons/bug.js";
import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import Droplets from "lucide-react/dist/esm/icons/droplets.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import FileWarning from "lucide-react/dist/esm/icons/file-warning.js";
import Flame from "lucide-react/dist/esm/icons/flame.js";
import Gavel from "lucide-react/dist/esm/icons/gavel.js";
import Home from "lucide-react/dist/esm/icons/home.js";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import Zap from "lucide-react/dist/esm/icons/zap.js";
import type {
  AuctionSale,
  RiskEvidenceJson,
  SaleAnalysisFact,
  SaleEvidenceRef,
  SaleRisk,
  SaleRiskOccurrence,
  SaleScoreFactor,
  ScoreFactorExplanation,
} from "@/lib/types";
import { documentTypeHelp, documentTypeLabel } from "@/lib/format";

type Factor = {
  key: string;
  label: string;
  reason: string | null;
  delta: number;
  raw?: string;
  confidence?: number | null;
  evidence?: string | null;
  explanation?: ScoreFactorExplanation | null;
  evidenceRefs: SaleEvidenceRef[];
};

// Labels FR pour les clés techniques du résumé
const FACTOR_LABELS: Record<string, string> = {
  occupation: "Occupation",
  état: "État du bien",
  etat: "État du bien",
  type: "Type de bien",
  localisation: "Localisation",
  surface: "Surface",
  prix_m2: "Prix au m²",
  atouts: "Atouts",
  risques: "Risques détectés",
  qualité: "Qualité des données",
  qualite: "Qualité des données",
};

function parseSummary(summary: string | null | undefined): { factors: Factor[]; total: number } {
  if (!summary) return { factors: [], total: 0 };
  // Format attendu : "key: description (+X); key: description (-Y); ..."
  const parts = summary.split(/;\s*/).filter(Boolean);
  const factors: Factor[] = [];
  let total = 0;
  for (const part of parts) {
    const m = part.match(/^([^:]+):\s*(.+?)\s*\(([+-]?\d+(?:[.,]\d+)?)\)\s*$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    const desc = m[2].trim();
    const delta = parseFloat(m[3].replace(",", "."));
    if (Number.isNaN(delta)) continue;
    const baseLabel = FACTOR_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
    factors.push({
      key,
      label: baseLabel,
      reason: desc,
      delta,
      raw: part,
      explanation: fallbackExplanation(key, desc, delta),
      evidenceRefs: [],
    });
    total += delta;
  }
  return { factors, total };
}

function normalizeScoreFactors(
  scoreFactors: SaleScoreFactor[] | null | undefined,
  summary: string | null | undefined,
): { factors: Factor[]; total: number } {
  const structured = (scoreFactors ?? [])
    .filter((factor) => factor && Number.isFinite(Number(factor.delta)))
    .sort((a, b) => (a.factor_order ?? 0) - (b.factor_order ?? 0))
    .map((factor) => {
      const key = factor.factor_key || factor.label || "facteur";
      const baseLabel = FACTOR_LABELS[key.toLowerCase()] ?? factor.label ?? key;
      return {
        key,
        label: baseLabel,
        reason: factor.reason,
        delta: Number(factor.delta),
        confidence: factor.confidence,
        evidence: factor.evidence,
        explanation: normalizeExplanation(
          factor.normalized_value,
          key,
          factor.reason,
          Number(factor.delta),
        ),
        evidenceRefs: normalizeEvidenceRefs(factor.evidence_refs),
      };
    });
  if (structured.length === 0) return parseSummary(summary);
  return {
    factors: structured,
    total: structured.reduce((sum, factor) => sum + factor.delta, 0),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeExplanation(
  value: unknown,
  key: string,
  reason: string | null | undefined,
  delta: number,
): ScoreFactorExplanation {
  const fallback = fallbackExplanation(key, reason, delta);
  if (!isRecord(value)) return fallback;
  return {
    ...fallback,
    status: stringValue(value.status) ?? fallback.status,
    axis: stringValue(value.axis) ?? fallback.axis,
    axis_label: stringValue(value.axis_label) ?? fallback.axis_label,
    question: stringValue(value.question) ?? fallback.question,
    decision: stringValue(value.decision) ?? fallback.decision,
    criterion: stringValue(value.criterion) ?? fallback.criterion,
    reasoning: stringValue(value.reasoning) ?? fallback.reasoning,
    calculation: stringValue(value.calculation) ?? fallback.calculation,
    score_before: numberValue(value.score_before),
    score_after: numberValue(value.score_after),
    confidence_note: stringValue(value.confidence_note) ?? fallback.confidence_note,
    limits: stringValue(value.limits) ?? fallback.limits,
    raw_value_label: stringValue(value.raw_value_label) ?? fallback.raw_value_label,
    facts: normalizeAnalysisFacts(value.facts),
    proof_level: stringValue(value.proof_level) ?? fallback.proof_level,
  };
}

function fallbackExplanation(
  key: string,
  reason: string | null | undefined,
  delta: number,
): ScoreFactorExplanation {
  const label = FACTOR_LABELS[key.toLowerCase()] ?? key;
  return {
    status: delta > 0 ? "favorable" : delta < 0 ? "vigilance" : "neutre",
    axis: "analysis_confidence",
    axis_label: "Analyse",
    question: "Que signifie ce facteur pour la décision d'enchérir ?",
    decision: reason || "Facteur pris en compte dans le score.",
    criterion: `${label} pris en compte dans le score global.`,
    reasoning: reason || "Aucun détail complémentaire n'est disponible pour ce facteur.",
    calculation: `Impact appliqué au score : ${signedDelta(delta)} point${Math.abs(delta) > 1 ? "s" : ""}.`,
    limits: "À confirmer dans les documents sources si ce facteur influence la décision.",
  };
}

function normalizeEvidenceRefs(value: unknown): SaleEvidenceRef[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    label: stringValue(item.label),
    document_label: stringValue(item.document_label),
    document_type: stringValue(item.document_type),
    page_number: numberValue(item.page_number),
    excerpt: stringValue(item.excerpt),
    confidence: numberValue(item.confidence),
  }));
}

function normalizeAnalysisFacts(value: unknown): SaleAnalysisFact[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((item) => ({
      status: stringValue(item.status),
      statement: stringValue(item.statement),
      document_label: stringValue(item.document_label),
      document_type: stringValue(item.document_type),
      page_number: numberValue(item.page_number),
      confidence: numberValue(item.confidence),
    }))
    .filter((item) => item.statement);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function signedDelta(value: number): string {
  return value > 0 ? `+${formatNumber(value)}` : formatNumber(value);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

// Libellés clairs par type de risque
const RISK_LABELS: Record<string, { label: string; icon: React.ReactNode; category: string }> = {
  amiante: { label: "Amiante détecté", icon: <Flame className="h-4 w-4" />, category: "Sanitaire" },
  plomb: { label: "Plomb (CREP)", icon: <Droplets className="h-4 w-4" />, category: "Sanitaire" },
  termites: { label: "Termites", icon: <Bug className="h-4 w-4" />, category: "Structurel" },
  travaux: {
    label: "Travaux à vérifier",
    icon: <FileWarning className="h-4 w-4" />,
    category: "État du bien",
  },
  servitude: { label: "Servitude", icon: <Gavel className="h-4 w-4" />, category: "Juridique" },
  copropriété: { label: "Copropriété", icon: <Home className="h-4 w-4" />, category: "Juridique" },
  copropriete: { label: "Copropriété", icon: <Home className="h-4 w-4" />, category: "Juridique" },
  dpe: { label: "DPE défavorable", icon: <Zap className="h-4 w-4" />, category: "Énergétique" },
  hypothèque: {
    label: "Hypothèque",
    icon: <FileWarning className="h-4 w-4" />,
    category: "Juridique",
  },
  hypotheque: {
    label: "Hypothèque",
    icon: <FileWarning className="h-4 w-4" />,
    category: "Juridique",
  },
  saisie: {
    label: "Saisie immobilière",
    icon: <Gavel className="h-4 w-4" />,
    category: "Juridique",
  },
  occupation: {
    label: "Occupation à clarifier",
    icon: <Home className="h-4 w-4" />,
    category: "Occupation",
  },
};

function getRiskMeta(r: SaleRisk) {
  const key = (r.risk_label || r.risk_type || "").toLowerCase().trim();
  const meta = RISK_LABELS[key];
  return {
    label: meta?.label ?? r.risk_label ?? r.risk_type ?? "Risque",
    icon: meta?.icon ?? <ShieldAlert className="h-4 w-4" />,
    category: meta?.category ?? "Autre",
  };
}

function confidenceLabel(confidence: number | null | undefined): string | null {
  if (confidence == null) return null;
  return `${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}%`;
}

function firstOccurrence(risk: SaleRisk): SaleRiskOccurrence | null {
  const occurrences = risk.occurrences ?? [];
  return (
    [...occurrences]
      .filter((occurrence) => Boolean(occurrence?.excerpt))
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0] ?? null
  );
}

function occurrenceSource(occurrence: SaleRiskOccurrence | null): string | null {
  if (!occurrence) return null;
  const parts = [
    occurrence.document_label ||
      (occurrence.document_type ? documentTypeLabel(occurrence.document_type) : null),
    occurrence.page_number ? `page ${occurrence.page_number}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function riskEvidenceJson(risk: SaleRisk): RiskEvidenceJson | null {
  return isRecord(risk.evidence_json) ? (risk.evidence_json as RiskEvidenceJson) : null;
}

function riskReasoning(risk: SaleRisk, occurrence: SaleRiskOccurrence | null): string {
  const evidence = riskEvidenceJson(risk);
  if (evidence?.reasoning) return evidence.reasoning;
  const type = occurrence?.document_type || evidence?.document_type;
  const source = type ? documentTypeLabel(type) : "document source";
  return `La mention est retenue parce qu'elle apparaît dans un contexte relié au bien, depuis ${source}.`;
}

function riskWhyItMatters(risk: SaleRisk): string | null {
  const evidence = riskEvidenceJson(risk);
  return evidence?.why_it_matters ?? null;
}

function riskEvidenceSource(risk: SaleRisk, occurrence: SaleRiskOccurrence | null): string | null {
  const evidence = riskEvidenceJson(risk);
  const documentType = occurrence?.document_type || evidence?.document_type;
  const documentLabel =
    occurrence?.document_label ||
    evidence?.document_label ||
    (documentType ? documentTypeLabel(documentType) : null);
  const page = occurrence?.page_number || evidence?.page_number;
  const parts = [documentLabel, page ? `page ${page}` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function severityBucket(sev: number | null | undefined): 1 | 2 | 3 {
  const s = sev ?? 1;
  if (s >= 3) return 3;
  if (s === 2) return 2;
  return 1;
}

const SEVERITY_STYLES: Record<
  1 | 2 | 3,
  { dot: string; bg: string; text: string; border: string; label: string }
> = {
  3: {
    dot: "bg-red-500",
    bg: "bg-red-500/10",
    text: "text-red-100",
    border: "border-red-300/20",
    label: "Majeur",
  },
  2: {
    dot: "bg-amber-500",
    bg: "bg-amber-400/10",
    text: "text-amber-100",
    border: "border-amber-300/20",
    label: "Modéré",
  },
  1: {
    dot: "bg-yellow-400",
    bg: "bg-white/[0.04]",
    text: "text-gold-soft",
    border: "border-white/10",
    label: "Mineur",
  },
};

function verdictFor(
  score: number | null | undefined,
  positives: number,
  negatives: number,
): string {
  if (score == null) {
    if (negatives === 0) return "Profil neutre — aucune alerte détectée.";
    return `Profil à analyser — ${negatives} point${negatives > 1 ? "s" : ""} de vigilance.`;
  }
  if (score >= 80) return "Excellent profil d'investissement.";
  if (score >= 60) {
    return negatives > 0
      ? `Investissement intéressant, sous réserve de ${negatives} point${negatives > 1 ? "s" : ""} de vigilance.`
      : "Investissement intéressant.";
  }
  if (score >= 40) return "Profil moyen — à étudier en détail avant de se positionner.";
  return "Profil risqué — vigilance forte recommandée.";
}

type ChecklistItem = {
  label: string;
  detail: string;
  tone: "ok" | "warning" | "todo";
};

type ScoreLens = {
  key: string;
  label: string;
  value: string;
  detail: string;
  tone: "good" | "ok" | "warning" | "bad";
  icon: "potential" | "risk" | "confidence";
};

type RiskItem = {
  key: string;
  meta: ReturnType<typeof getRiskMeta>;
  risk: SaleRisk;
  severity: 1 | 2 | 3;
};

function buildRiskItems(risks: SaleRisk[]): RiskItem[] {
  const seen = new Set<string>();
  return risks
    .map((risk) => {
      const meta = getRiskMeta(risk);
      return {
        key: `${meta.label}`,
        meta,
        risk,
        severity: severityBucket(risk.severity),
      } satisfies RiskItem;
    })
    .filter((item) => {
      if (seen.has(item.key)) return false;
      seen.add(item.key);
      return true;
    })
    .sort((a, b) => riskPriorityScore(b.risk) - riskPriorityScore(a.risk));
}

function riskPriorityScore(risk: SaleRisk): number {
  const severity = severityBucket(risk.severity) * 100;
  const impact = Math.abs(risk.score_impact ?? 0);
  const confidence = Math.round((risk.confidence ?? 0) * 10);
  return severity + impact + confidence;
}

function sortAxesByImpact(axes: AxisSummary[]): AxisSummary[] {
  return [...axes].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

type AxisSummary = {
  key: string;
  label: string;
  question: string;
  delta: number;
  status: string;
  facts: AxisFact[];
};

type AxisFact = SaleAnalysisFact & {
  factor_key?: string | null;
  factor_label?: string | null;
};

const AXIS_ORDER = [
  "financial_attractiveness",
  "asset_quality",
  "legal_security",
  "liquidity_resale",
  "analysis_confidence",
];

function axisSummaries(factors: Factor[]): AxisSummary[] {
  const grouped = new Map<string, AxisSummary>();
  for (const factor of factors) {
    const axis = factor.explanation?.axis || "analysis_confidence";
    const current =
      grouped.get(axis) ??
      ({
        key: axis,
        label: factor.explanation?.axis_label || "Analyse",
        question:
          factor.explanation?.question || "Que signifie ce facteur pour la décision d'enchérir ?",
        delta: 0,
        status: "neutre",
        facts: [],
      } satisfies AxisSummary);
    current.delta += factor.delta;
    const facts = normalizeAnalysisFacts(factor.explanation?.facts)
      .slice(0, 2)
      .map((fact) => ({
        ...fact,
        statement: humanizeFactorFact(fact, factor),
        factor_key: factor.key,
        factor_label: factor.label,
      }));
    if (facts.length === 0 && factor.reason) {
      facts.push({
        status: factor.delta > 0 ? "favorable" : factor.delta < 0 ? "vigilance" : "neutre",
        statement: humanizeFactorReason(factor),
        confidence: factor.confidence,
        factor_key: factor.key,
        factor_label: factor.label,
      });
    }
    current.facts.push(...facts);
    if (!current.label && factor.explanation?.axis_label)
      current.label = factor.explanation.axis_label;
    grouped.set(axis, current);
  }
  return [...grouped.values()]
    .map((axis) => ({
      ...axis,
      status: axis.delta > 0 ? "favorable" : axis.delta < 0 ? "vigilance" : "neutre",
      facts: dedupeAxisFacts(axis.facts).slice(0, 3),
    }))
    .sort((a, b) => AXIS_ORDER.indexOf(a.key) - AXIS_ORDER.indexOf(b.key));
}

function humanizeFactorFact(fact: SaleAnalysisFact, factor: Factor): string {
  const raw = fact.statement?.trim() || "";
  const key = factor.key.toLowerCase();
  const empty = isEmptyFact(raw);
  const numeric = numberValue(raw);

  if (empty) return emptyFactText(factor);
  if (looksAlreadyHuman(raw)) return raw;
  if (key.includes("occup")) return `Occupation retenue : ${occupancyText(raw)}.`;
  if (key.includes("type")) return `Type de bien retenu : ${propertyTypeText(raw)}.`;
  if (key.includes("localisation")) return locationText(raw);
  if (key.includes("surface") && numeric != null) {
    return `Surface exploitable retenue : ${formatFactNumber(numeric)} m².`;
  }
  if (key.includes("prix") && numeric != null) {
    return `Mise à prix rapportée à la surface : environ ${formatFactNumber(numeric)} €/m².`;
  }
  if (key.includes("atout")) return `Atouts d'usage détectés : ${raw}.`;
  if (key.includes("risque")) return `Point de vigilance retenu : ${raw}.`;
  if (key.includes("qual")) return `Point de qualité des données : ${raw}.`;
  if (key.includes("état") || key.includes("etat")) return `État du bien retenu : ${raw}.`;
  return raw;
}

function humanizeFactorReason(factor: Factor): string {
  const reason = factor.reason?.replace(/\s+/g, " ").trim();
  if (!reason) return emptyFactText(factor);
  const key = factor.key.toLowerCase();
  if (key.includes("état") || key.includes("etat")) return `État du bien : ${reason}.`;
  if (key.includes("qual")) return `Qualité des données : ${reason}.`;
  if (key.includes("risque")) return emptyFactText(factor);
  return reason.endsWith(".") ? reason : `${reason}.`;
}

function emptyFactText(factor: Factor): string {
  const key = factor.key.toLowerCase();
  if (key.includes("risque")) {
    return "Aucun risque contextualisé n'a été retenu dans les éléments analysés.";
  }
  if (key.includes("qual")) {
    return "Aucune pénalité qualité : les données structurantes sont exploitables.";
  }
  if (key.includes("atout")) return "Aucun atout d'usage spécifique n'a été détecté.";
  return factor.reason || "Information à confirmer dans les pièces sources.";
}

function isEmptyFact(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    !normalized ||
    normalized === "aucune valeur détectée" ||
    normalized === "aucune valeur detectee" ||
    normalized === "[]" ||
    normalized === "null"
  );
}

function looksAlreadyHuman(value: string): boolean {
  return value.includes(":") || /[.!?]$/.test(value.trim());
}

function propertyTypeText(value: string): string {
  return (
    {
      apartment: "appartement",
      house: "maison",
      building: "immeuble",
      mixed: "actif mixte",
      commercial: "local commercial",
      land: "terrain",
      parking: "parking",
      unknown: "type à confirmer",
      other: "type à confirmer",
    }[value.toLowerCase()] ?? value
  );
}

function occupancyText(value: string): string {
  return (
    {
      vacant: "libre",
      rented: "loué",
      occupied: "occupé",
      owner_occupied: "occupé par le propriétaire",
      squatted: "occupation sans droit ni titre",
      unknown: "à confirmer",
    }[value.toLowerCase()] ?? value
  );
}

function locationText(value: string): string {
  if (/^tj\s+/i.test(value)) {
    return `Localisation rattachée au ${value.replace(/^tj\s+/i, "TJ ")}.`;
  }
  return `Localisation retenue : ${value}.`;
}

function formatFactNumber(value: number): string {
  return new Intl.NumberFormat("fr-FR", {
    maximumFractionDigits: value >= 100 ? 0 : 1,
  }).format(value);
}

function dedupeAxisFacts(facts: AxisFact[]): AxisFact[] {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = fact.statement?.toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function shortText(value: string | null | undefined, max = 115): string {
  if (!value) return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  const clipped = normalized
    .slice(0, max - 1)
    .replace(/\s+\S*$/, "")
    .trim();
  return `${clipped || normalized.slice(0, max - 1).trim()}…`;
}

function riskKey(risk: SaleRisk): string {
  return `${risk.risk_label ?? ""} ${risk.risk_type ?? ""}`.toLowerCase();
}

function riskCertainty(
  risk: SaleRisk,
  occurrence: SaleRiskOccurrence | null,
): { label: string; detail: string; className: string } {
  const evidence = riskEvidenceJson(risk);
  const decision = evidence?.decision?.toLowerCase() ?? "";
  const confidence = occurrence?.confidence ?? risk.confidence ?? evidence?.confidence ?? null;
  if (decision.includes("confirm") || (confidence != null && confidence >= 0.82)) {
    return {
      label: "Risque confirmé",
      detail: "Mention contextualisée dans une pièce reliée au bien.",
      className: "border border-red-300/20 bg-red-500/15 text-red-100",
    };
  }
  if (confidence != null && confidence >= 0.62) {
    return {
      label: "Risque probable",
      detail: "Indice solide, mais à relire dans la pièce source.",
      className: "border border-amber-300/20 bg-amber-400/15 text-amber-100",
    };
  }
  return {
    label: "À confirmer",
    detail: "Indice détecté, preuve ou contexte encore insuffisant.",
    className: "border border-white/10 bg-white/10 text-muted-foreground",
  };
}

function riskDocumentContext(risk: SaleRisk, occurrence: SaleRiskOccurrence | null): string | null {
  const evidence = riskEvidenceJson(risk);
  if (evidence?.document_context) return evidence.document_context;
  const type = occurrence?.document_type || evidence?.document_type;
  return type ? documentTypeHelp(type) : null;
}

function riskActions(risk: SaleRisk): string[] {
  const key = riskKey(risk);
  if (key.includes("travaux") || key.includes("état") || key.includes("etat")) {
    return [
      "Demander ou estimer un budget travaux réaliste.",
      "Vérifier si la mention décrit le bien vendu, et pas seulement la procédure.",
      "Intégrer une marge de sécurité dans le prix maximum.",
    ];
  }
  if (
    key.includes("plomb") ||
    key.includes("amiante") ||
    key.includes("termite") ||
    key.includes("dpe")
  ) {
    return [
      "Relire le diagnostic technique concerné.",
      "Identifier si l'anomalie impose des travaux, une obligation ou seulement une information.",
      "Faire chiffrer l'impact avant de fixer le prix plafond.",
    ];
  }
  if (key.includes("servitude")) {
    return [
      "Relire le cahier des conditions de vente et les annexes.",
      "Comprendre précisément le droit accordé ou subi par le bien.",
      "Vérifier l'impact sur l'usage, l'accès ou la revente.",
    ];
  }
  if (key.includes("copro")) {
    return [
      "Contrôler les charges, impayés éventuels et travaux votés.",
      "Lire les pièces de copropriété disponibles.",
      "Prévoir une réserve de trésorerie après adjudication.",
    ];
  }
  if (key.includes("occup") || key.includes("bail") || key.includes("lou")) {
    return [
      "Identifier le titre d'occupation et les conditions du bail.",
      "Évaluer le délai et le coût éventuel pour récupérer le bien.",
      "Adapter le prix plafond à la disponibilité réelle du bien.",
    ];
  }
  return [
    "Relire l'extrait source dans son document complet.",
    "Valider l'impact avec un professionnel si le point influence l'offre.",
    "Conserver une marge de sécurité dans le prix maximum.",
  ];
}

function buildChecklist(sale: AuctionSale, risks: SaleRisk[], factors: Factor[]): ChecklistItem[] {
  const docsCount = sale.documents_rich?.length ?? 0;
  const hasOccupationFactor = factors.some((factor) => factor.key.toLowerCase().includes("occup"));
  const occupationKnown =
    Boolean(sale.occupancy_status) &&
    !["unknown", "inconnu"].includes(sale.occupancy_status?.toLowerCase() ?? "");
  const hasTechnicalRisk = risks.some((risk) =>
    /plomb|amiante|termite|dpe|travaux/.test(riskKey(risk)),
  );
  const hasLegalRisk = risks.some((risk) =>
    /servitude|copro|hypoth|saisie|bail|occup/.test(riskKey(risk)),
  );
  const scoreConfidence = sale.score_confidence ?? 0;

  return [
    {
      label: "Pièces sources",
      detail:
        docsCount > 0
          ? `${docsCount} document${docsCount > 1 ? "s" : ""} disponible${docsCount > 1 ? "s" : ""} à relire.`
          : "Aucun document riche détecté : décision à éviter sans pièces.",
      tone: docsCount > 0 ? "ok" : "todo",
    },
    {
      label: "Occupation",
      detail: occupationKnown
        ? `Statut lu : ${occupancyText(sale.occupancy_status ?? "")}. À confirmer dans le PV ou le bail.`
        : hasOccupationFactor
          ? "Signal d'occupation détecté, mais statut à confirmer."
          : "Statut non fiable : vérifier qui occupe le bien.",
      tone: occupationKnown ? "ok" : "todo",
    },
    {
      label: "Risques techniques",
      detail: hasTechnicalRisk
        ? "Diagnostics ou travaux à chiffrer avant enchère."
        : "Aucun signal technique fort extrait, sous réserve de relire les diagnostics.",
      tone: hasTechnicalRisk ? "warning" : "ok",
    },
    {
      label: "Risques juridiques",
      detail: hasLegalRisk
        ? "Servitude, occupation, copropriété ou procédure à clarifier."
        : "Aucun signal juridique fort extrait dans les éléments structurés.",
      tone: hasLegalRisk ? "warning" : "ok",
    },
    {
      label: "Fiabilité du score",
      detail:
        scoreConfidence >= 0.75
          ? "Données suffisamment cohérentes pour une première lecture."
          : "Certaines données manquent : utiliser le score comme pré-tri, pas comme décision finale.",
      tone: scoreConfidence >= 0.75 ? "ok" : "warning",
    },
    {
      label: "Prix maximum",
      detail:
        "Définir un plafond tout compris : prix, frais, travaux, délais et marge de sécurité.",
      tone: "todo",
    },
  ];
}

function buildScoreLenses(
  sale: AuctionSale,
  risks: SaleRisk[],
  factors: Factor[],
  axes: AxisSummary[],
): ScoreLens[] {
  const financialDelta = axisDelta(axes, "financial_attractiveness");
  const liquidityDelta = axisDelta(axes, "liquidity_resale");
  const assetDelta = axisDelta(axes, "asset_quality");
  const legalDelta = axisDelta(axes, "legal_security");
  const baseScore = sale.investment_score ?? 55;
  const potentialScore = clampScore(baseScore + financialDelta + liquidityDelta + assetDelta * 0.5);

  const riskPenalty =
    risks.reduce(
      (sum, risk) =>
        sum +
        severityBucket(risk.severity) * 10 +
        Math.max(0, Math.abs(risk.score_impact ?? 0)) * 1.2,
      0,
    ) +
    Math.max(0, -legalDelta) * 1.5;
  const safetyScore = clampScore(100 - riskPenalty);

  const docsCount = sale.documents_rich?.length ?? 0;
  const hasSurface = sale.app_surface_m2 != null || sale.habitable_surface_m2 != null;
  const hasOccupation =
    Boolean(sale.occupancy_status) &&
    !["unknown", "inconnu"].includes(sale.occupancy_status?.toLowerCase() ?? "");
  const rawConfidence = sale.score_confidence != null ? sale.score_confidence * 100 : 45;
  const confidenceScore = clampScore(
    rawConfidence + (docsCount > 0 ? 8 : -12) + (hasSurface ? 6 : -10) + (hasOccupation ? 4 : -6),
  );

  return [
    {
      key: "deal",
      label: "Potentiel du deal",
      value: `${Math.round(potentialScore)}/100`,
      detail:
        potentialScore >= 70
          ? "Le prix, les caractéristiques ou la liquidité créent une vraie piste à étudier."
          : potentialScore >= 55
            ? "Le dossier mérite une analyse, mais la marge doit être confirmée."
            : "Le potentiel semble limité avant vérification du prix plafond.",
      tone: potentialScore >= 70 ? "good" : potentialScore >= 55 ? "ok" : "warning",
      icon: "potential",
    },
    {
      key: "risk",
      label: "Risque dossier",
      value: `${Math.round(safetyScore)}/100`,
      detail:
        safetyScore >= 75
          ? "Peu de signaux bloquants contextualisés pour l'instant."
          : safetyScore >= 55
            ? "Des points peuvent peser sur l'usage, le coût ou la revente."
            : "Le dossier demande une vérification forte avant toute enchère.",
      tone: safetyScore >= 75 ? "good" : safetyScore >= 55 ? "warning" : "bad",
      icon: "risk",
    },
    {
      key: "confidence",
      label: "Confiance analyse",
      value: `${Math.round(confidenceScore)}/100`,
      detail:
        confidenceScore >= 75
          ? "Les données structurantes sont assez solides pour une première décision."
          : confidenceScore >= 55
            ? "La lecture est utile, mais certaines preuves doivent être complétées."
            : "Trop d'éléments manquent pour utiliser le score seul.",
      tone: confidenceScore >= 75 ? "good" : confidenceScore >= 55 ? "warning" : "bad",
      icon: "confidence",
    },
  ];
}

function axisDelta(axes: AxisSummary[], key: string): number {
  return axes.find((axis) => axis.key === key)?.delta ?? 0;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function InvestmentAnalysis({ sale }: { sale: AuctionSale }) {
  const { factors } = useMemo(
    () => normalizeScoreFactors(sale.score_factors, sale.investment_summary),
    [sale.score_factors, sale.investment_summary],
  );
  const score = sale.investment_score;
  const scoreConfidence = confidenceLabel(sale.score_confidence);
  const positives = factors.filter((f) => f.delta > 0).length;
  const negatives = factors.filter((f) => f.delta < 0).length;
  const verdict = verdictFor(score, positives, negatives);
  const axes = axisSummaries(factors);
  const scoreLenses = buildScoreLenses(sale, sale.risks ?? [], factors, axes);
  const visibleAxes = sortAxesByImpact(axes).slice(0, 3);
  const checklist = buildChecklist(sale, sale.risks ?? [], factors);

  const risks = sale.risks ?? [];
  const riskItems = buildRiskItems(risks);
  const visibleRiskItems = riskItems.slice(0, 3);
  const hiddenRiskItems = riskItems.slice(3);

  const hasFactors = factors.length > 0;
  const hasRisks = risks.length > 0;
  const hasRawSummary = !hasFactors && Boolean(sale.investment_summary);

  if (!hasFactors && !hasRisks && !sale.investment_summary && !sale.risk_notes) return null;

  const pct = score != null ? Math.max(0, Math.min(100, score)) : null;
  const gaugeColor =
    score == null
      ? "bg-muted-foreground"
      : score >= 80
        ? "bg-emerald-500"
        : score >= 60
          ? "bg-blue-500"
          : score >= 40
            ? "bg-amber-500"
            : "bg-red-500";

  return (
    <section className="liquid-panel rounded-lg p-5">
      <div className="flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span>Score Immojudis</span>
        <Activity className="h-4 w-4" />
      </div>

      {/* Verdict + jauge */}
      <div className="liquid-panel-soft mt-3 rounded-lg p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{verdict}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300/20 bg-emerald-400/10 px-2 py-0.5 text-xs font-medium text-emerald-100">
                <ShieldCheck className="h-3 w-3" /> {positives} point{positives > 1 ? "s" : ""} fort
                {positives > 1 ? "s" : ""}
              </span>
              {negatives > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/20 bg-amber-400/10 px-2 py-0.5 text-xs font-medium text-amber-100">
                  <ShieldAlert className="h-3 w-3" /> {negatives} point
                  {negatives > 1 ? "s" : ""} à vérifier
                </span>
              )}
              {risks.length > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full border border-red-300/20 bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-100">
                  <ShieldAlert className="h-3 w-3" /> {risks.length} risque
                  {risks.length > 1 ? "s" : ""} sourcé{risks.length > 1 ? "s" : ""}
                </span>
              )}
            </div>
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold tabular-nums text-foreground">
              {score != null ? Math.round(score) : "—"}
              <span className="text-base font-normal text-muted-foreground">/100</span>
            </div>
            {scoreConfidence && (
              <div className="mt-1 text-xs font-medium text-muted-foreground">
                confiance {scoreConfidence}
              </div>
            )}
          </div>
        </div>
        {pct != null && (
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className={`h-full rounded-full ${gaugeColor} transition-all`}
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-3">
        {scoreLenses.map((lens) => (
          <ScoreLensCard key={lens.key} lens={lens} />
        ))}
      </div>

      {(axes.length > 0 || checklist.length > 0) && (
        <div className="mt-5 space-y-3">
          {axes.length > 0 && (
            <details className="liquid-panel-soft group mt-4 rounded-lg">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-xs font-semibold text-muted-foreground">
                <span>Voir les axes qui expliquent le score</span>
                <span className="inline-flex items-center gap-2">
                  {visibleAxes.length} axe{visibleAxes.length > 1 ? "s" : ""} prioritaire
                  {visibleAxes.length > 1 ? "s" : ""}
                  <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
                </span>
              </summary>
              <div className="grid gap-2 border-t border-white/10 p-3 md:grid-cols-3">
                {visibleAxes.map((axis) => (
                  <AxisCard key={axis.key} axis={axis} />
                ))}
              </div>
            </details>
          )}

          {checklist.length > 0 && (
            <details className="liquid-panel-soft group mt-3 rounded-lg">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-semibold text-muted-foreground">
                <span>Voir la checklist complète avant enchère</span>
                <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
              </summary>
              <ul className="grid gap-2 border-t border-white/10 p-3 md:grid-cols-2">
                {checklist.map((item) => (
                  <ChecklistLine key={item.label} item={item} />
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {hasRawSummary && (
        <p className="mt-3 whitespace-pre-line text-sm text-foreground">
          {sale.investment_summary}
        </p>
      )}

      {hasRisks && (
        <div className="mt-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Vigilances prioritaires
            </h3>
            <span className="text-xs text-muted-foreground">
              {riskItems.length} alerte{riskItems.length > 1 ? "s" : ""}
            </span>
          </div>
          <ul className="mt-2 grid grid-cols-1 gap-2">
            {visibleRiskItems.map((item) => (
              <RiskCard key={item.key} item={item} />
            ))}
          </ul>
          {hiddenRiskItems.length > 0 && (
            <details className="liquid-panel-soft group mt-2 rounded-lg">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-semibold text-muted-foreground">
                <span>
                  Voir {hiddenRiskItems.length} autre{hiddenRiskItems.length > 1 ? "s" : ""}{" "}
                  vigilance
                  {hiddenRiskItems.length > 1 ? "s" : ""}
                </span>
                <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
              </summary>
              <ul className="grid gap-2 border-t border-white/10 p-3">
                {hiddenRiskItems.map((item) => (
                  <RiskCard key={item.key} item={item} compact />
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {!hasRisks && sale.risk_notes && (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
          <strong>Notes : </strong>
          {sale.risk_notes}
        </div>
      )}
    </section>
  );
}

function ScoreLensCard({ lens }: { lens: ScoreLens }) {
  const toneClass = {
    good: "border-emerald-300/20 bg-emerald-400/10 text-emerald-100",
    ok: "border-sky-300/20 bg-sky-400/10 text-sky-100",
    warning: "border-amber-300/20 bg-amber-400/10 text-amber-100",
    bad: "border-red-300/20 bg-red-500/10 text-red-100",
  }[lens.tone];
  const icon =
    lens.icon === "potential" ? (
      <Activity className="h-4 w-4" />
    ) : lens.icon === "risk" ? (
      <ShieldAlert className="h-4 w-4" />
    ) : (
      <FileText className="h-4 w-4" />
    );
  return (
    <div className={`rounded-lg border p-3 ${toneClass}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide">
          {icon}
          {lens.label}
        </div>
        <div className="text-base font-semibold tabular-nums">{lens.value}</div>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{lens.detail}</p>
    </div>
  );
}

function AxisCard({ axis }: { axis: AxisSummary }) {
  const isPositive = axis.delta > 0;
  const isNegative = axis.delta < 0;
  const visibleFacts = axis.facts.slice(0, 2);
  const toneClass = isPositive
    ? "border-emerald-300/20 bg-emerald-400/10"
    : isNegative
      ? "border-amber-300/20 bg-amber-400/10"
      : "border-white/10 bg-white/[0.04]";
  return (
    <div className={`rounded-md border p-3 ${toneClass}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {axis.label}
          </div>
          <p className="mt-1 text-sm font-medium leading-snug text-foreground">{axis.question}</p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${
            isPositive
              ? "border border-emerald-300/20 bg-emerald-400/10 text-emerald-100"
              : isNegative
                ? "border border-amber-300/20 bg-amber-400/10 text-amber-100"
                : "bg-white/10 text-muted-foreground"
          }`}
        >
          {signedDelta(axis.delta)}
        </span>
      </div>
      {visibleFacts.length > 0 && (
        <div className="mt-3 space-y-1.5 rounded-md bg-black/10 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
          <div className="font-semibold uppercase tracking-wide text-foreground/85">À retenir</div>
          {visibleFacts.map((fact, index) => (
            <p key={`${axis.key}-${fact.factor_key ?? fact.status ?? "fact"}-${index}`}>
              {shortText(fact.statement, 132)}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function ChecklistLine({ item }: { item: ChecklistItem }) {
  const tone =
    item.tone === "ok"
      ? "text-emerald-700 dark:text-emerald-300"
      : item.tone === "warning"
        ? "text-amber-700 dark:text-amber-300"
        : "text-muted-foreground";
  return (
    <li className="flex items-start gap-2 text-sm">
      <CheckCircle2 className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} />
      <div>
        <div className="font-medium text-foreground">{item.label}</div>
        <p className="text-xs leading-relaxed text-muted-foreground">{item.detail}</p>
      </div>
    </li>
  );
}

function RiskCard({ item, compact = false }: { item: RiskItem; compact?: boolean }) {
  const { meta, risk, severity } = item;
  const style = SEVERITY_STYLES[severity];
  const occurrence = firstOccurrence(risk);
  const source = riskEvidenceSource(risk, occurrence) || occurrenceSource(occurrence);
  const evidence = occurrence?.excerpt || risk.evidence;
  const why = riskWhyItMatters(risk);
  const certainty = riskCertainty(risk, occurrence);
  const documentContext = riskDocumentContext(risk, occurrence);
  const actions = riskActions(risk);
  const confidence = confidenceLabel(occurrence?.confidence ?? risk.confidence);

  return (
    <li className={`rounded-lg border px-3 py-3 text-sm ${style.bg} ${style.text} ${style.border}`}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">{meta.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{meta.label}</span>
            {risk.score_impact != null && (
              <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold opacity-80">
                {signedDelta(risk.score_impact)} pts
              </span>
            )}
            {confidence && (
              <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-medium opacity-80">
                {confidence}
              </span>
            )}
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${certainty.className}`}
            >
              {certainty.label}
            </span>
          </div>
          <div className="text-[10px] uppercase tracking-wide opacity-70">{meta.category}</div>
        </div>
      </div>

      <div className="mt-2 grid gap-1 text-xs leading-relaxed opacity-90">
        <div>
          <span className="font-semibold">À faire : </span>
          {actions[0]}
        </div>
        <div className="inline-flex items-center gap-1.5">
          <FileText className="h-3 w-3" />
          <span>
            <span className="font-semibold">Source : </span>
            {source || "à confirmer"}
          </span>
        </div>
      </div>

      {!compact && why && (
        <p className="mt-2 text-xs leading-relaxed opacity-90">
          <span className="font-semibold">Impact : </span>
          {shortText(why, 115)}
        </p>
      )}

      <details className="group mt-2 rounded-md bg-white/[0.05]">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2 py-1.5 text-xs font-semibold">
          <span>Preuve et raisonnement</span>
          <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
        </summary>
        <div className="space-y-2 border-t border-current/10 px-2 py-2 text-xs leading-relaxed">
          <p className="opacity-90">
            <span className="font-semibold">Pourquoi retenu : </span>
            {riskReasoning(risk, occurrence)}
          </p>
          <p className="opacity-80">
            <span className="font-semibold">Niveau de preuve : </span>
            {certainty.detail}
          </p>
          {documentContext && (
            <p className="opacity-85">
              <span className="font-semibold">Document : </span>
              {documentContext}
            </p>
          )}
          {why && (
            <p className="opacity-90">
              <span className="font-semibold">Impact potentiel : </span>
              {why}
            </p>
          )}
          {evidence && (
            <blockquote className="border-l border-current/25 pl-3 opacity-90">
              {evidence}
            </blockquote>
          )}
          <div>
            <div className="font-semibold">Vérifications</div>
            <ul className="mt-1 list-disc space-y-1 pl-4 opacity-90">
              {actions.map((action) => (
                <li key={action}>{action}</li>
              ))}
            </ul>
          </div>
        </div>
      </details>
    </li>
  );
}

function EvidenceExcerpt({ refItem }: { refItem: SaleEvidenceRef }) {
  const sourceParts = [
    refItem.document_label ||
      (refItem.document_type ? documentTypeLabel(refItem.document_type) : null),
    refItem.page_number ? `page ${refItem.page_number}` : null,
  ].filter(Boolean);

  return (
    <div className="border-l border-gold/40 pl-3">
      <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        <FileText className="h-3 w-3 text-gold" />
        <span>Preuve</span>
        {sourceParts.length > 0 && (
          <span className="normal-case tracking-normal">· {sourceParts.join(" · ")}</span>
        )}
        {confidenceLabel(refItem.confidence) && (
          <span className="normal-case tracking-normal">
            · confiance {confidenceLabel(refItem.confidence)}
          </span>
        )}
      </div>
      {refItem.excerpt && (
        <blockquote className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {refItem.excerpt}
        </blockquote>
      )}
    </div>
  );
}
