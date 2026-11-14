"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.js";
import CheckCircle from "lucide-react/dist/esm/icons/check-circle.js";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import XCircle from "lucide-react/dist/esm/icons/x-circle.js";
import { useEffect, useState } from "react";
import { queryErrorMessage } from "@/components/admin/admin-format";
import { formatShortDateTime } from "@/lib/format/dates";
import { formatShareAsPercent } from "@/lib/format/numbers";
import { toast } from "@/lib/toast";
import { AdminPagination } from "@/components/admin/AdminPagination";
import { AdminPill } from "@/components/admin/admin-pill";
import { CATALOGUE_READINESS_QUERY_KEY } from "@/components/admin/information-agent-queries";
import { factFieldLabel, formatFactValue } from "@/components/admin/fact-claim-format";
import { ADMIN_PAGE_SIZE, adminClampOffset } from "@/lib/admin-pagination";
import {
  fetchAdminAuctionFactClaimReview,
  reviewAdminAuctionFactClaimClient,
} from "@/lib/client-api";
import type {
  AdminAuctionFactClaimDecision,
  AdminAuctionFactClaimReviewItem,
} from "@/lib/admin-auction-fact-claims-review";

const QUERY_KEY = ["admin-auction-fact-claim-review"] as const;

type ReviewDecision = AdminAuctionFactClaimDecision["decision"];

