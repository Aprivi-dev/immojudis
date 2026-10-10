"use client";

import { createFileRoute, Link } from "@/lib/router-compat";
import { useQuery } from "@tanstack/react-query";
import Activity from "lucide-react/dist/esm/icons/activity.js";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.js";
import Database from "lucide-react/dist/esm/icons/database.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.js";
import type { ReactElement } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { saleDisplayTitle } from "@/lib/sale-title";
import { fetchAdminDataQuality, fetchValuationAdminOverview } from "@/lib/client-api";
import type {
  DataQualityPrioritySale,
  DataQualityReport,
  DataQualitySourceCoverage,
} from "@/lib/data-quality-monitor";
import { queryKeys } from "@/lib/query-keys";

export const Route = createFileRoute("/admin/quality")({
  component: AdminQualityPage,
});

export function AdminQualityPage() {
  const qualityQuery = useQuery({
    queryKey: queryKeys.adminQualityReport(),
    queryFn: fetchAdminDataQuality,
    staleTime: 60_000,
  });
  const qualityReport = qualityQuery.data;
  const {
    data: valuationOverview,
    isLoading: valuationLoading,
    refetch: refetchValuation,
    isFetching: valuationFetching,
    error: valuationError,
  } = useQuery({
    queryKey: queryKeys.adminValuationOverview(),
    queryFn: fetchValuationAdminOverview,
    staleTime: 60_000,
  });
  const metrics = buildQualityMetrics(qualityReport);
  const weakSales = qualityReport?.prioritySales ?? [];

  return (
    <AdminShell
      activeSection="quality"
      title="Qualité des données"
      description="Repérez les dossiers qui fragilisent la confiance produit."
      onRefresh={() => {
        void qualityQuery.refetch();
        void refetchValuation();
      }}
      isRefreshing={qualityQuery.isFetching || valuationFetching}
    >
      <div className="max-w-[92rem]">
        {qualityQuery.error && (
          <div
            role="alert"
            className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"
          >
            {qualityQuery.error instanceof Error
              ? qualityQuery.error.message
              : "Erreur de chargement"}
          </div>
        )}

        <p className="mt-6 text-xs text-muted-foreground">
          Les indicateurs et la ventilation par source couvrent {qualityReport?.sampleSize ?? "…"}{" "}
          ventes du catalogue. La file ci-dessous affiche uniquement les dossiers prioritaires parmi
          les 500 premières ventes classées par date pour garder l’écran réactif.
        </p>

        <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <QualityMetric
            icon={<Database />}
            label="Ventes"
            value={qualityQuery.isLoading ? "…" : String(metrics.total)}
          />
          <QualityMetric
            icon={<FileText />}
            label="Avec documents"
            value={qualityQuery.isLoading ? "…" : pct(metrics.withDocs, metrics.total)}
          />
          <QualityMetric
            icon={<Sparkles />}
            label="Synthèse IA"
            value={qualityQuery.isLoading ? "…" : pct(metrics.withAiDescription, metrics.total)}
          />
          <QualityMetric
            icon={<Activity />}
            label="Confiance moyenne"
            value={qualityQuery.isLoading ? "…" : metrics.avgConfidence}
          />
          <QualityMetric
            icon={<ShieldCheck />}
            label="Risques sourcés"
            value={qualityQuery.isLoading ? "…" : pct(metrics.sourcedRisks, metrics.riskSales)}
          />
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
          <section className="admin-panel rounded-lg p-5">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <AlertTriangle className="h-4 w-4 text-gold-text" />
              Points à surveiller
            </div>
            <ul className="mt-4 space-y-3 text-sm text-muted-foreground">
              <QualityLine
                label="Synthèse IA publique"
                value={pct(metrics.withAiDescription, metrics.total)}
              />
              <QualityLine
                label="Surface exploitable"
                value={pct(metrics.withSurface, metrics.total)}
              />
              <QualityLine
                label="Occupation renseignée"
                value={pct(metrics.withOccupation, metrics.total)}
              />
              <QualityLine
                label="Score confiance ≥ 70%"
                value={pct(metrics.highConfidence, metrics.total)}
              />
              <QualityLine
                label="Documents riches"
                value={pct(metrics.withRichDocs, metrics.total)}
              />
              <QualityLine
                label="Ventes avec alerte"
                value={pct(metrics.riskSales, metrics.total)}
              />
            </ul>
          </section>

          <section className="admin-panel rounded-lg p-5">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Dossiers à reprendre en priorité
            </div>
            <div className="mt-4 divide-y divide-brand-navy/10">
              {qualityQuery.error && !qualityReport ? (
                <p role="status" className="text-sm text-red-800">
                  Les dossiers prioritaires n’ont pas pu être vérifiés. Réessayez avec Actualiser.
                </p>
              ) : weakSales.length === 0 && !qualityQuery.isLoading ? (
                <p className="text-sm text-muted-foreground">
                  Aucun dossier faible dans l'échantillon chargé.
                </p>
              ) : (
                weakSales.map((sale) => <WeakSaleLine key={sale.id} sale={sale} />)
              )}
            </div>
          </section>
        </div>

        <section className="admin-panel mt-6 rounded-lg p-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Qualité par source
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Priorise les connecteurs qui créent le plus de dossiers incomplets ou peu fiables.
              </p>
            </div>
            <span className="text-xs text-muted-foreground">
              IA, GPS, surface, documents, occupation et confiance score
            </span>
          </div>
          <div className="mt-4 overflow-x-auto rounded-lg border border-brand-navy/10">
            <div className="grid min-w-[860px] grid-cols-[1.2fr_repeat(7,0.7fr)] gap-3 border-b border-brand-navy/10 bg-brand-navy/[0.03] px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <span>Source</span>
              <span>Annonces</span>
              <span>IA</span>
              <span>Surface</span>
              <span>GPS</span>
              <span>Docs</span>
              <span>Occup.</span>
              <span>Confiance</span>
            </div>
            <div className="divide-y divide-brand-navy/10">
              {metrics.sources.map((source) => (
                <SourceQualityLine key={source.name} source={source} />
              ))}
            </div>
          </div>
        </section>

        <section className="admin-panel mt-6 rounded-lg p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Modèles, promotion & dérive
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Les seuils affichés sont identiques aux garde-fous du pipeline d’entraînement.
              </p>
            </div>
            <span className="rounded-full border border-brand-navy/10 px-3 py-1 text-xs font-semibold text-foreground">
              {valuationLoading
                ? "Chargement…"
                : valuationOverview?.runtime.status === "healthy"
                  ? "Runtime sain"
                  : valuationOverview?.runtime.status === "degraded"
                    ? "Dérive à examiner"
                    : "Activité inconnue"}
            </span>
          </div>
          {valuationError ? (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"
            >
              {valuationOverview
                ? "Actualisation des estimations impossible. Les dernières données reçues restent affichées."
                : "Le diagnostic des estimations est indisponible. Réessayez avec Actualiser."}
            </p>
          ) : null}
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <QualityMetric
              icon={<Activity />}
              label="Estimations 24 h"
              value={
                valuationLoading
                  ? "…"
                  : valuationOverview
                    ? String(valuationOverview.runtime.estimates)
                    : "—"
              }
            />
            <QualityMetric
              icon={<Sparkles />}
              label="Hybride LightGBM"
              value={formatOptionalPct(valuationOverview?.runtime.hybridSharePct)}
            />
            <QualityMetric
              icon={<ShieldCheck />}
              label="Actionnables"
              value={formatOptionalPct(valuationOverview?.runtime.actionableSharePct)}
            />
          </div>
          {valuationOverview?.runtime.driftSignals.length ? (
            <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-warning">
              {valuationOverview.runtime.driftSignals.map((signal) => (
                <li key={signal}>{signal}</li>
              ))}
            </ul>
          ) : null}
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {(valuationOverview?.activeModels ?? []).map((model) => (
              <article
                key={model.id}
                className="rounded-lg border border-brand-navy/10 bg-brand-navy/[0.03] p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <strong className="text-sm text-foreground">{model.segment}</strong>
                  <span className={model.promotionGate.passes ? "text-success" : "text-danger"}>
                    {model.promotionGate.passes ? "Seuils validés" : "Seuils non validés"}
                  </span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {model.version} · erreur médiane{" "}
                  {formatOptionalPct(model.metrics.testMedianApePct)} · couverture{" "}
                  {formatOptionalPct(model.metrics.intervalCoveragePct)}
                </p>
              </article>
            ))}
          </div>
        </section>
      </div>
    </AdminShell>
  );
}

