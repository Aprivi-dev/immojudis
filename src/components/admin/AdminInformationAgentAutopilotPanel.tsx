"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "@/lib/toast";
import {
  fetchAdminInformationAgentAutopilot,
  runAdminInformationAgentAutopilotActionClient,
} from "@/lib/client-api";

const QUERY_KEY = ["admin-information-agent-autopilot"] as const;
const MODES = [
  ["off", "Éteint"],
  ["simulation", "Simulation"],
  ["live", "Réel"],
] as const;

/**
 * Pilote automatique : interrupteur à trois états, compteurs, contrôle de préparation, brouillons prêts à
 * valider, derniers événements et arrêt d’urgence. Désactivé par défaut. Tout arrive mis en forme par le
 * serveur ; chaque changement exige un motif (sauf l’arrêt d’urgence) et est journalisé.
 */
export function AdminInformationAgentAutopilotPanel() {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [cap, setCap] = useState("");
  const [days, setDays] = useState("");
  const [aipd, setAipd] = useState("");
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchAdminInformationAgentAutopilot,
    staleTime: 30_000,
  });
  const run = useMutation({
    mutationFn: runAdminInformationAgentAutopilotActionClient,
    onSuccess: (view) => {
      queryClient.setQueryData(QUERY_KEY, view);
      setReason("");
      toast.success("Pilote automatique mis à jour.");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Action impossible"),
  });
  const view = query.data;
  const ready = reason.trim().length >= 8 && !run.isPending;

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
                className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm"
              />
            </label>
            {MODES.map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className="admin-button-secondary"
                disabled={!ready || view.mode === mode}
                onClick={() => run.mutate({ action: "set_mode", mode, reason })}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              className="admin-button-primary"
              disabled={run.isPending || view.mode === "off"}
              onClick={() => run.mutate({ action: "emergency_stop" })}
            >
              Arrêt d’urgence
            </button>
          </div>
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
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="text-xs">
                Plafond par jour
                <input
                  value={cap}
                  onChange={(event) => setCap(event.target.value)}
                  inputMode="numeric"
                  placeholder={String(view.settings.capTotalOverride ?? "phase")}
                  className="mt-1 block w-24 rounded-lg border bg-white px-2 py-1"
                />
              </label>
              <label className="text-xs">
                Article 14 : jours
                <input
                  value={days}
                  onChange={(event) => setDays(event.target.value)}
                  inputMode="numeric"
                  placeholder={String(view.settings.art14MaxAgeDays)}
                  className="mt-1 block w-24 rounded-lg border bg-white px-2 py-1"
                />
              </label>
              <button
                type="button"
                className="admin-button-secondary"
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
                className="admin-button-secondary"
                disabled={!ready}
                onClick={() =>
                  run.mutate({
                    action: "update_settings",
                    reason,
                    changes: { allowLicitorDecoded: !view.settings.allowLicitorDecoded },
                  })
                }
              >
                Adresses Licitor décodées :{" "}
                {view.settings.allowLicitorDecoded ? "autorisées" : "exclues"}
              </button>
              <button
                type="button"
                className="admin-button-secondary"
                disabled={!ready}
                onClick={() =>
                  run.mutate({
                    action: "update_settings",
                    reason,
                    changes: { art14RuleEnabled: !view.settings.art14RuleEnabled },
                  })
                }
              >
                Règle de l’article 14 : {view.settings.art14RuleEnabled ? "active" : "coupée"}
              </button>
            </div>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <p className="text-xs">AIPD : {view.settings.aipdLabel}</p>
              <input
                aria-label="Version de l’AIPD"
                value={aipd}
                onChange={(event) => setAipd(event.target.value)}
                className="w-32 rounded-lg border bg-white px-2 py-1 text-xs"
              />
              <button
                type="button"
                className="admin-button-secondary"
                disabled={!ready || !aipd.trim()}
                onClick={() => run.mutate({ action: "attest_aipd", version: aipd.trim(), reason })}
              >
                Attester l’AIPD
              </button>
            </div>
          </details>
          <div>
            <p className="font-medium">Prêtes à valider ({view.ready.count})</p>
            <ul className="mt-1 list-inside list-disc text-brand-navy/70">
              {view.ready.items.map((item) => (
                <li key={item}>{item}</li>
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
