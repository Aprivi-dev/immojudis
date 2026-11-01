/**
 * Clés du registre des gabarits qui partent par Resend (celles dont la catégorie n'est pas `null`).
 * Module pur : `sendTrackedEmail` exige l'une d'elles, donc un envoi sans gabarit déclaré ne compile
 * pas. `registry.test.ts` vérifie que cette liste et le registre disent la même chose.
 */
export const SENT_TEMPLATE_KEYS = [
  "alert",
  "sale_reminder",
  "weekly_digest",
  "sale_result",
  "trial_end",
  "offer_opening",
  "payment_failed",
  "trial_ending",
  "cancellation",
  "commercial_confirmation",
  "lawyer_referral",
  "operations_incident",
  "replies_review_digest",
  "agent_request",
  "agent_court_registry",
] as const;
export type SentTemplateKey = (typeof SENT_TEMPLATE_KEYS)[number];

/**
 * Objet enregistré au journal des envois à la place de l'objet réel, pour les gabarits dont l'objet
 * est personnalisé avec des données de personnes tierces (nom du bien, du cabinet, de la juridiction).
 * Le journal garde 90 jours : il n'a pas besoin de ce détail pour répondre à « cet email est-il parti
 * et a-t-il été remis ? ». L'objet réel reste lisible dans le message lui-même, chez Resend.
 */
export const GENERIC_LOG_SUBJECTS: Partial<Record<SentTemplateKey, string>> = {
  lawyer_referral: "Mise en relation avec un avocat",
  agent_request: "Demande d’information à un professionnel",
  agent_court_registry: "Demande d’information à une juridiction",
};
