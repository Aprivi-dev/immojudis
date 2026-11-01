import type { EmailCategory } from "@/lib/email-alerts";

/**
 * Registre des emails d'Immojudis (module « Emails » de l'administration).
 *
 * Module pur : aucun accès à la base ni à l'environnement, importable par les tests. Les définitions
 * n'importent pas les constructeurs d'emails : chaque `sample()` les charge à la demande (`import()`),
 * ce qui garde le registre léger et n'exécute rien tant qu'un aperçu n'est pas demandé.
 */

/**
 * Qui peut modifier le gabarit.
 * - `editable` : textes éditables plus tard (lot 5), dans un cadre verrouillé. Lecture seule d'ici là.
 * - `readonly` : gabarit figé, garde-fous juridiques ou techniques ; aucun éditeur prévu.
 * - `supabase` : email envoyé par Supabase Auth, dont le HTML est collé dans son tableau de bord.
 */
export type EmailTemplateLevel = "editable" | "readonly" | "supabase";

/**
 * Variable d'environnement qui porte l'expéditeur du gabarit (voir `EMAIL_ENV_ALLOWLIST`). `null` dans
 * une définition : l'expéditeur n'est pas dans l'environnement d'Immojudis (emails d'authentification,
 * envoyés par le SMTP de Supabase).
 */
export type EmailSenderVariable =
  | "ALERT_EMAIL_FROM"
  | "TRANSACTIONAL_EMAIL_FROM"
  | "INFORMATION_AGENT_EMAIL_FROM"
  | "CONTACT_EMAIL_FROM";

/** Un rendu d'exemple : une variante du gabarit (une vente, plusieurs ventes, mode interne…). */
export type EmailSampleVariant = {
  key: string;
  label: string;
  subject: string;
  /** HTML complet de l'aperçu ; `null` pour un email en texte seul (formulaire de contact). */
  html: string | null;
  text: string;
  /**
   * Emails Supabase : le HTML à coller dans le tableau de bord, avec ses variables Go
   * (`{{ .Email }}`…). `html` porte la même page avec des valeurs d'exemple.
   */
  pasteHtml?: string;
};

/**
 * Zone de texte modifiable d'un gabarit. Réservé au lot 5 (surcharges de textes) : aucun gabarit n'en
 * déclare encore, le type garde seulement la place.
 */
export type EmailEditableZone = {
  key: string;
  label: string;
  maxLength: number;
};

export type EmailTemplateDefinition = {
  /** Identifiant stable, en minuscules et tirets bas. */
  key: string;
  label: string;
  /** Quand l'email part, en une phrase. */
  description: string;
  /** Étiquette Resend de l'envoi ; `null` : aucun envoi Resend étiqueté (contact, authentification). */
  category: EmailCategory | null;
  sender: EmailSenderVariable | null;
  level: EmailTemplateLevel;
  /** Lot 5. */
  editableZones?: readonly EmailEditableZone[];
  /**
   * Rendus d'exemple, par le vrai constructeur du gabarit et des données fictives. Absent quand le
   * gabarit est construit à l'intérieur de son envoi (voir `sampleUnavailable`).
   */
  sample?: () => Promise<EmailSampleVariant[]>;
  /** Pourquoi aucun aperçu n'est possible, en une phrase. Obligatoire sans `sample`. */
  sampleUnavailable?: string;
};

/**
 * Catégories d'envoi qu'aucune définition ne couvre parce que le message est interne et n'a pas de
 * gabarit à présenter. Vide aujourd'hui : chaque catégorie a au moins une définition.
 */
export const EMAIL_CATEGORIES_WITHOUT_TEMPLATE: readonly EmailCategory[] = [];
