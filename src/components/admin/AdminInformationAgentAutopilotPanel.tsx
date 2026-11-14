"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { queryErrorMessage } from "@/components/admin/admin-format";
import { AdminAutopilotEmergencyStop } from "@/components/admin/AdminAutopilotEmergencyStop";
import { toast } from "@/lib/toast";
import {
  AUTOPILOT_QUERY_KEY as QUERY_KEY,
  autopilotQuery,
} from "@/components/admin/information-agent-queries";
import { runAdminInformationAgentAutopilotActionClient } from "@/lib/client-api";
import type { AutopilotPreparedDraft } from "@/lib/information-agent/autopilot-view";

const BTN = "admin-button-secondary";
const MODES = [
  ["off", "Éteint"],
  ["simulation", "Simulation"],
  ["live", "Réel"],
] as const;

/**
 * Pilote automatique : interrupteur à trois états, compteurs, contrôle de préparation, brouillons prêts à
 * valider, derniers événements et arrêt d’urgence. Désactivé par défaut. Tout arrive mis en forme par le
 * serveur ; chaque changement exige un motif (sauf l’arrêt d’urgence) et est journalisé. Un brouillon prêt
 * à valider s’ouvre dans l’éditeur de l’onglet « À contacter » (`onOpenDraft`), là où il se valide. En mode
 * Simulation, un passage peut être lancé à la main (hors plage horaire) ; son résultat ou son refus s’affiche.
 */
