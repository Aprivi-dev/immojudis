/**
 * Formulaire de contact : validation, limite de débit et composition de l'email.
 * Le module est pur (aucune dépendance réseau) : l'envoi réel passe par une
 * fonction injectée, ce qui le rend testable sans Resend.
 */

export const CONTACT_SUBJECTS = [
  { value: "annonce", label: "Question sur une annonce" },
  { value: "abonnement", label: "Mon abonnement ou mon accès Analyse" },
  { value: "donnees", label: "Mes données personnelles" },
  { value: "erreur", label: "Signaler une erreur ou une information manquante" },
  { value: "professionnel", label: "Espace professionnel" },
  { value: "avocat", label: "Avocat : présenter mon cabinet" },
  { value: "autre", label: "Autre demande" },
] as const;

export type ContactSubject = (typeof CONTACT_SUBJECTS)[number]["value"];
export type ContactFields = {
  name: string;
  email: string;
  subject: ContactSubject;
  message: string;
};
export type ContactFieldErrors = Partial<Record<keyof ContactFields, string>>;
export type ContactState = {
  status: "idle" | "sent" | "error";
  message?: string;
  fieldErrors?: ContactFieldErrors;
  values?: Partial<Record<keyof ContactFields, string>>;
};

export const CONTACT_LIMITS = { name: 100, email: 254, message: 4000, minMessage: 10 } as const;

