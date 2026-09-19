"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.js";
import CheckCircle from "lucide-react/dist/esm/icons/check-circle.js";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import MailPlus from "lucide-react/dist/esm/icons/mail-plus.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { useState } from "react";
import { toast } from "sonner";
import { Link } from "@/lib/router-compat";
import {
  fetchAdminCatalogueReadiness,
  runAdminCatalogueReadinessActionClient,
} from "@/lib/client-api";
import type {
  CatalogueReadinessQueueItem,
  CatalogueReadinessStatus,
} from "@/lib/admin-catalogue-readiness";

const QUERY_KEY = ["admin-catalogue-readiness"] as const;
const PAGE_SIZE = 100;

export type InformationRequestSelection = {
  saleId: string;
  title: string;
  recipientName: string | null;
  recipientContact: string | null;
};

export function AdminCatalogueReadinessPanel({
  onPrepareInformationRequest,
}: {
  onPrepareInformationRequest?: (selection: InformationRequestSelection) => void;
}) {
  const queryClient = useQueryClient();
  const [pageOffset, setPageOffset] = useState(0);
  const query = useQuery({
    queryKey: [...QUERY_KEY, pageOffset],
    queryFn: () => fetchAdminCatalogueReadiness({ offset: pageOffset, limit: PAGE_SIZE }),
    staleTime: 30_000,
  });
  const action = useMutation({
    mutationFn: runAdminCatalogueReadinessActionClient,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success("Décision de maturité enregistrée.");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Action impossible"),
  });

  if (query.isPending) {
    return <p role="status">Chargement de la file de maturité…</p>;
  }
  if (query.error || !query.data) {
    return (
      <section className="rounded-xl border bg-white p-5">
        <p role="alert" className="text-sm text-red-700">
          {query.error instanceof Error
            ? query.error.message
            : "La file de maturité est indisponible."}
        </p>
        <button className="admin-button-secondary mt-3" onClick={() => void query.refetch()}>
          Réessayer
        </button>
      </section>
    );
  }

  const overview = query.data;
  return (
    <div className="space-y-4">
      <section className="rounded-xl border bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-[#a36f2c]">
              <ShieldCheck className="size-4" />
              Sélection Premium
            </div>
            <h2 className="mt-2 text-xl font-semibold">Seuil de maturité du catalogue</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[#132238]/65">
              Les fiches restent conservées en base. Lorsque le filtre est actif, seules les fiches
              prêtes ou publiées par dérogation alimentent l’analyse Premium.
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
                overview.policy.enforcementEnabled
                  ? "admin-button-secondary"
                  : "admin-button-primary"
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
          <Metric label="Prêtes Premium" value={overview.counts.premium_ready} tone="green" />
        </div>
        <p className="mt-3 text-xs text-[#132238]/55">
          Politique {overview.policy.policyVersion} · seuil {overview.policy.premiumReadyMin}/100 ·
          confiance minimale {Math.round(overview.policy.minimumScoreConfidence * 100)} %
        </p>
      </section>

      <section className="overflow-hidden rounded-xl border bg-white">
        <div className="border-b px-5 py-4">
          <h2 className="font-semibold">File d’enrichissement</h2>
          <p className="mt-1 text-sm text-[#132238]/60">
            {overview.queueTotal} dossier{overview.queueTotal > 1 ? "s" : ""} à reprendre, classés
            par proximité avec le seuil.
          </p>
        </div>
        {overview.items.length ? (
          <div className="divide-y">
            {overview.items.map((item) => (
              <QueueLine
                key={item.id}
                item={item}
                pending={action.isPending}
                run={action.mutate}
                onPrepareInformationRequest={onPrepareInformationRequest}
              />
            ))}
          </div>
        ) : (
          <p className="p-5 text-sm text-[#132238]/60">Aucun dossier à reprendre.</p>
        )}
        {overview.queueTotal > overview.queueLimit ? (
          <div className="flex items-center justify-between gap-3 border-t px-5 py-3 text-sm">
            <span className="text-[#132238]/55">
              {overview.queueOffset + 1}–
              {Math.min(overview.queueOffset + overview.items.length, overview.queueTotal)} sur{" "}
              {overview.queueTotal}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="admin-button-secondary"
                disabled={overview.queueOffset === 0 || query.isFetching}
                onClick={() => setPageOffset(Math.max(0, overview.queueOffset - PAGE_SIZE))}
              >
                Précédent
              </button>
              <button
                type="button"
                className="admin-button-secondary"
                disabled={
                  overview.queueOffset + overview.items.length >= overview.queueTotal ||
                  query.isFetching
                }
                onClick={() => setPageOffset(overview.queueOffset + PAGE_SIZE)}
              >
                Suivant
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function QueueLine({
  item,
  pending,
  run,
  onPrepareInformationRequest,
}: {
  item: CatalogueReadinessQueueItem;
  pending: boolean;
  run: (
    input:
      | { action: "set_override"; saleId: string; decision: "hold" | "publish"; reason: string }
      | { action: "clear_override"; saleId: string },
  ) => void;
  onPrepareInformationRequest?: (selection: InformationRequestSelection) => void;
}) {
  const [decision, setDecision] = useState<"hold" | "publish" | null>(null);
  const [reason, setReason] = useState("");
  const title = item.title || [item.city, item.department].filter(Boolean).join(" — ") || item.id;
  return (
    <article className="p-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ReadinessPill status={item.readinessStatus} />
            <span className="font-mono text-xs text-[#132238]/50">
              {item.readinessScore == null ? "Non scorée" : `${item.readinessScore}/100`}
            </span>
            {item.override ? (
              <span className="rounded-full border px-2 py-0.5 text-[11px]">
                Dérogation : {item.override === "publish" ? "publier" : "retenir"}
              </span>
            ) : null}
          </div>
          <h3 className="mt-2 truncate font-semibold">{title}</h3>
          <p className="mt-1 text-xs text-[#132238]/55">
            {[item.city, item.department, item.sourceName].filter(Boolean).join(" · ") ||
              "Source inconnue"}
          </p>
          {item.blockers.length ? (
            <p className="mt-3 text-sm text-red-700">Blocages : {item.blockers.join(" · ")}</p>
          ) : null}
          {item.missingFields.length ? (
            <p className="mt-2 text-sm text-[#132238]/65">
              Manques : {item.missingFields.join(" · ")}
            </p>
          ) : null}
          <p className="mt-2 text-xs text-[#132238]/50">
            Contact : {item.lawyerContact || item.lawyerName || "aucun contact détecté"}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {onPrepareInformationRequest ? (
            <button
              type="button"
              className="admin-button-primary inline-flex items-center gap-2"
              onClick={() =>
                onPrepareInformationRequest({
                  saleId: item.id,
                  title,
                  recipientName: item.lawyerName,
                  recipientContact: item.lawyerContact,
                })
              }
            >
              <MailPlus className="size-3.5" />
              Préparer une demande
            </button>
          ) : null}
          <Link
            to="/sales/$id"
            params={{ id: item.id }}
            className="admin-button-secondary inline-flex items-center gap-2"
          >
            Voir la fiche <ExternalLink className="size-3.5" />
          </Link>
          {item.override ? (
            <button
              type="button"
              className="admin-button-secondary"
              disabled={pending}
              onClick={() => run({ action: "clear_override", saleId: item.id })}
            >
              Lever la dérogation
            </button>
          ) : (
            <>
              <button
                type="button"
                className="admin-button-secondary"
                onClick={() => setDecision("hold")}
              >
                Maintenir interne
              </button>
              <button
                type="button"
                className="admin-button-secondary"
                onClick={() => setDecision("publish")}
              >
                Déroger et publier
              </button>
            </>
          )}
        </div>
      </div>
      {decision ? (
        <div className="mt-4 flex flex-col gap-2 rounded-lg bg-slate-50 p-3 sm:flex-row">
          <label className="min-w-0 flex-1 text-xs font-medium">
            Motif obligatoire
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm"
              placeholder="Précisez la preuve ou la raison éditoriale"
            />
          </label>
          <div className="flex items-end gap-2">
            <button
              type="button"
              className="admin-button-primary"
              disabled={pending || reason.trim().length < 8}
              onClick={() => {
                run({ action: "set_override", saleId: item.id, decision, reason: reason.trim() });
                setDecision(null);
                setReason("");
              }}
            >
              Confirmer
            </button>
            <button
              type="button"
              className="admin-button-secondary"
              onClick={() => setDecision(null)}
            >
              Annuler
            </button>
          </div>
        </div>
      ) : null}
    </article>
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
          : "text-[#132238]";
  return (
    <div className="rounded-lg border bg-slate-50 p-3">
      <div className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="mt-1 text-xs text-[#132238]/55">{label}</div>
    </div>
  );
}

function ReadinessPill({ status }: { status: CatalogueReadinessStatus }) {
  const config = {
    unassessed: ["Non évaluée", "border-slate-300 bg-slate-50 text-slate-700"],
    internal_only: ["Interne", "border-red-200 bg-red-50 text-red-700"],
    needs_enrichment: ["À enrichir", "border-amber-200 bg-amber-50 text-amber-800"],
    premium_ready: ["Prête Premium", "border-emerald-200 bg-emerald-50 text-emerald-700"],
  }[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${config[1]}`}
    >
      {status === "premium_ready" ? <CheckCircle className="size-3" /> : null}
      {config[0]}
    </span>
  );
}
