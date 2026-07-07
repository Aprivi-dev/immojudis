import type { AuctionCostAnalysis } from "@/lib/auction-cost-analysis";
import type { CadastralAnalysis } from "@/lib/cadastre-analysis";
import type { OccupancyAnalysis } from "@/lib/occupation-analysis";
import type { AuctionSale, SaleDocumentRich, SaleRisk } from "@/lib/types";

export type LegalAttentionPriority = "high" | "medium" | "low";
export type LegalAttentionStatus = "missing" | "to_verify" | "watch" | "documented";

export type LegalAttentionItem = {
  key: string;
  label: string;
  priority: LegalAttentionPriority;
  status: LegalAttentionStatus;
  source: string;
  reason: string;
  action: string;
};

export type LegalAttentionAnalysis = {
  available: boolean;
  priority: LegalAttentionPriority;
  confidenceLabel: string;
  items: LegalAttentionItem[];
  missingDocuments: string[];
  summary: string;
  nextActions: string[];
  disclaimer: string;
};

export function buildLegalAttentionAnalysis({
  sale,
  documents,
  risks,
  cadastralAnalysis,
  occupancyAnalysis,
  auctionCostAnalysis,
  hasDiagnostics,
}: {
  sale: AuctionSale;
  documents: SaleDocumentRich[];
  risks: SaleRisk[];
  cadastralAnalysis: CadastralAnalysis;
  occupancyAnalysis: OccupancyAnalysis;
  auctionCostAnalysis: AuctionCostAnalysis;
  hasDiagnostics: boolean;
}): LegalAttentionAnalysis {
  const items = dedupeItems([
    ...documentControlItems(documents),
    ...occupancyItems(occupancyAnalysis),
    ...auctionCostItems(auctionCostAnalysis),
    ...cadastreItems(cadastralAnalysis),
    ...diagnosticsItems({ documents, hasDiagnostics }),
    ...riskItems(risks),
    ...saleTimingItems(sale),
  ]).slice(0, 12);
  const missingDocuments = buildMissingDocuments({ documents, cadastralAnalysis, hasDiagnostics });
  const priority = highestPriority(items);

  return {
    available: items.length > 0,
    priority,
    confidenceLabel: confidenceLabel({ items, missingDocuments }),
    items,
    missingDocuments,
    summary: summary({ items, missingDocuments }),
    nextActions: nextActions({ items, missingDocuments }),
    disclaimer:
      "Revue opérationnelle des points à faire confirmer par les pièces officielles ou un conseil ; elle ne constitue pas un avis juridique.",
  };
}

function documentControlItems(documents: SaleDocumentRich[]): LegalAttentionItem[] {
  const items: LegalAttentionItem[] = [];
  const hasConditions = hasDocument(documents, /cahier|conditions/i);
  const hasProcedure = hasDocument(documents, /procedure|saisie|commandement|jugement/i);

  if (!hasConditions) {
    items.push({
      key: "conditions_missing",
      label: "Cahier des conditions",
      priority: "high",
      status: "missing",
      source: "Pièces du dossier",
      reason:
        "La pièce centrale qui fixe règles de vente, frais, clauses et contraintes n'est pas repérée.",
      action: "Récupérer et relire le cahier des conditions avant de figer la mise maximale.",
    });
  } else {
    items.push({
      key: "conditions_review",
      label: "Conditions de vente",
      priority: "medium",
      status: "to_verify",
      source: "Cahier des conditions",
      reason:
        "Les clauses particulières peuvent modifier frais, délais, occupation, servitudes ou usage.",
      action:
        "Relire clauses particulières, frais taxés, paiement, surenchère et obligations de l'adjudicataire.",
    });
  }

  if (!hasProcedure) {
    items.push({
      key: "procedure_context",
      label: "Procédure de saisie",
      priority: "low",
      status: "missing",
      source: "Pièces du dossier",
      reason:
        "Le contexte de procédure n'est pas encore explicitement rattaché aux pièces collectées.",
      action:
        "Vérifier si une pièce de procédure précise des délais, parties ou contraintes particulières.",
    });
  }

  return items;
}

