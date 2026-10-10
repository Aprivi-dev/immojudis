"use client";

import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.js";
import Bot from "lucide-react/dist/esm/icons/bot.js";
import CheckCircle from "lucide-react/dist/esm/icons/check-circle.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import XCircle from "lucide-react/dist/esm/icons/x-circle.js";
import { useState } from "react";
import { AdminPanel, AdminPrimaryButton, AdminSectionHeading } from "@/components/admin/AdminShell";
import {
  errorCount,
  formatDateTime,
  formatInteger,
  runDuration,
  shortId,
  summaryNumber,
} from "@/components/admin/admin-format";
import { StatusPill } from "@/components/admin/admin-ui";
import { adminRunRestartRequest, type AdminRunRequest } from "@/lib/admin-run-actions";
import { collectionSourceResults } from "@/lib/admin-source-collection";
import type {
  AdminScrollSource,
  AiDescriptionDashboardStats,
  AuctionRun,
} from "@/lib/admin.functions";

export const SOURCE_OPTIONS: Array<{ value: AdminScrollSource; label: string }> = [
  { value: "all", label: "Toutes les sources" },
  { value: "avoventes", label: "Avoventes" },
  { value: "licitor", label: "Licitor" },
  { value: "vench", label: "Vench" },
  { value: "info_encheres", label: "Info Enchères" },
  { value: "encheres_publiques", label: "Enchères-Publiques" },
  { value: "petites_affiches", label: "Petites Affiches · Supabase" },
  { value: "cessions_etat", label: "Cessions État · Supabase" },
  { value: "agrasc", label: "AGRASC" },
  { value: "encheres_immobilieres", label: "Enchères Immobilières" },
  { value: "notaires", label: "Notaires" },
];

