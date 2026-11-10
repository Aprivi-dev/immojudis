"use client";

import { useEffect, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import CheckCircle from "lucide-react/dist/esm/icons/check-circle.js";
import MailQuestion from "lucide-react/dist/esm/icons/mail-question.js";
import { toast } from "@/lib/toast";
import { AdminPagination } from "@/components/admin/AdminPagination";
import { ADMIN_PAGE_SIZE, adminClampOffset } from "@/lib/admin-pagination";
import {
  UNROUTED_QUERY_KEY as QUERY_KEY,
  unroutedQuery,
} from "@/components/admin/information-agent-queries";
import { markAdminInformationAgentUnroutedHandledClient } from "@/lib/client-api";

const REASON_LABELS: Record<string, string> = {
  no_token: "Adresse de réponse sans jeton de dossier",
  unknown_case: "Jeton inconnu (dossier supprimé avec sa vente, ou jamais créé)",
  case_not_open: "Dossier clos",
  token_mismatch: "Message adressé à plusieurs dossiers",
};

const AUTHENTICATION_LABELS: Record<string, string> = {
  pass: "expéditeur authentifié",
  fail: "authentification de l’expéditeur échouée",
  unverified: "authentification de l’expéditeur non vérifiée",
};

/**
 * Messages reçus à l’adresse de réponse sans dossier ouvert. Ils sont seulement conservés : rien n’est
 * extrait, rien n’est répondu. Le texte est un contenu non fiable, affiché comme du texte brut.
 */
export function AdminInformationAgentUnroutedPanel() {
  const queryClient = useQueryClient();
  const [offset, setOffset] = useState(0);
  const query = useQuery({ ...unroutedQuery(offset), placeholderData: keepPreviousData });
  // Après traitement des dernières lignes d’une page, revient sur la dernière page non vide.
  useEffect(() => {
    const data = query.data;
    if (data && data.messages.length === 0 && data.offset > 0) {
      setOffset(adminClampOffset(data.offset, data.limit, data.total));
    }
  }, [query.data]);
  const markHandled = useMutation({
    mutationFn: markAdminInformationAgentUnroutedHandledClient,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success("Message marqué comme traité.");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Action impossible"),
  });

  const page = query.data;
  const messages = page?.messages ?? [];
  return (
    <section className="overflow-hidden rounded-xl border bg-white">
      <div className="border-b px-5 py-4">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-gold-text">
          <MailQuestion className="size-4" />
          Réponses reçues
        </div>
        <h2 className="mt-2 font-semibold">Messages non rattachés</h2>
        <p className="mt-1 text-sm text-brand-navy/60">
          Messages reçus à l’adresse de réponse sans dossier ouvert. Ils ne sont ni analysés ni
          suivis d’une réponse : lisez-les, puis marquez-les comme traités. Pour intégrer une
          information à une annonce, consignez la réponse sur l’enquête concernée.
        </p>
      </div>
      {query.isPending ? (
        <p className="p-5 text-sm text-brand-navy/55">Chargement…</p>
      ) : query.error ? (
        <p role="alert" className="p-5 text-sm text-danger">
          {query.error instanceof Error ? query.error.message : "Messages indisponibles"}
        </p>
      ) : messages.length ? (
        <div className="divide-y">
          {messages.map((message) => {
            const received = new Intl.DateTimeFormat("fr-FR", {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(message.received_at));
            const authentication = message.sender_authentication
              ? (AUTHENTICATION_LABELS[message.sender_authentication] ??
                message.sender_authentication)
              : null;
            return (
              <article
                key={message.id}
                className={`p-5 text-sm ${message.sender_known ? "bg-surface-muted" : "bg-warning-tint"}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-words font-medium">
                      {message.sender || "Expéditeur inconnu"}
                    </p>
                    <p className="mt-1 break-words text-brand-navy/80">
                      {message.subject || "(sans objet)"}
                    </p>
                    <p className="mt-1 text-xs text-brand-navy/60">
                      Reçu le {received} · {REASON_LABELS[message.reason] ?? message.reason} ·{" "}
                      {message.sender_known
                        ? "expéditeur présent dans nos données"
                        : "expéditeur jamais sollicité"}
                      {authentication ? ` · ${authentication}` : ""}
                      {message.attachment_count > 0
                        ? ` · ${message.attachment_count} pièce(s) jointe(s) non conservée(s)`
                        : ""}
                    </p>
                    {message.opposition_recorded ? (
                      <p className="mt-1 text-xs font-medium text-brand-navy/80">
                        Demande de ne plus être contacté : opposition enregistrée automatiquement.
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="admin-button-secondary inline-flex items-center gap-2"
                    disabled={markHandled.isPending}
                    onClick={() =>
                      markHandled.mutate({ action: "mark_handled", messageId: message.id })
                    }
                  >
                    <CheckCircle className="size-4" /> Marquer comme traité
                  </button>
                </div>
                {message.excerpt ? (
                  <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-white p-3 font-sans text-sm text-brand-navy">
                    {message.excerpt}
                  </pre>
                ) : (
                  <p className="mt-3 text-xs text-brand-navy/60">
                    Texte non lu : expéditeur inconnu. Le message est consultable dans Resend
                    (identifiant {message.provider_email_id}).
                  </p>
                )}
              </article>
            );
          })}
          <AdminPagination
            label="messages non rattachés"
            offset={page?.offset ?? 0}
            limit={page?.limit ?? ADMIN_PAGE_SIZE}
            total={page?.total ?? 0}
            shown={messages.length}
            busy={query.isFetching}
            onOffsetChange={setOffset}
          />
        </div>
      ) : (
        <p className="p-5 text-sm text-brand-navy/55">Aucun message non rattaché à traiter.</p>
      )}
    </section>
  );
}