const EMAIL_PATTERN = /^[^\s@<>,;:"]+@[^\s@<>,;:"]+\.[^\s@<>,;:"]{2,}$/;

function text(value: FormDataEntryValue | null | undefined): string {
  return typeof value === "string" ? value : "";
}

/** Retire les retours à la ligne : un nom ou un sujet ne doit pas pouvoir injecter d'en-tête. */
function singleLine(value: string): string {
  return value
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Rubriques d'un signalement : l'endroit de la fiche concerné. Une liste fermée, car la valeur vient
 * de l'adresse de la page et finit dans le message prérempli.
 */
export const CONTACT_REPORT_TOPICS = {
  fiche: "Fiche de la vente",
  prix: "Mise à prix",
  date: "Date ou lieu de la vente",
  localisation: "Localisation du bien",
  "ecart-marche": "Écart au marché",
  pepite: "Repère Pépite",
  plafond: "Enchère ou offre plafond",
  source: "Source de l’annonce",
} as const;
export type ContactReportTopic = keyof typeof CONTACT_REPORT_TOPICS;

const SALE_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** Adresse du formulaire de contact prérempli pour signaler une erreur sur une fiche. */
export function contactReportPath(saleId: string, topic: ContactReportTopic = "fiche"): string {
  const query = new URLSearchParams({ sujet: "erreur", vente: saleId, rubrique: topic });
  return `/contact?${query.toString()}`;
}

/**
 * Sujet et message préremplis d'après l'adresse (`?sujet=erreur&vente=<id>&rubrique=<rubrique>`).
 * Chaque valeur est contrôlée : un sujet de la liste, un identifiant de vente de la forme d'un UUID,
 * une rubrique de `CONTACT_REPORT_TOPICS`. Le reste est ignoré. Aucun texte n'est repris tel quel.
 */
export function contactPrefill(params: { get(name: string): string | null }): {
  subject?: ContactSubject;
  message?: string;
} {
  const subject = CONTACT_SUBJECTS.find((candidate) => candidate.value === params.get("sujet"));
  const saleId = params.get("vente")?.trim() ?? "";
  const topicKey = params.get("rubrique") ?? "";
  const topic = Object.hasOwn(CONTACT_REPORT_TOPICS, topicKey)
    ? CONTACT_REPORT_TOPICS[topicKey as ContactReportTopic]
    : null;
  const lines: string[] = [];
  if (SALE_ID.test(saleId)) lines.push(`Vente concernée : ${saleId.toLowerCase()}`);
  if (topic && lines.length > 0) lines.push(`Rubrique : ${topic}`);
  const message =
    lines.length > 0 ? `${lines.join("\n")}\n\nCe qui est inexact ou manquant : ` : undefined;
  return {
    ...(subject ? { subject: subject.value } : {}),
    ...(message ? { message } : {}),
  };
}

export function validateContact(
  input: Partial<Record<keyof ContactFields | "website", FormDataEntryValue | null>>,
): { ok: true; data: ContactFields } | { ok: false; fieldErrors: ContactFieldErrors } {
  const name = singleLine(text(input.name));
  const email = singleLine(text(input.email)).toLowerCase();
  const subjectValue = text(input.subject);
  const message = text(input.message).replace(/\r\n/g, "\n").trim();
  const fieldErrors: ContactFieldErrors = {};

  if (name.length < 2) fieldErrors.name = "Indiquez votre nom.";
  else if (name.length > CONTACT_LIMITS.name) fieldErrors.name = "Ce nom est trop long.";

  if (!email) fieldErrors.email = "Indiquez votre adresse email.";
  else if (email.length > CONTACT_LIMITS.email || !EMAIL_PATTERN.test(email)) {
    fieldErrors.email = "Cette adresse email n’est pas valide.";
  }

  const subject = CONTACT_SUBJECTS.find((candidate) => candidate.value === subjectValue);
  if (!subject) fieldErrors.subject = "Choisissez un sujet.";

  if (message.length < CONTACT_LIMITS.minMessage) {
    fieldErrors.message = "Décrivez votre demande en quelques phrases.";
  } else if (message.length > CONTACT_LIMITS.message) {
    fieldErrors.message = `Ce message est trop long (${CONTACT_LIMITS.message} caractères au maximum).`;
  }

  if (Object.keys(fieldErrors).length > 0 || !subject) return { ok: false, fieldErrors };
  return { ok: true, data: { name, email, subject: subject.value, message } };
}

// ── Limite de débit ───────────────────────────────────────────────────────
// Le limiteur est injecté (`ContactDeps.limiter`). En production c'est le limiteur partagé du dépôt
// (`enforceIpRateLimit` et `enforceGlobalRateLimit`, tenus en base : voir `src/app/contact/actions.ts`
// et `CONTACT_RATE_LIMITS`). L'ancien limiteur en mémoire était propre à chaque instance serveur,
// donc inopérant sur Vercel.

// ── Composition de l'email ────────────────────────────────────────────────
export type ContactEmail = {
  from: string;
  to: string;
  replyTo: string;
  subject: string;
  text: string;
};

export function buildContactEmail(
  data: ContactFields,
  { to, from }: { to: string; from: string },
): ContactEmail {
  const subject = CONTACT_SUBJECTS.find((candidate) => candidate.value === data.subject)!;
  return {
    from,
    to,
    replyTo: data.email,
    subject: singleLine(`[Contact Immojudis] ${subject.label} — ${data.name}`),
    text: [
      `Nom : ${data.name}`,
      `Email : ${data.email}`,
      `Sujet : ${subject.label}`,
      "",
      data.message,
      "",
      "—",
      "Message envoyé depuis le formulaire de contact. Répondre à cet email écrit à l’expéditeur.",
    ].join("\n"),
  };
}

export type ContactDeps = {
  /** Vrai si l'envoi est autorisé. Peut lever (base de données indisponible) : le message n'est alors pas envoyé. */
  limiter: { consume(clientKey: string): boolean | Promise<boolean> };
  /** Journal des échecs (une ligne JSON, sans donnée personnelle) ; `console.error` par défaut. */
  log?: (line: string) => void;
  /** Destinataire, expéditeur et envoi : absents si le service n'est pas configuré. */
  to?: string | null;
  from?: string | null;
  send?: (email: ContactEmail) => Promise<{ error?: { message?: string } | null }>;
};

const SENT: ContactState = {
  status: "sent",
  message: "Merci, votre message a bien été envoyé. Nous vous répondrons par email.",
};

export async function deliverContact(
  input: Partial<Record<keyof ContactFields | "website", FormDataEntryValue | null>>,
  clientKey: string,
  deps: ContactDeps,
): Promise<ContactState> {
  const values = {
    name: text(input.name),
    email: text(input.email),
    subject: text(input.subject),
    message: text(input.message),
  };
  // Piège à robots : le champ « website » est invisible pour une personne. On répond comme si
  // l'envoi avait réussi, sans rien envoyer.
  if (text(input.website).trim() !== "") return SENT;

  const parsed = validateContact(input);
  if (!parsed.ok) {
    return {
      status: "error",
      message: "Vérifiez les champs signalés.",
      fieldErrors: parsed.fieldErrors,
      values,
    };
  }

  if (!deps.to || !deps.from || !deps.send) {
    return {
      status: "error",
      message:
        "Le formulaire n’est pas disponible pour le moment. Réessayez plus tard ou utilisez l’adresse de contact indiquée sur cette page.",
      values,
    };
  }

  const log = deps.log ?? ((line: string) => console.error(line));
  try {
    if (!(await deps.limiter.consume(clientKey))) {
      return {
        status: "error",
        message: "Trop de messages envoyés. Patientez quelques minutes avant de réessayer.",
        values,
      };
    }
  } catch (error) {
    // Limiteur indisponible : le message n'est pas envoyé (un formulaire sans plafond serait ouvert aux
    // abus), la personne est prévenue et le journal garde la cause.
    log(contactFailureLine("limiter_unavailable", error));
    return { status: "error", message: SEND_FAILED_MESSAGE, values };
  }

  try {
    const { error } = await deps.send(
      buildContactEmail(parsed.data, { to: deps.to, from: deps.from }),
    );
    if (error) throw error;
  } catch (error) {
    log(contactFailureLine("send_failed", error));
    return { status: "error", message: SEND_FAILED_MESSAGE, values };
  }
  return SENT;
}

const SEND_FAILED_MESSAGE =
  "Votre message n’a pas pu être envoyé. Réessayez dans un instant ou écrivez-nous à l’adresse de contact indiquée sur cette page.";

/**
 * Une ligne de journal pour un échec d'envoi : le nom et le code de l'erreur, et un message où toute
 * adresse email est masquée et qui est tronqué. Jamais le nom, l'email, le sujet ni le texte de la
 * personne : le journal ne contient aucune donnée personnelle.
 */
export function contactFailureLine(event: "send_failed" | "limiter_unavailable", error: unknown) {
  const details = (typeof error === "object" && error !== null ? error : {}) as {
    name?: unknown;
    statusCode?: unknown;
    message?: unknown;
  };
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(details.message ?? "");
  const message = raw.replace(/[^\s@<>,;:"']+@[^\s@<>,;:"']+/g, "[email]").slice(0, 200);
  return JSON.stringify({
    scope: "contact",
    level: "error",
    event,
    errorName: typeof details.name === "string" ? details.name.slice(0, 60) : null,
    statusCode: typeof details.statusCode === "number" ? details.statusCode : null,
    message,
  });
}
