import { useQuery } from "@tanstack/react-query";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.js";
import CheckCircle from "lucide-react/dist/esm/icons/check-circle.js";
import Clipboard from "lucide-react/dist/esm/icons/clipboard.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import XCircle from "lucide-react/dist/esm/icons/x-circle.js";
import { toast } from "sonner";
import { fetchAdminReadiness } from "@/lib/client-api";
import type { ReadinessItem, ReadinessStatus } from "@/lib/admin-readiness";

const READINESS_QUERY_KEY = ["admin-readiness"] as const;

export function AdminReadinessPanel() {
  const readinessQuery = useQuery({
    queryKey: READINESS_QUERY_KEY,
    queryFn: fetchAdminReadiness,
    staleTime: 30_000,
  });
  const readiness = readinessQuery.data ?? null;
  const webhookUrl = readiness?.webhookUrl ?? null;

  return (
    <section className="liquid-panel mt-6 rounded-lg p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gold">
            <StatusIcon status={readiness?.status ?? "warning"} />
            Readiness offre
          </div>
          <h2 className="mt-3 font-display text-2xl">Activation commerciale</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Vérifie les prérequis de l'offre payante : Stripe, webhook, crons, pipeline data,
            synthèses IA, migrations et accès manuel admin.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void readinessQuery.refetch()}
          className="liquid-panel-soft inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-gold transition hover:border-gold"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${readinessQuery.isFetching ? "animate-spin" : ""}`} />
          Actualiser
        </button>
      </div>

      {readinessQuery.error ? (
        <div className="mt-4 rounded-lg border border-red-300/20 bg-red-500/10 p-3 text-sm text-red-100">
          {readinessQuery.error instanceof Error
            ? readinessQuery.error.message
            : "Diagnostic indisponible"}
        </div>
      ) : null}

      <div className="mt-5 grid gap-4 lg:grid-cols-[0.85fr_1.15fr]">
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
          <ReadinessBadge status={readiness?.status ?? "warning"} />
          <div className="mt-4 grid gap-3 text-sm">
            <DiagnosticLine
              label="Dernière vérification"
              value={readiness?.checkedAt ? formatDateTime(readiness.checkedAt) : "Chargement"}
            />
            <DiagnosticLine
              label="Migration attendue"
              value={readiness?.migrations.expectedLatestVersion ?? "—"}
            />
            <DiagnosticLine
              label="Migration appliquée"
              value={readiness?.migrations.latestAppliedVersion ?? "Non vérifiée"}
            />
            <DiagnosticLine
              label="Migrations journalisées"
              value={
                readiness?.migrations.appliedCount == null
                  ? "Non vérifié"
                  : String(readiness.migrations.appliedCount)
              }
            />
          </div>

          {webhookUrl ? (
            <button
              type="button"
              onClick={() => copyWebhookUrl(webhookUrl)}
              className="liquid-panel-soft mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-gold transition hover:border-gold"
            >
              <Clipboard className="h-3.5 w-3.5" />
              Copier l'URL webhook Stripe
            </button>
          ) : null}
        </div>

        <div className="overflow-hidden rounded-lg border border-white/10">
          <div className="grid grid-cols-[0.62fr_0.38fr] gap-3 bg-white/[0.04] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            <span>Contrôle</span>
            <span>État</span>
          </div>
          <div className="divide-y divide-white/10">
            {readinessQuery.isLoading ? (
              <div className="p-4 text-sm text-muted-foreground">Chargement du diagnostic</div>
            ) : readiness?.items.length ? (
              readiness.items.map((item) => <ReadinessLine key={item.key} item={item} />)
            ) : (
              <div className="p-4 text-sm text-muted-foreground">Aucun contrôle disponible</div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function ReadinessLine({ item }: { item: ReadinessItem }) {
  return (
    <div className="grid grid-cols-[0.62fr_0.38fr] gap-3 px-3 py-3 text-sm">
      <div className="min-w-0">
        <div className="flex items-center gap-2 font-semibold text-foreground">
          <StatusIcon status={item.status} />
          {item.label}
        </div>
        <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.detail}</div>
        {item.action ? (
          <div className="mt-2 text-xs leading-relaxed text-amber-100">{item.action}</div>
        ) : null}
      </div>
      <div className="flex items-start justify-end">
        <ReadinessPill status={item.status} />
      </div>
    </div>
  );
}

function DiagnosticLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-white/10 pb-2 last:border-b-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-[60%] truncate font-mono text-xs text-foreground">{value}</span>
    </div>
  );
}

function ReadinessBadge({ status }: { status: ReadinessStatus }) {
  const label =
    status === "ready" ? "Prêt" : status === "warning" ? "À surveiller" : "Action requise";
  return (
    <div className="flex items-center gap-3">
      <span className="grid h-10 w-10 place-items-center rounded-lg border border-white/10 bg-white/[0.04] text-gold">
        <StatusIcon status={status} />
      </span>
      <div>
        <div className="font-semibold text-foreground">{label}</div>
        <div className="text-xs text-muted-foreground">État global de commercialisation</div>
      </div>
    </div>
  );
}

function ReadinessPill({ status }: { status: ReadinessStatus }) {
  const label = status === "ready" ? "Prêt" : status === "warning" ? "À vérifier" : "Bloquant";
  const tone =
    status === "ready"
      ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-100"
      : status === "warning"
        ? "border-amber-300/20 bg-amber-400/10 text-amber-100"
        : "border-red-300/20 bg-red-500/10 text-red-100";

  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] ${tone}`}>
      {label}
    </span>
  );
}

function StatusIcon({ status }: { status: ReadinessStatus }) {
  if (status === "ready") return <CheckCircle className="h-4 w-4 text-emerald-200" />;
  if (status === "warning") return <AlertTriangle className="h-4 w-4 text-amber-200" />;
  return <XCircle className="h-4 w-4 text-red-200" />;
}

async function copyWebhookUrl(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    toast.success("URL webhook copiée.");
  } catch {
    toast.error("Copie impossible.");
  }
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
