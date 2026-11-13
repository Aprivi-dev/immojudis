"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { queryErrorMessage } from "@/components/admin/admin-format";
import {
  CATALOGUE_READINESS_QUERY_KEY as QUERY_KEY,
  catalogueReadinessQuery,
} from "@/components/admin/information-agent-queries";
import { runAdminCatalogueReadinessActionClient } from "@/lib/client-api";
import { formatShareAsPercent } from "@/lib/format/numbers";
import { toast } from "@/lib/toast";

/**
 * Onglet « Réglages » : seuil de maturité du catalogue (interrupteur du filtre Analyse) et ses
 * indicateurs. Même réponse du serveur que la file de travail de « À contacter » (page 0 : les
 * indicateurs ne dépendent pas de la page de la file).
 */
export function AdminCatalogueReadinessSettings() {
  const queryClient = useQueryClient();
  const query = useQuery(catalogueReadinessQuery(0));
  const action = useMutation({
    mutationFn: runAdminCatalogueReadinessActionClient,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success("Décision de maturité enregistrée.");
    },
    onError: (error) => toast.error(queryErrorMessage(error, "Action impossible")),
  });

  if (query.isPending) {
    return <p role="status">Chargement du seuil de maturité…</p>;
  }
  if (query.error || !query.data) {
    return (
      <section className="rounded-xl border bg-white p-5">
        <p role="alert" className="text-sm text-danger">
          {queryErrorMessage(query.error, "Le seuil de maturité est indisponible.")}
        </p>
        <button className="admin-button-secondary mt-3" onClick={() => void query.refetch()}>
          Réessayer
        </button>
      </section>
    );
  }

  const overview = query.data;
  return (
    <section className="rounded-xl border bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-gold-text">
            <ShieldCheck className="size-4" />
            Sélection Analyse
          </div>
          <h2 className="mt-2 text-xl font-semibold">Seuil de maturité du catalogue</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-brand-navy/65">
            Les fiches restent conservées en base. Lorsque le filtre est actif, seules les fiches
            prêtes ou publiées par dérogation alimentent l’offre Analyse.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="admin-button-secondary inline-flex items-center gap-2"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw className={`size-4 ${query.isFetching ? "animate-spin" : ""}`} />
            Actualiser
          </button>
          <button
            type="button"
            className={
              overview.policy.enforcementEnabled ? "admin-button-secondary" : "admin-button-primary"
            }
            disabled={
              action.isPending ||
              (!overview.policy.enforcementEnabled && !overview.canEnableEnforcement)
            }
            onClick={() =>
              action.mutate({
                action: "set_enforcement",
                enabled: !overview.policy.enforcementEnabled,
              })
            }
          >
            {overview.policy.enforcementEnabled ? "Désactiver le filtre" : "Activer le filtre"}
          </button>
        </div>
      </div>

      {!overview.canEnableEnforcement && !overview.policy.enforcementEnabled ? (
        <p className="mt-4 flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          Activation verrouillée : {overview.pendingEvaluations} annonce
          {overview.pendingEvaluations > 1 ? "s restent" : " reste"} à évaluer avec la politique
          courante.
        </p>
      ) : null}

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Metric label="Annonces actives" value={overview.activeSales} />
        <Metric label="À évaluer" value={overview.pendingEvaluations} tone="amber" />
        <Metric label="Internes" value={overview.counts.internal_only} tone="red" />
        <Metric label="À enrichir" value={overview.counts.needs_enrichment} tone="amber" />
        <Metric label="Prêtes Analyse" value={overview.counts.premium_ready} tone="green" />
      </div>
      <p className="mt-3 text-xs text-brand-navy/55">
        Politique {overview.policy.policyVersion} · seuil {overview.policy.premiumReadyMin}/100 ·
        confiance minimale {formatShareAsPercent(overview.policy.minimumScoreConfidence)}
      </p>
    </section>
  );
}

function Metric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "green" | "amber" | "red";
}) {
  const color =
    tone === "green"
      ? "text-emerald-700"
      : tone === "amber"
        ? "text-amber-700"
        : tone === "red"
          ? "text-red-700"
          : "text-brand-navy";
  return (
    <div className="rounded-lg border bg-slate-50 p-3">
      <div className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="mt-1 text-xs text-brand-navy/55">{label}</div>
    </div>
  );
}