function occupancyItems(occupancy: OccupancyAnalysis): LegalAttentionItem[] {
  if (occupancy.status === "free") {
    return [
      {
        key: "occupation_confirm_free",
        label: "Occupation",
        priority: "low",
        status: "to_verify",
        source: "Analyse occupation",
        reason:
          "Le bien semble libre, mais ce point reste à confirmer dans les pièces et à la visite.",
        action: "Confirmer l'absence d'occupant et de bail avant audience.",
      },
    ];
  }

  const priority: LegalAttentionPriority =
    occupancy.status === "conflicting" || occupancy.status === "to_confirm" ? "high" : "medium";

  return [
    {
      key: "occupation_risk",
      label: "Occupation",
      priority,
      status: occupancy.status === "conflicting" ? "watch" : "to_verify",
      source: "Analyse occupation",
      reason: occupancy.decisionImpact,
      action: occupancy.nextActions[0] ?? "Confirmer l'occupation exacte dans les pièces.",
    },
  ];
}

function auctionCostItems(costs: AuctionCostAnalysis): LegalAttentionItem[] {
  const items: LegalAttentionItem[] = [];

  if (!costs.consignation) {
    items.push({
      key: "consignation_missing",
      label: "Consignation",
      priority: "high",
      status: "missing",
      source: "Analyse frais",
      reason: "Le montant exact de consignation n'est pas confirmé dans les sources exploitées.",
      action: "Identifier montant, bénéficiaire et forme de paiement exigés avant l'audience.",
    });
  }

  if (costs.sourceFeeSignals.length || costs.status !== "costed_with_consignation") {
    items.push({
      key: "fees_review",
      label: "Frais particuliers",
      priority: "medium",
      status: "to_verify",
      source: "Analyse frais",
      reason:
        "La simulation doit être complétée avec les frais du cahier des conditions et les frais taxés.",
      action: "Reporter tous les frais spécifiques dans la simulation de plafond.",
    });
  }

  return items;
}

function cadastreItems(cadastre: CadastralAnalysis): LegalAttentionItem[] {
  if (cadastre.status === "identified") {
    return [
      {
        key: "cadastre_confirm",
        label: "Cadastre et servitudes",
        priority: "low",
        status: "to_verify",
        source: "Analyse cadastrale",
        reason:
          "Une parcelle est repérée mais les limites, accès et servitudes restent à confirmer.",
        action: cadastre.nextActions[0] ?? "Contrôler plan, limites et accès.",
      },
    ];
  }

  return [
    {
      key: "cadastre_missing",
      label: "Cadastre et servitudes",
      priority: "medium",
      status: cadastre.available ? "to_verify" : "missing",
      source: "Analyse cadastrale",
      reason: cadastre.summary,
      action: cadastre.nextActions[0] ?? "Rattacher la vente à une parcelle cadastrale.",
    },
  ];
}

function diagnosticsItems({
  documents,
  hasDiagnostics,
}: {
  documents: SaleDocumentRich[];
  hasDiagnostics: boolean;
}): LegalAttentionItem[] {
  if (hasDiagnostics) return [];
  const hasDiagnosticDocument = hasDocument(documents, /diagnostic|dpe|amiante|plomb|termite/i);
  return [
    {
      key: "diagnostics_missing",
      label: "Diagnostics",
      priority: "medium",
      status: hasDiagnosticDocument ? "to_verify" : "missing",
      source: "Pièces du dossier",
      reason: "Les diagnostics techniques ne sont pas encore qualifiés dans le rapport.",
      action:
        "Relire DPE, amiante, plomb, termites et contraintes techniques avant chiffrage travaux.",
    },
  ];
}

function riskItems(risks: SaleRisk[]): LegalAttentionItem[] {
  return risks
    .filter((risk) => cleanText(risk.risk_label) || cleanText(risk.risk_type))
    .slice(0, 6)
    .map((risk, index) => {
      const severity = typeof risk.severity === "number" ? risk.severity : 1;
      return {
        key: `risk_${risk.risk_type || index}`,
        label: cleanText(risk.risk_label) ?? cleanText(risk.risk_type) ?? "Risque",
        priority: severity >= 3 ? "high" : severity >= 2 ? "medium" : "low",
        status: "watch",
        source: risk.occurrences?.[0]?.document_label ?? "Risques détectés",
        reason: cleanText(risk.evidence) ?? "Point détecté dans les sources, à qualifier.",
        action: riskAction(risk),
      };
    });
}

