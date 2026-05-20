import { useMemo } from "react";
import { TrendingUp, TrendingDown, Minus, ShieldAlert, ShieldCheck, Activity, FileWarning, Gavel, Flame, Droplets, Bug, Home, Zap } from "lucide-react";
import type { AuctionSale, SaleRisk } from "@/lib/types";

type Factor = { label: string; delta: number; raw: string };

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
    factors.push({ label: `${baseLabel} — ${desc}`, delta, raw: part });
    total += delta;
  }
  return { factors, total };
}

// Libellés clairs par type de risque
const RISK_LABELS: Record<string, { label: string; icon: React.ReactNode; category: string }> = {
  amiante: { label: "Amiante détecté", icon: <Flame className="h-4 w-4" />, category: "Sanitaire" },
  plomb: { label: "Plomb (CREP)", icon: <Droplets className="h-4 w-4" />, category: "Sanitaire" },
  termites: { label: "Termites", icon: <Bug className="h-4 w-4" />, category: "Structurel" },
  servitude: { label: "Servitude", icon: <Gavel className="h-4 w-4" />, category: "Juridique" },
  copropriété: { label: "Copropriété", icon: <Home className="h-4 w-4" />, category: "Juridique" },
  copropriete: { label: "Copropriété", icon: <Home className="h-4 w-4" />, category: "Juridique" },
  dpe: { label: "DPE défavorable", icon: <Zap className="h-4 w-4" />, category: "Énergétique" },
  hypothèque: { label: "Hypothèque", icon: <FileWarning className="h-4 w-4" />, category: "Juridique" },
  hypotheque: { label: "Hypothèque", icon: <FileWarning className="h-4 w-4" />, category: "Juridique" },
  saisie: { label: "Saisie immobilière", icon: <Gavel className="h-4 w-4" />, category: "Juridique" },
};

function getRiskMeta(r: SaleRisk) {
  const key = (r.risk_type || "").toLowerCase().trim();
  const meta = RISK_LABELS[key];
  return {
    label: meta?.label ?? r.risk_label ?? r.risk_type ?? "Risque",
    icon: meta?.icon ?? <ShieldAlert className="h-4 w-4" />,
    category: meta?.category ?? "Autre",
  };
}

function severityBucket(sev: number | null | undefined): 1 | 2 | 3 {
  const s = sev ?? 1;
  if (s >= 3) return 3;
  if (s === 2) return 2;
  return 1;
}

const SEVERITY_STYLES: Record<1 | 2 | 3, { dot: string; bg: string; text: string; border: string; label: string }> = {
  3: {
    dot: "bg-red-500",
    bg: "bg-red-50 dark:bg-red-900/20",
    text: "text-red-900 dark:text-red-200",
    border: "border-red-200 dark:border-red-900/40",
    label: "Majeur",
  },
  2: {
    dot: "bg-amber-500",
    bg: "bg-amber-50 dark:bg-amber-900/20",
    text: "text-amber-900 dark:text-amber-200",
    border: "border-amber-200 dark:border-amber-900/40",
    label: "Modéré",
  },
  1: {
    dot: "bg-yellow-400",
    bg: "bg-secondary",
    text: "text-secondary-foreground",
    border: "border-border",
    label: "Mineur",
  },
};

