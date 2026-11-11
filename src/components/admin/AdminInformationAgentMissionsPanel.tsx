"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Bot from "lucide-react/dist/esm/icons/bot.js";
import Copy from "lucide-react/dist/esm/icons/copy.js";
import MailCheck from "lucide-react/dist/esm/icons/mail-check.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import type { InformationRequestSelection } from "@/components/admin/AdminCatalogueReadinessPanel";
import { AdminInformationAgentPreviewPanel as PreviewPanel } from "@/components/admin/AdminInformationAgentPreviewPanel";
import {
  missionsQuery as missionsQueryOptions,
  MISSIONS_QUERY_KEY as QUERY_KEY,
} from "@/components/admin/information-agent-queries";
import {
  isMissionEditable,
  missionStatusLabel,
} from "@/components/admin/information-agent-missions-ui";
import { ADMIN_PAGE_MAX_LIMIT } from "@/lib/admin-pagination";
import {
  createAdminInformationAgentMission,
  fetchAdminInformationAgentMissions,
  fetchAdminSourceRefreshStatus,
  previewAdminInformationAgentMission,
  requestAdminSourceRefresh,
  runAdminInformationAgentMissionAction,
} from "@/lib/client-api";
import type { AdminSourceRefreshResponse } from "@/lib/admin-source-refresh";
import { isValidInformationAgentEmail } from "@/lib/information-agent/email-address";
import type {
  InformationAgentMission,
  InformationAgentPreviewResponse,
} from "@/lib/information-agent";
import type { InformationAgentInventoryItem } from "@/lib/information-agent-inventory";
import {
  INFORMATION_AGENT_QUESTIONS,
  type InformationAgentQuestionKey,
} from "@/lib/information-agent-questions";
import { formatAdminDateTime as formatDateTime } from "@/lib/admin-date-format";

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

/** Demande d'ouverture d'une mission depuis la liste des envois ; `nonce` distingue deux demandes. */
export type OpenMissionRequest = { mission: InformationAgentMission; nonce: number };

/**
 * Éditeur de l'onglet « À contacter » : préparation du brouillon, relecture, aperçu et envoi. Le
 * composant reste monté quand on change d'onglet (l'espace de travail le masque) : le brouillon en
 * cours d'édition n'est jamais perdu. `active` suspend les requêtes périodiques tant qu'il est masqué.
 */
