"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Bot from "lucide-react/dist/esm/icons/bot.js";
import Copy from "lucide-react/dist/esm/icons/copy.js";
import Eye from "lucide-react/dist/esm/icons/eye.js";
import MailCheck from "lucide-react/dist/esm/icons/mail-check.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "@/lib/toast";
import type { InformationRequestSelection } from "@/components/admin/AdminCatalogueReadinessPanel";
import { AdminPagination } from "@/components/admin/AdminPagination";
import { ADMIN_PAGE_MAX_LIMIT, ADMIN_PAGE_SIZE, adminClampOffset } from "@/lib/admin-pagination";
import {
  createAdminInformationAgentMission,
  fetchAdminInformationAgentMissions,
  fetchAdminSourceRefreshStatus,
  previewAdminInformationAgentMission,
  requestAdminSourceRefresh,
  runAdminInformationAgentMissionAction,
} from "@/lib/client-api";
import type { AdminSourceRefreshResponse } from "@/lib/admin-source-refresh";
import type {
  InformationAgentMission,
  InformationAgentPreviewResponse,
} from "@/lib/information-agent";
import type { InformationAgentInventoryItem } from "@/lib/information-agent-inventory";
import {
  INFORMATION_AGENT_QUESTIONS,
  type InformationAgentQuestionKey,
} from "@/lib/information-agent-questions";
import { saleDetailPath } from "@/lib/navigation";

const QUERY_KEY = ["admin-information-agent-missions"] as const;
const SOURCE_REFRESH_QUERY_KEY = ["admin-information-agent-source-refresh"] as const;

type EditedMissionDraft = {
  recipientName: string;
  recipientEmail: string;
  recipientOriginUrl: string;
  subject: string;
  bodyText: string;
  recipientReviewNotice: boolean;
};

type ShownPreview = { key: string; response: InformationAgentPreviewResponse };

