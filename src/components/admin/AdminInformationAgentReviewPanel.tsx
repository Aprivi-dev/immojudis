"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import CheckCircle from "lucide-react/dist/esm/icons/check-circle.js";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import Inbox from "lucide-react/dist/esm/icons/inbox.js";
import XCircle from "lucide-react/dist/esm/icons/x-circle.js";
import { toast } from "sonner";
import { Link } from "@/lib/router-compat";
import {
  fetchAdminInformationAgentReview,
  reviewAdminInformationAgentFactClient,
} from "@/lib/client-api";

const QUERY_KEY = ["admin-information-agent-review"] as const;

export function AdminInformationAgentReviewPanel() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchAdminInformationAgentReview,
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

  const facts = query.data?.facts ?? [];
  const rejectedMessages = query.data?.rejectedMessages ?? [];
  const assetsById = new Map((query.data?.assets ?? []).map((asset) => [asset.id, asset]));
  const casesById = new Map((query.data?.cases ?? []).map((item) => [item.id, item]));
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
      ) : facts.length || rejectedMessages.length ? (
        <>
          {rejectedMessages.length ? (
            <div className="border-b bg-amber-50 px-5 py-4 text-sm text-amber-950">
              <p className="font-semibold">Pièces non traitées à vérifier</p>
              {rejectedMessages.map((message) => {
                const details =
                  message.metadata &&
                  typeof message.metadata === "object" &&
                  !Array.isArray(message.metadata)
                    ? message.metadata
                    : {};
                const rejected = Array.isArray(details.rejected_attachments)
                  ? details.rejected_attachments
                  : [];
                return (
                  <p key={message.id} className="mt-2">
                    Dossier {shortId(message.case_id)} ·{" "}
                    {casesById.get(message.case_id)?.recipient_email ?? "contact inconnu"} ·{" "}
                    {Number(details.rejected_attachment_count)} pièce(s) :{" "}
                    {rejected
                      .map((item) => {
                        if (!item || typeof item !== "object" || Array.isArray(item))
                          return "pièce inconnue";
                        const value = item as Record<string, unknown>;
                        return `${String(value.filename ?? "pièce")} (${String(value.reason ?? "non traitée")})`;
                      })
                      .join(", ")}
                  </p>
                );
              })}
            </div>
          ) : null}
          <div className="divide-y">
            {facts.map((fact) => {
              const asset = fact.evidence_asset_id
                ? assetsById.get(fact.evidence_asset_id)
                : undefined;
              const informationCase = casesById.get(fact.case_id);
              const requiresRights = fact.fact_key === "document" || fact.fact_key === "photo";
              const canAccept = !requiresRights || asset?.rights_status === "authorized";
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
                          Droits de diffusion : {asset?.rights_status ?? "à confirmer"}
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
          </div>
        </>
      ) : (
        <p className="p-5 text-sm text-[#132238]/55">Aucune information en attente de contrôle.</p>
      )}
    </section>
  );
}

function shortId(value: string): string {
  return value.slice(0, 8);
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