export function AdminInformationAgentMissionsPanel({
  selection,
  onClose,
  openRequest = null,
  active = true,
}: {
  selection: InformationRequestSelection | null;
  onClose: () => void;
  openRequest?: OpenMissionRequest | null;
  active?: boolean;
}) {
  const queryClient = useQueryClient();
  // Première page seulement : elle sert à retrouver un brouillon existant de la vente ; la liste
  // paginée des envois a sa propre requête (même clé à la page 0, donc une seule réponse partagée).
  const missionsQuery = useQuery(missionsQueryOptions(0));
  const sourceRefreshQuery = useQuery({
    queryKey: [...SOURCE_REFRESH_QUERY_KEY, selection?.saleId],
    queryFn: () => fetchAdminSourceRefreshStatus(selection!.saleId),
    enabled: Boolean(selection?.saleId) && active,
    staleTime: 3_000,
    refetchInterval: (query) => {
      const status = query.state.data?.request?.status;
      return active && (status === "queued" || status === "running") ? 5_000 : false;
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
              // « Préparer » rend l'aperçu exact avec le brouillon : l'administrateur relit tout de suite.
              setShownPreview(
                response.preview
                  ? { key: previewKeyOf(response.mission), response: response.preview }
                  : null,
              );
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
  // Relecture confirmée : valable pour cet aperçu seulement (tout changement la retire).
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
  const sendConfirmed = Boolean(previewKey) && confirmedKey === previewKey;
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
    : !isValidInformationAgentEmail(recipientEmail)
      ? "Renseignez une adresse email valide pour activer l’envoi."
      : subject.trim().length < 3 || bodyText.trim().length < 20
        ? "Renseignez un objet et un message (20 caractères au moins) pour activer l’envoi."
        : !shownPreview
          ? "Affichez l’aperçu pour activer l’envoi."
          : !previewIsCurrent
            ? "Le message a changé depuis l’aperçu : actualisez l’aperçu pour activer l’envoi."
            : !previewAllowsSend
              ? "L’aperçu signale un blocage : l’envoi reste bloqué tant qu’un contrôle échoue."
              : !sendConfirmed
                ? "Cochez la confirmation de relecture pour activer l’envoi."
                : null;

  /**
   * Recrée le brouillon de la mission ouverte (le serveur annule l'ancien pour cette vente et cette adresse).
   * Toujours disponible sur un brouillon modifiable : c'est le seul chemin pour un brouillon créé avant que
   * le serveur n'enregistre son destinataire, que l'aperçu refuse en demandant de le régénérer.
   */
  const regenerateDraft = () => {
    const opened = activeMissionRef.current;
    if (!opened?.saleId) return;
    const queued = selectionRef.current;
    if (queued && queued.saleId === opened.saleId) {
      prepareDraft(queued, { recipientEmail, recipientName, force: true });
      return;
    }
    // Mission ouverte depuis la liste des envois : aucune sélection de la file ne la porte.
    void createDraftAsync({
      saleId: opened.saleId,
      recipientEmail: recipientEmail.trim() || undefined,
      recipientName: recipientName.trim() || undefined,
    })
      .then((response) => {
        if (!response?.mission) throw new Error("Le brouillon reçu est incomplet.");
        void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
        // L'administrateur a pu ouvrir une autre mission pendant la régénération : on ne l'écrase pas.
        if (activeMissionRef.current?.id !== opened.id) return;
        hydrateMission(response.mission);
        setShownPreview(
          response.preview
            ? { key: previewKeyOf(response.mission), response: response.preview }
            : null,
        );
        toast.success("Brouillon régénéré. Aucun email n’a encore été envoyé.");
      })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "Brouillon indisponible.");
      });
  };

  // Ouverture demandée depuis la liste des envois (autre onglet). Une préparation automatique de la
  // file encore en cours ne doit jamais écraser la mission choisie dans l'historique.
  const handledOpenNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!openRequest || handledOpenNonceRef.current === openRequest.nonce) return;
    handledOpenNonceRef.current = openRequest.nonce;
    selectionRef.current = null;
    setDraftError(null);
    hydrateMission(openRequest.mission);
    // Le formulaire était masqué ou hors écran : sans ce déplacement, l'ouverture ne se voit pas.
    composerSectionRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    composerHeadingRef.current?.focus({ preventScroll: true });
  }, [openRequest, hydrateMission]);
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
                !isValidInformationAgentEmail(recipientEmail) ||
                (recipientEmail.trim().length > 0 && !isValidInformationAgentEmail(recipientEmail))
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
                {activeMission.status === "failed" && activeMission.sendOutcome !== "unverified"
                  ? "Motif de l’échec"
                  : "À vérifier"}{" "}
                :
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
            {activeMission.recipientProfile &&
            normalizeEmail(recipientEmail) === normalizeEmail(activeMission.recipientEmail) ? (
              <p className="text-xs leading-5 text-brand-navy/70" data-testid="recipient-profile">
                <span className="font-semibold">{activeMission.recipientProfile.roleLabel}</span>
                {" · "}
                {activeMission.recipientProfile.originLabel}
                {activeMission.recipientProfile.originSourceName
                  ? ` (${activeMission.recipientProfile.originSourceName})`
                  : ""}
                {activeMission.recipientProfile.originUrl ? (
                  <>
                    {" "}
                    <a
                      href={activeMission.recipientProfile.originUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="underline underline-offset-2"
                    >
                      voir l’annonce
                    </a>
                  </>
                ) : null}
                {" · "}
                {activeMission.recipientProfile.addressKindLabel}
              </p>
            ) : null}
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
                  !isValidInformationAgentEmail(recipientEmail) ||
                  subject.trim().length < 3 ||
                  bodyText.trim().length < 20
                }
                originField={
                  <Field
                    id={ORIGIN_FIELD_ID}
                    label="Page publique où figure l’adresse (si elle ne vient pas de l’annonce)"
                    value={recipientOriginUrl}
                    onChange={handleOriginChange}
                    type="url"
                  />
                }
              />
            ) : null}
            {selection ? (
              <div className="rounded-lg border border-sky-200 bg-sky-50/70 p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-sky-950">
                      Actualiser la source (facultatif)
                    </p>
                    <p className="mt-1 max-w-2xl text-xs leading-5 text-sky-950/70">
                      Facultatif, et sans rapport avec l’origine de l’adresse du destinataire. Cela
                      relit l’annonce pour mettre la fiche à jour ; le brouillon ne change que si
                      vous le régénérez.
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
                {activeMission.saleId ? (
                  <button
                    type="button"
                    className="admin-button-secondary inline-flex items-center gap-2"
                    disabled={createDraft.isPending}
                    onClick={regenerateDraft}
                  >
                    <RefreshCw className="size-3.5" />
                    {createDraft.isPending ? "Régénération…" : "Régénérer le brouillon"}
                  </button>
                ) : null}
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
                <label className="flex w-full items-start gap-2 rounded-lg border bg-warning-tint p-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={sendConfirmed}
                    disabled={!previewAllowsSend || runAction.isPending}
                    onChange={(event) => setConfirmedKey(event.target.checked ? previewKey : null)}
                  />
                  <span>
                    J’ai relu le message exact affiché dans l’aperçu et je confirme son envoi à{" "}
                    {recipientEmail.trim() || "ce destinataire"}.
                  </span>
                </label>
                <button
                  type="button"
                  className="admin-button-primary inline-flex items-center gap-2"
                  aria-describedby={sendDisabledReason ? "send-disabled-reason" : undefined}
                  disabled={
                    runAction.isPending ||
                    !previewAllowsSend ||
                    !sendConfirmed ||
                    !isValidInformationAgentEmail(recipientEmail) ||
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
    </section>
  );
}

const ORIGIN_FIELD_ID = "information-agent-origin-url";

function Field({
  id,
  label,
  value,
  onChange,
  type = "text",
  required = false,
  readOnly = false,
}: {
  id?: string;
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
        id={id}
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

/** Clé de l'aperçu d'un brouillon non modifié (même formule que `previewKey` du composant). */
function previewKeyOf(mission: InformationAgentMission): string {
  return JSON.stringify([
    mission.id,
    normalizeEmail(mission.recipientEmail),
    (mission.recipientName ?? "").trim(),
    mission.subject.trim(),
    mission.bodyText.trim(),
    "",
  ]);
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

const STALE_DRAFT_DAYS = 3;

function isStaleDraft(createdAt: string, now = Date.now()): boolean {
  const created = Date.parse(createdAt);
  return Number.isFinite(created) && now - created > STALE_DRAFT_DAYS * 24 * 60 * 60 * 1000;
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

function showError(error: unknown) {
  toast.error(error instanceof Error ? error.message : "Action impossible");
}
