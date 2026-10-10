"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Bot from "lucide-react/dist/esm/icons/bot.js";
import Copy from "lucide-react/dist/esm/icons/copy.js";
import MailCheck from "lucide-react/dist/esm/icons/mail-check.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { InformationRequestSelection } from "@/components/admin/AdminCatalogueReadinessPanel";
import {
  createAdminInformationAgentMission,
  fetchAdminInformationAgentMissions,
  fetchAdminSourceRefreshStatus,
  requestAdminSourceRefresh,
  runAdminInformationAgentMissionAction,
} from "@/lib/client-api";
import type { AdminSourceRefreshResponse } from "@/lib/admin-source-refresh";
import type { InformationAgentMission } from "@/lib/information-agent";

const QUERY_KEY = ["admin-information-agent-missions"] as const;
const SOURCE_REFRESH_QUERY_KEY = ["admin-information-agent-source-refresh"] as const;

type EditedMissionDraft = {
  recipientName: string;
  recipientEmail: string;
  subject: string;
  bodyText: string;
  recipientReviewNotice: boolean;
};

export function AdminInformationAgentMissionsPanel({
  selection,
  onClose,
}: {
  selection: InformationRequestSelection | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const missionsQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => fetchAdminInformationAgentMissions(),
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
  const [sourceRefreshCycleId, setSourceRefreshCycleId] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [recipientReviewNotice, setRecipientReviewNotice] = useState(false);
  const [preparingSelectionKey, setPreparingSelectionKey] = useState<string | null>(null);
  const selectionRef = useRef(selection);
  const activeMissionRef = useRef<InformationAgentMission | null>(null);
  const preparedDraftsRef = useRef(new Map<string, InformationAgentMission>());
  const preparingKeysRef = useRef(new Set<string>());
  const availableMissionsRef = useRef<InformationAgentMission[]>([]);
  const composerSectionRef = useRef<HTMLElement | null>(null);
  const composerHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const editedDraftsRef = useRef(new Map<string, EditedMissionDraft>());
  const createDraft = useMutation({ mutationFn: createAdminInformationAgentMission });
  const createDraftAsync = createDraft.mutateAsync;

  useEffect(() => {
    availableMissionsRef.current = missionsQuery.data?.missions ?? [];
  }, [missionsQuery.data?.missions]);

  const hydrateMission = useCallback((mission: InformationAgentMission) => {
    const edited = editedDraftsRef.current.get(mission.id);
    activeMissionRef.current = mission;
    setActiveMission(mission);
    setRecipientName(edited?.recipientName ?? mission.recipientName ?? "");
    setRecipientEmail(edited?.recipientEmail ?? mission.recipientEmail);
    setSubject(edited?.subject ?? mission.subject);
    setBodyText(edited?.bodyText ?? mission.bodyText);
    setRecipientReviewNotice(edited?.recipientReviewNotice ?? false);
  }, []);

  const rememberEdits = useCallback((patch: Partial<EditedMissionDraft>) => {
    const mission = activeMissionRef.current;
    if (!mission || !isMissionEditable(mission.status)) return;
    const previous = editedDraftsRef.current.get(mission.id) ?? {
      recipientName: mission.recipientName ?? "",
      recipientEmail: mission.recipientEmail,
      subject: mission.subject,
      bodyText: mission.bodyText,
      recipientReviewNotice: false,
    };
    editedDraftsRef.current.set(mission.id, { ...previous, ...patch });
  }, []);

  const prepareDraft = useCallback(
    (
      requestSelection: InformationRequestSelection,
      options: { recipientEmail?: string; recipientName?: string; force?: boolean } = {},
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

      if (!options.force) {
        const cached = preparedDraftsRef.current.get(requestKey);
        if (cached) {
          if (isCurrentSelection()) hydrateMission(cached);
          return;
        }
        const existingCandidates = availableMissionsRef.current.filter(
          (mission) =>
            mission.saleId === requestSelection.saleId &&
            isMissionEditable(mission.status) &&
            (!recipientEmail ||
              normalizeEmail(mission.recipientEmail) === normalizeEmail(recipientEmail)),
        );
        const existing = existingCandidates.length === 1 ? existingCandidates[0] : undefined;
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
      void createDraftAsync({
        saleId: requestSelection.saleId,
        ...(options.force || recipientEmail || recipientName
          ? {
              recipientEmail,
              recipientName,
            }
          : {}),
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
      toast.success(updated?.status === "sent" ? "Demande envoyée." : "Mission mise à jour.");
    },
    onError: showError,
  });

  const resumeMission = (mission: InformationAgentMission) => {
    // A pending automatic preparation for the queue must never overwrite a
    // mission selected from the history list.
    selectionRef.current = null;
    onClose();
    setDraftError(null);
    hydrateMission(mission);
  };
  const closeComposer = () => {
    selectionRef.current = null;
    activeMissionRef.current = null;
    setActiveMission(null);
    setDraftError(null);
    setPreparingSelectionKey(null);
    setSubject("");
    setBodyText("");
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
            Le brouillon est préparé automatiquement, puis modifié et envoyé uniquement sur
            validation admin.
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
                Statut : {missionStatusLabel(activeMission.status)} · annonce {activeMission.saleId}
              </p>
            </div>
            <span className="rounded-full border bg-white px-2.5 py-1 text-xs">
              {missionStatusLabel(activeMission.status)}
            </span>
          </div>
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
            <p className="text-xs text-brand-navy/65">
              Le mail envoyé ajoutera une adresse de réponse propre au dossier et un lien privé
              permettant de déposer une réponse, des liens ou des pièces sans compte.
            </p>
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
                disabled={
                  runAction.isPending ||
                  !looksLikeEmail(recipientEmail) ||
                  subject.trim().length < 3 ||
                  bodyText.trim().length < 20
                }
                onClick={() => {
                  if (
                    !window.confirm(
                      "Confirmer l’envoi de cet email au professionnel, avec une adresse de réponse et un lien privé de dépôt ?",
                    )
                  )
                    return;
                  runAction.mutate({
                    action: "approve_and_send",
                    missionId: activeMission.id,
                    approvalConfirmed: true,
                    recipientEmail: recipientEmail.trim(),
                    recipientName: recipientName.trim() || null,
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
                onClick={() => runAction.mutate({ action: "cancel", missionId: activeMission.id })}
              >
                Annuler la mission
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
            {missionsQuery.data.missions.slice(0, 12).map((mission) => (
              <div
                key={mission.id}
                className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{mission.recipientEmail}</p>
                  <p className="mt-0.5 text-xs text-brand-navy/50">
                    {missionStatusLabel(mission.status)} · {formatDateTime(mission.updatedAt)}
                  </p>
                </div>
                {mission.status === "draft" || mission.status === "failed" ? (
                  <button
                    type="button"
                    className="admin-button-secondary"
                    onClick={() => resumeMission(mission)}
                  >
                    Reprendre
                  </button>
                ) : null}
              </div>
            ))}
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
  type?: "text" | "email";
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