export function OperationsRunTable({
  runs,
  isLoading,
  selectedRunId,
  onSelectRun,
}: {
  runs: AuctionRun[];
  isLoading: boolean;
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
}) {
  if (isLoading) {
    return <div className="p-5 text-sm text-brand-navy/58">Chargement des exécutions…</div>;
  }
  if (!runs.length) {
    return <div className="p-5 text-sm text-brand-navy/58">Aucune exécution trouvée.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[58rem]">
        <div className="grid grid-cols-[1fr_1fr_0.85fr_1.25fr_0.8fr_0.75fr_0.75fr_0.45fr] gap-3 border-b border-brand-navy/10 px-5 py-3 text-xs font-semibold text-brand-navy/55">
          <span>Run</span>
          <span>Source</span>
          <span>Statut</span>
          <span>Début</span>
          <span>Durée</span>
          <span>Collectées</span>
          <span>Intégrées</span>
          <span>Err.</span>
        </div>
        <div className="divide-y divide-brand-navy/10">
          {runs.map((run) => {
            const selected = run.id === selectedRunId;
            return (
              <button
                key={run.id}
                type="button"
                onClick={() => onSelectRun(run.id)}
                className={`grid w-full grid-cols-[1fr_1fr_0.85fr_1.25fr_0.8fr_0.75fr_0.75fr_0.45fr] gap-3 px-5 py-3 text-left text-sm transition hover:bg-brand-navy/[0.025] ${
                  selected ? "border-l-2 border-gold-soft bg-cream pl-[1.125rem]" : ""
                }`}
              >
                <span className="font-mono text-xs font-semibold text-brand-navy">
                  #{shortId(run.id).toUpperCase()}
                </span>
                <span className="truncate text-brand-navy/72">{run.source ?? "—"}</span>
                <StatusPill status={run.status} />
                <span className="text-brand-navy/65">
                  {run.startedAt ? formatDateTime(run.startedAt) : "—"}
                </span>
                <span className="text-brand-navy/65">{runDuration(run)}</span>
                <span className="tabular-nums text-brand-navy">
                  {summaryNumber(run, "collected")}
                </span>
                <span className="tabular-nums text-brand-navy">
                  {summaryNumber(run, "upserted")}
                </span>
                <span className={errorCount(run.errors) ? "text-red-600" : "text-brand-navy/65"}>
                  {errorCount(run.errors)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function RunDetails({
  run,
  onRestart,
  restartPending,
}: {
  run: AuctionRun | null;
  onRestart: (request: AdminRunRequest) => void;
  restartPending: boolean;
}) {
  const [showLogs, setShowLogs] = useState(false);
  if (!run) {
    return (
      <AdminPanel className="flex min-h-96 items-center justify-center p-6 text-sm text-brand-navy/58">
        Sélectionnez une exécution pour voir son détail.
      </AdminPanel>
    );
  }
  const stages = [
    ["Collecte", summaryNumber(run, "collected")],
    ["Déduplication", summaryNumber(run, "deduplicated")],
    ["Écriture Supabase", summaryNumber(run, "upserted")],
  ] as const;
  const restartRequest = adminRunRestartRequest(run);
  return (
    <AdminPanel className="p-5">
      <AdminSectionHeading title="Exécution sélectionnée" />
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <strong className="font-mono text-xl text-brand-navy">
          #{shortId(run.id).toUpperCase()}
        </strong>
        <StatusPill status={run.status} />
      </div>
      <dl className="mt-5 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-3 text-sm">
        <dt className="text-brand-navy/55">Source</dt>
        <dd className="text-brand-navy">{run.source ?? "—"}</dd>
        <dt className="text-brand-navy/55">Début</dt>
        <dd className="text-brand-navy">{run.startedAt ? formatDateTime(run.startedAt) : "—"}</dd>
        <dt className="text-brand-navy/55">Durée</dt>
        <dd className="text-brand-navy">{runDuration(run)}</dd>
      </dl>
      <div className="mt-5 grid grid-cols-3 divide-x divide-brand-navy/10 border-y border-brand-navy/10 py-4 text-center">
        <RunSummaryNumber value={summaryNumber(run, "collected")} label="collectées" />
        <RunSummaryNumber value={summaryNumber(run, "deduplicated")} label="dédupliquées" />
        <RunSummaryNumber value={summaryNumber(run, "upserted")} label="intégrées" />
      </div>
      <div className="mt-5 space-y-4">
        {stages.map(([label, value], index) => (
          <div key={label} className="relative flex items-center gap-3 text-sm">
            {index < stages.length - 1 ? (
              <span
                className={`absolute left-[0.47rem] top-5 h-5 w-px ${
                  runStageState(run, index) === "complete" ? "bg-emerald-300" : "bg-brand-navy/15"
                }`}
              />
            ) : null}
            <RunStageIcon state={runStageState(run, index)} />
            <span className="flex-1 text-brand-navy">{label}</span>
            <span className="tabular-nums text-brand-navy/58">
              {value} · {runStageLabel(runStageState(run, index))}
            </span>
          </div>
        ))}
        {errorCount(run.errors) > 0 ? (
          <div className="flex items-center gap-3 text-sm text-amber-700">
            <AlertTriangle className="size-4" />
            {errorCount(run.errors)} avertissement{errorCount(run.errors) > 1 ? "s" : ""}
          </div>
        ) : null}
      </div>
      {collectionSourceResults(run.summary).length > 0 ? (
        <div className="mt-5 space-y-2 text-sm" aria-label="Résultats par source">
          <h3 className="font-semibold text-brand-navy">Résultats par source</h3>
          {collectionSourceResults(run.summary).map((result) => (
            <div
              key={result.source}
              className="flex flex-wrap justify-between gap-2 border-t border-brand-navy/10 pt-2"
            >
              <span>
                {SOURCE_OPTIONS.find((option) => option.value === result.source)?.label.replace(
                  " · Supabase",
                  "",
                ) ?? result.source}
              </span>
              <span className={result.failed ? "text-amber-700" : "text-brand-navy/65"}>
                {result.transport} · {result.listings ?? "—"} annonce(s) extraite(s)
                {result.failed ? " · Erreur signalée" : ""}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="mt-6 grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => setShowLogs((current) => !current)}
          className="admin-button-secondary"
          aria-expanded={showLogs}
        >
          {showLogs ? "Masquer les détails" : "Afficher les détails"}
        </button>
        <AdminPrimaryButton
          disabled={restartPending || !restartRequest}
          onClick={() => restartRequest && onRestart(restartRequest)}
        >
          {restartPending ? <RefreshCw className="size-4 animate-spin" /> : null}
          Relancer
        </AdminPrimaryButton>
      </div>
      {!restartRequest ? (
        <p className="mt-3 text-sm text-brand-navy/65">
          {run.status === "queued" || run.status === "running"
            ? "Cette exécution est déjà en attente ou en cours."
            : "Les paramètres d’origine ne permettent pas cette relance. Utilisez les commandes de collecte ou d’enrichissement de cette page."}
        </p>
      ) : null}
      {showLogs ? (
        <div className="mt-4 grid gap-4 rounded-lg border border-brand-navy/10 bg-brand-navy/[0.025] p-4 text-xs">
          <div>
            <h3 className="font-semibold text-brand-navy">Résumé JSON</h3>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-brand-navy/72">
              {JSON.stringify(run.summary, null, 2)}
            </pre>
          </div>
          <div>
            <h3 className="font-semibold text-brand-navy">Erreurs JSON</h3>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-brand-navy/72">
              {JSON.stringify(run.errors, null, 2)}
            </pre>
          </div>
        </div>
      ) : null}
    </AdminPanel>
  );
}

type RunStageState = "complete" | "failed" | "running" | "pending" | "unknown";

function runStageState(run: AuctionRun, index: number): RunStageState {
  const summaryKeys = ["collected", "deduplicated", "upserted"];
  const key = summaryKeys[index];
  const hasValue = key ? typeof run.summary[key] === "number" : false;

  if (run.status === "failed") {
    const failedStage = failedRunStageIndex(run);
    if (failedStage == null) return "unknown";
    if (index === failedStage) return "failed";
    return index < failedStage && hasValue ? "complete" : "unknown";
  }
  if (run.status === "succeeded") return hasValue ? "complete" : "unknown";
  if (run.status === "running") return hasValue ? "complete" : index === 0 ? "running" : "pending";
  if (run.status === "queued") return "pending";
  return hasValue ? "complete" : "unknown";
}

function failedRunStageIndex(run: AuctionRun): number | null {
  for (const key of Object.keys(run.errors)) {
    const normalized = key.toLocaleLowerCase("fr-FR");
    if (/(collect|source|scrap)/.test(normalized)) return 0;
    if (/(dedup|duplicat)/.test(normalized)) return 1;
    if (/(upsert|write|supabase|persist)/.test(normalized)) return 2;
  }
  return null;
}

function runStageLabel(state: RunStageState): string {
  if (state === "complete") return "terminée";
  if (state === "failed") return "en échec";
  if (state === "running") return "en cours";
  if (state === "pending") return "en attente";
  return "non déterminée";
}

function RunStageIcon({ state }: { state: RunStageState }) {
  if (state === "complete") {
    return <CheckCircle className="relative z-10 size-4 shrink-0 text-emerald-600" />;
  }
  if (state === "failed") {
    return <XCircle className="relative z-10 size-4 shrink-0 text-red-600" />;
  }
  if (state === "running") {
    return <RefreshCw className="relative z-10 size-4 shrink-0 animate-spin text-sky-600" />;
  }
  return <AlertTriangle className="relative z-10 size-4 shrink-0 text-amber-600" />;
}

function RunSummaryNumber({ value, label }: { value: string; label: string }) {
  return (
    <span className="px-2">
      <strong className="block text-xl tabular-nums text-brand-navy">{value}</strong>
      <span className="mt-1 block text-xs text-brand-navy/55">{label}</span>
    </span>
  );
}

export function AiBackfillPanel({
  aiDescriptions,
  remaining,
  progress,
  backfillLimit,
  setBackfillLimit,
  pending,
  onBackfill,
  expanded = false,
  status = "ready",
}: {
  aiDescriptions?: AiDescriptionDashboardStats;
  remaining: number;
  progress: number;
  backfillLimit: number;
  setBackfillLimit: (value: number) => void;
  pending: boolean;
  onBackfill: () => void;
  expanded?: boolean;
  /** La couverture IA se calcule à part (lecture de toutes les ventes) : état de cette lecture. */
  status?: "ready" | "loading" | "error";
}) {
  const validLimit = Number.isInteger(backfillLimit) && backfillLimit >= 1 && backfillLimit <= 100;
  return (
    <AdminPanel className="p-5">
      <AdminSectionHeading
        title="Synthèses IA manquantes"
        description={
          expanded
            ? `Version attendue : ${aiDescriptions?.expectedPromptVersion ?? "chargement…"}`
            : undefined
        }
      />
      <div className="mt-5 grid gap-5 md:grid-cols-[auto_1fr_auto_auto] md:items-center">
        <div
          className="grid size-20 place-items-center rounded-full text-lg font-semibold text-brand-navy"
          style={{
            background: `radial-gradient(circle closest-side, white 78%, transparent 80% 100%), conic-gradient(#216ac0 ${progress}%, #e6edf5 0)`,
          }}
          aria-label={`${progress}% des synthèses prêtes`}
        >
          {progress}%
        </div>
        <div>
          <strong className="text-2xl tabular-nums text-brand-navy">
            {formatInteger(aiDescriptions?.ready ?? 0)} /{" "}
            {formatInteger(aiDescriptions?.activeOrUpcoming ?? 0)}
          </strong>
          <p
            className="mt-1 text-sm text-brand-navy/62"
            role={status === "ready" ? undefined : "status"}
          >
            {status === "loading"
              ? "Calcul de la couverture IA en cours…"
              : status === "error"
                ? "Couverture IA indisponible pour le moment."
                : `${remaining} annonce${remaining > 1 ? "s" : ""} à traiter`}
          </p>
        </div>
        <label className="grid gap-2 text-sm font-medium text-brand-navy">
          Taille du lot
          <input
            type="number"
            min={1}
            max={100}
            step={1}
            required
            value={Number.isNaN(backfillLimit) ? "" : backfillLimit}
            aria-invalid={!validLimit}
            onChange={(event) => setBackfillLimit(event.target.valueAsNumber)}
            className="h-11 w-32 rounded-lg border border-brand-navy/18 bg-white px-3 text-sm outline-none focus:border-gold"
          />
          {!validLimit ? <span role="alert">Saisissez un entier de 1 à 100.</span> : null}
        </label>
        <button
          type="button"
          disabled={pending || status !== "ready" || remaining === 0 || !validLimit}
          onClick={onBackfill}
          className="admin-button-secondary md:self-end"
        >
          {pending ? <RefreshCw className="size-4 animate-spin" /> : <Bot className="size-4" />}
          Lancer le backfill
        </button>
      </div>
    </AdminPanel>
  );
}
