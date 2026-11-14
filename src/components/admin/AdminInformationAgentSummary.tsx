import type { ReactNode } from "react";
import { AdminAutopilotEmergencyStop } from "@/components/admin/AdminAutopilotEmergencyStop";
import type {
  InformationAgentSummaryData,
  SummaryValue,
} from "@/components/admin/use-information-agent-summary";

const PILOT_LABELS = { off: "Éteint", simulation: "Simulation", live: "Réel" } as const;
const PILOT_TONES = {
  off: "text-brand-navy",
  simulation: "text-warning",
  live: "text-success",
} as const;

function display<T>(entry: SummaryValue<T>): string {
  if (entry.value !== null) return String(entry.value);
  return entry.failed ? "indisponible" : "…";
}

/**
 * Bandeau de synthèse, visible sous tous les onglets : état du pilote (Éteint, Simulation, Réel, ou Arrêté
 * automatiquement avec son motif en clair), envois du jour, réponses à relire, messages non rattachés, et
 * l'arrêt d'urgence du pilote. Deux colonnes à 390 px, une ligne au-delà. Aucun contenu de message ni
 * adresse : seulement des nombres et l'état du pilote.
 */
export function AdminInformationAgentSummary({
  summary,
}: {
  summary: InformationAgentSummaryData;
}) {
  const mode = summary.pilotMode.value;
  return (
    <section aria-label="Synthèse de l’agent" className="rounded-xl border bg-white p-3 sm:p-4">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Item label="Pilote automatique">
          {summary.pilotAutoStopped ? (
            <span className="text-danger">Arrêté automatiquement</span>
          ) : (
            <span className={mode ? PILOT_TONES[mode] : ""}>
              {mode ? PILOT_LABELS[mode] : display(summary.pilotMode)}
            </span>
          )}
        </Item>
        <Item label="Envois du jour">{display(summary.sentToday)}</Item>
        <Item label="Réponses à relire">{display(summary.toReview)}</Item>
        <Item label="Messages non rattachés">{display(summary.unrouted)}</Item>
      </dl>
      <div className="mt-3 flex flex-wrap items-start gap-3">
        {summary.pilotNotice ? (
          <p
            role="alert"
            className={`min-w-0 flex-1 basis-64 rounded-lg border p-2 text-xs leading-5 ${
              summary.pilotNotice.tone === "alert"
                ? "border-danger/30 bg-danger-tint text-danger"
                : "border-warning/30 bg-warning-tint text-warning"
            }`}
          >
            {summary.pilotNotice.text}
          </p>
        ) : null}
        <div className="ml-auto">
          <AdminAutopilotEmergencyStop mode={mode} />
        </div>
      </div>
    </section>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-brand-navy/60">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums leading-6">{children}</dd>
    </div>
  );
}
