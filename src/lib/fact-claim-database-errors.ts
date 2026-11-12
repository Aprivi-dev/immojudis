import { PublicApiError, RateLimitError } from "@/lib/api-errors";

/**
 * Seule traduction des erreurs de la base sur les observations (`auction_fact_claims`) vers une
 * réponse HTTP et un message lisible. Elle sert la relecture (`review_auction_fact_claim`) et les
 * décisions du registre des pièces (`accept_`, `reject_`, `withdraw_`, `oppose_auction_fact_claim`).
 *
 * Les fonctions de décision lèvent une liste fermée où le message EST le code (migration
 * `20261118100100_fact_claim_decision_rpcs.sql`) : on traduit d'abord ce code. À défaut (fonction
 * de relecture, refus de droit par PostgREST), on se rabat sur le SQLSTATE. Rien d'autre que le
 * message écrit ici ne part vers le navigateur.
 */

const SALE_BUSY = "Import en cours sur cette vente, réessayez dans une minute.";
const FINAL = "Décision définitive, elle ne peut plus être modifiée.";

type Translation = { status: number; message: string };

/** Codes attendus de la base, à accorder avec la fonction de décision. */
export const FACT_CLAIM_DATABASE_ERROR_CODES = {
  admin_required: { status: 403, message: "Action réservée aux administrateurs." },
  second_factor_required: {
    status: 403,
    message:
      "Cette décision demande la double authentification. Activez-la dans Sécurité, puis reconnectez-vous.",
  },
  rate_limited: {
    status: 429,
    message: "Plafond de décisions atteint pour cette heure. Réessayez plus tard.",
  },
  final_rate_limited: {
    status: 429,
    message: "Plafond de décisions définitives atteint pour aujourd'hui. Réessayez demain.",
  },
  decision_in_progress: {
    status: 409,
    message:
      "Une autre décision est en cours avec votre compte. Attendez quelques secondes, puis réessayez.",
  },
  sale_busy: { status: 409, message: SALE_BUSY },
  retry: { status: 409, message: SALE_BUSY },
  invalid_transition: { status: 409, message: "Cette observation a déjà été traitée." },
  opposed_final: { status: 409, message: FINAL },
  withdrawal_final: { status: 409, message: FINAL },
  origin_cannot_hold: {
    status: 409,
    message:
      "L'origine de cette observation ne permet pas d'afficher sa valeur sur la fiche. Elle ne peut pas être acceptée.",
  },
  field_not_applicable: {
    status: 409,
    message: "Une surface bâtie ne peut pas être acceptée sur une vente de terrain.",
  },
  claim_detached: {
    status: 409,
    message:
      "Cette observation n'est plus rattachée à une vente (doublons fusionnés). Elle reviendra sur la vente conservée.",
  },
  claim_not_found: { status: 404, message: "Observation introuvable." },
  sale_not_found: { status: 404, message: "Vente introuvable." },
  invalid_reason_code: { status: 400, message: "Motif non reconnu." },
  invalid_lot_attachment: { status: 400, message: "Rattachement au lot non reconnu." },
  invalid_argument: {
    status: 400,
    message: "Cette valeur ne peut pas être affichée sur la fiche, ou la demande est incomplète.",
  },
  registry_unavailable: {
    status: 503,
    message:
      "Le registre des pièces est indisponible. Aucune décision n'a été enregistrée. Prévenez l'équipe technique.",
  },
  registry_write_failed: {
    status: 500,
    message:
      "La décision n'a pas pu être enregistrée et rien n'a été modifié. Réessayez ; si l'erreur persiste, prévenez l'équipe technique.",
  },
} as const satisfies Record<string, Translation>;

export type FactClaimDatabaseErrorCode = keyof typeof FACT_CLAIM_DATABASE_ERROR_CODES;

/** Repli par SQLSTATE, pour une erreur qui ne porte pas un code de la liste fermée. */
const SQLSTATE_FALLBACK: Record<string, Translation> = {
  "42501": { status: 403, message: "Action non autorisée." },
  "55P03": { status: 409, message: SALE_BUSY },
  "40001": { status: 409, message: SALE_BUSY },
  "55000": {
    status: 409,
    message: "Ce fait a déjà été traité ou est en cours de traitement ailleurs.",
  },
};

/**
 * Rend l'erreur à passer à `apiRouteError` : une erreur publique quand la base a répondu par un
 * code connu ; sinon une erreur sans texte de la base, ou l'erreur d'origine si elle ne vient pas
 * de la base (elle recevra le message générique de la route).
 */
export function translateFactClaimDatabaseError(error: unknown): unknown {
  if (!error || typeof error !== "object") return error;
  const { code, message } = error as { code?: unknown; message?: unknown };
  const translation =
    (typeof message === "string" && Object.hasOwn(FACT_CLAIM_DATABASE_ERROR_CODES, message)
      ? FACT_CLAIM_DATABASE_ERROR_CODES[message as FactClaimDatabaseErrorCode]
      : undefined) ??
    (typeof code === "string" && Object.hasOwn(SQLSTATE_FALLBACK, code)
      ? SQLSTATE_FALLBACK[code]
      : undefined);
  if (!translation) {
    // Erreur de la base hors liste : son texte peut citer une valeur ou un objet SQL. Seul son
    // SQLSTATE va au journal du serveur, et la route répond son message générique.
    return typeof code === "string" && "details" in error
      ? new Error(`Unhandled database error ${code}`)
      : error;
  }
  return translation.status === 429
    ? // Fenêtre d'une heure au plus pour le plafond horaire ; le navigateur n'en fait rien d'automatique.
      new RateLimitError(translation.message, 3600, translation.message)
    : new PublicApiError(translation.message, translation.status);
}
