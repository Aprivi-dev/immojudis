import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import Activity from "lucide-react/dist/esm/icons/activity.js";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.js";
import Database from "lucide-react/dist/esm/icons/database.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { getSales } from "@/lib/queries";
import type { AuctionSale } from "@/lib/types";

export const Route = createFileRoute("/admin/quality")({
  head: () => ({
    meta: [
      { title: "Qualité data — Immojudis" },
      {
        name: "description",
        content: "Tableau de bord qualité des données et du scoring Immojudis.",
      },
    ],
  }),
  component: AdminQualityPage,
});

function AdminQualityPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-quality-sales"],
    queryFn: () => getSales({}, 500, "date_asc"),
    staleTime: 60_000,
  });
  const sales = data ?? [];
  const metrics = buildQualityMetrics(sales);
  const weakSales = sales
    .filter(
      (sale) =>
        (sale.score_confidence ?? 0) < 0.55 ||
        richDocumentCount(sale) === 0 ||
        sale.app_surface_m2 == null ||
        !sale.occupancy_status ||
        sale.occupancy_status === "unknown",
    )
    .slice(0, 12);

  return (
    <main className="liquid-page min-h-screen bg-background px-4 py-8">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.3em] text-gold">
              Admin qualité
            </div>
            <h1 className="mt-2 font-display text-4xl text-foreground">Pilotage data & scoring</h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              Vue interne pour repérer rapidement les ventes qui fragilisent la confiance produit.
            </p>
          </div>
          <Link
            to="/sales"
            className="liquid-button rounded-lg px-4 py-2 text-xs font-semibold uppercase tracking-wide text-background"
          >
            Retour annonces
          </Link>
        </div>

        {error && (
          <div className="mt-6 rounded-lg border border-red-300/20 bg-red-500/10 p-4 text-sm text-red-100">
            {error instanceof Error ? error.message : "Erreur de chargement"}
          </div>
        )}

        <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <QualityMetric
            icon={<Database />}
            label="Ventes"
            value={isLoading ? "…" : String(metrics.total)}
          />
          <QualityMetric
            icon={<FileText />}
            label="Avec documents"
            value={isLoading ? "…" : pct(metrics.withDocs, metrics.total)}
          />
          <QualityMetric
            icon={<Activity />}
            label="Confiance moyenne"
            value={isLoading ? "…" : metrics.avgConfidence}
          />
          <QualityMetric
            icon={<ShieldCheck />}
            label="Risques sourcés"
            value={isLoading ? "…" : pct(metrics.sourcedRisks, metrics.riskSales)}
          />
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
          <section className="liquid-panel rounded-lg p-5">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <AlertTriangle className="h-4 w-4 text-gold" />
              Points à surveiller
            </div>
            <ul className="mt-4 space-y-3 text-sm text-muted-foreground">
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

          <section className="liquid-panel rounded-lg p-5">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Dossiers à reprendre en priorité
            </div>
            <div className="mt-4 divide-y divide-white/10">
              {weakSales.length === 0 && !isLoading ? (
                <p className="text-sm text-muted-foreground">
                  Aucun dossier faible dans l'échantillon chargé.
                </p>
              ) : (
                weakSales.map((sale) => <WeakSaleLine key={sale.id} sale={sale} />)
              )}
            </div>
          </section>
        </div>

        <section className="liquid-panel mt-6 rounded-lg p-5">
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
              GPS, surface, documents, occupation et confiance score
            </span>
          </div>
          <div className="mt-4 overflow-x-auto rounded-lg border border-white/10">
            <div className="grid min-w-[760px] grid-cols-[1.2fr_repeat(6,0.7fr)] gap-3 border-b border-white/10 bg-white/[0.04] px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <span>Source</span>
              <span>Annonces</span>
              <span>Surface</span>
              <span>GPS</span>
              <span>Docs</span>
              <span>Occup.</span>
              <span>Confiance</span>
            </div>
            <div className="divide-y divide-white/10">
              {metrics.sources.map((source) => (
                <SourceQualityLine key={source.name} source={source} />
              ))}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
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
    <div className="liquid-panel-soft rounded-lg p-4">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
        <span className="text-gold [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
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

