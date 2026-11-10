"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import CheckCircle from "lucide-react/dist/esm/icons/check-circle.js";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import MailPlus from "lucide-react/dist/esm/icons/mail-plus.js";
import { useEffect, useState } from "react";
import { toast } from "@/lib/toast";
import { AdminPagination } from "@/components/admin/AdminPagination";
import {
  CATALOGUE_READINESS_QUERY_KEY as QUERY_KEY,
  catalogueReadinessQuery,
} from "@/components/admin/information-agent-queries";
import { adminClampOffset } from "@/lib/admin-pagination";
import Link from "next/link";
import { saleDetailPath } from "@/lib/navigation";
import { runAdminCatalogueReadinessActionClient } from "@/lib/client-api";
import type {
  CatalogueReadinessQueueItem,
  CatalogueReadinessStatus,
} from "@/lib/admin-catalogue-readiness";

const CONTACT_CLASS_LABELS = { A: "Avocat", B: "À confirmer", C: "Greffe", D: "" } as const;

export type InformationRequestSelection = {
  saleId: string;
  title: string;
  recipientName: string | null;
  recipientContact: string | null;
};

/**
 * File de travail de l'onglet « À contacter ». Le seuil de maturité du catalogue et ses indicateurs
 * sont dans l'onglet « Réglages » (`AdminCatalogueReadinessSettings`) ; les deux lisent la même
 * réponse du serveur.
 */
export function AdminCatalogueReadinessPanel({
  onPrepareInformationRequest,
}: {
  onPrepareInformationRequest?: (selection: InformationRequestSelection) => void;
}) {
  const queryClient = useQueryClient();
  const [pageOffset, setPageOffset] = useState(0);
  const query = useQuery(catalogueReadinessQuery(pageOffset));
  // Après traitement des dernières lignes d'une page, revient sur la dernière page non vide.
  useEffect(() => {
    const data = query.data;
    if (data && data.items.length === 0 && data.queueOffset > 0) {
      setPageOffset(adminClampOffset(data.queueOffset, data.queueLimit, data.queueTotal));
    }
  }, [query.data]);
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
      <section className="overflow-hidden rounded-xl border bg-white">
        <div className="border-b px-5 py-4">
          <h2 className="font-semibold">File d’enrichissement</h2>
          <p className="mt-1 text-sm text-brand-navy/60">
            {overview.queueTotal} dossier{overview.queueTotal > 1 ? "s" : ""} à reprendre avec un
            contact : avocats, puis greffes, puis adresses à confirmer.
          </p>
          {overview.classCounts ? (
            <p className="mt-1 text-xs text-brand-navy/55">
              Avocat {overview.classCounts.A} · Greffe {overview.classCounts.C} · À confirmer{" "}
              {overview.classCounts.B}
            </p>
          ) : null}
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
          <p className="p-5 text-sm text-brand-navy/60">Aucun dossier à reprendre.</p>
        )}
        <AdminPagination
          label="file d’enrichissement"
          offset={overview.queueOffset}
          limit={overview.queueLimit}
          total={overview.queueTotal}
          shown={overview.items.length}
          busy={query.isFetching}
          onOffsetChange={setPageOffset}
        />
      </section>
      {overview.impossibleItems?.length ? (
        <details className="overflow-hidden rounded-xl border bg-white">
          <summary className="cursor-pointer px-5 py-4 font-semibold">
            Contact impossible ({overview.classCounts?.D ?? overview.impossibleItems.length})
          </summary>
          <p className="border-t px-5 py-3 text-sm text-brand-navy/60">
            L’annonce ne donne aucune adresse email. Si vous en trouvez une sur une page publique,
            saisissez-la : elle est alors citée au destinataire.
          </p>
          <div className="divide-y border-t">
            {overview.impossibleItems.map((item) => (
              <QueueLine
                key={item.id}
                item={item}
                pending={action.isPending}
                run={action.mutate}
                onPrepareInformationRequest={onPrepareInformationRequest}
              />
            ))}
          </div>
        </details>
      ) : null}
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
  const blockedReason = item.informationAgentBlockedReason ?? null;
  const impossible = item.contactClass === "D";
  return (
    <article className="p-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ReadinessPill status={item.readinessStatus} />
            <span className="font-mono text-xs text-brand-navy/50">
              {item.readinessScore == null ? "Non scorée" : `${item.readinessScore}/100`}
            </span>
            {item.contactClass && item.contactClass !== "D" ? (
              <span className="rounded-full border px-2 py-0.5 text-xs">
                {CONTACT_CLASS_LABELS[item.contactClass]}
              </span>
            ) : null}
            {item.override ? (
              <span className="rounded-full border px-2 py-0.5 text-[11px]">
                Dérogation : {item.override === "publish" ? "publier" : "retenir"}
              </span>
            ) : null}
          </div>
          <h3 className="mt-2 truncate font-semibold">{title}</h3>
          <p className="mt-1 text-xs text-brand-navy/55">
            {[item.city, item.department, item.sourceName].filter(Boolean).join(" · ") ||
              "Source inconnue"}
          </p>
          {item.blockers.length ? (
            <p className="mt-3 text-sm text-red-700">Blocages : {item.blockers.join(" · ")}</p>
          ) : null}
          {item.missingFields.length ? (
            <p className="mt-2 text-sm text-brand-navy/65">
              Manques : {item.missingFields.join(" · ")}
            </p>
          ) : null}
          <p className="mt-2 text-xs text-brand-navy/50">
            Contact : {item.lawyerContact || item.lawyerName || "aucun contact détecté"}
          </p>
          {onPrepareInformationRequest && blockedReason ? (
            <p id={`information-agent-blocked-${item.id}`} className="mt-1 text-xs text-amber-900">
              {blockedReason}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {onPrepareInformationRequest ? (
            <button
              type="button"
              className="admin-button-primary inline-flex items-center gap-2"
              disabled={Boolean(blockedReason) && !impossible}
              aria-describedby={blockedReason ? `information-agent-blocked-${item.id}` : undefined}
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
              {impossible
                ? "Saisir une adresse trouvée sur une page publique"
                : "Ouvrir le message"}
            </button>
          ) : null}
          <Link
            href={saleDetailPath(item.id)}
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

function ReadinessPill({ status }: { status: CatalogueReadinessStatus }) {
  const config = {
    unassessed: ["Non évaluée", "border-slate-300 bg-slate-50 text-slate-700"],
    internal_only: ["Interne", "border-red-200 bg-red-50 text-red-700"],
    needs_enrichment: ["À enrichir", "border-amber-200 bg-amber-50 text-amber-800"],
    premium_ready: ["Prête Analyse", "border-emerald-200 bg-emerald-50 text-emerald-700"],
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