export function AdminInformationAgentAutopilotPanel({
  onOpenDraft,
}: {
  onOpenDraft?: (draft: AutopilotPreparedDraft) => void;
}) {
  const queryClient = useQueryClient();
  const reasonHintId = useId();
  const [reason, setReason] = useState("");
  const [runOutcome, setRunOutcome] = useState<{ refused: boolean; text: string } | null>(null);
  const [cap, setCap] = useState("");
  const [days, setDays] = useState("");
  const [aipd, setAipd] = useState("");
  const query = useQuery(autopilotQuery());
  const run = useMutation({
    mutationFn: runAdminInformationAgentAutopilotActionClient,
    onSuccess: ({ onDemandRun, ...view }) => {
      queryClient.setQueryData(QUERY_KEY, view);
      setReason("");
      if (onDemandRun) setRunOutcome({ refused: false, text: onDemandRun.text });
      toast.success(
        onDemandRun ? "Passage de simulation terminé." : "Pilote automatique mis à jour.",
      );
    },
    onError: (error, input) => {
      const message = queryErrorMessage(error, "Action impossible");
      if (input.action === "run_simulation_now") setRunOutcome({ refused: true, text: message });
      toast.error(message);
    },
  });
  const view = query.data;
  const reasonMissing = reason.trim().length < 8;
  const ready = !reasonMissing && !run.isPending;

  return (
    <section className="rounded-xl border bg-white p-5" aria-labelledby="autopilot-title">
      <h2 id="autopilot-title" className="font-semibold">
        Pilote automatique
      </h2>
      {query.error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          Pilote indisponible.
        </p>
      ) : null}
      {view ? (
        <div className="mt-3 space-y-4 text-sm">
          <p>
            État : <strong>{view.modeLabel}</strong>
          </p>
          {view.notice ? (
            <p
              role="alert"
              className={view.notice.tone === "alert" ? "text-danger" : "text-warning"}
            >
              {view.notice.text}
            </p>
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1 text-xs font-medium">
              Motif du changement (8 caractères au moins)
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                aria-describedby={reasonMissing ? reasonHintId : undefined}
                className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm"
              />
            </label>
            {MODES.map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className={BTN}
                disabled={!ready || view.mode === mode}
                onClick={() => run.mutate({ action: "set_mode", mode, reason })}
              >
                {label}
              </button>
            ))}
            <AdminAutopilotEmergencyStop mode={view.mode} />
            {reasonMissing ? (
              <p id={reasonHintId} className="basis-full text-xs text-brand-navy/70">
                Saisissez un motif de 8 caractères au moins pour activer les boutons (l’arrêt
                d’urgence n’en demande pas).
              </p>
            ) : null}
          </div>
          {view.mode === "simulation" || runOutcome ? (
            <div className="flex flex-wrap items-center gap-2">
              {view.mode === "simulation" ? (
                <button
                  type="button"
                  className={BTN}
                  disabled={!ready}
                  onClick={() => {
                    setRunOutcome(null);
                    run.mutate({ action: "run_simulation_now", reason });
                  }}
                >
                  Lancer un passage de simulation
                </button>
              ) : null}
              {runOutcome ? (
                <p
                  role={runOutcome.refused ? "alert" : "status"}
                  className={runOutcome.refused ? "text-danger" : "text-brand-navy/80"}
                >
                  {runOutcome.text}
                </p>
              ) : null}
            </div>
          ) : null}
          <dl className="grid gap-x-6 sm:grid-cols-2">
            {view.counters.map((counter) => (
              <div key={counter.label} className="flex justify-between gap-3 border-b py-1">
                <dt className="text-brand-navy/70">{counter.label}</dt>
                <dd className="font-medium">{counter.value}</dd>
              </div>
            ))}
          </dl>
          <details>
            <summary className="cursor-pointer font-medium">
              Contrôle de préparation au mode réel :{" "}
              {view.readiness.ready ? "satisfait" : "non satisfait"}
            </summary>
            <ul className="mt-2 space-y-1">
              {view.readiness.checks.map((check) => (
                <li key={check.label} className={check.ok ? "text-success" : "text-danger"}>
                  {check.ok ? "Oui" : "Non"} · {check.label}{" "}
                  <span className="text-brand-navy/60">({check.detail})</span>
                </li>
              ))}
            </ul>
          </details>
          <details>
            <summary className="cursor-pointer font-medium">Réglages</summary>
            <div className="mt-2 flex flex-wrap items-end gap-2 text-xs">
              {(
                [
                  ["Plafond par jour", cap, setCap, view.settings.capTotalOverride ?? "phase"],
                  ["Article 14 : jours", days, setDays, view.settings.art14MaxAgeDays],
                  ["Version de l’AIPD", aipd, setAipd, view.settings.aipdLabel],
                ] as const
              ).map(([label, value, set, hint]) => (
                <label key={label}>
                  {label}
                  <input
                    value={value}
                    onChange={(event) => set(event.target.value)}
                    placeholder={String(hint)}
                    className="mt-1 block w-28 rounded-lg border bg-white px-2 py-1"
                  />
                </label>
              ))}
              <button
                type="button"
                className={BTN}
                disabled={!ready || (!cap && !days)}
                onClick={() =>
                  run.mutate({
                    action: "update_settings",
                    reason,
                    changes: {
                      ...(cap ? { capTotalOverride: Number(cap) } : {}),
                      ...(days ? { art14MaxAgeDays: Number(days) } : {}),
                    },
                  })
                }
              >
                Enregistrer
              </button>
              <button
                type="button"
                className={BTN}
                disabled={!ready || !aipd.trim()}
                onClick={() => run.mutate({ action: "attest_aipd", version: aipd.trim(), reason })}
              >
                Attester l’AIPD
              </button>
              {(
                [
                  ["Licitor décodées", "allowLicitorDecoded", view.settings.allowLicitorDecoded],
                  ["Article 14", "art14RuleEnabled", view.settings.art14RuleEnabled],
                ] as const
              ).map(([label, key, on]) => (
                <button
                  key={key}
                  type="button"
                  className={BTN}
                  disabled={!ready}
                  onClick={() =>
                    run.mutate({ action: "update_settings", reason, changes: { [key]: !on } })
                  }
                >
                  {label} : {on ? "oui" : "non"}
                </button>
              ))}
            </div>
          </details>
          <div>
            <p className="font-medium">Prêtes à valider ({view.ready.count})</p>
            <ul className="mt-1 list-inside list-disc text-brand-navy/70">
              {view.ready.items.map((item) => (
                <li key={item.missionId}>
                  {onOpenDraft ? (
                    <button
                      type="button"
                      className="text-left font-medium text-gold-text underline"
                      onClick={() => onOpenDraft(item)}
                    >
                      {item.label}
                    </button>
                  ) : (
                    item.label
                  )}
                </li>
              ))}
            </ul>
          </div>
          <details>
            <summary className="cursor-pointer font-medium">Derniers événements</summary>
            <ul className="mt-2 space-y-1">
              {view.events.map((event, index) => (
                <li key={`${event.at}-${index}`}>
                  {event.at} · {event.label} {event.detail}
                </li>
              ))}
            </ul>
          </details>
        </div>
      ) : null}
    </section>
  );
}
