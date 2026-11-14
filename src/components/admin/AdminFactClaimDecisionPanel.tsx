"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.js";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { queryErrorMessage } from "@/components/admin/admin-format";
import { formatShortDateTime } from "@/lib/format/dates";
import { AdminPagination } from "@/components/admin/AdminPagination";
import { AdminPill, type AdminPillTone } from "@/components/admin/admin-pill";
import { factFieldLabel, formatFactValue } from "@/components/admin/fact-claim-format";
import type {
  AdminFactClaimDecisionInput,
  AdminFactClaimDecisionItem,
  AdminFactClaimDecisionResult,
} from "@/lib/admin-fact-claim-decisions";
import { ADMIN_PAGE_SIZE, adminClampOffset } from "@/lib/admin-pagination";
import { decideAdminFactClaimClient, fetchAdminFactClaimDecisions } from "@/lib/client-api";
import {
  FACT_CLAIM_DECISIONS_SALE_PARAM,
  FACT_CLAIM_DECISIONS_SECTION_ID,
  FACT_CLAIM_LOT_ATTACHMENTS,
  FACT_CLAIM_REJECT_REASONS,
  FACT_CLAIM_RESERVED_EVIDENCE_KINDS,
  FACT_CLAIM_WITHDRAW_REASONS,
  factClaimLotAttachmentHolds,
  isFinalFactClaimAction,
  isFinalFactClaimDecision,
  type FactClaimDecisionAction,
  type FactClaimLotAttachment,
  type FactClaimRejectReason,
  type FactClaimWithdrawReason,
} from "@/lib/fact-claim-decisions";
import { toast } from "@/lib/toast";
import { UUID_SOURCE } from "@/lib/uuid";

const QUERY_KEY = ["admin-fact-claim-decisions"] as const;
const UUID_IN_TEXT = new RegExp(UUID_SOURCE, "i");

const ACTION_LABELS: Record<FactClaimDecisionAction, string> = {
  accept: "Accepter (peut mettre à jour la fiche)",
  reject: "Rejeter l’observation",
  withdraw: "Retirer de la fiche",
  oppose: "Enregistrer une opposition",
};

const ORIGIN_LABELS: Record<string, string> = {
  ...FACT_CLAIM_RESERVED_EVIDENCE_KINDS,
  source_listing: "Annonce",
  source_document: "Document de la vente",
  source_record: "Fiche de la source",
  email_attachment: "Pièce jointe d’un e-mail",
  portal_upload: "Dépôt sur le portail",
  manual_review: "Relecture manuelle",
  agent_research: "Recherche de l’agent",
};

const OCCUPANCY_LABELS: Record<string, string> = {
  vacant: "Libre",
  occupied: "Occupé",
  rented: "Loué",
};

type Draft = {
  claimId: string;
  action: FactClaimDecisionAction;
  lotAttachment: FactClaimLotAttachment | "";
  lotRef: string;
  reasonCode: string;
  /** Case « j’ai compris que c’est définitif », exigée pour une décision sans annulation. */
  finalConfirmed: boolean;
};

type Outcome = { kind: "success" | "error"; message: string };

