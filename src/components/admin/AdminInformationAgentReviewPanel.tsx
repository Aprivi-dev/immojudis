"use client";

import { useEffect, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import CheckCircle from "lucide-react/dist/esm/icons/check-circle.js";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import Inbox from "lucide-react/dist/esm/icons/inbox.js";
import XCircle from "lucide-react/dist/esm/icons/x-circle.js";
import { toast } from "@/lib/toast";
import { AdminPagination } from "@/components/admin/AdminPagination";
import { ADMIN_PAGE_SIZE, adminClampOffset } from "@/lib/admin-pagination";
import Link from "next/link";
import { saleDetailPath } from "@/lib/navigation";
import {
  fetchAdminInformationAgentEvidenceUrlClient,
  fetchAdminInformationAgentReview,
  reviewAdminInformationAgentFactClient,
  runAdminInformationAgentMessageActionClient,
  updateAdminInformationAgentEvidenceRightsClient,
  type AdminInformationAgentEvidenceRightsStatus,
} from "@/lib/client-api";
import type { InformationAgentFactSource } from "@/lib/admin-information-agent";

const QUERY_KEY = ["admin-information-agent-review"] as const;
const REVIEWABLE_CASE_STATUSES = new Set(["sending", "sent", "replied", "review"]);

export function AdminInformationAgentReviewPanel() {
  const queryClient = useQueryClient();
  const [openingAssetId, setOpeningAssetId] = useState<string | null>(null);
  const [previewingAssetId, setPreviewingAssetId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ assetId: string; signedUrl: string } | null>(null);
  const [rightsNotes, setRightsNotes] = useState<Record<string, string>>({});
  // Motif facultatif d'un rejet, transmis comme `notes` et conservé dans l'historique de la revue.
  const [rejectNotes, setRejectNotes] = useState<Record<string, string>>({});
  // "Caviardage vérifié": checkbox + name of the person, required before a piece goes public.
  const [redaction, setRedaction] = useState<Record<string, { confirmed: boolean; by: string }>>(
    {},
  );
  const [offset, setOffset] = useState(0);
  const query = useQuery({
    queryKey: [...QUERY_KEY, offset],
    queryFn: () => fetchAdminInformationAgentReview({ offset, limit: ADMIN_PAGE_SIZE }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  // Après traitement des dernières lignes d'une page, revient sur la dernière page non vide.
  useEffect(() => {
    const data = query.data;
    if (data && data.facts.length === 0 && data.messages.length === 0 && data.offset > 0) {
      setOffset(adminClampOffset(data.offset, data.limit, data.total));
    }
  }, [query.data]);
  const review = useMutation({
    mutationFn: reviewAdminInformationAgentFactClient,
    onSuccess: (_response, input) => {
      setRejectNotes((previous) => ({ ...previous, [input.factId]: "" }));
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["admin-catalogue-readiness"] });
      toast.success("Information contrôlée. La fiche sera réévaluée après enrichissement.");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Revue impossible"),
  });
  const messageAction = useMutation({
    mutationFn: runAdminInformationAgentMessageActionClient,
    onSuccess: (response, input) => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success(
        input.action === "record_opposition"
          ? `Opposition enregistrée (${response.opposedEmails.join(", ")}) : plus aucune sollicitation.`
          : "Réponse marquée comme traitée.",
      );
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Action impossible"),
  });
  const recordOpposition = (messageId: string) => {
    if (
      !window.confirm(
        "Enregistrer l’opposition de ce professionnel ? Il ne sera plus jamais sollicité, sur aucun canal.",
      )
    ) {
      return;
    }
    messageAction.mutate({ action: "record_opposition", messageId });
  };
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

  const page = query.data;
  const facts = page?.facts ?? [];
  const messages = page?.messages ?? [];
  const assetsById = new Map((page?.assets ?? []).map((asset) => [asset.id, asset]));
  const extractionsByAssetId = new Map(
    (page?.extractions ?? []).map((extraction) => [extraction.asset_id, extraction]),
  );
  const casesById = new Map((page?.cases ?? []).map((item) => [item.id, item]));
  const factSourcesByMessageId = new Map(
    (page?.factSources ?? []).map((source) => [source.messageId, source]),
  );
  return (
    <section className="overflow-hidden rounded-xl border bg-white">
      <div className="border-b px-5 py-4">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-gold-text">
          <Inbox className="size-4" />
          Réponses reçues
        </div>
        <h2 className="mt-2 font-semibold">Informations à contrôler</h2>
        <p className="mt-1 text-sm text-brand-navy/60">
          Rien n’est intégré à une annonce sans validation. Les pièces doivent aussi disposer de
          droits de diffusion.
        </p>
      </div>
      {query.isPending ? (
        <p className="p-5 text-sm text-brand-navy/55">Chargement…</p>
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
            const viaPortal = metadataObject?.channel === "portal";
            const portalSenderName =
              viaPortal && typeof metadataObject?.sender_name === "string"
                ? metadataObject.sender_name
                : null;
            const senderMismatch = metadataObject?.sender_matches_recipient === false;
            const authentication = recordValue(metadataObject?.sender_authentication);
            const authenticationStatus =
              !viaPortal && !importedManually && typeof authentication?.status === "string"
                ? authentication.status
                : null;
            const processing = recordValue(metadataObject?.inbound_processing);
            const ignoredCaseStatus =
              typeof metadataObject?.processing_ignored_case_status === "string"
                ? metadataObject.processing_ignored_case_status
                : null;
            const rejectedAttachments = rejectedEvidence(metadata);
            const rejectedCount =
              typeof metadataObject?.rejected_attachment_count === "number"
                ? metadataObject.rejected_attachment_count
                : rejectedAttachments.length;
            const senderUnverified =
              importedManually ||
              viaPortal ||
              senderMismatch ||
              (authenticationStatus !== null && authenticationStatus !== "pass");
            return (
              <article
                key={message.id}
                className={`p-5 text-sm ${senderUnverified ? "bg-amber-50" : "bg-slate-50"}`}
              >
                <p
                  className={`font-semibold ${
                    senderUnverified ? "text-amber-900" : "text-brand-navy"
                  }`}
                >
                  {importedManually
                    ? "Import manuel — expéditeur non vérifié"
                    : viaPortal
                      ? "Dépôt via le lien privé — identité non vérifiée"
                      : senderMismatch
                        ? "Expéditeur à vérifier"
                        : "Réponse reçue par e-mail"}
                </p>
                <p className="mt-1 text-brand-navy">
                  {portalSenderName ? `${portalSenderName} · ` : ""}
                  {message.from_email} · {message.subject}
                </p>
                {viaPortal ? (
                  <p className="mt-1 text-xs text-amber-900/80">
                    Le nom et l’adresse ont été saisis par la personne qui a utilisé le lien : ils
                    ne prouvent pas son identité, même s’ils correspondent au contact sollicité.
                  </p>
                ) : null}
                {authenticationStatus && authenticationStatus !== "pass" ? (
                  <p className="mt-1 text-xs text-amber-900/80">
                    {authenticationStatus === "fail"
                      ? "L’authentification de l’expéditeur a échoué"
                      : "L’authentification de l’expéditeur n’a pas pu être vérifiée"}{" "}
                    : aucune information n’a été extraite et aucune pièce jointe n’a été conservée.
                    Vérifiez l’expéditeur et, si besoin, demandez les pièces par un autre canal.
                  </p>
                ) : null}
                <ProcessingStatus processing={processing} />
                {importedManually ? (
                  <p className="mt-1 text-xs text-amber-900/80">
                    Le message a été saisi par un administrateur ; l’adresse affichée est un
                    rattachement de dossier et ne prouve pas l’identité de l’expéditeur.
                  </p>
                ) : null}
                <p className="mt-1 text-brand-navy/70">
                  Dossier {message.case_id ? shortId(message.case_id) : "inconnu"} · Contact attendu
                  : {informationCase?.recipient_email || "adresse indisponible"}
                </p>
                {informationCase?.sale_id ? (
                  <Link
                    href={saleDetailPath(informationCase.sale_id)}
                    className="mt-1 inline-block font-medium text-gold-text underline"
                  >
                    Voir l’annonce {shortId(informationCase.sale_id)}
                  </Link>
                ) : null}
                <p className="mt-2 whitespace-pre-wrap text-brand-navy/80">
                  {message.body_text.slice(0, 500)}
                </p>
                {message.body_text.length > 500 ? (
                  <details className="mt-2 text-brand-navy/80">
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
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="admin-button-secondary"
                    disabled={messageAction.isPending}
                    onClick={() =>
                      messageAction.mutate({ action: "mark_handled", messageId: message.id })
                    }
                  >
                    Marquer comme traitée
                  </button>
                  <button
                    type="button"
                    className="admin-button-secondary text-red-800"
                    disabled={messageAction.isPending}
                    onClick={() => recordOpposition(message.id)}
                  >
                    Enregistrer une opposition
                  </button>
                </div>
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
                      <span className="text-xs text-brand-navy/50">
                        {extractionLabel(fact.extraction_method, fact.confidence)}
                      </span>
                    </div>
                    <p className="mt-2 font-medium">{fact.display_value}</p>
                    {asset?.original_filename && asset.original_filename !== fact.display_value ? (
                      <p className="mt-1 text-xs text-brand-navy/55">
                        Pièce jointe : {asset.original_filename}
                      </p>
                    ) : null}
                    {typeof fact.source_page === "number" && fact.source_page > 0 ? (
                      <p className="mt-1 text-xs text-brand-navy/55">
                        Page source : {fact.source_page}
                      </p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-brand-navy/60">
                      <Link
                        href={saleDetailPath(fact.sale_id)}
                        className="inline-flex items-center gap-1 font-medium text-gold-text underline"
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
                      <p className="mt-1 text-xs text-brand-navy/50">
                        Objet : {informationCase.subject}
                      </p>
                    ) : null}
                    <FactProvenance source={factSourcesByMessageId.get(fact.message_id)} />
                    {isLotUnidentified(fact.metadata) ? (
                      <p className="mt-2 text-xs font-medium text-amber-900">
                        Vente à plusieurs lots : la réponse ne cite aucun lot. Rattachez cette
                        information au bon lot avant de l’accepter.
                      </p>
                    ) : null}
                    {fact.evidence_excerpt ? (
                      <p className="mt-2 text-sm text-brand-navy/60">« {fact.evidence_excerpt} »</p>
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
                          <span className="text-brand-navy/65">
                            Analyse : {extraction?.status ?? "en attente"}
                          </span>
                        </div>
                        {extraction?.summary ? (
                          <p className="mt-2 break-words text-xs text-brand-navy/75">
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
                                  <p className="text-xs font-medium text-brand-navy/75">
                                    Aperçu privé · {asset.original_filename}
                                  </p>
                                  <button
                                    type="button"
                                    className="text-xs font-medium text-gold-text underline"
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
                                <p className="px-1 pt-2 text-[11px] text-brand-navy/55">
                                  Ce lien expire rapidement et l’original reste dans le stockage
                                  privé.
                                </p>
                              </div>
                            ) : null}
                            <label className="mt-3 block text-xs text-brand-navy/70">
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
                                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-sm text-brand-navy outline-none focus:border-gold-soft focus:ring-1 focus:ring-gold-soft"
                              />
                            </label>
                            <p className="mt-2 text-xs text-brand-navy/60">
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
                          <label className="flex items-start gap-2 text-xs text-brand-navy">
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
                          <label className="mt-2 block text-xs text-brand-navy">
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
                          <p className="mt-2 text-[11px] text-brand-navy/60">
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
                  <div className="flex shrink-0 flex-wrap gap-2 lg:max-w-sm">
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
                        review.mutate({
                          factId: fact.id,
                          decision: "rejected",
                          notes: rejectNotes[fact.id]?.trim() || null,
                        })
                      }
                    >
                      <XCircle className="size-4" /> Rejeter
                    </button>
                    <label className="block w-full basis-full text-xs text-brand-navy/70">
                      <span className="font-medium">Motif du rejet (facultatif)</span>
                      <input
                        type="text"
                        value={rejectNotes[fact.id] ?? ""}
                        onChange={(event) =>
                          setRejectNotes((previous) => ({
                            ...previous,
                            [fact.id]: event.target.value,
                          }))
                        }
                        placeholder="Ex. information déjà connue, source douteuse"
                        maxLength={1000}
                        className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-sm text-brand-navy outline-none focus:border-gold-soft focus:ring-1 focus:ring-gold-soft"
                      />
                    </label>
                  </div>
                </div>
              </article>
            );
          })}
          <AdminPagination
            label="réponses et informations à contrôler"
            offset={page?.offset ?? 0}
            limit={page?.limit ?? ADMIN_PAGE_SIZE}
            total={page?.total ?? 0}
            shown={Math.max(facts.length, messages.length)}
            busy={query.isFetching}
            onOffsetChange={setOffset}
          />
        </div>
      ) : (
        <p className="p-5 text-sm text-brand-navy/55">Aucune information en attente de contrôle.</p>
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

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Les règles d'extraction portent une valeur fixe, pas une probabilité : on dit comment le fait a
 * été lu. Seule l'IA déclare une confiance, présentée comme telle.
 */
function extractionLabel(method: string | null | undefined, confidence: unknown): string {
  if (method?.startsWith("semantic") || method?.startsWith("photo_semantic")) {
    return `Lu par l’IA · confiance déclarée par le modèle : ${Math.round(Number(confidence) * 100)} %`;
  }
  if (method?.startsWith("deterministic")) return "Extraction automatique par règles";
  return "Extraction automatique";
}

const PROCESSING_STATUS_LABELS: Record<string, string> = {
  queued: "en file d’attente",
  failed: "en échec après plusieurs tentatives",
  review: "à contrôler",
  ignored: "ignoré",
};

const PROCESSING_REASON_LABELS: Record<string, string> = {
  contact_opposed: "opposition enregistrée automatiquement",
  sender_mismatch: "expéditeur différent du contact sollicité",
  sender_authentication_failed: "authentification de l’expéditeur échouée",
  sender_authentication_unverified: "authentification de l’expéditeur non vérifiée",
  auto_reply: "réponse automatique (absence ou accusé de réception) : ignorée",
  possible_opposition:
    "possible demande de ne plus être contacté : à lire avant toute relance, aucune opposition enregistrée",
  unidentified_lot_review: "vente à plusieurs lots : lot non identifié dans la réponse",
  ambiguous_reply_review: "réponse ambiguë à relire",
  case_closed: "dossier clos",
  case_closed_during_processing: "dossier clos pendant le traitement",
};

function isLotUnidentified(metadata: unknown): boolean {
  return (
    Boolean(metadata) &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).lot_unidentified === true
  );
}

/** État du traitement automatique d'une réponse : rien n'est montré quand il s'est terminé normalement. */
function ProcessingStatus({ processing }: { processing: Record<string, unknown> | null }) {
  const status = typeof processing?.status === "string" ? processing.status : null;
  if (!status || status === "completed") return null;
  const reason = typeof processing?.reason === "string" ? processing.reason : null;
  const lastError = typeof processing?.last_error === "string" ? processing.last_error : null;
  return (
    <p
      className={`mt-1 text-xs ${status === "failed" ? "font-medium text-red-800" : "text-brand-navy/65"}`}
    >
      Traitement automatique : {PROCESSING_STATUS_LABELS[status] ?? status}
      {reason ? ` (${PROCESSING_REASON_LABELS[reason] ?? reason})` : ""}
      {status === "failed" && lastError ? ` — ${lastError}` : ""}
    </p>
  );
}

function FactProvenance({ source }: { source: InformationAgentFactSource | undefined }) {
  if (!source) return null;
  const channel =
    source.channel === "portal"
      ? "Dépôt via le lien privé (identité non vérifiée)"
      : source.channel === "admin_manual_reply"
        ? "Réponse consignée par un administrateur (expéditeur non vérifié)"
        : "Réponse par e-mail";
  const received = source.receivedAt
    ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(source.receivedAt),
      )
    : null;
  return (
    <p className="mt-1 text-xs text-brand-navy/60">
      Provenance : {channel}
      {source.fromEmail ? ` · ${source.fromEmail}` : ""}
      {received ? ` · reçue le ${received}` : ""}
      {source.senderMatchesRecipient === false
        ? source.channel === "portal"
          ? " · adresse déclarée différente du contact sollicité"
          : " · expéditeur différent du contact sollicité"
        : ""}
    </p>
  );
}
