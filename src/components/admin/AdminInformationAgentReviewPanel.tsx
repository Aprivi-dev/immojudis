"use client";

import { useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import CheckCircle from "lucide-react/dist/esm/icons/check-circle.js";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import Inbox from "lucide-react/dist/esm/icons/inbox.js";
import XCircle from "lucide-react/dist/esm/icons/x-circle.js";
import { toast } from "sonner";
import { Link } from "@/lib/router-compat";
import {
  fetchAdminInformationAgentEvidenceUrlClient,
  fetchAdminInformationAgentReview,
  reviewAdminInformationAgentFactClient,
  updateAdminInformationAgentEvidenceRightsClient,
  type AdminInformationAgentEvidenceRightsStatus,
  type AdminInformationAgentReviewPageParam,
} from "@/lib/client-api";

const QUERY_KEY = ["admin-information-agent-review"] as const;
const REVIEW_DONE_CURSOR = "__done__";
const REVIEWABLE_CASE_STATUSES = new Set(["sending", "sent", "replied", "review"]);

export function AdminInformationAgentReviewPanel() {
  const queryClient = useQueryClient();
  const [openingAssetId, setOpeningAssetId] = useState<string | null>(null);
  const [previewingAssetId, setPreviewingAssetId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ assetId: string; signedUrl: string } | null>(null);
  const [rightsNotes, setRightsNotes] = useState<Record<string, string>>({});
  // "Caviardage vérifié": checkbox + name of the person, required before a piece goes public.
  const [redaction, setRedaction] = useState<Record<string, { confirmed: boolean; by: string }>>(
    {},
  );
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
  const rightsReview = useMutation({
    mutationFn: updateAdminInformationAgentEvidenceRightsClient,
    onSuccess: ({ asset }) => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      setRightsNotes((previous) => ({ ...previous, [asset.id]: "" }));
      toast.success(
        asset.rights_status === "authorized"
          ? "Droits autorisés. La pièce pourra être acceptée si son analyse est terminée."
          : "Droits restreints. La pièce ne pourra pas être publiée.",
      );
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Décision sur les droits impossible"),
  });

  const openEvidenceAsset = async (assetId: string) => {
    // Reserve the tab during the click so the browser does not treat the
    // signed-URL navigation as an unsolicited popup after the fetch resolves.
    const openedWindow = window.open("about:blank", "_blank");
    if (!openedWindow) {
      toast.error("Le navigateur a bloqué l’ouverture de la pièce.");
      return;
    }
    openedWindow.opener = null;
    setOpeningAssetId(assetId);
    try {
      const signedUrl = await fetchAdminInformationAgentEvidenceUrlClient(assetId);
      openedWindow.location.assign(signedUrl);
    } catch (error) {
      openedWindow.close();
      toast.error(error instanceof Error ? error.message : "Impossible d’ouvrir cette pièce.");
    } finally {
      setOpeningAssetId(null);
    }
  };

  const previewEvidenceAsset = async (assetId: string) => {
    setPreviewingAssetId(assetId);
    try {
      const signedUrl = await fetchAdminInformationAgentEvidenceUrlClient(assetId);
      setPreview({ assetId, signedUrl });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Impossible de prévisualiser cette pièce.",
      );
    } finally {
      setPreviewingAssetId(null);
    }
  };

  const reviewEvidenceRights = (
    assetId: string,
    rightsStatus: AdminInformationAgentEvidenceRightsStatus,
  ) => {
    rightsReview.mutate({
      assetId,
      rightsStatus,
      notes: rightsNotes[assetId]?.trim() || null,
    });
  };

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
            const metadataObject =
              metadata && typeof metadata === "object" && !Array.isArray(metadata)
                ? metadata
                : null;
            const importedManually = metadataObject?.imported_manually === true;
            const senderMismatch = metadataObject?.sender_matches_recipient === false;
            const ignoredCaseStatus =
              typeof metadataObject?.processing_ignored_case_status === "string"
                ? metadataObject.processing_ignored_case_status
                : null;
            const rejectedAttachments = rejectedEvidence(metadata);
            const rejectedCount =
              typeof metadataObject?.rejected_attachment_count === "number"
                ? metadataObject.rejected_attachment_count
                : rejectedAttachments.length;
            const senderUnverified = importedManually || senderMismatch;
            return (
              <article
                key={message.id}
                className={`p-5 text-sm ${senderUnverified ? "bg-amber-50" : "bg-slate-50"}`}
              >
                <p
                  className={`font-semibold ${
                    senderUnverified ? "text-amber-900" : "text-[#132238]"
                  }`}
                >
                  {importedManually
                    ? "Import manuel — expéditeur non vérifié"
                    : senderMismatch
                      ? "Expéditeur à vérifier"
                      : "Réponse reçue"}
                </p>
                <p className="mt-1 text-[#132238]">
                  {message.from_email} · {message.subject}
                </p>
                {importedManually ? (
                  <p className="mt-1 text-xs text-amber-900/80">
                    Le message a été saisi par un administrateur ; l’adresse affichée est un
                    rattachement de dossier et ne prouve pas l’identité de l’expéditeur.
                  </p>
                ) : null}
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
            const redactionCheck = redaction[fact.id] ?? { confirmed: false, by: "" };
            const redactionOk = redactionCheck.confirmed && redactionCheck.by.trim().length >= 3;
            const canAccept =
              caseCanAccept &&
              (!requiresRights ||
                (asset?.rights_status === "authorized" &&
                  extraction?.status === "completed" &&
                  redactionOk));
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
                    {typeof fact.source_page === "number" && fact.source_page > 0 ? (
                      <p className="mt-1 text-xs text-[#132238]/55">
                        Page source : {fact.source_page}
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
                      <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                          <span
                            className={
                              canAccept ? "font-medium text-emerald-700" : "text-amber-800"
                            }
                          >
                            Droits de diffusion : {rightsStatusLabel(asset?.rights_status)}
                          </span>
                          <span className="text-[#132238]/65">
                            Analyse : {extraction?.status ?? "en attente"}
                          </span>
                        </div>
                        {extraction?.summary ? (
                          <p className="mt-2 break-words text-xs text-[#132238]/75">
                            <span className="font-medium">Résumé de l’analyse — à vérifier :</span>{" "}
                            {extraction.summary}
                          </p>
                        ) : null}
                        {extraction &&
                        (extraction.status === "unsupported" || extraction.status === "failed") ? (
                          <p role="alert" className="mt-2 break-words text-xs text-red-700">
                            <span className="font-medium">Erreur d’analyse :</span>{" "}
                            {extraction.error_message ||
                              "L’analyse de cette pièce n’a pas abouti. Vérifiez la pièce avant toute publication."}
                          </p>
                        ) : null}
                        {asset ? (
                          <>
                            <div className="mt-3 flex flex-wrap gap-2">
                              {previewKindForAsset(asset) ? (
                                <button
                                  type="button"
                                  className="admin-button-secondary inline-flex items-center gap-2"
                                  disabled={previewingAssetId === asset.id}
                                  onClick={() => void previewEvidenceAsset(asset.id)}
                                >
                                  <ExternalLink className="size-4" />
                                  {previewingAssetId === asset.id
                                    ? "Prévisualisation…"
                                    : "Prévisualiser la pièce"}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className="admin-button-secondary inline-flex items-center gap-2"
                                disabled={openingAssetId === asset.id}
                                onClick={() => void openEvidenceAsset(asset.id)}
                              >
                                <ExternalLink className="size-4" />
                                {openingAssetId === asset.id ? "Ouverture…" : "Consulter la pièce"}
                              </button>
                              <button
                                type="button"
                                className="admin-button-secondary"
                                aria-pressed={asset.rights_status === "authorized"}
                                disabled={
                                  rightsReview.isPending || asset.rights_status === "authorized"
                                }
                                onClick={() => reviewEvidenceRights(asset.id, "authorized")}
                              >
                                Autoriser la diffusion
                              </button>
                              <button
                                type="button"
                                className="admin-button-secondary"
                                aria-pressed={asset.rights_status === "restricted"}
                                disabled={
                                  rightsReview.isPending || asset.rights_status === "restricted"
                                }
                                onClick={() => reviewEvidenceRights(asset.id, "restricted")}
                              >
                                Restreindre la diffusion
                              </button>
                            </div>
                            {preview?.assetId === asset.id ? (
                              <div className="mt-3 rounded-lg border border-slate-200 bg-white p-2">
                                <div className="flex items-center justify-between gap-2 px-1 pb-2">
                                  <p className="text-xs font-medium text-[#132238]/75">
                                    Aperçu privé · {asset.original_filename}
                                  </p>
                                  <button
                                    type="button"
                                    className="text-xs font-medium text-[#7c5222] underline"
                                    onClick={() => setPreview(null)}
                                  >
                                    Fermer l’aperçu
                                  </button>
                                </div>
                                <iframe
                                  title={`Aperçu privé de ${asset.original_filename}`}
                                  src={preview.signedUrl}
                                  sandbox=""
                                  referrerPolicy="no-referrer"
                                  className="h-[28rem] w-full rounded border bg-slate-50"
                                />
                                <p className="px-1 pt-2 text-[11px] text-[#132238]/55">
                                  Ce lien expire rapidement et l’original reste dans le stockage
                                  privé.
                                </p>
                              </div>
                            ) : null}
                            <label className="mt-3 block text-xs text-[#132238]/70">
                              <span className="font-medium">Note de revue (facultative)</span>
                              <input
                                type="text"
                                value={rightsNotes[asset.id] ?? ""}
                                onChange={(event) =>
                                  setRightsNotes((previous) => ({
                                    ...previous,
                                    [asset.id]: event.target.value,
                                  }))
                                }
                                placeholder="Ex. autorisation reçue dans le message"
                                maxLength={1000}
                                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-sm text-[#132238] outline-none focus:border-[#a36f2c] focus:ring-1 focus:ring-[#a36f2c]"
                              />
                            </label>
                            <p className="mt-2 text-xs text-[#132238]/60">
                              La décision enregistre l’administrateur, la date et cette note dans
                              l’historique de la pièce.
                            </p>
                          </>
                        ) : (
                          <p className="mt-2 text-xs text-amber-800">
                            Pièce jointe introuvable : impossible de contrôler ses droits.
                          </p>
                        )}
                        <fieldset className="mt-3 rounded border border-amber-300 bg-amber-50/60 p-3">
                          <legend className="px-1 text-xs font-semibold text-amber-900">
                            Caviardage vérifié
                          </legend>
                          <label className="flex items-start gap-2 text-xs text-[#132238]">
                            <input
                              type="checkbox"
                              checked={redactionCheck.confirmed}
                              onChange={(event) =>
                                setRedaction((current) => ({
                                  ...current,
                                  [fact.id]: { ...redactionCheck, confirmed: event.target.checked },
                                }))
                              }
                            />
                            J’ai contrôlé la pièce : les données personnelles (noms, téléphones,
                            adresses de tiers) sont caviardées sur toutes les pages visibles.
                          </label>
                          <label className="mt-2 block text-xs text-[#132238]">
                            Nom de la personne qui a contrôlé
                            <input
                              className="mt-1 block w-full rounded border px-2 py-1 text-sm"
                              maxLength={120}
                              value={redactionCheck.by}
                              onChange={(event) =>
                                setRedaction((current) => ({
                                  ...current,
                                  [fact.id]: { ...redactionCheck, by: event.target.value },
                                }))
                              }
                            />
                          </label>
                          <p className="mt-2 text-[11px] text-[#132238]/60">
                            Le PDF sera aplati en images sans métadonnées avant publication ; le
                            fichier est servi par lien signé de 10 minutes.
                          </p>
                        </fieldset>
                        {!canAccept ? (
                          <p className="mt-2 text-xs text-amber-800">
                            L’acceptation restera désactivée tant que les droits ne sont pas
                            autorisés, que l’analyse n’est pas terminée et que le caviardage n’est
                            pas vérifié.
                          </p>
                        ) : null}
                      </div>
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
                        review.mutate({
                          factId: fact.id,
                          decision: "accepted",
                          notes: null,
                          ...(requiresRights
                            ? {
                                redactionConfirmed: redactionCheck.confirmed,
                                redactionVerifiedBy: redactionCheck.by.trim(),
                              }
                            : {}),
                        })
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
      visit_information: "Visite",
      starting_price_eur: "Mise à prix",
      sale_date: "Date de vente",
      energy_diagnostics: "Diagnostics énergétiques",
      property_type: "Type de bien",
      address: "Adresse",
      document: "Document",
      photo: "Photo",
    }[key] ?? key
  );
}

function rightsStatusLabel(value: string | undefined): string {
  switch (value) {
    case "authorized":
      return "autorisés";
    case "restricted":
      return "restreints";
    case "unverified":
      return "à vérifier";
    default:
      return "à confirmer";
  }
}

function previewKindForAsset(asset: {
  mime_type?: unknown;
  original_filename?: unknown;
}): "pdf" | "image" | "text" | null {
  const mimeType = typeof asset.mime_type === "string" ? asset.mime_type.toLowerCase() : "";
  if (mimeType === "application/pdf") return "pdf";
  if (["image/jpeg", "image/png", "image/webp"].includes(mimeType)) return "image";
  if (mimeType === "text/plain") return "text";

  const filename =
    typeof asset.original_filename === "string" ? asset.original_filename.toLowerCase() : "";
  if (filename.endsWith(".pdf")) return "pdf";
  if ([".jpg", ".jpeg", ".png", ".webp"].some((extension) => filename.endsWith(extension))) {
    return "image";
  }
  if (filename.endsWith(".txt")) return "text";
  return null;
}
