"use client";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import CheckCircle from "lucide-react/dist/esm/icons/check-circle.js";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import Inbox from "lucide-react/dist/esm/icons/inbox.js";
import XCircle from "lucide-react/dist/esm/icons/x-circle.js";
import { toast } from "sonner";
import { Link } from "@/lib/router-compat";
import {
  fetchAdminInformationAgentReview,
  reviewAdminInformationAgentFactClient,
  type AdminInformationAgentReviewPageParam,
} from "@/lib/client-api";

const QUERY_KEY = ["admin-information-agent-review"] as const;
const REVIEW_DONE_CURSOR = "__done__";
const REVIEWABLE_CASE_STATUSES = new Set(["sending", "sent", "replied", "review"]);

export function AdminInformationAgentReviewPanel() {
  const queryClient = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: QUERY_KEY,
    queryFn: ({ pageParam }) => fetchAdminInformationAgentReview(pageParam),
    initialPageParam: {} satisfies AdminInformationAgentReviewPageParam,
    getNextPageParam: (lastPage, _pages, lastPageParam) => {
      if (!lastPage.hasMoreFacts && !lastPage.hasMoreMessages) return undefined;
      return {
        ...lastPageParam,
        factCursor: lastPage.hasMoreFacts
          ? (lastPage.nextFactsCursor ?? REVIEW_DONE_CURSOR)
          : REVIEW_DONE_CURSOR,
        messageCursor: lastPage.hasMoreMessages
          ? (lastPage.nextMessagesCursor ?? REVIEW_DONE_CURSOR)
          : REVIEW_DONE_CURSOR,
      };
    },
    staleTime: 30_000,
  });
  const review = useMutation({
    mutationFn: reviewAdminInformationAgentFactClient,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["admin-catalogue-readiness"] });
      toast.success("Information contrôlée. La fiche sera réévaluée après enrichissement.");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Revue impossible"),
  });

  const pages = query.data?.pages ?? [];
  const facts = pages.flatMap((page) => page.facts ?? []);
  const messages = pages.flatMap((page) => page.messages ?? []);
  const assetsById = new Map(
    pages.flatMap((page) => page.assets).map((asset) => [asset.id, asset]),
  );
  const extractionsByAssetId = new Map(
    pages
      .flatMap((page) => page.extractions)
      .map((extraction) => [extraction.asset_id, extraction]),
  );
  const casesById = new Map(pages.flatMap((page) => page.cases).map((item) => [item.id, item]));
  return (
    <section className="overflow-hidden rounded-xl border bg-white">
      <div className="border-b px-5 py-4">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-[#a36f2c]">
          <Inbox className="size-4" />
          Réponses reçues
        </div>
        <h2 className="mt-2 font-semibold">Informations à contrôler</h2>
        <p className="mt-1 text-sm text-[#132238]/60">
          Rien n’est intégré à une annonce sans validation. Les pièces doivent aussi disposer de
          droits de diffusion.
        </p>
      </div>
      {query.isPending ? (
        <p className="p-5 text-sm text-[#132238]/55">Chargement…</p>
      ) : query.error ? (
        <p role="alert" className="p-5 text-sm text-red-700">
          {query.error instanceof Error ? query.error.message : "Réponses indisponibles"}
        </p>
      ) : facts.length || messages.length ? (
        <div className="divide-y">
          {messages.map((message) => {
            const informationCase = message.case_id ? casesById.get(message.case_id) : undefined;
            const metadata = message.metadata;
            const senderMismatch =
              metadata &&
              typeof metadata === "object" &&
              !Array.isArray(metadata) &&
              metadata.sender_matches_recipient === false;
            const ignoredCaseStatus =
              metadata &&
              typeof metadata === "object" &&
              !Array.isArray(metadata) &&
              typeof metadata.processing_ignored_case_status === "string"
                ? metadata.processing_ignored_case_status
                : null;
            const rejectedAttachments = rejectedEvidence(metadata);
            const rejectedCount =
              metadata &&
              typeof metadata === "object" &&
              !Array.isArray(metadata) &&
              typeof metadata.rejected_attachment_count === "number"
                ? metadata.rejected_attachment_count
                : rejectedAttachments.length;
            return (
              <article
                key={message.id}
                className={`p-5 text-sm ${senderMismatch ? "bg-amber-50" : "bg-slate-50"}`}
              >
                <p
                  className={`font-semibold ${senderMismatch ? "text-amber-900" : "text-[#132238]"}`}
                >
                  {senderMismatch ? "Expéditeur à vérifier" : "Réponse reçue"}
                </p>
                <p className="mt-1 text-[#132238]">
                  {message.from_email} · {message.subject}
                </p>
                <p className="mt-1 text-[#132238]/70">
                  Dossier {message.case_id ? shortId(message.case_id) : "inconnu"} · Contact attendu
                  : {informationCase?.recipient_email || "adresse indisponible"}
                </p>
                {informationCase?.sale_id ? (
                  <Link
                    to="/sales/$id"
                    params={{ id: informationCase.sale_id }}
                    className="mt-1 inline-block font-medium text-[#7c5222] underline"
                  >
                    Voir l’annonce {shortId(informationCase.sale_id)}
                  </Link>
                ) : null}
                <p className="mt-2 whitespace-pre-wrap text-[#132238]/80">
                  {message.body_text.slice(0, 500)}
                </p>
                {message.body_text.length > 500 ? (
                  <details className="mt-2 text-[#132238]/80">
                    <summary className="cursor-pointer font-medium underline">
                      Lire le message complet
                    </summary>
                    <p className="mt-2 whitespace-pre-wrap break-words">{message.body_text}</p>
                  </details>
                ) : null}
                {rejectedAttachments.length ? (
                  <ul className="mt-2 list-inside list-disc text-amber-900">
                    {rejectedAttachments.map((attachment, index) => (
                      <li key={`${attachment.filename}-${index}`}>
                        Pièce non traitée : {attachment.filename} — {attachment.reason}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {rejectedCount > rejectedAttachments.length ? (
                  <p className="mt-1 text-xs text-amber-900">
                    {rejectedCount - rejectedAttachments.length} autre(s) pièce(s) non traitée(s).
                  </p>
                ) : null}
                {senderMismatch ? (
                  <p className="mt-2 text-xs text-amber-900/80">
                    Aucune donnée ni pièce jointe de ce message n’a été proposée à la publication.
                  </p>
                ) : null}
                {ignoredCaseStatus ? (
                  <p className="mt-2 text-xs text-amber-900">
                    Réponse reçue après la clôture du dossier ({ignoredCaseStatus}) : aucun candidat
                    n’a été créé.
                  </p>
                ) : null}
              </article>
            );
          })}
          {facts.map((fact) => {
            const asset = fact.evidence_asset_id
              ? assetsById.get(fact.evidence_asset_id)
              : undefined;
            const informationCase = casesById.get(fact.case_id);
            const requiresRights = fact.fact_key === "document" || fact.fact_key === "photo";
            const extraction = asset ? extractionsByAssetId.get(asset.id) : undefined;
            const caseCanAccept =
              informationCase !== undefined && REVIEWABLE_CASE_STATUSES.has(informationCase.status);
            const canAccept =
              caseCanAccept &&
              (!requiresRights ||
                (asset?.rights_status === "authorized" && extraction?.status === "completed"));
            return (
              <article key={fact.id} className="p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border bg-slate-50 px-2 py-0.5 text-xs">
                        {factLabel(fact.fact_key)}
                      </span>
                      <span className="text-xs text-[#132238]/50">
                        Confiance {Math.round(Number(fact.confidence) * 100)} %
                      </span>
                    </div>
                    <p className="mt-2 font-medium">{fact.display_value}</p>
                    {asset?.original_filename && asset.original_filename !== fact.display_value ? (
                      <p className="mt-1 text-xs text-[#132238]/55">
                        Pièce jointe : {asset.original_filename}
                      </p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#132238]/60">
                      <Link
                        to="/sales/$id"
                        params={{ id: fact.sale_id }}
                        className="inline-flex items-center gap-1 font-medium text-[#7c5222] underline"
                      >
                        Voir l’annonce {shortId(fact.sale_id)}
                        <ExternalLink className="size-3" />
                      </Link>
                      <span>Dossier {shortId(fact.case_id)}</span>
                      <span>
                        Contact : {informationCase?.recipient_name || "sans nom"} ·{" "}
                        {informationCase?.recipient_email || "adresse indisponible"}
                      </span>
                    </div>
                    {informationCase?.subject ? (
                      <p className="mt-1 text-xs text-[#132238]/50">
                        Objet : {informationCase.subject}
                      </p>
                    ) : null}
                    {fact.evidence_excerpt ? (
                      <p className="mt-2 text-sm italic text-[#132238]/60">
                        « {fact.evidence_excerpt} »
                      </p>
                    ) : null}
                    {requiresRights ? (
                      <p
                        className={`mt-2 text-xs ${canAccept ? "text-emerald-700" : "text-amber-800"}`}
                      >
                        Droits de diffusion : {asset?.rights_status ?? "à confirmer"} · Analyse :{" "}
                        {extraction?.status ?? "en attente"}
                      </p>
                    ) : null}
                    {!caseCanAccept ? (
                      <p className="mt-2 text-xs text-amber-800">
                        Le dossier est fermé ou indisponible pour cette revue ; l’acceptation est
                        désactivée.
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <button
                      type="button"
                      className="admin-button-primary inline-flex items-center gap-2"
                      disabled={review.isPending || !canAccept}
                      onClick={() =>
                        review.mutate({ factId: fact.id, decision: "accepted", notes: null })
                      }
                    >
                      <CheckCircle className="size-4" /> Accepter
                    </button>
                    <button
                      type="button"
                      className="admin-button-secondary inline-flex items-center gap-2"
                      disabled={review.isPending}
                      onClick={() =>
                        review.mutate({ factId: fact.id, decision: "rejected", notes: null })
                      }
                    >
                      <XCircle className="size-4" /> Rejeter
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
          {query.hasNextPage ? (
            <div className="p-5">
              <button
                type="button"
                className="admin-button-secondary"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage
                  ? "Chargement…"
                  : pages.at(-1)?.hasMoreFacts
                    ? "Charger plus d’informations"
                    : "Charger les réponses précédentes"}
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="p-5 text-sm text-[#132238]/55">Aucune information en attente de contrôle.</p>
      )}
    </section>
  );
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function rejectedEvidence(value: unknown): Array<{ filename: string; reason: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const attachments = (value as Record<string, unknown>).rejected_attachments;
  if (!Array.isArray(attachments)) return [];
  return attachments.filter(
    (item): item is { filename: string; reason: string } =>
      item &&
      typeof item === "object" &&
      typeof item.filename === "string" &&
      typeof item.reason === "string",
  );
}

function factLabel(key: string): string {
  return (
    {
      surface_m2: "Surface",
      land_surface_m2: "Terrain",
      rooms_count: "Pièces",
      occupancy_status: "Occupation",
      starting_price_eur: "Mise à prix",
      sale_date: "Date de vente",
      property_type: "Type de bien",
      document: "Document",
      photo: "Photo",
    }[key] ?? key
  );
}