export function AdminAuctionFactClaimReviewPanel() {
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>({});
  const [offset, setOffset] = useState(0);
  const query = useQuery({
    queryKey: [...QUERY_KEY, offset],
    queryFn: () => fetchAdminAuctionFactClaimReview({ offset, limit: ADMIN_PAGE_SIZE }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  // Après décision sur les dernières lignes d'une page, revient sur la dernière page non vide.
  useEffect(() => {
    const data = query.data;
    if (data && data.items.length === 0 && data.offset > 0) {
      setOffset(adminClampOffset(data.offset, data.limit, data.total));
    }
  }, [query.data]);
  const review = useMutation({
    mutationFn: reviewAdminAuctionFactClaimClient,
    onSuccess: () => {
      setDrafts({});
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: CATALOGUE_READINESS_QUERY_KEY });
      toast.success("Décision enregistrée. La fiche sera réévaluée avec ce contrôle.");
    },
    onError: (error) => toast.error(queryErrorMessage(error, "Décision impossible.")),
  });

  const items = query.data?.items ?? [];
  const startDecision = (claimId: string, decision: ReviewDecision) => {
    setDrafts((previous) => ({
      ...previous,
      [claimId]: { decision, note: previous[claimId]?.note ?? "" },
    }));
  };

  const submitDecision = (claimId: string) => {
    const draft = drafts[claimId];
    if (!draft) return;
    review.mutate({
      claimId,
      decision: draft.decision,
      resolutionNote: draft.decision === "accepted" ? null : draft.note.trim() || null,
    });
  };

  return (
    <section
      className="overflow-hidden rounded-xl border bg-white"
      aria-labelledby="fact-review-title"
    >
      <div className="border-b px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-gold-text">
              <CheckCircle className="size-4" />
              Contrôle des faits sourcés
            </div>
            <h2 id="fact-review-title" className="mt-2 font-semibold">
              Faits à vérifier, sans effet sur la fiche
            </h2>
            <p className="mt-1 max-w-3xl text-sm text-brand-navy/60">
              Marquer un fait vérifié confirme que la valeur extraite correspond à celle de la fiche
              : la fiche ne change pas.
            </p>
          </div>
          <button
            type="button"
            className="admin-button-secondary inline-flex items-center gap-2"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw className={`size-4 ${query.isFetching ? "animate-spin" : ""}`} />
            Actualiser
          </button>
        </div>
      </div>

      {query.isPending ? (
        <p role="status" className="p-5 text-sm text-brand-navy/55">
          Chargement des faits…
        </p>
      ) : query.error ? (
        <div className="p-5">
          <p role="alert" className="text-sm text-red-700">
            {queryErrorMessage(query.error, "La revue des faits est indisponible.")}
          </p>
          <button
            type="button"
            className="admin-button-secondary mt-3"
            onClick={() => void query.refetch()}
          >
            Réessayer
          </button>
        </div>
      ) : items.length ? (
        <div className="divide-y">
          {items.map((item) => (
            <ClaimLine
              key={item.claimId}
              item={item}
              draft={drafts[item.claimId]}
              pending={review.isPending}
              onDecision={(decision) => startDecision(item.claimId, decision)}
              onNoteChange={(note) =>
                setDrafts((previous) => ({
                  ...previous,
                  [item.claimId]: { ...(previous[item.claimId] ?? { decision: "rejected" }), note },
                }))
              }
              onConfirm={() => submitDecision(item.claimId)}
              onCancel={() =>
                setDrafts((previous) => {
                  const next = { ...previous };
                  delete next[item.claimId];
                  return next;
                })
              }
            />
          ))}
          <AdminPagination
            label="faits à vérifier"
            offset={query.data?.offset ?? 0}
            limit={query.data?.limit ?? ADMIN_PAGE_SIZE}
            total={query.data?.total ?? 0}
            shown={items.length}
            busy={query.isFetching}
            onOffsetChange={setOffset}
          />
        </div>
      ) : (
        <p className="p-5 text-sm text-brand-navy/60">Aucun fait en attente de revue.</p>
      )}
    </section>
  );
}

type ReviewDraft = {
  decision: ReviewDecision;
  note: string;
};

function ClaimLine({
  item,
  draft,
  pending,
  onDecision,
  onNoteChange,
  onConfirm,
  onCancel,
}: {
  item: AdminAuctionFactClaimReviewItem;
  draft?: ReviewDraft;
  pending: boolean;
  onDecision: (decision: ReviewDecision) => void;
  onNoteChange: (note: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const activeDraft = item.status === "candidate" ? draft : undefined;
  const needsNote = activeDraft?.decision === "rejected" || activeDraft?.decision === "conflicted";
  const locatorQuote = evidenceQuote(item);
  return (
    <article className="p-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <AdminPill tone={item.status === "conflicted" ? "danger" : "warning"}>
              {item.status === "conflicted" ? (
                <AlertTriangle className="size-3" />
              ) : (
                <CheckCircle className="size-3" />
              )}
              {item.status === "conflicted" ? "Conflit" : "À confirmer"}
            </AdminPill>
            <span className="text-xs text-brand-navy/55">{factFieldLabel(item.fieldKey)}</span>
            <span className="font-mono text-[11px] text-brand-navy/45">
              {shortId(item.claimId)}
            </span>
          </div>
          <h3 className="mt-2 truncate font-semibold">
            {item.sale.title || item.sale.city || `Vente ${shortId(item.saleId)}`}
          </h3>
          <p className="mt-1 text-xs text-brand-navy/55">
            {[item.sale.city, item.sale.saleDate ? formatShortDateTime(item.sale.saleDate) : null]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
            <div className="rounded-lg border bg-amber-50/60 p-3">
              <dt className="text-xs font-medium text-brand-navy/60">Valeur extraite</dt>
              <dd className="mt-1 font-semibold text-amber-900">{formatFactValue(item.value)}</dd>
            </div>
            <div className="rounded-lg border bg-slate-50 p-3">
              <dt className="text-xs font-medium text-brand-navy/60">Valeur canonique actuelle</dt>
              <dd className="mt-1 font-semibold text-brand-navy">
                {formatFactValue(item.currentCanonicalValue)}
              </dd>
            </div>
          </dl>
          <div className="mt-3 rounded-lg border border-dashed p-3 text-xs text-brand-navy/65">
            <p className="font-medium text-brand-navy">Preuve · {item.evidence.kind}</p>
            {locatorQuote ? <p className="mt-1 whitespace-pre-wrap">« {locatorQuote} »</p> : null}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              {item.evidence.sourceUrl ? (
                <a
                  href={item.evidence.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-gold-text underline"
                >
                  Ouvrir la source <ExternalLink className="size-3" />
                </a>
              ) : null}
              <span>
                Confiance :{" "}
                {item.evidence.confidence == null
                  ? "non renseignée"
                  : formatShareAsPercent(item.evidence.confidence)}
              </span>
              <span>Capturé le {formatShortDateTime(item.evidence.capturedAt)}</span>
            </div>
          </div>
        </div>
        {item.status === "candidate" ? (
          <div className="flex shrink-0 flex-wrap gap-2 xl:max-w-[18rem] xl:justify-end">
            <button
              type="button"
              className="admin-button-primary inline-flex items-center gap-1"
              disabled={pending}
              onClick={() => onDecision("accepted")}
            >
              <CheckCircle className="size-3.5" />
              Marquer vérifié (la fiche ne change pas)
            </button>
            <button
              type="button"
              className="admin-button-secondary inline-flex items-center gap-1"
              disabled={pending}
              onClick={() => onDecision("rejected")}
            >
              <XCircle className="size-3.5" />
              Rejeter
            </button>
            <button
              type="button"
              className="admin-button-secondary inline-flex items-center gap-1"
              disabled={pending}
              onClick={() => onDecision("conflicted")}
            >
              <AlertTriangle className="size-3.5" />
              Marquer conflit
            </button>
          </div>
        ) : null}
      </div>
      {item.status === "conflicted" ? (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-950">
          <p className="font-medium">Conflit déjà enregistré</p>
          {item.resolutionNote ? <p className="mt-1">Motif : {item.resolutionNote}</p> : null}
          <p className="mt-2 text-xs text-red-900/80">
            Marche à suivre : lancer une nouvelle collecte ou attendre une nouvelle observation,
            puis vérifier le nouveau fait candidat. Cette décision résolue ne peut pas être
            remplacée depuis cette file.
          </p>
        </div>
      ) : activeDraft ? (
        <div className="mt-4 rounded-lg bg-slate-50 p-3">
          <p className="text-sm font-medium">
            {activeDraft.decision === "accepted"
              ? "Confirmer la vérification"
              : activeDraft.decision === "rejected"
                ? "Motif du rejet"
                : "Motif du conflit"}
          </p>
          {needsNote ? (
            <label className="mt-2 block text-xs font-medium text-brand-navy/75">
              Justification obligatoire
              <textarea
                value={activeDraft.note}
                onChange={(event) => onNoteChange(event.target.value)}
                className="mt-1 min-h-20 w-full rounded-lg border bg-white px-3 py-2 text-sm"
                maxLength={2000}
                placeholder="Expliquez la décision pour conserver une piste d’audit."
              />
            </label>
          ) : (
            <p className="mt-1 text-xs text-brand-navy/60">
              La valeur doit encore correspondre au canonique au moment de la validation.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="admin-button-primary"
              disabled={pending || (needsNote && activeDraft.note.trim().length < 8)}
              onClick={onConfirm}
            >
              Confirmer
            </button>
            <button type="button" className="admin-button-secondary" onClick={onCancel}>
              Annuler
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function evidenceQuote(item: AdminAuctionFactClaimReviewItem): string | null {
  const quote = item.evidence.locator.quote;
  return typeof quote === "string" && quote.trim() ? quote.trim() : null;
}

function shortId(value: string): string {
  return value.slice(0, 8);
}
