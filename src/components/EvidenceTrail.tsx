import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert.js";
import type { AuctionSale, SaleRisk, SaleRiskOccurrence } from "@/lib/types";
import { documentTypeHelp, documentTypeLabel } from "@/lib/format";

export function EvidenceTrail({ sale }: { sale: AuctionSale }) {
  const risks = sale.risks ?? [];
  const sourcedRisks = risks.filter((risk) => risk.evidence || risk.occurrences?.length);

  if (sourcedRisks.length === 0 && !sale.surface_evidence) {
    return (
      <div className="liquid-panel-soft rounded-lg p-5 text-sm text-muted-foreground">
        Aucune preuve détaillée n'est encore disponible dans les données structurées.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {sale.surface_evidence && (
        <EvidenceCard
          title="Surface retenue"
          status={
            sale.surface_confidence != null
              ? `${Math.round(sale.surface_confidence * 100)}%`
              : "à confirmer"
          }
          source={sale.surface_source ? sale.surface_source.replaceAll("_", " ") : "source surface"}
          excerpt={sale.surface_evidence}
          reasoning="Cette surface est utilisée pour calculer le prix au mètre carré et les comparables."
          impact="Si la surface est erronée, le prix au m² et le seuil d'enchère peuvent être faussés."
        />
      )}

      {sourcedRisks.map((risk) => {
        const occurrence = bestOccurrence(risk);
        const evidence = risk.evidence_json;
        const reasoning = isRecord(evidence)
          ? stringValue(evidence.reasoning) || stringValue(evidence.decision)
          : null;
        const impact = isRecord(evidence)
          ? stringValue(evidence.why_it_matters) || stringValue(evidence.next_action)
          : null;
        const source = occurrenceSource(occurrence, evidence);
        const status = isRecord(evidence)
          ? riskStatusLabel(stringValue(evidence.risk_status) || stringValue(evidence.status))
          : risk.confidence != null
            ? `${Math.round(risk.confidence * 100)}%`
            : "à confirmer";
        return (
          <EvidenceCard
            key={`${risk.risk_label}-${source}`}
            title={risk.risk_label || risk.risk_type || "Risque"}
            status={status}
            source={source}
            excerpt={occurrence?.excerpt || risk.evidence || ""}
            reasoning={
              reasoning ||
              "Mention retenue car elle est contextualisée dans une pièce liée au bien."
            }
            impact={
              impact || "Ce point peut modifier le prix plafond, le coût ou la stratégie d'enchère."
            }
            documentType={
              occurrence?.document_type ||
              (isRecord(evidence) ? stringValue(evidence.document_type) : null)
            }
          />
        );
      })}
    </div>
  );
}

function EvidenceCard({
  title,
  status,
  source,
  excerpt,
  reasoning,
  impact,
  documentType,
}: {
  title: string;
  status: string;
  source: string;
  excerpt: string;
  reasoning: string;
  impact: string;
  documentType?: string | null;
}) {
  return (
    <details className="liquid-panel-soft group rounded-lg">
      <summary className="flex cursor-pointer list-none items-start justify-between gap-3 p-4">
        <div className="flex min-w-0 gap-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{title}</span>
              <span className="rounded-full border border-white/10 bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                {status}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <FileText className="h-3 w-3 text-gold" />
              <span>{source}</span>
            </div>
          </div>
        </div>
        <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-3 border-t border-white/10 px-4 pb-4 pt-3 text-sm leading-relaxed">
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">Ce qu'on retient : </span>
          {reasoning}
        </p>
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">Pourquoi ça compte : </span>
          {impact}
        </p>
        {documentType && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Type de pièce : </span>
            {documentTypeHelp(documentType)}
          </p>
        )}
        {excerpt && (
          <blockquote className="border-l border-gold/40 pl-3 text-xs text-muted-foreground">
            <span className="mb-1 block font-medium text-foreground">Preuve source</span>
            {excerpt}
          </blockquote>
        )}
      </div>
    </details>
  );
}

function bestOccurrence(risk: SaleRisk): SaleRiskOccurrence | null {
  return (
    [...(risk.occurrences ?? [])]
      .filter((occurrence) => occurrence.excerpt)
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0] ?? null
  );
}

function occurrenceSource(
  occurrence: SaleRiskOccurrence | null,
  evidence: SaleRisk["evidence_json"],
): string {
  const documentType =
    occurrence?.document_type || (isRecord(evidence) ? stringValue(evidence.document_type) : null);
  const documentLabel =
    occurrence?.document_label ||
    (isRecord(evidence) ? stringValue(evidence.document_label) : null) ||
    (documentType ? documentTypeLabel(documentType) : "Source à confirmer");
  const page =
    occurrence?.page_number || (isRecord(evidence) ? numberValue(evidence.page_number) : null);
  return [documentLabel, page ? `page ${page}` : null].filter(Boolean).join(" · ");
}

function riskStatusLabel(status: string | null): string {
  const labels: Record<string, string> = {
    confirmed: "Confirmé",
    probable: "Probable",
    to_verify: "À vérifier",
    to_quantify: "À chiffrer",
    property_specific_clause: "Clause spécifique",
    confirmé: "Confirmé",
    incertain: "Incertain",
  };
  return status ? (labels[status] ?? status.replaceAll("_", " ")) : "À confirmer";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
