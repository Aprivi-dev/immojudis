/**
 * Registre des pièces : vocabulaire des décisions d'un administrateur, partagé par la route, la
 * lecture serveur et l'écran. Module sans dépendance serveur.
 *
 * La base reste seule juge (`app_private.decide_auction_fact_claim`, migration
 * `20261118100100_fact_claim_decision_rpcs.sql`, et la contrainte
 * `auction_fact_claim_decisions_reason_code_check`). Ce module est la seule copie de ces listes
 * côté application : il sert à proposer les bons choix, pas à autoriser. Une liste modifiée en
 * base se modifie ici, et nulle part ailleurs.
 */

const FACT_CLAIM_DECISION_ACTIONS = ["accept", "reject", "withdraw", "oppose"] as const;
export type FactClaimDecisionAction = (typeof FACT_CLAIM_DECISION_ACTIONS)[number];

/** Motifs admis par la base pour un rejet, avec leur libellé. */
export const FACT_CLAIM_REJECT_REASONS = {
  already_known: "Information déjà connue",
  other_lot: "Concerne un autre lot",
  doubtful_statement: "Déclaration douteuse",
  implausible_value: "Valeur invraisemblable",
  other: "Autre motif",
} as const;

/** Motifs admis par la base pour un retrait, avec leur libellé. */
export const FACT_CLAIM_WITHDRAW_REASONS = {
  entry_error: "Erreur de saisie",
  other_lot: "Concerne un autre lot",
  replaced_by_source: "Remplacée par la source",
  authorization_withdrawn: "Autorisation d'affichage retirée (définitif)",
  other: "Autre motif",
} as const;

/** Rattachements au lot admis par la base pour une acceptation. Seuls les deux premiers affichent la valeur. */
export const FACT_CLAIM_LOT_ATTACHMENTS = {
  single_lot: "Vente à un seul lot",
  matched: "Lot identifié dans la pièce",
  unmatched: "Lot différent de celui de la fiche",
  unknown: "Lot inconnu",
} as const;

/**
 * Natures d'observation que le registre réserve (garde d'origine
 * `auction_fact_claims_registry_origin_guard`), avec leur libellé : ce sont elles que la file de
 * décision montre quand aucune vente n'est choisie.
 */
export const FACT_CLAIM_RESERVED_EVIDENCE_KINDS = {
  professional_email: "Réponse d’un professionnel par e-mail",
  professional_form: "Formulaire rempli par un professionnel",
  admin_entry: "Saisie d’un administrateur",
} as const;

export type FactClaimRejectReason = keyof typeof FACT_CLAIM_REJECT_REASONS;
export type FactClaimWithdrawReason = keyof typeof FACT_CLAIM_WITHDRAW_REASONS;
export type FactClaimLotAttachment = keyof typeof FACT_CLAIM_LOT_ATTACHMENTS;

/** Un rattachement qui tient le champ : la valeur acceptée s'affiche sur la fiche. */
export function factClaimLotAttachmentHolds(attachment: FactClaimLotAttachment): boolean {
  return attachment === "single_lot" || attachment === "matched";
}

export type FactClaimLatestDecision = {
  decision: string;
  reasonCode: string | null;
};

/**
 * Une décision définitive : opposition, ou retrait pour autorisation retirée. Aucune annulation
 * n'existe (même règle que `app_private.fact_decision_is_final`).
 */
export function isFinalFactClaimDecision(latest: FactClaimLatestDecision | null): boolean {
  return (
    latest?.decision === "opposed" ||
    (latest?.decision === "withdrawn" && latest.reasonCode === "authorization_withdrawn")
  );
}

const DECISION_OF_ACTION: Record<FactClaimDecisionAction, string> = {
  accept: "accepted",
  reject: "rejected",
  withdraw: "withdrawn",
  oppose: "opposed",
};

/** L'action demandée, avec ce motif, écrirait-elle une décision définitive ? */
export function isFinalFactClaimAction(
  action: FactClaimDecisionAction,
  reasonCode: string | null,
): boolean {
  return isFinalFactClaimDecision({ decision: DECISION_OF_ACTION[action], reasonCode });
}

/**
 * Actions proposées selon la dernière décision de l'observation (table des transitions de la
 * fonction de décision). Une nouvelle acceptation d'une observation déjà acceptée (correction du
 * lot) n'est pas proposée par l'écran.
 */
export function allowedFactClaimDecisionActions(
  latest: FactClaimLatestDecision | null,
): FactClaimDecisionAction[] {
  if (!latest) return ["accept", "reject", "oppose"];
  if (latest.decision === "opposed") return [];
  if (isFinalFactClaimDecision(latest)) return ["oppose"];
  switch (latest.decision) {
    case "accepted":
      return ["reject", "withdraw", "oppose"];
    case "contradicted":
      return ["accept", "reject", "oppose"];
    case "rejected":
    case "withdrawn":
      return ["accept", "oppose"];
    default:
      return [];
  }
}