export function AdminFactClaimDecisionPanel() {
  const queryClient = useQueryClient();
  const [saleInput, setSaleInput] = useState("");
  const [saleInputError, setSaleInputError] = useState<string | null>(null);
  const [saleId, setSaleId] = useState<string | undefined>();
  const [offset, setOffset] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const saleFieldId = useId();

  const query = useQuery({
    queryKey: [...QUERY_KEY, saleId ?? null, offset],
    queryFn: () => fetchAdminFactClaimDecisions({ saleId, offset, limit: ADMIN_PAGE_SIZE }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  useEffect(() => {
    const data = query.data;
    if (data && data.items.length === 0 && data.offset > 0) {
      setOffset(adminClampOffset(data.offset, data.limit, data.total));
    }
  }, [query.data]);
  // Lien « Observations à décider » d'une vente (`factClaimDecisionsHref`) : la vente est lue dans l'adresse.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get(
      FACT_CLAIM_DECISIONS_SALE_PARAM,
    );
    const match = requested ? UUID_IN_TEXT.exec(requested) : null;
    if (!match) return;
    setSaleInput(match[0]);
    setSaleId(match[0].toLowerCase());
    document.getElementById(FACT_CLAIM_DECISIONS_SECTION_ID)?.scrollIntoView?.({ block: "start" });
  }, []);

  const decide = useMutation({
    mutationFn: decideAdminFactClaimClient,
    onSuccess: (response, input) => {
      const message = successMessage(input, response);
      setDraft(null);
      setOutcome({ kind: "success", message });
      toast.success(message);
    },
    onError: (error) => {
      const message = queryErrorMessage(error, "La décision n’a pas pu être enregistrée.");
      // Après un refus, la confirmation d’une décision définitive est à redonner.
      setDraft((current) => (current ? { ...current, finalConfirmed: false } : current));
      setOutcome({ kind: "error", message });
      toast.error(message);
    },
    // Réussite ou échec, l’état affiché est relu sur le serveur : un refus signale souvent que
    // l’observation a changé entre-temps.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  const submitSaleFilter = (event: FormEvent) => {
    event.preventDefault();
    const text = saleInput.trim();
    const match = UUID_IN_TEXT.exec(text);
    if (text && !match) {
      setSaleInputError("Identifiant de vente non reconnu. Collez l’adresse de la fiche.");
      return;
    }
    setSaleInputError(null);
    setOffset(0);
    setDraft(null);
    setSaleId(match?.[0].toLowerCase());
  };

  const items = query.data?.items ?? [];

  return (
    <section
      id={FACT_CLAIM_DECISIONS_SECTION_ID}
      className="overflow-hidden rounded-xl border bg-white"
      aria-labelledby="fact-decision-title"
    >
      <div className="border-b px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-gold-text">
              <Scale className="size-4" aria-hidden="true" />
              Registre des pièces
            </div>
            <h2 id="fact-decision-title" className="mt-2 font-semibold">
              Observations à décider, qui peuvent modifier la fiche
            </h2>
            <p className="mt-1 max-w-3xl text-sm text-brand-navy/60">
              Une observation acceptée peut remplacer la valeur affichée sur la fiche, si elle
              l’emporte et qu’elle est rattachée au lot ; le résultat s’affiche après
              l’enregistrement. Une opposition ou un retrait d’autorisation sont définitifs.
            </p>
          </div>
          <button
            type="button"
            className="admin-button-secondary inline-flex items-center gap-2"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw
              className={`size-4 ${query.isFetching ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            Actualiser les observations
          </button>
        </div>
        <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={submitSaleFilter}>
          <div className="min-w-0 flex-1 basis-64">
            <label htmlFor={saleFieldId} className="block text-xs font-medium text-brand-navy/75">
              Vente (identifiant ou adresse de la fiche)
            </label>
            <input
              id={saleFieldId}
              value={saleInput}
              onChange={(event) => setSaleInput(event.target.value)}
              className="mt-1 min-h-11 w-full rounded-lg border bg-white px-3 py-2 text-sm"
              autoComplete="off"
              aria-invalid={saleInputError ? true : undefined}
              aria-describedby={saleInputError ? `${saleFieldId}-error` : undefined}
            />
          </div>
          <button type="submit" className="admin-button-secondary">
            {saleInput.trim() ? "Afficher cette vente" : "Afficher toutes les ventes"}
          </button>
        </form>
        {saleInputError ? (
          <p id={`${saleFieldId}-error`} role="alert" className="mt-2 text-sm text-danger">
            {saleInputError}
          </p>
        ) : null}
        <p className="mt-2 text-xs text-brand-navy/60">
          {saleId
            ? "Toutes les observations de cette vente."
            : "Sans vente choisie : les réponses de professionnels et les saisies d’administrateur."}
        </p>
      </div>

      {outcome ? (
        <p
          role={outcome.kind === "error" ? "alert" : "status"}
          className={`border-b px-5 py-3 text-sm ${
            outcome.kind === "error" ? "bg-danger-tint text-danger" : "bg-success-tint text-success"
          }`}
        >
          {outcome.message}
        </p>
      ) : null}

      {query.isPending ? (
        <p role="status" className="p-5 text-sm text-brand-navy/55">
          Chargement des observations…
        </p>
      ) : query.error ? (
        <div className="p-5">
          <p role="alert" className="text-sm text-danger">
            {queryErrorMessage(query.error, "La liste des observations est indisponible.")}
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
            <DecisionLine
              key={item.claimId}
              item={item}
              draft={draft?.claimId === item.claimId ? draft : null}
              pending={decide.isPending}
              onStart={(action) => {
                setOutcome(null);
                setDraft({
                  claimId: item.claimId,
                  action,
                  lotAttachment: "",
                  lotRef: "",
                  reasonCode: "",
                  finalConfirmed: false,
                });
              }}
              onChange={(patch) =>
                setDraft((current) => (current ? { ...current, ...patch } : current))
              }
              onCancel={() => setDraft(null)}
              onSubmit={(input) => decide.mutate(input)}
            />
          ))}
          <AdminPagination
            label="observations à décider"
            offset={query.data?.offset ?? 0}
            limit={query.data?.limit ?? ADMIN_PAGE_SIZE}
            total={query.data?.total ?? 0}
            shown={items.length}
            busy={query.isFetching}
            onOffsetChange={setOffset}
          />
        </div>
      ) : (
        <p className="p-5 text-sm text-brand-navy/60">
          {saleId
            ? "Aucune observation pour cette vente."
            : "Aucune observation de professionnel ou d’administrateur à décider."}
        </p>
      )}
    </section>
  );
}

function DecisionLine({
  item,
  draft,
  pending,
  onStart,
  onChange,
  onCancel,
  onSubmit,
}: {
  item: AdminFactClaimDecisionItem;
  draft: Draft | null;
  pending: boolean;
  onStart: (action: FactClaimDecisionAction) => void;
  onChange: (patch: Partial<Draft>) => void;
  onCancel: () => void;
  onSubmit: (input: AdminFactClaimDecisionInput) => void;
}) {
  const titleId = useId();
  const articleRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const hadDraft = useRef(false);
  // Le formulaire se ferme (annulation, réussite) : le bouton qui portait le focus disparaît. Le
  // focus revient au titre de l’observation, sauf si l’administrateur est déjà parti ailleurs.
  useEffect(() => {
    const closed = hadDraft.current && !draft;
    hadDraft.current = draft != null;
    if (!closed) return;
    const active = document.activeElement;
    if (!active || active === document.body || articleRef.current?.contains(active)) {
      titleRef.current?.focus();
    }
  }, [draft]);
  const state = decisionState(item.latestDecision);
  return (
    <article ref={articleRef} className="p-5" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-center gap-2">
        <AdminPill tone={state.tone}>{state.label}</AdminPill>
        {item.latestDecision ? (
          <span className="text-xs text-brand-navy/55">
            Décision du {formatShortDateTime(item.latestDecision.decidedAt)}
          </span>
        ) : null}
      </div>
      <h3 id={titleId} ref={titleRef} tabIndex={-1} className="mt-2 font-semibold outline-none">
        {factFieldLabel(item.fieldKey)}
        <span className="font-normal text-brand-navy/60">
          {" · "}
          {item.sale.title || item.sale.city || "Vente sans titre"}
        </span>
      </h3>
      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-brand-navy/55">
        {item.sale.city ? <span>{item.sale.city}</span> : null}
        {item.sale.saleDate ? (
          <span>Vente du {formatShortDateTime(item.sale.saleDate)}</span>
        ) : null}
        <Link
          href={`/sales/${item.saleId}`}
          className="inline-flex min-h-6 items-center font-medium text-gold-text underline"
        >
          Voir la fiche
        </Link>
      </p>
      <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
        <div className="rounded-lg border bg-warning-tint p-3">
          <dt className="text-xs font-medium text-brand-navy/60">Valeur proposée</dt>
          <dd className="mt-1 break-words font-semibold text-warning">
            {displayValue(item.fieldKey, item.value)}
          </dd>
        </div>
        <div className="rounded-lg border bg-surface-muted p-3">
          <dt className="text-xs font-medium text-brand-navy/60">Valeur affichée aujourd’hui</dt>
          <dd className="mt-1 break-words font-semibold text-brand-navy">
            {displayValue(item.fieldKey, item.currentValue)}
          </dd>
        </div>
      </dl>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed p-3 text-xs text-brand-navy/65">
        <span className="font-medium text-brand-navy">
          Origine : {ORIGIN_LABELS[item.origin] ?? "Autre origine"}
        </span>
        {item.sourceUrl ? (
          <a
            href={item.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-6 items-center gap-1 font-medium text-gold-text underline"
          >
            Ouvrir la source <ExternalLink className="size-3" aria-hidden="true" />
            <span className="sr-only">(nouvel onglet)</span>
          </a>
        ) : (
          <span>Pièce sans lien public</span>
        )}
        <span>Reçue le {formatShortDateTime(item.capturedAt)}</span>
      </div>

      {item.allowedActions.length ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {item.allowedActions.map((action) => (
            <button
              key={action}
              type="button"
              className={action === "accept" ? "admin-button-primary" : "admin-button-secondary"}
              disabled={pending}
              aria-describedby={titleId}
              aria-expanded={draft?.action === action}
              onClick={() => onStart(action)}
            >
              {ACTION_LABELS[action]}
            </button>
          ))}
        </div>
      ) : (
        <p className="mt-4 text-sm text-brand-navy/70">
          {isFinalFactClaimDecision(item.latestDecision)
            ? "Aucune action possible : cette décision est définitive."
            : "Aucune action proposée pour cet état."}
        </p>
      )}

      {draft ? (
        <DecisionForm
          item={item}
          draft={draft}
          pending={pending}
          onChange={onChange}
          onCancel={onCancel}
          onSubmit={onSubmit}
        />
      ) : null}
    </article>
  );
}

function DecisionForm({
  item,
  draft,
  pending,
  onChange,
  onCancel,
  onSubmit,
}: {
  item: AdminFactClaimDecisionItem;
  draft: Draft;
  pending: boolean;
  onChange: (patch: Partial<Draft>) => void;
  onCancel: () => void;
  onSubmit: (input: AdminFactClaimDecisionInput) => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const fieldId = useId();
  // Le formulaire s’ouvre sous les boutons : le focus y est porté pour le clavier et les lecteurs d’écran.
  useEffect(() => headingRef.current?.focus(), [draft.action]);

  const isFinal = isFinalFactClaimAction(draft.action, draft.reasonCode);
  const input = decisionInput(item, draft);
  const ready = input != null && (!isFinal || draft.finalConfirmed);

  return (
    <form
      className="mt-4 rounded-lg bg-surface-muted p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !pending) onSubmit(input);
      }}
    >
      <h4 ref={headingRef} tabIndex={-1} className="text-sm font-semibold outline-none">
        {FORM_TITLES[draft.action]}
      </h4>

      {draft.action === "accept" ? (
        <>
          <label htmlFor={`${fieldId}-lot`} className="mt-3 block text-xs font-medium">
            Rattachement au lot (obligatoire)
          </label>
          <select
            id={`${fieldId}-lot`}
            required
            value={draft.lotAttachment}
            onChange={(event) =>
              onChange({ lotAttachment: event.target.value as Draft["lotAttachment"] })
            }
            className="mt-1 min-h-11 w-full rounded-lg border bg-white px-3 py-2 text-sm sm:max-w-md"
          >
            <option value="">Choisir…</option>
            {Object.entries(FACT_CLAIM_LOT_ATTACHMENTS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {draft.lotAttachment === "matched" ? (
            <>
              <label htmlFor={`${fieldId}-ref`} className="mt-3 block text-xs font-medium">
                Lot cité par la pièce (facultatif, par exemple « lot 2 »)
              </label>
              <input
                id={`${fieldId}-ref`}
                value={draft.lotRef}
                maxLength={40}
                onChange={(event) => onChange({ lotRef: event.target.value })}
                className="mt-1 min-h-11 w-full rounded-lg border bg-white px-3 py-2 text-sm sm:max-w-md"
                autoComplete="off"
              />
            </>
          ) : null}
          {draft.lotAttachment ? (
            <p className="mt-2 text-xs text-brand-navy/70">
              {factClaimLotAttachmentHolds(draft.lotAttachment)
                ? "Si cette observation l’emporte, sa valeur remplacera celle de la fiche. Le résultat s’affiche après l’enregistrement."
                : "La décision sera enregistrée, mais la valeur ne sera pas affichée sur la fiche."}
            </p>
          ) : null}
        </>
      ) : null}

      {draft.action === "reject" || draft.action === "withdraw" ? (
        <>
          <label htmlFor={`${fieldId}-reason`} className="mt-3 block text-xs font-medium">
            Motif (obligatoire)
          </label>
          <select
            id={`${fieldId}-reason`}
            required
            value={draft.reasonCode}
            onChange={(event) =>
              onChange({ reasonCode: event.target.value, finalConfirmed: false })
            }
            className="mt-1 min-h-11 w-full rounded-lg border bg-white px-3 py-2 text-sm sm:max-w-md"
          >
            <option value="">Choisir…</option>
            {Object.entries(
              draft.action === "reject" ? FACT_CLAIM_REJECT_REASONS : FACT_CLAIM_WITHDRAW_REASONS,
            ).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </>
      ) : null}

      {isFinal ? (
        <div className="mt-3 rounded-lg border border-danger/30 bg-danger-tint p-3 text-sm text-danger">
          <p className="flex items-start gap-2 font-medium">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {draft.action === "oppose"
              ? "Une opposition est définitive. Cette observation ne pourra plus jamais être acceptée, et la décision ne peut pas être annulée."
              : "Un retrait d’autorisation est définitif. Cette observation ne pourra plus jamais être acceptée, et la décision ne peut pas être annulée."}
          </p>
          <label className="mt-3 flex min-h-11 items-center gap-3">
            <input
              type="checkbox"
              className="size-5 shrink-0"
              checked={draft.finalConfirmed}
              onChange={(event) => onChange({ finalConfirmed: event.target.checked })}
            />
            <span>J’ai compris que cette décision est définitive.</span>
          </label>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="submit" className="admin-button-primary" disabled={!ready || pending}>
          {pending ? "Enregistrement…" : submitLabel(draft.action, isFinal)}
        </button>
        <button type="button" className="admin-button-secondary" onClick={onCancel}>
          Annuler
        </button>
      </div>
    </form>
  );
}

const FORM_TITLES: Record<FactClaimDecisionAction, string> = {
  accept: "Accepter cette observation",
  reject: "Rejeter cette observation",
  withdraw: "Retirer cette observation de la fiche",
  oppose: "Enregistrer l’opposition d’un professionnel",
};

function submitLabel(action: FactClaimDecisionAction, isFinal: boolean): string {
  switch (action) {
    case "accept":
      return "Confirmer l’acceptation";
    case "reject":
      return "Confirmer le rejet";
    case "withdraw":
      return isFinal ? "Confirmer le retrait définitif" : "Confirmer le retrait";
    case "oppose":
      return "Confirmer l’opposition définitive";
  }
}

/** La demande à envoyer, ou null tant qu’un champ obligatoire manque. */
function decisionInput(
  item: AdminFactClaimDecisionItem,
  draft: Draft,
): AdminFactClaimDecisionInput | null {
  const claimId = item.claimId;
  switch (draft.action) {
    case "accept": {
      if (!draft.lotAttachment) return null;
      const lotRef = draft.lotAttachment === "matched" ? draft.lotRef.trim() : "";
      return {
        action: "accept",
        claimId,
        lotAttachment: draft.lotAttachment,
        ...(lotRef ? { lotRef } : {}),
        // La décision vue à l’écran : si une autre l’a suivie, la base refuse (« déjà traitée »).
        ...(item.latestDecision ? { supersedesDecisionId: item.latestDecision.id } : {}),
      };
    }
    case "reject":
      return draft.reasonCode in FACT_CLAIM_REJECT_REASONS
        ? { action: "reject", claimId, reasonCode: draft.reasonCode as FactClaimRejectReason }
        : null;
    case "withdraw":
      return draft.reasonCode in FACT_CLAIM_WITHDRAW_REASONS
        ? { action: "withdraw", claimId, reasonCode: draft.reasonCode as FactClaimWithdrawReason }
        : null;
    case "oppose":
      return { action: "oppose", claimId };
  }
}

function successMessage(
  input: AdminFactClaimDecisionInput,
  response: AdminFactClaimDecisionResult,
): string {
  switch (input.action) {
    case "accept":
      return response.result.state === "held"
        ? "Observation acceptée. Sa valeur est maintenant affichée sur la fiche."
        : "Observation acceptée et enregistrée. Sa valeur n’est pas affichée sur la fiche.";
    case "reject":
      return "Observation rejetée.";
    case "withdraw":
      return isFinalFactClaimAction(input.action, input.reasonCode)
        ? "Autorisation retirée. Cette décision est définitive."
        : "Observation retirée de la fiche.";
    case "oppose":
      return "Opposition enregistrée. Cette décision est définitive.";
  }
}

function decisionState(latest: AdminFactClaimDecisionItem["latestDecision"]): {
  label: string;
  tone: AdminPillTone;
} {
  if (!latest) return { label: "À décider", tone: "warning" };
  if (isFinalFactClaimDecision(latest)) {
    return {
      label:
        latest.decision === "opposed"
          ? "Dernière décision : opposition (définitif)"
          : "Dernière décision : autorisation retirée (définitif)",
      tone: "danger",
    };
  }
  switch (latest.decision) {
    case "accepted":
      return {
        label: factClaimLotAttachmentHolds(latest.lotAttachment as FactClaimLotAttachment)
          ? "Dernière décision : acceptée"
          : "Dernière décision : acceptée, sans affichage",
        tone: "success",
      };
    case "rejected":
      return { label: "Dernière décision : rejetée", tone: "neutral" };
    case "withdrawn":
      return { label: "Dernière décision : retirée", tone: "neutral" };
    case "contradicted":
      return { label: "Dernière décision : contredite par une autre source", tone: "danger" };
    default:
      return { label: "État inconnu", tone: "neutral" };
  }
}

function displayValue(fieldKey: string, value: unknown): string {
  // Absente de la réponse : le champ n’a pas de colonne connue, la fiche n’a pas été lue.
  if (value === undefined) return "Non comparée ici";
  if (value === null || value === "") return "Non renseignée";
  if (fieldKey === "property.occupancy_status" && typeof value === "string") {
    return OCCUPANCY_LABELS[value] ?? value;
  }
  return formatFactValue(value);
}