export function AdminInformationAgentMissionsPanel({
  selection,
  onClose,
}: {
  selection: InformationRequestSelection | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [listOffset, setListOffset] = useState(0);
  const missionsQuery = useQuery({
    queryKey: [...QUERY_KEY, listOffset],
    queryFn: () =>
      fetchAdminInformationAgentMissions({ offset: listOffset, limit: ADMIN_PAGE_SIZE }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const sourceRefreshQuery = useQuery({
    queryKey: [...SOURCE_REFRESH_QUERY_KEY, selection?.saleId],
    queryFn: () => fetchAdminSourceRefreshStatus(selection!.saleId),
    enabled: Boolean(selection?.saleId),
    staleTime: 3_000,
    refetchInterval: (query) => {
      const status = query.state.data?.request?.status;
      return status === "queued" || status === "running" ? 5_000 : false;
    },
  });
  const [recipientName, setRecipientName] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [activeMission, setActiveMission] = useState<InformationAgentMission | null>(null);
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [recipientOriginUrl, setRecipientOriginUrl] = useState("");
  const [shownPreview, setShownPreview] = useState<ShownPreview | null>(null);
  const [manualReply, setManualReply] = useState("");
  const [sourceRefreshCycleId, setSourceRefreshCycleId] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [recipientReviewNotice, setRecipientReviewNotice] = useState(false);
  const [preparingSelectionKey, setPreparingSelectionKey] = useState<string | null>(null);
  const selectionRef = useRef(selection);
  const activeMissionRef = useRef<InformationAgentMission | null>(null);
  const preparedDraftsRef = useRef(new Map<string, InformationAgentMission>());
  const preparingKeysRef = useRef(new Set<string>());
  const availableMissionsRef = useRef<InformationAgentMission[]>([]);
  const missionsTotalRef = useRef<number | null>(null);
  const composerSectionRef = useRef<HTMLElement | null>(null);
  const composerHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const editedDraftsRef = useRef(new Map<string, EditedMissionDraft>());
  const createDraft = useMutation({ mutationFn: createAdminInformationAgentMission });
  const createDraftAsync = createDraft.mutateAsync;

  useEffect(() => {
    availableMissionsRef.current = missionsQuery.data?.missions ?? [];
    // Tant que la liste n'est pas arrivée le total reste inconnu (null) ; une réponse sans total
    // (ancienne version de l'API) compte comme une liste complète.
    if (missionsQuery.data) {
      missionsTotalRef.current = missionsQuery.data.total ?? missionsQuery.data.missions.length;
    }
    if (
      missionsQuery.data &&
      !missionsQuery.data.missions.length &&
      missionsQuery.data.offset > 0
    ) {
      setListOffset(
        adminClampOffset(
          missionsQuery.data.offset,
          missionsQuery.data.limit,
          missionsQuery.data.total,
        ),
      );
    }
  }, [missionsQuery.data]);

  const hydrateMission = useCallback((mission: InformationAgentMission) => {
    const edited = editedDraftsRef.current.get(mission.id);
    activeMissionRef.current = mission;
    setActiveMission(mission);
    setRecipientName(edited?.recipientName ?? mission.recipientName ?? "");
    setRecipientEmail(edited?.recipientEmail ?? mission.recipientEmail);
    setSubject(edited?.subject ?? mission.subject);
    setBodyText(edited?.bodyText ?? mission.bodyText);
    setRecipientOriginUrl(edited?.recipientOriginUrl ?? "");
    setRecipientReviewNotice(edited?.recipientReviewNotice ?? false);
    setManualReply("");
  }, []);

  const rememberEdits = useCallback((patch: Partial<EditedMissionDraft>) => {
    const mission = activeMissionRef.current;
    if (!mission || !isMissionEditable(mission.status)) return;
    const previous = editedDraftsRef.current.get(mission.id) ?? {
      recipientName: mission.recipientName ?? "",
      recipientEmail: mission.recipientEmail,
      recipientOriginUrl: "",
      subject: mission.subject,
      bodyText: mission.bodyText,
      recipientReviewNotice: false,
    };
    editedDraftsRef.current.set(mission.id, { ...previous, ...patch });
  }, []);

  const prepareDraft = useCallback(
    (
      requestSelection: InformationRequestSelection,
      options: {
        recipientEmail?: string;
        recipientName?: string;
        force?: boolean;
        questionKeys?: InformationAgentQuestionKey[];
      } = {},
    ) => {
      const recipientEmail = options.recipientEmail?.trim() || undefined;
      const recipientName = options.recipientName?.trim() || undefined;
      const requestKey = JSON.stringify([
        selectionIdentityKey(requestSelection),
        recipientEmail ?? "",
        recipientName ?? "",
      ]);
      const isCurrentSelection = () =>
        selectionRef.current != null &&
        selectionIdentityKey(selectionRef.current) === selectionIdentityKey(requestSelection);
      const uniqueEditableMission = (missions: InformationAgentMission[]) => {
        const candidates = missions.filter(
          (mission) =>
            mission.saleId === requestSelection.saleId &&
            isMissionEditable(mission.status) &&
            (!recipientEmail ||
              normalizeEmail(mission.recipientEmail) === normalizeEmail(recipientEmail)),
        );
        return candidates.length === 1 ? candidates[0] : undefined;
      };

      if (!options.force) {
        const cached = preparedDraftsRef.current.get(requestKey);
        if (cached) {
          if (isCurrentSelection()) hydrateMission(cached);
          return;
        }
        const existing = uniqueEditableMission(availableMissionsRef.current);
        if (existing) {
          preparedDraftsRef.current.set(requestKey, existing);
          if (isCurrentSelection()) hydrateMission(existing);
          return;
        }
      } else {
        for (const [key, cached] of preparedDraftsRef.current) {
          if (cached.saleId === requestSelection.saleId) preparedDraftsRef.current.delete(key);
        }
      }

      if (preparingKeysRef.current.has(requestKey)) {
        if (isCurrentSelection()) {
          setDraftError(null);
          setPreparingSelectionKey(requestKey);
        }
        return;
      }
      preparingKeysRef.current.add(requestKey);
      if (isCurrentSelection()) {
        setDraftError(null);
        setPreparingSelectionKey(requestKey);
      }

      // The one-click path deliberately sends only the sale id. The server
      // must choose a unique, permitted contact and reject missing or
      // ambiguous contacts instead of trusting the first email in a label.
      const create = () =>
        createDraftAsync({
          saleId: requestSelection.saleId,
          ...(options.force || recipientEmail || recipientName
            ? {
                recipientEmail,
                recipientName,
              }
            : {}),
          ...(options.questionKeys?.length ? { questionKeys: options.questionKeys } : {}),
        })
          .then((response) => {
            if (!response?.mission) throw new Error("Le brouillon reçu est incomplet.");
            preparingKeysRef.current.delete(requestKey);
            preparedDraftsRef.current.set(requestKey, response.mission);
            if (isCurrentSelection()) {
              setPreparingSelectionKey(null);
              setDraftError(null);
              hydrateMission(response.mission);
              toast.success("Brouillon généré. Aucun email n’a encore été envoyé.");
            }
            void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
          })
          .catch((error: unknown) => {
            preparingKeysRef.current.delete(requestKey);
            if (isCurrentSelection()) {
              setPreparingSelectionKey(null);
              setDraftError(error instanceof Error ? error.message : "Brouillon indisponible.");
            }
          });

      // La liste est paginée (50 par page) : un brouillon de cette vente peut se trouver sur une
      // page non chargée. On le cherche par vente avant d'en créer un second.
      const hasUnloadedMissions =
        missionsTotalRef.current === null ||
        missionsTotalRef.current > availableMissionsRef.current.length;
      if (options.force || !hasUnloadedMissions) {
        void create();
        return;
      }
      void queryClient
        .fetchQuery({
          queryKey: [...QUERY_KEY, "sale", requestSelection.saleId],
          queryFn: () =>
            fetchAdminInformationAgentMissions({
              saleId: requestSelection.saleId,
              limit: ADMIN_PAGE_MAX_LIMIT,
            }),
          staleTime: 0,
        })
        .then((response) => response.missions)
        .catch(() => [] as InformationAgentMission[])
        .then((saleMissions) => {
          const existing = uniqueEditableMission(saleMissions);
          if (!existing) return create();
          preparingKeysRef.current.delete(requestKey);
          preparedDraftsRef.current.set(requestKey, existing);
          if (isCurrentSelection()) {
            setPreparingSelectionKey(null);
            hydrateMission(existing);
          }
        });
    },
    [createDraftAsync, hydrateMission, queryClient],
  );
  useEffect(() => {
    selectionRef.current = selection;
    if (!selection) {
      setPreparingSelectionKey(null);
      return;
    }

    setRecipientName("");
    setRecipientEmail("");
    setActiveMission(null);
    activeMissionRef.current = null;
    setSubject("");
    setBodyText("");
    setRecipientOriginUrl("");
    setShownPreview(null);
    setDraftError(null);
    setRecipientReviewNotice(false);
    setSourceRefreshCycleId(null);
    // A queue click is the complete preparation action. Contact discovery is
    // server-side so that a phone label or multiple addresses never selects a
    // recipient accidentally.
    prepareDraft(selection);
  }, [prepareDraft, selection]);

  useEffect(() => {
    if (!selection) return;
    composerSectionRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    composerHeadingRef.current?.focus({ preventScroll: true });
  }, [selection]);
  const sourceRefresh = useMutation({
    mutationFn: requestAdminSourceRefresh,
    onSuccess: (response, input) => {
      if (selectionRef.current?.saleId !== input.saleId) return;
      setSourceRefreshCycleId(response.request?.id ?? null);
      queryClient.setQueryData<AdminSourceRefreshResponse>(
        [...SOURCE_REFRESH_QUERY_KEY, input.saleId],
        response,
      );
      toast.success(
        response.request?.reused
          ? "Un refresh actif de cette source est déjà pris en compte."
          : "Refresh source demandé. Le statut sera actualisé automatiquement.",
      );
    },
    onError: showError,
  });
  const runAction = useMutation({
    mutationFn: runAdminInformationAgentMissionAction,
    onSuccess: (response, input) => {
      const updated = response.missions.find((mission) => mission.id === input.missionId);
      if (updated) {
        for (const [key, cached] of preparedDraftsRef.current) {
          if (cached.id !== updated.id) continue;
          if (updated.status === "draft" || updated.status === "failed") {
            preparedDraftsRef.current.set(key, updated);
          } else {
            preparedDraftsRef.current.delete(key);
          }
        }
        if (!isMissionEditable(updated.status)) editedDraftsRef.current.delete(updated.id);
      }
      if (updated && activeMissionRef.current?.id === updated.id) {
        activeMissionRef.current = updated;
        setActiveMission(updated);
      }
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      if (input.action === "record_reply") setManualReply("");
      toast.success(
        updated?.status === "sent" && input.action === "approve_and_send"
          ? "Demande envoyée."
          : input.action === "record_reply"
            ? "Réponse rattachée au dossier : elle passe par la revue avant toute publication."
            : "Mission mise à jour.",
      );
    },
    onError: showError,
  });
  const previewKey = activeMission
    ? JSON.stringify([
        activeMission.id,
        normalizeEmail(recipientEmail),
        recipientName.trim(),
        subject.trim(),
        bodyText.trim(),
        recipientOriginUrl.trim(),
      ])
    : null;
  const previewMutation = useMutation({
    mutationFn: ({
      key: _key,
      ...input
    }: Parameters<typeof previewAdminInformationAgentMission>[0] & {
      key: string;
    }) => previewAdminInformationAgentMission(input),
    onSuccess: (response, input) => setShownPreview({ key: input.key, response }),
    onError: showError,
  });
  const previewIsCurrent = Boolean(shownPreview && previewKey && shownPreview.key === previewKey);
  const previewAllowsSend =
    previewIsCurrent &&
    Boolean(shownPreview?.response.fingerprint) &&
    !shownPreview?.response.blockers.length;

  // Pourquoi « Valider et envoyer » est grisé : dit à côté du bouton, pas dans une info-bulle que ni
  // le clavier ni le tactile ne voient.
  const sendDisabledReason = runAction.isPending
    ? null
    : !looksLikeEmail(recipientEmail)
      ? "Renseignez une adresse email valide pour activer l’envoi."
      : subject.trim().length < 3 || bodyText.trim().length < 20
        ? "Renseignez un objet et un message (20 caractères au moins) pour activer l’envoi."
        : !shownPreview
          ? "Affichez l’aperçu pour activer l’envoi."
          : !previewIsCurrent
            ? "Le message a changé depuis l’aperçu : actualisez l’aperçu pour activer l’envoi."
            : !previewAllowsSend
              ? "L’aperçu signale un blocage : l’envoi reste bloqué tant qu’un contrôle échoue."
              : null;

  const resumeMission = (mission: InformationAgentMission) => {
    // A pending automatic preparation for the queue must never overwrite a
    // mission selected from the history list.
    selectionRef.current = null;
    onClose();
    setDraftError(null);
    hydrateMission(mission);
    // La liste est sous le formulaire : sans ce déplacement, l'ouverture ne se voit pas.
    composerSectionRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    composerHeadingRef.current?.focus({ preventScroll: true });
  };
  const closeComposer = () => {
    selectionRef.current = null;
    activeMissionRef.current = null;
    setActiveMission(null);
    setDraftError(null);
    setPreparingSelectionKey(null);
    setSubject("");
    setBodyText("");
    setRecipientOriginUrl("");
    setShownPreview(null);
    onClose();
  };
  const copyMessage = async () => {
    const recipient = recipientName.trim()
      ? `${recipientName.trim()} <${recipientEmail.trim()}>`
      : recipientEmail.trim();
    const content = [`À : ${recipient}`, `Objet : ${subject.trim()}`, "", bodyText.trim()].join(
      "\n",
    );
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = content;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        textarea.remove();
        if (!copied) throw new Error("La copie n’a pas été autorisée par le navigateur.");
      }
      toast.success("Destinataire, objet et message copiés.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Copie impossible.");
    }
  };
  const handleRecipientEmailChange = (value: string) => {
    setRecipientEmail(value);
    const mission = activeMissionRef.current;
    if (!mission || !isMissionEditable(mission.status)) return;
    const emailChanged = normalizeEmail(value) !== normalizeEmail(mission.recipientEmail);
    if (emailChanged) {
      setRecipientName("");
      setRecipientReviewNotice(true);
      rememberEdits({
        recipientEmail: value,
        recipientName: "",
        recipientReviewNotice: true,
      });
      return;
    }
    rememberEdits({ recipientEmail: value });
  };
  const handleRecipientNameChange = (value: string) => {
    setRecipientName(value);
    rememberEdits({ recipientName: value });
  };
  const handleSubjectChange = (value: string) => {
    setSubject(value);
    rememberEdits({ subject: value });
  };
  const handleBodyChange = (value: string) => {
    setBodyText(value);
    rememberEdits({ bodyText: value });
  };
  const handleOriginChange = (value: string) => {
    setRecipientOriginUrl(value);
    rememberEdits({ recipientOriginUrl: value });
  };
  const showPreview = () => {
    if (!activeMission || !previewKey) return;
    previewMutation.mutate({
      key: previewKey,
      missionId: activeMission.id,
      recipientEmail: recipientEmail.trim(),
      recipientName: recipientName.trim() || null,
      subject: subject.trim(),
      bodyText: bodyText.trim(),
      recipientOriginUrl: recipientOriginUrl.trim() || null,
    });
  };

  const sourceRefreshCycle = sourceRefreshCycleId
    ? (sourceRefreshQuery.data?.history.find((item) => item.id === sourceRefreshCycleId) ??
      (sourceRefreshQuery.data?.request?.id === sourceRefreshCycleId
        ? sourceRefreshQuery.data.request
        : null))
    : null;
  const sourceRefreshStatus = sourceRefreshCycle?.status ?? null;
  const sourceRefreshInProgress =
    sourceRefreshStatus === "queued" || sourceRefreshStatus === "running";
  const sourceRefreshReady = sourceRefreshStatus === "completed";

  return (
    <section
      ref={composerSectionRef}
      aria-busy={Boolean(preparingSelectionKey)}
      className="overflow-hidden rounded-xl border bg-white"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-gold-text">
            <Bot className="size-4" />
            Enrichissement administré
          </div>
          <h2 ref={composerHeadingRef} tabIndex={-1} className="mt-2 font-semibold">
            Demandes d’informations
          </h2>
          <p className="mt-1 text-sm text-brand-navy/60">
            Le brouillon est préparé automatiquement. Chaque envoi est déclenché à la main, fiche
            par fiche, après l’aperçu du message ; aucune relance n’est automatique.
          </p>
        </div>
        {selection || activeMission ? (
          <button type="button" className="admin-button-secondary" onClick={closeComposer}>
            <X className="size-4" aria-hidden="true" /> Fermer
          </button>
        ) : null}
      </div>

      {selection && !activeMission ? (
        <div className="border-b bg-amber-50/50 p-5">
          <h3 className="font-semibold">Préparation du message · {selection.title}</h3>
          <p className="mt-1 text-xs text-brand-navy/55">Annonce {selection.saleId}</p>
          <p className="mt-3 text-sm text-brand-navy/70" role="status" aria-live="polite">
            {preparingSelectionKey
              ? "Le brouillon est en cours de préparation avec le contact vérifié côté serveur…"
              : draftError
                ? "Le message n’a pas pu être préparé automatiquement. Vérifiez le contact puis réessayez."
                : "Le message sera affiché ici dès qu’il est prêt à être relu."}
          </p>
          {draftError ? (
            <p
              role="alert"
              className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
            >
              {draftError}
            </p>
          ) : null}
          {draftError ? (
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <Field
                label="Nom du destinataire (à vérifier)"
                value={recipientName}
                onChange={setRecipientName}
              />
              <Field
                label="Email du destinataire"
                value={recipientEmail}
                onChange={setRecipientEmail}
                type="email"
                required
              />
            </div>
          ) : null}
          {draftError ? (
            <button
              type="button"
              className="admin-button-primary mt-4"
              disabled={
                createDraft.isPending ||
                !looksLikeEmail(recipientEmail) ||
                (recipientEmail.trim().length > 0 && !looksLikeEmail(recipientEmail))
              }
              onClick={() =>
                prepareDraft(selection, {
                  recipientEmail,
                  recipientName,
                  force: true,
                })
              }
            >
              {createDraft.isPending ? "Préparation…" : "Préparer avec ce contact"}
            </button>
          ) : null}
        </div>
      ) : null}

      {activeMission ? (
        <div className="border-b bg-slate-50 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-semibold">
                Brouillon pour {recipientEmail.trim() || "destinataire à vérifier"}
              </h3>
              <p className="mt-1 text-xs text-brand-navy/55">
                Statut : {missionStatusLabel(activeMission.status)} · annonce {activeMission.saleId}{" "}
                · préparé le {formatDateTime(activeMission.createdAt)}
              </p>
            </div>
            <span className="rounded-full border bg-white px-2.5 py-1 text-xs">
              {missionStatusLabel(activeMission.status)}
            </span>
          </div>
          {activeMission.failureReason ? (
            <p className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-900">
              <span className="font-semibold">
                {activeMission.status === "failed" ? "Motif de l’échec" : "À vérifier"} :
              </span>{" "}
              {activeMission.failureReason}
            </p>
          ) : null}
          {isMissionEditable(activeMission.status) && isStaleDraft(activeMission.createdAt) ? (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
              Brouillon préparé il y a plus de {STALE_DRAFT_DAYS} jours : l’aperçu relit la vente et
              bloque l’envoi si sa date, sa mise à prix ou son statut ont changé. Régénérez-le au
              besoin.
            </p>
          ) : null}
          <div className="mt-4 space-y-3">
            <Field
              label="Nom du destinataire"
              value={recipientName}
              onChange={handleRecipientNameChange}
              readOnly={!isMissionEditable(activeMission.status)}
            />
            <Field
              label="Email"
              value={recipientEmail}
              onChange={handleRecipientEmailChange}
              type="email"
              readOnly={!isMissionEditable(activeMission.status)}
            />
            <Field
              label="Objet"
              value={subject}
              onChange={handleSubjectChange}
              readOnly={!isMissionEditable(activeMission.status)}
            />
            <label className="block text-xs font-medium">
              Message
              <textarea
                value={bodyText}
                readOnly={!isMissionEditable(activeMission.status)}
                onChange={(event) => handleBodyChange(event.target.value)}
                rows={12}
                className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm leading-6"
              />
            </label>
            {recipientReviewNotice ? (
              <p
                className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
                role="status"
              >
                L’adresse du destinataire a changé. Relisez le nom et la formule d’appel dans le
                message avant l’envoi ; le contenu saisi n’est pas réécrit automatiquement.
              </p>
            ) : null}
            {isMissionEditable(activeMission.status) ? (
              <Field
                label="Page publique où figure l’adresse (si elle ne vient pas de l’annonce)"
                value={recipientOriginUrl}
                onChange={handleOriginChange}
                type="url"
              />
            ) : null}
            <p className="text-xs text-brand-navy/65">
              Le mail envoyé ajoutera une adresse de réponse propre au dossier, un lien privé de
              dépôt sans compte, l’origine de l’adresse avec le lien de l’annonce et un lien de
              désinscription.
            </p>
            <InventoryPanel items={activeMission.inventory ?? []} />
            {selection && isMissionEditable(activeMission.status) ? (
              <QuestionChoice
                key={activeMission.id}
                missing={activeMission.missingInformation}
                asked={activeMission.questionKeys}
                disabled={createDraft.isPending}
                onRegenerate={(questionKeys) =>
                  prepareDraft(selection, {
                    recipientEmail,
                    recipientName,
                    force: true,
                    questionKeys,
                  })
                }
              />
            ) : null}
            {isMissionEditable(activeMission.status) ? (
              <PreviewPanel
                preview={shownPreview?.response ?? null}
                current={previewIsCurrent}
                loading={previewMutation.isPending}
                onShow={showPreview}
                disabled={
                  !looksLikeEmail(recipientEmail) ||
                  subject.trim().length < 3 ||
                  bodyText.trim().length < 20
                }
              />
            ) : null}
            {selection ? (
              <div className="rounded-lg border border-sky-200 bg-sky-50/70 p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-sky-950">
                      Actualiser la source si nécessaire
                    </p>
                    <p className="mt-1 max-w-2xl text-xs leading-5 text-sky-950/70">
                      Le brouillon est déjà disponible. Une actualisation relira l’URL exacte de
                      l’annonce et permettra une régénération explicite après contrôle.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="admin-button-secondary inline-flex items-center gap-2 bg-white"
                    disabled={sourceRefresh.isPending || sourceRefreshInProgress}
                    onClick={() => sourceRefresh.mutate({ saleId: selection.saleId, force: true })}
                  >
                    <RefreshCw
                      className={`size-3.5 ${sourceRefresh.isPending ? "animate-spin" : ""}`}
                    />
                    {sourceRefreshInProgress
                      ? "Refresh en cours…"
                      : sourceRefresh.isPending
                        ? "Mise en file…"
                        : "Actualiser la source"}
                  </button>
                </div>
                <SourceRefreshStatus
                  response={sourceRefreshQuery.data}
                  requestId={sourceRefreshCycleId}
                  loading={sourceRefreshQuery.isPending}
                  error={sourceRefreshQuery.error}
                />
              </div>
            ) : null}
          </div>
          {activeMission.status === "draft" || activeMission.status === "failed" ? (
            <>
              <div className="mt-4 flex flex-wrap gap-2">
                {selection && sourceRefreshReady ? (
                  <button
                    type="button"
                    className="admin-button-secondary inline-flex items-center gap-2"
                    disabled={createDraft.isPending || sourceRefreshInProgress}
                    onClick={() =>
                      prepareDraft(selection, {
                        recipientEmail,
                        recipientName,
                        force: true,
                      })
                    }
                  >
                    <RefreshCw className="size-3.5" />
                    {createDraft.isPending
                      ? "Régénération…"
                      : "Régénérer depuis la source actualisée"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="admin-button-primary inline-flex items-center gap-2"
                  aria-describedby={sendDisabledReason ? "send-disabled-reason" : undefined}
                  disabled={
                    runAction.isPending ||
                    !previewAllowsSend ||
                    !looksLikeEmail(recipientEmail) ||
                    subject.trim().length < 3 ||
                    bodyText.trim().length < 20
                  }
                  onClick={() => {
                    const fingerprint = shownPreview?.response.fingerprint;
                    if (!previewAllowsSend || !fingerprint) return;
                    if (
                      !window.confirm(
                        `Envoyer maintenant cet email à ${recipientEmail.trim()}, tel qu’affiché dans l’aperçu ? Aucun autre envoi n’aura lieu sans nouvelle validation.`,
                      )
                    )
                      return;
                    runAction.mutate({
                      action: "approve_and_send",
                      missionId: activeMission.id,
                      approvalConfirmed: true,
                      previewFingerprint: fingerprint,
                      recipientEmail: recipientEmail.trim(),
                      recipientName: recipientName.trim() || null,
                      recipientOriginUrl: recipientOriginUrl.trim() || null,
                      subject: subject.trim(),
                      bodyText: bodyText.trim(),
                    });
                  }}
                >
                  <MailCheck className="size-4" />
                  Valider et envoyer
                </button>
                <button
                  type="button"
                  className="admin-button-secondary inline-flex items-center gap-2"
                  disabled={!recipientEmail.trim() || !subject.trim() || !bodyText.trim()}
                  onClick={() => void copyMessage()}
                >
                  <Copy className="size-4" />
                  Copier le message
                </button>
                <button
                  type="button"
                  className="admin-button-secondary"
                  disabled={runAction.isPending}
                  onClick={() =>
                    runAction.mutate({ action: "cancel", missionId: activeMission.id })
                  }
                >
                  Annuler la mission
                </button>
              </div>
              {sendDisabledReason ? (
                <p id="send-disabled-reason" className="mt-2 text-xs text-brand-navy/70">
                  {sendDisabledReason}
                </p>
              ) : null}
            </>
          ) : null}
          {activeMission.status === "sent" || activeMission.status === "replied" ? (
            <div className="mt-4 rounded-lg border bg-white p-3">
              <label className="block text-xs font-medium">
                Consigner une réponse reçue hors de l’adresse du dossier (téléphone, courrier, autre
                messagerie)
                <textarea
                  value={manualReply}
                  onChange={(event) => setManualReply(event.target.value)}
                  rows={4}
                  className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm leading-6"
                />
              </label>
              <p className="mt-1 text-xs text-brand-navy/60">
                La réponse est rattachée à ce dossier comme import manuel (expéditeur non vérifié).
                Les informations extraites passent par la revue avant toute publication ; une
                demande de ne plus être contacté est enregistrée comme opposition.
              </p>
              <button
                type="button"
                className="admin-button-secondary mt-2"
                disabled={runAction.isPending || !manualReply.trim()}
                onClick={() =>
                  runAction.mutate({
                    action: "record_reply",
                    missionId: activeMission.id,
                    bodyText: manualReply.trim(),
                  })
                }
              >
                Rattacher la réponse au dossier
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="p-5">
        <h3 className="text-sm font-semibold">Missions récentes</h3>
        {missionsQuery.isPending ? (
          <p className="mt-3 text-sm text-brand-navy/55">Chargement…</p>
        ) : missionsQuery.error ? (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {missionsQuery.error instanceof Error
              ? missionsQuery.error.message
              : "Missions indisponibles"}
          </p>
        ) : missionsQuery.data?.missions.length ? (
          <div className="mt-3 divide-y rounded-lg border">
            {missionsQuery.data.missions.map((mission) => (
              <div
                key={mission.id}
                className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 text-sm"
              >
                <div className="min-w-0">
                  {mission.saleId ? (
                    <p className="truncate font-medium">
                      <Link
                        href={saleDetailPath(mission.saleId)}
                        className="underline-offset-2 hover:underline"
                      >
                        {mission.saleTitle || "Annonce sans titre"}
                      </Link>
                    </p>
                  ) : null}
                  <p
                    className={`truncate ${mission.saleId ? "text-xs text-brand-navy/70" : "font-medium"}`}
                  >
                    {mission.recipientEmail}
                  </p>
                  <p className="mt-0.5 text-xs text-brand-navy/50">
                    {missionStatusLabel(mission.status)} · {formatDateTime(mission.updatedAt)}
                  </p>
                  {mission.status === "failed" && mission.failureReason ? (
                    <p className="mt-0.5 line-clamp-2 text-xs text-red-800">
                      {mission.failureReason}
                    </p>
                  ) : null}
                </div>
                {/* Un brouillon ou un échec se reprend ; tout autre statut s'ouvre en lecture seule
                    (seul le formulaire de réponse consignée reste actif pour envoyée / répondue). */}
                <button
                  type="button"
                  className="admin-button-secondary"
                  onClick={() => resumeMission(mission)}
                >
                  {isMissionEditable(mission.status) ? "Reprendre" : "Ouvrir"}
                </button>
              </div>
            ))}
            <AdminPagination
              label="missions récentes"
              offset={missionsQuery.data.offset ?? 0}
              limit={missionsQuery.data.limit ?? ADMIN_PAGE_SIZE}
              total={missionsQuery.data.total ?? missionsQuery.data.missions.length}
              shown={missionsQuery.data.missions.length}
              busy={missionsQuery.isFetching}
              onOffsetChange={setListOffset}
              className="!px-3"
            />
          </div>
        ) : (
          <p className="mt-3 text-sm text-brand-navy/55">Aucune mission.</p>
        )}
      </div>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  required = false,
  readOnly = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email" | "url";
  required?: boolean;
  readOnly?: boolean;
}) {
  return (
    <label className="block text-xs font-medium">
      {label}
      <input
        type={type}
        required={required}
        readOnly={readOnly}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm"
      />
    </label>
  );
}

const INVENTORY_STATUS_LABELS: Record<InformationAgentInventoryItem["status"], string> = {
  present: "Disponible",
  to_confirm: "À confirmer",
  missing: "Manquant",
  not_applicable: "Sans objet",
};

function InventoryPanel({ items }: { items: InformationAgentInventoryItem[] }) {
  if (!items.length) return null;
  const open = items.filter((item) => item.status === "missing" || item.status === "to_confirm");
  const known = items.filter((item) => item.status === "present");
  return (
    <section aria-label="Inventaire de la fiche" className="rounded-lg border bg-white p-3">
      <h4 className="text-sm font-semibold">Inventaire de la fiche</h4>
      <p className="mt-1 text-xs text-brand-navy/60">
        Établi au moment du brouillon à partir des données des sources, des pièces et des faits
        extraits des PDF. Seuls les éléments manquants ou à confirmer sont demandés.
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <InventoryList title={`À obtenir (${open.length})`} items={open} />
        <InventoryList title={`Déjà disponible (${known.length})`} items={known} />
      </div>
    </section>
  );
}

function InventoryList({
  title,
  items,
}: {
  title: string;
  items: InformationAgentInventoryItem[];
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-brand-navy/60">{title}</p>
      {items.length ? (
        <ul className="mt-1 space-y-1 text-xs">
          {items.map((item) => (
            <li key={item.key}>
              <span className="font-medium">{item.label}</span>
              {" · "}
              <span>{INVENTORY_STATUS_LABELS[item.status]}</span>
              <span className="block text-brand-navy/60">
                {item.detail}
                {item.origin ? ` (${item.origin})` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-brand-navy/55">Aucun élément.</p>
      )}
    </div>
  );
}

const MAX_CHOSEN_QUESTIONS = 6;

/**
 * Lacunes détectées et questions retenues : l'administrateur voit celles écartées par la limite
 * de quatre questions et peut régénérer le brouillon avec son propre choix.
 */
function QuestionChoice({
  missing,
  asked,
  disabled,
  onRegenerate,
}: {
  missing: readonly string[];
  asked: readonly InformationAgentQuestionKey[];
  disabled: boolean;
  onRegenerate: (questionKeys: InformationAgentQuestionKey[]) => void;
}) {
  const keys = [...new Set([...asked, ...missing])].filter(
    (key): key is InformationAgentQuestionKey => key in INFORMATION_AGENT_QUESTIONS,
  );
  const [chosen, setChosen] = useState<InformationAgentQuestionKey[]>([...asked]);
  if (!keys.length) return null;
  const unchanged = chosen.length === asked.length && chosen.every((key) => asked.includes(key));
  return (
    <fieldset className="rounded-lg border bg-white p-3">
      <legend className="px-1 text-sm font-semibold">Questions posées</legend>
      <p className="text-xs text-brand-navy/60">
        Informations manquantes détectées sur la fiche. Quatre questions au plus restent
        conseillées.
      </p>
      <ul className="mt-2 grid gap-1 sm:grid-cols-2">
        {keys.map((key) => (
          <li key={key}>
            <label className="flex min-h-9 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={chosen.includes(key)}
                disabled={
                  disabled || (!chosen.includes(key) && chosen.length >= MAX_CHOSEN_QUESTIONS)
                }
                onChange={(event) =>
                  setChosen((current) =>
                    event.target.checked
                      ? [...current, key]
                      : current.filter((item) => item !== key),
                  )
                }
              />
              {INFORMATION_AGENT_QUESTIONS[key].label}
              {!asked.includes(key) ? (
                <span className="text-xs text-brand-navy/50">(non posée)</span>
              ) : null}
            </label>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="admin-button-secondary mt-2"
        disabled={disabled || unchanged || chosen.length === 0}
        onClick={() => onRegenerate(chosen)}
      >
        Régénérer avec ces questions
      </button>
    </fieldset>
  );
}

function PreviewPanel({
  preview,
  current,
  loading,
  disabled,
  onShow,
}: {
  preview: InformationAgentPreviewResponse | null;
  current: boolean;
  loading: boolean;
  disabled: boolean;
  onShow: () => void;
}) {
  return (
    <section aria-label="Aperçu de l’e-mail" className="rounded-lg border bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Aperçu de l’e-mail</h4>
        <button
          type="button"
          className="admin-button-secondary inline-flex items-center gap-2"
          disabled={disabled || loading}
          onClick={onShow}
        >
          <Eye className="size-4" aria-hidden="true" />
          {loading ? "Préparation…" : current ? "Actualiser l’aperçu" : "Afficher l’aperçu"}
        </button>
      </div>
      {!preview ? (
        <p className="mt-2 text-xs text-brand-navy/60">
          L’envoi n’est possible qu’après l’affichage de l’aperçu exact du message.
        </p>
      ) : (
        <>
          {!current ? (
            <p role="status" className="mt-2 text-xs text-amber-900">
              Le message a été modifié depuis cet aperçu : affichez-le de nouveau avant l’envoi.
            </p>
          ) : null}
          {preview.blockers.length ? (
            <ul
              role="alert"
              className="mt-2 list-inside list-disc rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800"
            >
              {preview.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          ) : null}
          <dl className="mt-2 grid gap-1 text-xs text-brand-navy/75">
            <div>
              <dt className="inline font-medium">De : </dt>
              <dd className="inline">{preview.preview.from ?? "expéditeur à configurer"}</dd>
            </div>
            <div>
              <dt className="inline font-medium">À : </dt>
              <dd className="inline">{preview.preview.to}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Objet : </dt>
              <dd className="inline">{preview.preview.subject}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Origine de l’adresse : </dt>
              <dd className="inline">{preview.addressOrigin.text}</dd>
            </div>
            {preview.addressOrigin.automated ? (
              <div role="note" className="rounded-lg border border-amber-200 bg-amber-50 p-2">
                <dt className="inline font-medium">Adresse retrouvée automatiquement : </dt>
                <dd className="inline">
                  l’outil de recherche l’a lue sur une page publique, personne ne l’a encore
                  vérifiée.{" "}
                  {preview.addressOrigin.url ? (
                    <>
                      <a
                        href={preview.addressOrigin.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium underline"
                      >
                        Ouvrir la page source
                      </a>{" "}
                      et vérifier que l’adresse est bien celle de ce professionnel avant d’envoyer.
                    </>
                  ) : (
                    "Vérifiez l’adresse avant d’envoyer."
                  )}
                </dd>
              </div>
            ) : null}
          </dl>
          <iframe
            title="Aperçu de l’e-mail envoyé"
            srcDoc={preview.preview.html}
            sandbox=""
            className="mt-3 h-[640px] w-full rounded-lg border"
          />
          <details className="mt-2 text-xs text-brand-navy/75">
            <summary className="cursor-pointer font-medium">
              Version texte (envoyée avec le HTML, lue par certaines messageries)
            </summary>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border bg-slate-50 p-3 font-sans">
              {preview.preview.text}
            </pre>
          </details>
          <p className="mt-2 text-xs text-brand-navy/55">
            Le jeton de l’adresse de réponse et le lien privé de dépôt sont attribués au moment de
            l’envoi ; tout le reste est identique au message qui partira.
          </p>
        </>
      )}
    </section>
  );
}

function selectionIdentityKey(selection: InformationRequestSelection): string {
  return JSON.stringify([
    selection.saleId,
    selection.recipientName ?? "",
    selection.recipientContact ?? "",
  ]);
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isMissionEditable(status: string): boolean {
  return status === "draft" || status === "failed";
}

const STALE_DRAFT_DAYS = 3;

function isStaleDraft(createdAt: string, now = Date.now()): boolean {
  const created = Date.parse(createdAt);
  return Number.isFinite(created) && now - created > STALE_DRAFT_DAYS * 24 * 60 * 60 * 1000;
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function missionStatusLabel(status: string): string {
  return (
    {
      draft: "Brouillon",
      subscribed: "Rattachée au dossier",
      approved: "Validée",
      sending: "Envoi en cours",
      sent: "Envoyée",
      replied: "Réponse reçue",
      review: "À vérifier",
      completed: "Terminée",
      failed: "Échec",
      cancelled: "Annulée",
    }[status] ?? status
  );
}

function SourceRefreshStatus({
  response,
  requestId,
  loading,
  error,
}: {
  response: AdminSourceRefreshResponse | undefined;
  requestId: string | null;
  loading: boolean;
  error: unknown;
}) {
  if (loading) {
    return <p className="mt-2 text-xs text-sky-950/65">Recherche du dernier statut…</p>;
  }
  if (error) {
    return (
      <p className="mt-2 text-xs text-amber-900">
        Le statut du refresh n’est pas disponible pour le moment. La demande reste protégée par la
        file serveur.
      </p>
    );
  }
  const request = requestId
    ? (response?.history.find((item) => item.id === requestId) ??
      (response?.request?.id === requestId ? response.request : null))
    : response?.request;
  if (!request) {
    return <p className="mt-2 text-xs text-sky-950/65">Aucun refresh récent pour cette annonce.</p>;
  }
  const detail = request.errorMessage ? ` · ${request.errorMessage}` : "";
  return (
    <p className="mt-2 text-xs text-sky-950/75">
      Dernier refresh : <strong>{sourceRefreshStatusLabel(request.status)}</strong>
      {request.completedAt ? ` · terminé le ${formatDateTime(request.completedAt)}` : ""}
      {detail}
    </p>
  );
}

function sourceRefreshStatusLabel(status: string): string {
  return (
    {
      queued: "en file",
      running: "en cours",
      completed: "terminé, données disponibles",
      failed: "en échec",
      cancelled: "annulé",
    }[status] ?? status
  );
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

function showError(error: unknown) {
  toast.error(error instanceof Error ? error.message : "Action impossible");
}