function saleTimingItems(sale: AuctionSale): LegalAttentionItem[] {
  if (!sale.sale_date) {
    return [
      {
        key: "audience_missing",
        label: "Audience",
        priority: "medium",
        status: "missing",
        source: "Annonce",
        reason: "La date d'audience n'est pas stabilisée dans les données de la vente.",
        action: "Confirmer date, heure, lieu d'audience et modalités de participation.",
      },
    ];
  }
  return [];
}

function riskAction(risk: SaleRisk): string {
  const text = normalizeText(`${risk.risk_label ?? ""} ${risk.risk_type ?? ""}`);
  if (/occupation|bail|locataire/.test(text))
    return "Qualifier titre, délai de libération et impact de calendrier.";
  if (/travaux|renov|etat|diagnostic/.test(text))
    return "Transformer le risque en budget travaux et délai.";
  if (/servitude|cadastre|parcelle/.test(text))
    return "Contrôler l'impact sur usage, accès et revente.";
  return "Chiffrer ou arbitrer ce point avant d'arrêter la stratégie d'enchère.";
}

function buildMissingDocuments({
  documents,
  cadastralAnalysis,
  hasDiagnostics,
}: {
  documents: SaleDocumentRich[];
  cadastralAnalysis: CadastralAnalysis;
  hasDiagnostics: boolean;
}): string[] {
  const missing: string[] = [];
  if (!hasDocument(documents, /cahier|conditions/i)) missing.push("Cahier des conditions");
  if (!hasDocument(documents, /pv|descriptif|commissaire|huissier/i)) {
    missing.push("PV descriptif ou constat");
  }
  if (!hasDiagnostics) missing.push("Diagnostics techniques");
  if (!cadastralAnalysis.available) missing.push("Plan ou référence cadastrale");
  return missing;
}

function nextActions({
  items,
  missingDocuments,
}: {
  items: LegalAttentionItem[];
  missingDocuments: string[];
}): string[] {
  const actions = [
    ...missingDocuments.map((document) => `Récupérer ou confirmer : ${document}.`),
    ...items.filter((item) => item.priority === "high").map((item) => item.action),
    ...items.filter((item) => item.priority === "medium").map((item) => item.action),
  ];
  return dedupeStrings(actions).slice(0, 6);
}

function summary({
  items,
  missingDocuments,
}: {
  items: LegalAttentionItem[];
  missingDocuments: string[];
}): string {
  const highCount = items.filter((item) => item.priority === "high").length;
  const mediumCount = items.filter((item) => item.priority === "medium").length;
  const parts = [`${items.length} point(s) de revue`];
  if (highCount) parts.push(`${highCount} prioritaire(s)`);
  if (mediumCount) parts.push(`${mediumCount} à vérifier`);
  if (missingDocuments.length) parts.push(`${missingDocuments.length} pièce(s) manquante(s)`);
  return `${parts.join(" · ")}.`;
}

function highestPriority(items: LegalAttentionItem[]): LegalAttentionPriority {
  if (items.some((item) => item.priority === "high")) return "high";
  if (items.some((item) => item.priority === "medium")) return "medium";
  return "low";
}

function confidenceLabel({
  items,
  missingDocuments,
}: {
  items: LegalAttentionItem[];
  missingDocuments: string[];
}): string {
  if (missingDocuments.length >= 2) return "Revue incomplète : pièces majeures manquantes";
  if (items.some((item) => item.priority === "high")) return "Points bloquants à arbitrer";
  if (items.length) return "Revue opérationnelle à compléter";
  return "Aucun point structuré détecté";
}

function hasDocument(documents: SaleDocumentRich[], pattern: RegExp): boolean {
  return documents.some((document) =>
    pattern.test(`${document.type ?? ""} ${document.document_type ?? ""} ${document.label ?? ""}`),
  );
}

function dedupeItems(items: LegalAttentionItem[]): LegalAttentionItem[] {
  const byKey = new Map<string, LegalAttentionItem>();
  for (const item of items) {
    const current = byKey.get(item.key);
    if (!current || priorityRank(item.priority) > priorityRank(current.priority)) {
      byKey.set(item.key, item);
    }
  }
  return [...byKey.values()].sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority));
}

function priorityRank(priority: LegalAttentionPriority): number {
  if (priority === "high") return 3;
  if (priority === "medium") return 2;
  return 1;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalizeText(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text || null;
}