function WeakSaleLine({ sale }: { sale: AuctionSale }) {
  const flags = [];
  if ((sale.score_confidence ?? 0) < 0.55) flags.push("confiance faible");
  if (richDocumentCount(sale) === 0) flags.push("documents manquants");
  if (sale.app_surface_m2 == null) flags.push("surface absente");
  if (!sale.occupancy_status || sale.occupancy_status === "unknown") flags.push("occupation");
  return (
    <Link
      to="/sales/$id"
      params={{ id: sale.id }}
      className="flex items-center justify-between gap-4 py-3 text-sm transition hover:text-gold-soft"
    >
      <span className="min-w-0">
        <span className="block truncate font-medium text-foreground">
          {sale.title ?? sale.city ?? sale.id}
        </span>
        <span className="text-xs text-muted-foreground">{flags.join(" · ")}</span>
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
  withSurface: number;
  withGps: number;
  withDocs: number;
  withOccupation: number;
  avgConfidence: string;
  weakCount: number;
};

function SourceQualityLine({ source }: { source: SourceQuality }) {
  return (
    <div className="grid min-w-[760px] grid-cols-[1.2fr_repeat(6,0.7fr)] gap-3 px-3 py-3 text-sm">
      <span className="min-w-0">
        <span className="block truncate font-medium text-foreground">{source.name}</span>
        <span className="text-xs text-muted-foreground">
          {source.weakCount} dossier{source.weakCount > 1 ? "s" : ""} à reprendre
        </span>
      </span>
      <span className="tabular-nums text-muted-foreground">{source.total}</span>
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
      ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-100"
      : Number.isFinite(numeric) && numeric >= 50
        ? "border-amber-300/20 bg-amber-400/10 text-amber-100"
        : "border-red-300/20 bg-red-500/10 text-red-100";
  return (
    <span className={`inline-flex w-fit rounded-full border px-2 py-0.5 text-xs ${tone}`}>
      {value}
    </span>
  );
}

function buildQualityMetrics(sales: AuctionSale[]) {
  const total = sales.length;
  const riskSales = sales.filter((sale) => (sale.risks?.length ?? 0) > 0);
  const confidences = sales
    .map((sale) => sale.score_confidence)
    .filter((value): value is number => typeof value === "number");
  const avg =
    confidences.length > 0
      ? `${Math.round((confidences.reduce((sum, value) => sum + value, 0) / confidences.length) * 100)}%`
      : "—";
  return {
    total,
    withDocs: sales.filter((sale) => documentCount(sale) > 0 || richDocumentCount(sale) > 0).length,
    withRichDocs: sales.filter((sale) => richDocumentCount(sale) > 0).length,
    withSurface: sales.filter((sale) => sale.app_surface_m2 != null).length,
    withOccupation: sales.filter(
      (sale) => sale.occupancy_status && sale.occupancy_status !== "unknown",
    ).length,
    highConfidence: sales.filter((sale) => (sale.score_confidence ?? 0) >= 0.7).length,
    riskSales: riskSales.length,
    sourcedRisks: riskSales.filter((sale) =>
      (sale.risks ?? []).some((risk) => risk.evidence || risk.occurrences?.[0]?.excerpt),
    ).length,
    avgConfidence: avg,
    sources: buildSourceQuality(sales),
  };
}

function buildSourceQuality(sales: AuctionSale[]): SourceQuality[] {
  const groups = new Map<string, AuctionSale[]>();
  for (const sale of sales) {
    const key = sale.primary_source || sale.source_name || "source inconnue";
    groups.set(key, [...(groups.get(key) ?? []), sale]);
  }
  return [...groups.entries()]
    .map(([name, items]) => {
      const confidences = items
        .map((sale) => sale.score_confidence)
        .filter((value): value is number => typeof value === "number");
      const avgConfidence =
        confidences.length > 0
          ? `${Math.round((confidences.reduce((sum, value) => sum + value, 0) / confidences.length) * 100)}%`
          : "—";
      return {
        name,
        total: items.length,
        withSurface: items.filter((sale) => sale.app_surface_m2 != null).length,
        withGps: items.filter((sale) => sale.latitude != null && sale.longitude != null).length,
        withDocs: items.filter((sale) => documentCount(sale) > 0 || richDocumentCount(sale) > 0)
          .length,
        withOccupation: items.filter(
          (sale) => sale.occupancy_status && sale.occupancy_status !== "unknown",
        ).length,
        avgConfidence,
        weakCount: items.filter(
          (sale) =>
            (sale.score_confidence ?? 0) < 0.55 ||
            sale.app_surface_m2 == null ||
            richDocumentCount(sale) === 0 ||
            !sale.occupancy_status ||
            sale.occupancy_status === "unknown",
        ).length,
      };
    })
    .sort((a, b) => b.weakCount - a.weakCount || b.total - a.total);
}

function pct(count: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((count / total) * 100)}%`;
}

function documentCount(sale: AuctionSale): number {
  return Array.isArray(sale.documents) ? sale.documents.length : 0;
}

function richDocumentCount(sale: AuctionSale): number {
  return sale.documents_rich?.length ?? 0;
}