function verdictFor(score: number | null | undefined, positives: number, negatives: number): string {
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

export function InvestmentAnalysis({ sale }: { sale: AuctionSale }) {
  const { factors, total } = useMemo(() => parseSummary(sale.investment_summary), [sale.investment_summary]);
  const score = sale.investment_score;
  const positives = factors.filter((f) => f.delta > 0).length;
  const negatives = factors.filter((f) => f.delta < 0).length;
  const verdict = verdictFor(score, positives, negatives);

  // Cartes de risques nettoyées
  const risks = sale.risks ?? [];
  const grouped: Record<1 | 2 | 3, Array<{ key: string; meta: ReturnType<typeof getRiskMeta>; risk: SaleRisk }>> = { 3: [], 2: [], 1: [] };
  const seen = new Set<string>();
  for (const r of risks) {
    const meta = getRiskMeta(r);
    const key = `${meta.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    grouped[severityBucket(r.severity)].push({ key, meta, risk: r });
  }

  const hasFactors = factors.length > 0;
  const hasRisks = risks.length > 0;
  const hasRawSummary = !hasFactors && Boolean(sale.investment_summary);

  if (!hasFactors && !hasRisks && !sale.investment_summary && !sale.risk_notes) return null;

  const pct = score != null ? Math.max(0, Math.min(100, score)) : null;
  const gaugeColor =
    score == null ? "bg-muted-foreground"
      : score >= 80 ? "bg-emerald-500"
      : score >= 60 ? "bg-blue-500"
      : score >= 40 ? "bg-amber-500"
      : "bg-red-500";

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Analyse d'investissement</h2>
        <Activity className="h-4 w-4 text-muted-foreground" />
      </div>

      {/* Verdict + jauge */}
      <div className="mt-3 rounded-md border border-border bg-background p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{verdict}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200">
                <ShieldCheck className="h-3 w-3" /> {positives} point{positives > 1 ? "s" : ""} fort{positives > 1 ? "s" : ""}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
                <ShieldAlert className="h-3 w-3" /> {negatives + (risks.length > 0 && negatives === 0 ? 1 : 0)} vigilance{(negatives + (risks.length > 0 && negatives === 0 ? 1 : 0)) > 1 ? "s" : ""}
              </span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold tabular-nums text-foreground">
              {score != null ? Math.round(score) : "—"}
              <span className="text-base font-normal text-muted-foreground">/100</span>
            </div>
          </div>
        </div>
        {pct != null && (
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
            <div className={`h-full rounded-full ${gaugeColor} transition-all`} style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>

      {/* Décomposition des facteurs */}
      {hasFactors && (
        <div className="mt-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Décomposition du score</h3>
          <ul className="mt-2 divide-y divide-border rounded-md border border-border">
            {factors.map((f, i) => {
              const isPos = f.delta > 0;
              const isNeg = f.delta < 0;
              return (
                <li key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <div className="flex min-w-0 items-center gap-2">
                    {isPos ? (
                      <TrendingUp className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    ) : isNeg ? (
                      <TrendingDown className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
                    ) : (
                      <Minus className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate text-foreground">{f.label}</span>
                  </div>
                  <span
                    className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums ${
                      isPos
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200"
                        : isNeg
                          ? "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {f.delta > 0 ? `+${f.delta}` : f.delta}
                  </span>
                </li>
              );
            })}
            <li className="flex items-center justify-between gap-3 bg-muted/40 px-3 py-2 text-sm font-semibold">
              <span>Total des facteurs</span>
              <span className="tabular-nums">{total > 0 ? `+${total}` : total}</span>
            </li>
          </ul>
        </div>
      )}

      {hasRawSummary && (
        <p className="mt-3 whitespace-pre-line text-sm text-foreground">{sale.investment_summary}</p>
      )}

      {/* Risques regroupés par sévérité */}
      {hasRisks && (
        <div className="mt-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Points de vigilance</h3>
          <div className="mt-2 space-y-3">
            {([3, 2, 1] as const).map((sev) => {
              const items = grouped[sev];
              if (items.length === 0) return null;
              const style = SEVERITY_STYLES[sev];
              return (
                <div key={sev}>
                  <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <span className={`h-2 w-2 rounded-full ${style.dot}`} />
                    {style.label} ({items.length})
                  </div>
                  <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {items.map(({ key, meta }) => (
                      <li
                        key={key}
                        className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${style.bg} ${style.text} ${style.border}`}
                      >
                        <span className="shrink-0">{meta.icon}</span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{meta.label}</div>
                          <div className="text-[10px] uppercase tracking-wide opacity-70">{meta.category}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!hasRisks && sale.risk_notes && (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
          <strong>Notes : </strong>{sale.risk_notes}
        </div>
      )}
    </section>
  );
}