function formatOptionalPct(value: number | null | undefined): string {
  return value == null ? "—" : `${value.toLocaleString("fr-FR", { maximumFractionDigits: 1 })}%`;
}

function QualityMetric({
  icon,
  label,
  value,
}: {
  icon: ReactElement;
  label: string;
  value: string;
}) {
  return (
    <div className="admin-panel rounded-lg p-4">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
        <span className="text-gold-text [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
        {label}
      </div>
      <div className="mt-3 text-2xl font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}

function QualityLine({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span>{label}</span>
      <span className="font-semibold tabular-nums text-foreground">{value}</span>
    </li>
  );
}

function WeakSaleLine({ sale }: { sale: DataQualityPrioritySale }) {
  return (
    <Link
      to="/sales/$id"
      params={{ id: sale.id }}
      className="flex items-center justify-between gap-4 py-3 text-sm transition hover:text-gold-text"
    >
      <span className="min-w-0">
        <span className="block truncate font-medium text-foreground">
          {saleDisplayTitle(sale, sale.city ?? sale.id)}
        </span>
        <span className="text-xs text-muted-foreground">{sale.flags.join(" · ")}</span>
      </span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {sale.score_confidence != null ? `${Math.round(sale.score_confidence * 100)}%` : "—"}
      </span>
    </Link>
  );
}

type SourceQuality = {
  name: string;
  total: number;
  withAiDescription: number;
  withSurface: number;
  withGps: number;
  withDocs: number;
  withOccupation: number;
  avgConfidence: string;
  weakCount: number;
};

function SourceQualityLine({ source }: { source: SourceQuality }) {
  return (
    <div className="grid min-w-[860px] grid-cols-[1.2fr_repeat(7,0.7fr)] gap-3 px-3 py-3 text-sm">
      <span className="min-w-0">
        <span className="block truncate font-medium text-foreground">{source.name}</span>
        <span className="text-xs text-muted-foreground">
          {source.weakCount} dossier{source.weakCount > 1 ? "s" : ""} à reprendre
        </span>
      </span>
      <span className="tabular-nums text-muted-foreground">{source.total}</span>
      <QualityPill value={pct(source.withAiDescription, source.total)} />
      <QualityPill value={pct(source.withSurface, source.total)} />
      <QualityPill value={pct(source.withGps, source.total)} />
      <QualityPill value={pct(source.withDocs, source.total)} />
      <QualityPill value={pct(source.withOccupation, source.total)} />
      <QualityPill value={source.avgConfidence} />
    </div>
  );
}

function QualityPill({ value }: { value: string }) {
  const numeric = parseInt(value, 10);
  const tone =
    Number.isFinite(numeric) && numeric >= 75
      ? "border-emerald-300/20 bg-success-tint text-success"
      : Number.isFinite(numeric) && numeric >= 50
        ? "border-amber-300/20 bg-warning-tint text-warning"
        : "border-red-300/20 bg-danger-tint text-danger";
  return (
    <span className={`inline-flex w-fit rounded-full border px-2 py-0.5 text-xs ${tone}`}>
      {value}
    </span>
  );
}

function buildQualityMetrics(report: DataQualityReport | undefined) {
  const metric = (key: string) =>
    [...(report?.fields ?? []), ...(report?.capabilities ?? [])].find((item) => item.key === key);
  return {
    total: report?.sampleSize ?? 0,
    withAiDescription: metric("ai_description")?.count ?? 0,
    withDocs: metric("documents")?.count ?? 0,
    withRichDocs: report?.richDocumentsCount ?? 0,
    withSurface: metric("surface")?.count ?? 0,
    withOccupation: report?.occupationCount ?? 0,
    highConfidence: report?.highConfidenceCount ?? 0,
    riskSales: report?.riskSales ?? 0,
    sourcedRisks: report?.sourcedRiskSales ?? 0,
    avgConfidence:
      report?.averageConfidencePct == null
        ? "—"
        : String(Math.round(report.averageConfidencePct)) + "%",
    sources: (report?.sourceCoverage ?? []).map(sourceCoverageToQuality),
  };
}

function sourceCoverageToQuality(source: DataQualitySourceCoverage): SourceQuality {
  return {
    name: source.source,
    total: source.count,
    withAiDescription: source.count - source.missingAiDescription,
    withSurface: source.count - source.missingSurface,
    withGps: source.count - source.missingLocation,
    withDocs: source.count - source.missingDocuments,
    withOccupation: source.count - source.missingOccupation,
    avgConfidence:
      source.averageConfidencePct == null
        ? "—"
        : String(Math.round(source.averageConfidencePct)) + "%",
    weakCount: source.weakCount,
  };
}

function pct(count: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((count / total) * 100)}%`;
}
