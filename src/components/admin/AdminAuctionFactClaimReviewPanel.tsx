"use client";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.js";
import CheckCircle from "lucide-react/dist/esm/icons/check-circle.js";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import XCircle from "lucide-react/dist/esm/icons/x-circle.js";
import { useState } from "react";
import { toast } from "sonner";
import {
  fetchAdminAuctionFactClaimReview,
  reviewAdminAuctionFactClaimClient,
  type AdminAuctionFactClaimReviewPageParam,
} from "@/lib/client-api";
import type {
  AdminAuctionFactClaimDecision,
  AdminAuctionFactClaimReviewItem,
} from "@/lib/admin-auction-fact-claims-review";

const QUERY_KEY = ["admin-auction-fact-claim-review"] as const;
const PAGE_SIZE = 25;

type ReviewDecision = AdminAuctionFactClaimDecision["decision"];

export function AdminAuctionFactClaimReviewPanel() {
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>({});
  const query = useInfiniteQuery({
    queryKey: QUERY_KEY,
    queryFn: ({ pageParam }) => fetchAdminAuctionFactClaimReview(pageParam),
    initialPageParam: { limit: PAGE_SIZE } satisfies AdminAuctionFactClaimReviewPageParam,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor
        ? { limit: PAGE_SIZE, cursor: lastPage.nextCursor }
        : undefined,
    staleTime: 30_000,
  });
  const review = useMutation({
    mutationFn: reviewAdminAuctionFactClaimClient,
    onSuccess: () => {
      setDrafts({});
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["admin-catalogue-readiness"] });
      toast.success("Décision enregistrée. La fiche sera réévaluée avec ce contrôle.");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Décision impossible."),
  });

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
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
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-[#a36f2c]">
              <CheckCircle className="size-4" />
              Contrôle des faits sourcés
            </div>
            <h2 id="fact-review-title" className="mt-2 font-semibold">
              Faits à vérifier
            </h2>
            <p className="mt-1 max-w-3xl text-sm text-[#132238]/60">
              Comparez la valeur extraite avec la valeur canonique avant de l’accepter. Une preuve
              acceptée ne modifie pas automatiquement la fiche.
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
        <p role="status" className="p-5 text-sm text-[#132238]/55">
          Chargement des faits…
        </p>
      ) : query.error ? (
        <div className="p-5">
          <p role="alert" className="text-sm text-red-700">
            {query.error instanceof Error
              ? query.error.message
              : "La revue des faits est indisponible."}
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
          {query.hasNextPage ? (
            <div className="border-t px-5 py-3">
              <button
                type="button"
                className="admin-button-secondary"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? "Chargement…" : "Charger les faits suivants"}
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="p-5 text-sm text-[#132238]/60">Aucun fait en attente de revue.</p>
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
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
                item.status === "conflicted"
                  ? "border-red-200 bg-red-50 text-red-700"
                  : "border-amber-200 bg-amber-50 text-amber-800"
              }`}
            >
              {item.status === "conflicted" ? (
                <AlertTriangle className="size-3" />
              ) : (
                <CheckCircle className="size-3" />
              )}
              {item.status === "conflicted" ? "Conflit" : "À confirmer"}
            </span>
            <span className="text-xs text-[#132238]/55">{fieldLabel(item.fieldKey)}</span>
            <span className="font-mono text-[11px] text-[#132238]/45">{shortId(item.claimId)}</span>
          </div>
          <h3 className="mt-2 truncate font-semibold">
            {item.sale.title || item.sale.city || `Vente ${shortId(item.saleId)}`}
          </h3>
          <p className="mt-1 text-xs text-[#132238]/55">
            {[item.sale.city, item.sale.saleDate ? formatDate(item.sale.saleDate) : null]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
            <div className="rounded-lg border bg-amber-50/60 p-3">
              <dt className="text-xs font-medium text-[#132238]/60">Valeur extraite</dt>
              <dd className="mt-1 font-semibold text-amber-900">{formatValue(item.value)}</dd>
            </div>
            <div className="rounded-lg border bg-slate-50 p-3">
              <dt className="text-xs font-medium text-[#132238]/60">Valeur canonique actuelle</dt>
              <dd className="mt-1 font-semibold text-[#132238]">
                {formatValue(item.currentCanonicalValue)}
              </dd>
            </div>
          </dl>
          <div className="mt-3 rounded-lg border border-dashed p-3 text-xs text-[#132238]/65">
            <p className="font-medium text-[#132238]">Preuve · {item.evidence.kind}</p>
            {locatorQuote ? <p className="mt-1 whitespace-pre-wrap">« {locatorQuote} »</p> : null}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              {item.evidence.sourceUrl ? (
                <a
                  href={item.evidence.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-[#7c5222] underline"
                >
                  Ouvrir la source <ExternalLink className="size-3" />
                </a>
              ) : null}
              <span>
                Confiance :{" "}
                {item.evidence.confidence == null
                  ? "non renseignée"
                  : `${Math.round(item.evidence.confidence * 100)} %`}
              </span>
              <span>Capturé le {formatDate(item.evidence.capturedAt)}</span>
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
              Accepter
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
              ? "Confirmer l’acceptation"
              : activeDraft.decision === "rejected"
                ? "Motif du rejet"
                : "Motif du conflit"}
          </p>
          {needsNote ? (
            <label className="mt-2 block text-xs font-medium text-[#132238]/75">
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
            <p className="mt-1 text-xs text-[#132238]/60">
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

function fieldLabel(fieldKey: string): string {
  return (
    {
      "sale.sale_date": "Date de vente",
      "sale.starting_price_eur": "Mise à prix",
      "property.surface_m2": "Surface",
      "property.habitable_surface_m2": "Surface habitable",
      "property.carrez_surface_m2": "Surface Carrez",
      "property.land_surface_m2": "Surface terrain",
      "property.occupancy_status": "Occupation",
    }[fieldKey] ?? fieldKey
  );
}

function formatValue(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "number") {
    return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(value);
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "Valeur non affichable";
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Paris",
  }).format(date);
}

function evidenceQuote(item: AdminAuctionFactClaimReviewItem): string | null {
  const quote = item.evidence.locator.quote;
  return typeof quote === "string" && quote.trim() ? quote.trim() : null;
}

function shortId(value: string): string {
  return value.slice(0, 8);
}
