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
// Fenêtre glissante en mémoire : suffit contre un envoi répété depuis un même poste, mais
// elle est propre à chaque instance serveur. Une limite partagée relève du chantier P4-02.
export function createContactLimiter({
  perClient = 3,
  windowMs = 15 * 60_000,
  global = 40,
  globalWindowMs = 60 * 60_000,
  now = () => Date.now(),
}: {
  perClient?: number;
  windowMs?: number;
  global?: number;
  globalWindowMs?: number;
  now?: () => number;
} = {}) {
  const clients = new Map<string, number[]>();
  let all: number[] = [];
  return {
    /** Renvoie true si l'envoi est autorisé, et le compte. */
    consume(clientKey: string): boolean {
      const t = now();
      all = all.filter((at) => t - at < globalWindowMs);
      const recent = (clients.get(clientKey) ?? []).filter((at) => t - at < windowMs);
      if (recent.length >= perClient || all.length >= global) {
        clients.set(clientKey, recent);
        return false;
      }
      recent.push(t);
      all.push(t);
      clients.set(clientKey, recent);
      if (clients.size > 5000) {
        for (const [key, stamps] of clients) {
          if (!stamps.some((at) => t - at < windowMs)) clients.delete(key);
        }
      }
      return true;
    },
  };
}

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
  limiter: { consume(clientKey: string): boolean };
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

  if (!deps.limiter.consume(clientKey)) {
    return {
      status: "error",
      message: "Trop de messages envoyés. Patientez quelques minutes avant de réessayer.",
      values,
    };
  }

  try {
    const { error } = await deps.send(
      buildContactEmail(parsed.data, { to: deps.to, from: deps.from }),
    );
    if (error) throw new Error(error.message);
  } catch {
    return {
      status: "error",
      message: "Votre message n’a pas pu être envoyé. Réessayez dans un instant.",
      values,
    };
  }
  return SENT;
}
