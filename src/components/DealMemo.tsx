import { useMemo, useState } from "react";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.js";
import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2.js";
import FileSearch from "lucide-react/dist/esm/icons/file-search.js";
import ListChecks from "lucide-react/dist/esm/icons/list-checks.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import Target from "lucide-react/dist/esm/icons/target.js";
import type { AuctionSale, SaleRisk, SaleScoreFactor } from "@/lib/types";
import { formatPrice, formatPricePerM2, formatSurface, occupancyLabel } from "@/lib/format";

type MemoMode = "simple" | "expert";

type MemoItem = {
  title: string;
  text: string;
  tone: "positive" | "warning" | "neutral";
};

export function DealMemo({ sale }: { sale: AuctionSale }) {
  const [mode, setMode] = useState<MemoMode>("simple");
  const memo = useMemo(() => buildDealMemo(sale), [sale]);

  return (
    <div className="liquid-panel rounded-lg p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Target className="h-4 w-4 text-gold" />
            Décision en 5 minutes
          </div>
          <h3 className="mt-2 text-lg font-semibold text-foreground">{memo.headline}</h3>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Une lecture simple : pourquoi regarder, ce qui peut bloquer et quoi faire avant de
            fixer ton plafond.
          </p>
        </div>

        <div className="inline-flex rounded-full border border-white/10 bg-white/[0.04] p-1 text-xs font-medium">
          <button
            type="button"
            onClick={() => setMode("simple")}
            className={`rounded-full px-3 py-1 transition ${
              mode === "simple" ? "bg-gold text-background" : "text-muted-foreground"
            }`}
          >
            Simple
          </button>
          <button
            type="button"
            onClick={() => setMode("expert")}
            className={`rounded-full px-3 py-1 transition ${
              mode === "expert" ? "bg-gold text-background" : "text-muted-foreground"
            }`}
          >
            Expert
          </button>
        </div>
      </div>

      {mode === "simple" ? (
        <div className="mt-5 grid gap-3 md:grid-cols-4">
          {memo.items.map((item) => (
            <MemoCard key={item.title} item={item} />
          ))}
        </div>
      ) : (
        <div className="mt-5 grid gap-3 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gold">
              <ListChecks className="h-4 w-4" />
              Avant enchère
            </div>
            <ul className="mt-3 space-y-2">
              {memo.actions.map((action) => (
                <li
                  key={action}
                  className="flex gap-2 text-sm leading-relaxed text-muted-foreground"
                >
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
                  <span>{action}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gold">
              <FileSearch className="h-4 w-4" />
              Niveau de preuve
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <MemoMetric label="Documents" value={String(memo.documentsCount)} />
              <MemoMetric label="Risques sourcés" value={String(memo.sourcedRisks)} />
              <MemoMetric label="Confiance score" value={memo.confidenceLabel} />
              <MemoMetric label="Surface" value={memo.surfaceLabel} />
            </dl>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              {memo.proofReading}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function MemoCard({ item }: { item: MemoItem }) {
  const icon =
    item.tone === "positive" ? (
      <ShieldCheck className="h-4 w-4" />
    ) : item.tone === "warning" ? (
      <AlertTriangle className="h-4 w-4" />
    ) : (
      <ListChecks className="h-4 w-4" />
    );
  const toneClass = {
    positive: "border-emerald-300/20 bg-emerald-400/10 text-emerald-100",
    warning: "border-amber-300/25 bg-amber-400/10 text-amber-100",
    neutral: "border-white/10 bg-white/[0.04] text-gold",
  }[item.tone];
  return (
    <div className={`rounded-lg border p-4 ${toneClass}`}>
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide">
        {icon}
        {item.title}
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{item.text}</p>
    </div>
  );
}

function MemoMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-semibold text-foreground">{value}</dd>
    </div>
  );
}

function buildDealMemo(sale: AuctionSale) {
  const risks = sale.risks ?? [];
  const score = sale.investment_score;
  const confidence = sale.score_confidence ?? null;
  const surface = sale.app_surface_m2 ?? sale.habitable_surface_m2 ?? sale.carrez_surface_m2;
  const startingPricePerM2 =
    surface && sale.starting_price_eur ? sale.starting_price_eur / surface : null;
  const docs = sale.documents_rich?.length ?? 0;
  const sourcedRisks = risks.filter((risk) =>
    Boolean(risk.evidence || risk.occurrences?.[0]?.excerpt),
  ).length;
  const strongestFactor = topFactor(sale.score_factors, "positive");
  const weakestFactor = topFactor(sale.score_factors, "negative");
  const mainRisk = [...risks].sort((a, b) => (b.severity ?? 0) - (a.severity ?? 0))[0];

  const headline =
    score == null
      ? "Dossier à structurer"
      : score >= 70 && risks.length === 0
        ? "Dossier intéressant à confirmer"
        : score >= 55
          ? "Dossier exploitable avec vérifications"
          : "Dossier à sécuriser avant décision";

  const positiveText =
    strongestFactor?.reason ||
    (surface
      ? `Surface exploitable de ${formatSurface(surface)} et mise à prix ${formatPrice(sale.starting_price_eur)}.`
      : `Mise à prix ${formatPrice(sale.starting_price_eur)} à analyser avec les documents.`);

  const riskText = mainRisk
    ? `${riskLabel(mainRisk)} : ${riskImpact(mainRisk)}`
    : weakestFactor?.reason ||
      "Aucune alerte forte n'est remontée, mais les pièces officielles restent indispensables.";

  const actionText =
    docs === 0
      ? "Récupérer les documents officiels avant toute décision."
      : mainRisk
        ? nextAction(mainRisk)
        : "Définir un prix plafond tout compris et relire les pièces avant audience.";

  const priceText =
    startingPricePerM2 != null
      ? `Mise à prix à environ ${formatPricePerM2(startingPricePerM2)} avant frais et travaux. Le bon seuil compare le coût complet aux ventes DVF proches.`
      : "Surface ou prix incomplet : impossible de fixer un seuil fiable sans compléter les données.";

  const actions = buildActions(sale, risks);
  const confidenceLabel =
    confidence == null
      ? "Non calculée"
      : `${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}%`;
  const proofReading =
    docs === 0
      ? "Le dossier manque de pièces : la lecture doit rester un pré-tri."
      : sourcedRisks > 0
        ? "Les alertes principales disposent d'au moins une preuve ou d'un extrait source."
        : "Le dossier a des pièces, mais les alertes restent à confirmer dans les documents.";

  return {
    headline,
    documentsCount: docs,
    sourcedRisks,
    confidenceLabel,
    surfaceLabel: surface ? formatSurface(surface) : "À confirmer",
    proofReading,
    actions,
    items: [
      {
        title: "Pourquoi regarder",
        text: positiveText,
        tone: "positive",
      },
      {
        title: "Ce qui peut bloquer",
        text: riskText,
        tone: mainRisk || weakestFactor ? "warning" : "positive",
      },
      {
        title: "Prix plafond",
        text: priceText,
        tone: startingPricePerM2 != null ? "neutral" : "warning",
      },
      {
        title: "Prochaine action",
        text: actionText,
        tone: "neutral",
      },
    ] satisfies MemoItem[],
  };
}

function buildActions(sale: AuctionSale, risks: SaleRisk[]): string[] {
  const actions = [
    "Fixer un prix plafond tout compris : frais, travaux, délai, fiscalité et marge de sécurité.",
  ];
  if ((sale.documents_rich?.length ?? 0) === 0) {
    actions.unshift(
      "Récupérer le PV descriptif, le cahier des conditions de vente et les diagnostics.",
    );
  }
  if (!sale.occupancy_status || sale.occupancy_status === "unknown") {
    actions.push(`Confirmer l'occupation réelle : ${occupancyLabel(sale.occupancy_status)}.`);
  }
  for (const risk of risks.slice(0, 3)) {
    actions.push(nextAction(risk));
  }
  actions.push("Conserver la preuve utilisée pour chaque hypothèse importante.");
  return [...new Set(actions)].slice(0, 7);
}

function topFactor(
  factors: SaleScoreFactor[] | null | undefined,
  direction: "positive" | "negative",
) {
  return [...(factors ?? [])]
    .filter((factor) =>
      direction === "positive" ? Number(factor.delta ?? 0) > 0 : Number(factor.delta ?? 0) < 0,
    )
    .sort((a, b) => Math.abs(Number(b.delta ?? 0)) - Math.abs(Number(a.delta ?? 0)))[0];
}

function riskLabel(risk: SaleRisk): string {
  return risk.risk_label || risk.risk_type || "Risque";
}

function riskImpact(risk: SaleRisk): string {
  const evidence = risk.evidence_json;
  if (isRecord(evidence) && typeof evidence.why_it_matters === "string") {
    return evidence.why_it_matters.replace(/\s*Sévérité retenue\s*:\s*\d+\/\d+\.?/i, "");
  }
  return risk.evidence
    ? "preuve disponible, impact à relire dans le document source."
    : "impact à confirmer.";
}

function nextAction(risk: SaleRisk): string {
  const label = riskLabel(risk).toLowerCase();
  const evidence = risk.evidence_json;
  if (isRecord(evidence) && typeof evidence.next_action === "string" && evidence.next_action) {
    return evidence.next_action;
  }
  if (label.includes("travaux")) return "Chiffrer les travaux avant de calculer la marge.";
  if (/amiante|plomb|termite|dpe/.test(label)) {
    return "Relire le diagnostic technique et identifier l'obligation ou le coût réel.";
  }
  if (label.includes("servitude"))
    return "Comprendre l'impact de la servitude sur l'usage ou la revente.";
  if (label.includes("occup")) return "Confirmer le bail, le loyer et le délai de libération.";
  if (label.includes("copro")) return "Contrôler charges, règlement, travaux votés et syndic.";
  return "Relire la pièce source complète avant de se positionner.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
