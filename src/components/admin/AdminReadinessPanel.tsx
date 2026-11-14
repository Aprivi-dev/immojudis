import { useQuery } from "@tanstack/react-query";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.js";
import CheckCircle from "lucide-react/dist/esm/icons/check-circle.js";
import Clipboard from "lucide-react/dist/esm/icons/clipboard.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import XCircle from "lucide-react/dist/esm/icons/x-circle.js";
import { formatPercent } from "@/lib/format/numbers";
import { toast } from "@/lib/toast";
import type {
  AdminOperationalReadinessResponse,
  ReadinessItem,
  ReadinessStatus,
} from "@/lib/admin-readiness";
import { adminReadinessQuery } from "@/components/admin/admin-readiness-query";
import { formatCompactDateTime, queryErrorMessage } from "@/components/admin/admin-format";
import { AdminPill } from "@/components/admin/admin-pill";

export function AdminReadinessPanel() {
  const readinessQuery = useQuery(adminReadinessQuery());
  const readiness = readinessQuery.data ?? null;
  const webhookUrl = readiness?.webhookUrl ?? null;

  return (
    <section className="admin-panel mt-6 rounded-lg p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gold-text">
            <StatusIcon status={readiness?.status ?? "warning"} />
            Readiness offre
          </div>
          <h2 className="mt-3 font-display text-2xl">Activation commerciale</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Vérifie les prérequis de l'offre payante : Stripe, webhook, crons, pipeline data,
            migrations et accès manuel admin.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void readinessQuery.refetch()}
          className="admin-panel inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-gold-text transition hover:border-gold"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${readinessQuery.isFetching ? "animate-spin" : ""}`} />
          Actualiser
        </button>
      </div>

      {readinessQuery.error ? (
        <div className="mt-4 rounded-lg border border-red-300/20 bg-danger-tint p-3 text-sm text-danger">
          {queryErrorMessage(readinessQuery.error, "Diagnostic indisponible")}
        </div>
      ) : null}

      <div className="mt-5 grid gap-4 lg:grid-cols-[0.85fr_1.15fr]">
        <div className="rounded-lg border border-brand-navy/10 bg-brand-navy/[0.03] p-4">
          <ReadinessBadge status={readiness?.status ?? "warning"} />
          <div className="mt-4 grid gap-3 text-sm">
            <DiagnosticLine
              label="Dernière vérification"
              value={
                readiness?.checkedAt ? formatCompactDateTime(readiness.checkedAt) : "Chargement"
              }
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
            <DiagnosticLine
              label="Contrôle santé"
              value={
                readiness?.operations.lastHealthRunAt
                  ? formatCompactDateTime(readiness.operations.lastHealthRunAt)
                  : "Non vérifié"
              }
            />
            <DiagnosticLine
              label="SLO santé (30 j)"
              value={formatOperationalSlo(readiness?.operations ?? null)}
            />
            <DiagnosticLine
              label="Alertes ouvertes"
              value={
                readiness?.operations.openAlertCount == null
                  ? "Non vérifié"
                  : String(readiness.operations.openAlertCount)
              }
            />
            <DiagnosticLine
              label="Scheduler santé"
              value={readiness?.operations.schedulerSchedule ?? "Inactif"}
            />
          </div>

          {webhookUrl ? (
            <button
              type="button"
              onClick={() => copyWebhookUrl(webhookUrl)}
              className="admin-panel mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-gold-text transition hover:border-gold"
            >
              <Clipboard className="h-3.5 w-3.5" />
              Copier l'URL webhook Stripe
            </button>
          ) : null}
        </div>

        <div className="overflow-hidden rounded-lg border border-brand-navy/10">
          <div className="grid grid-cols-[0.62fr_0.38fr] gap-3 bg-brand-navy/[0.03] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            <span>Contrôle</span>
            <span>État</span>
          </div>
          <div className="divide-y divide-brand-navy/10">
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

      {readiness?.operations.alerts.length ? (
        <div className="mt-5 overflow-hidden rounded-lg border border-brand-navy/10">
          <div className="grid grid-cols-[1fr_0.34fr_0.34fr] gap-3 bg-brand-navy/[0.03] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            <span>Incident opérationnel</span>
            <span>Gravité</span>
            <span>Notification</span>
          </div>
          <div className="divide-y divide-brand-navy/10">
            {readiness.operations.alerts.map((alert) => (
              <div
                key={alert.key}
                className="grid grid-cols-[1fr_0.34fr_0.34fr] gap-3 px-3 py-3 text-xs"
              >
                <div className="min-w-0">
                  <div className="text-foreground">{alert.label}</div>
                  <div className="mt-1 text-muted-foreground">
                    {alert.stateLabel} · dernier signal le {formatCompactDateTime(alert.lastSeenAt)}
                  </div>
                </div>
                <span className="text-foreground">{alert.severityLabel}</span>
                <span className="text-foreground">{alert.notificationLabel}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
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
          <div className="mt-2 text-xs leading-relaxed text-warning">{item.action}</div>
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
    <div className="flex items-center justify-between gap-4 border-b border-brand-navy/10 pb-2 last:border-b-0 last:pb-0">
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
      <span className="grid h-10 w-10 place-items-center rounded-lg border border-brand-navy/10 bg-brand-navy/[0.03] text-gold-text">
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
  const tone = status === "ready" ? "success" : status === "warning" ? "warning" : "danger";
  return <AdminPill tone={tone}>{label}</AdminPill>;
}

function StatusIcon({ status }: { status: ReadinessStatus }) {
  if (status === "ready") return <CheckCircle className="h-4 w-4 text-success" />;
  if (status === "warning") return <AlertTriangle className="h-4 w-4 text-warning" />;
  return <XCircle className="h-4 w-4 text-danger" />;
}

async function copyWebhookUrl(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    toast.success("URL webhook copiée.");
  } catch {
    toast.error("Copie impossible.");
  }
}

function formatOperationalSlo(
  operations: AdminOperationalReadinessResponse["operations"] | null,
): string {
  if (!operations || operations.successRatePercent == null) return "Non calculé";
  return `${formatPercent(operations.successRatePercent, 3, 3)} / ${formatPercent(operations.sloTargetPercent, 3)}`;
}
