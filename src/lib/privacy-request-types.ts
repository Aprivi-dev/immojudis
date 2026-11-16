/**
 * Types de demandes de droits et leurs libellés, partagés par le formulaire « Mes droits », le panneau
 * de conformité et les emails de suivi. Module pur, importable côté navigateur.
 */

export const PRIVACY_REQUEST_TYPES = [
  "access",
  "portability",
  "rectification",
  "erasure",
  "restriction",
  "objection",
  "consent_withdrawal",
  "contract_withdrawal",
] as const;

export type PrivacyRequestType = (typeof PRIVACY_REQUEST_TYPES)[number];

export const PRIVACY_REQUEST_TYPE_OPTIONS: ReadonlyArray<{
  value: PrivacyRequestType;
  label: string;
  detail: string;
}> = [
  {
    value: "access",
    label: "Accéder à mes données",
    detail: "Obtenir une copie et les informations associées.",
  },
  {
    value: "portability",
    label: "Portabilité",
    detail: "Recevoir les données fournies dans un format exploitable.",
  },
  {
    value: "rectification",
    label: "Rectification",
    detail: "Corriger une information inexacte ou incomplète.",
  },
  {
    value: "erasure",
    label: "Effacement / compte",
    detail: "Demander la suppression du compte et des données effaçables.",
  },
  {
    value: "restriction",
    label: "Limitation",
    detail: "Demander le gel temporaire d’un traitement contesté.",
  },
  {
    value: "objection",
    label: "Opposition",
    detail: "Contester un traitement fondé sur l’intérêt légitime.",
  },
  {
    value: "consent_withdrawal",
    label: "Retirer un consentement",
    detail: "Retirer un accord facultatif, notamment pour les alertes email.",
  },
  {
    value: "contract_withdrawal",
    label: "Rétractation d’une commande",
    detail: "Notifier une rétractation : abonnement Analyse ou achat d’une vente à l’unité.",
  },
];

export function privacyRequestTypeLabel(value: string): string {
  return PRIVACY_REQUEST_TYPE_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

/** `metadata.source` d'une demande déposée par un professionnel sans compte (lien signé de l'agent). */
export const PROFESSIONAL_PRIVACY_SOURCE = "information_agent_professional_link";

/**
 * `account` : titulaire d'un compte, ou ancien titulaire (compte effacé : `user_id` nul). Seule une demande
 * déposée par le lien signé d'un professionnel, sans compte, est `information_agent_professional`.
 */
export function privacyRequestSubjectKind(row: {
  user_id: string | null;
  metadata: unknown;
}): "account" | "information_agent_professional" {
  const metadata =
    row.metadata && typeof row.metadata === "object"
      ? (row.metadata as Record<string, unknown>)
      : null;
  return !row.user_id && metadata?.source === PROFESSIONAL_PRIVACY_SOURCE
    ? "information_agent_professional"
    : "account";
}

/**
 * Codes de clôture d'une demande d'effacement. Une demande `erasure` ne passe à « Traitée » que par
 * l'exécution (codes `ERASURE_EXECUTED_CODES`, posés par `executePrivacyErasure`), ou avec un code
 * explicite de clôture sans exécution (effacement sans objet, ou refusé).
 */
export const ERASURE_EXECUTED_CODES = [
  "erasure_executed",
  "information_agent_professional_erasure_executed",
] as const;
export const ERASURE_CLOSED_WITHOUT_EXECUTION_CODES = [
  "erasure_not_applicable",
  "erasure_refused",
] as const;
