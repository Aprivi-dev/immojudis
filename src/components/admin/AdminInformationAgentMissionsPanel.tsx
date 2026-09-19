"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Bot from "lucide-react/dist/esm/icons/bot.js";
import MailCheck from "lucide-react/dist/esm/icons/mail-check.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { InformationRequestSelection } from "@/components/admin/AdminCatalogueReadinessPanel";
import {
  createAdminInformationAgentMission,
  fetchAdminInformationAgentMissions,
  runAdminInformationAgentMissionAction,
} from "@/lib/client-api";
import type { InformationAgentMission } from "@/lib/information-agent";

const QUERY_KEY = ["admin-information-agent-missions"] as const;

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
  const [recipientName, setRecipientName] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [activeMission, setActiveMission] = useState<InformationAgentMission | null>(null);
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");

  useEffect(() => {
    if (!selection) return;
    setRecipientName(selection.recipientName ?? "");
    setRecipientEmail(extractEmail(selection.recipientContact) ?? "");
    setActiveMission(null);
    setSubject("");
    setBodyText("");
  }, [selection]);

  const createDraft = useMutation({
    mutationFn: createAdminInformationAgentMission,
    onSuccess: (response) => {
      setActiveMission(response.mission);
      setSubject(response.mission.subject);
      setBodyText(response.mission.bodyText);
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success("Brouillon généré. Aucun email n’a encore été envoyé.");
    },
    onError: showError,
  });
  const runAction = useMutation({
    mutationFn: runAdminInformationAgentMissionAction,
    onSuccess: (response) => {
      const updated = response.missions.find((mission) => mission.id === activeMission?.id);
      if (updated) setActiveMission(updated);
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success(updated?.status === "sent" ? "Demande envoyée." : "Mission mise à jour.");
    },
    onError: showError,
  });

  const resumeMission = (mission: InformationAgentMission) => {
    setActiveMission(mission);
    setRecipientName(mission.recipientName ?? "");
    setRecipientEmail(mission.recipientEmail);
    setSubject(mission.subject);
    setBodyText(mission.bodyText);
  };
  const closeComposer = () => {
    setActiveMission(null);
    setSubject("");
    setBodyText("");
    onClose();
  };

  return (
    <section className="overflow-hidden rounded-xl border bg-white">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-[#a36f2c]">
            <Bot className="size-4" />
            Enrichissement administré
          </div>
          <h2 className="mt-2 font-semibold">Demandes d’informations</h2>
          <p className="mt-1 text-sm text-[#132238]/60">
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
          <h3 className="font-semibold">Préparer la demande · {selection.title}</h3>
          <p className="mt-1 text-xs text-[#132238]/55">Annonce {selection.saleId}</p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <Field label="Nom du destinataire" value={recipientName} onChange={setRecipientName} />
            <Field
              label="Email du destinataire"
              value={recipientEmail}
              onChange={setRecipientEmail}
              type="email"
              required
            />
          </div>
          <button
            type="button"
            className="admin-button-primary mt-4"
            disabled={createDraft.isPending || !looksLikeEmail(recipientEmail)}
            onClick={() =>
              createDraft.mutate({
                saleId: selection.saleId,
                recipientEmail: recipientEmail.trim(),
                recipientName: recipientName.trim() || undefined,
              })
            }
          >
            {createDraft.isPending ? "Préparation…" : "Générer le brouillon"}
          </button>
        </div>
      ) : null}

      {activeMission ? (
        <div className="border-b bg-slate-50 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-semibold">Brouillon pour {activeMission.recipientEmail}</h3>
              <p className="mt-1 text-xs text-[#132238]/55">
                Statut : {missionStatusLabel(activeMission.status)} · annonce {activeMission.saleId}
              </p>
            </div>
            <span className="rounded-full border bg-white px-2.5 py-1 text-xs">
              {missionStatusLabel(activeMission.status)}
            </span>
          </div>
          <div className="mt-4 space-y-3">
            <Field label="Email" value={recipientEmail} onChange={setRecipientEmail} type="email" />
            <Field label="Objet" value={subject} onChange={setSubject} />
            <label className="block text-xs font-medium">
              Message
              <textarea
                value={bodyText}
                onChange={(event) => setBodyText(event.target.value)}
                rows={12}
                className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm leading-6"
              />
            </label>
          </div>
          {activeMission.status === "draft" || activeMission.status === "failed" ? (
            <div className="mt-4 flex flex-wrap gap-2">
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
                  if (!window.confirm("Confirmer l’envoi de cet email au professionnel ?")) return;
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
          <p className="mt-3 text-sm text-[#132238]/55">Chargement…</p>
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
                  <p className="mt-0.5 text-xs text-[#132238]/50">
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
          <p className="mt-3 text-sm text-[#132238]/55">Aucune mission.</p>
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
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email";
  required?: boolean;
}) {
  return (
    <label className="block text-xs font-medium">
      {label}
      <input
        type={type}
        required={required}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm"
      />
    </label>
  );
}

function extractEmail(value: string | null): string | null {
  return value?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;
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

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

function showError(error: unknown) {
  toast.error(error instanceof Error ? error.message : "Action impossible");
}
