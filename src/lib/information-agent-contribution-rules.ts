import { safeExternalHttpUrl } from "@/lib/external-url";

/**
 * Règles du dépôt de contribution (`/contribuer`) partagées entre le formulaire (navigateur) et
 * l'API (`information-agent-contribution.ts`). Le navigateur applique exactement les contrôles du
 * serveur avant de téléverser la moindre pièce : un refus tardif consomme le quota de pièces du
 * dossier (16 préparations par jour) pour rien. Aucun import serveur ici.
 */

export const CONTRIBUTION_LIMITS = {
  senderNameMin: 2,
  senderNameMax: 180,
  senderEmailMax: 320,
  noteMax: 10_000,
  linkMax: 2048,
  linksMax: 5,
  fileNameMax: 180,
  /** Texte du message enregistré (réponse + lignes « Lien transmis : … ») : limite de la base. */
  bodyMax: 16_000,
} as const;

export type ContributionFieldName =
  | "senderName"
  | "senderEmail"
  | "note"
  | "externalLinks"
  | "files"
  | "authorizedToTransmit";

export type ContributionFieldError = { field: ContributionFieldName; message: string };

const FIELD_NAMES: ReadonlySet<string> = new Set<ContributionFieldName>([
  "senderName",
  "senderEmail",
  "note",
  "externalLinks",
  "files",
  "authorizedToTransmit",
]);

export function isContributionFieldName(value: unknown): value is ContributionFieldName {
  return typeof value === "string" && FIELD_NAMES.has(value);
}

/**
 * Même expression que `z.string().email()` de zod 3 (le serveur applique aussi `.email()` : un test
 * compare les deux). Un `type="email"` du navigateur accepte davantage (`a@b`, `a@b.c`).
 */
export const CONTRIBUTION_EMAIL_PATTERN =
  /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,}$/i;

export function isValidContributionEmail(value: string): boolean {
  return (
    value.length <= CONTRIBUTION_LIMITS.senderEmailMax && CONTRIBUTION_EMAIL_PATTERN.test(value)
  );
}

const formatCount = (value: number) => value.toLocaleString("fr-FR");

/** Message de chaque champ, identique côté navigateur et côté serveur. */
export const CONTRIBUTION_FIELD_MESSAGES = {
  senderNameMissing: "Indiquez votre nom ou votre cabinet.",
  senderNameTooLong: `Le nom ou le cabinet ne doit pas dépasser ${CONTRIBUTION_LIMITS.senderNameMax} caractères.`,
  senderEmailInvalid: "Indiquez une adresse e-mail valide.",
  senderEmailTooLong: `L’adresse e-mail ne doit pas dépasser ${CONTRIBUTION_LIMITS.senderEmailMax} caractères.`,
  noteTooLong: `Votre réponse dépasse ${formatCount(CONTRIBUTION_LIMITS.noteMax)} caractères. Raccourcissez-la, ou joignez un fichier.`,
  linksTooMany: `Ajoutez au maximum ${CONTRIBUTION_LIMITS.linksMax} liens, un par ligne.`,
  linkTooLong: `Un lien dépasse ${formatCount(CONTRIBUTION_LIMITS.linkMax)} caractères.`,
  linkInvalid:
    "Chaque lien doit commencer par http:// ou https://, sans identifiant ni mot de passe.",
  empty: "Ajoutez une réponse, un lien ou au moins une pièce jointe.",
  bodyTooLong: "Votre réponse et vos liens sont trop longs : raccourcissez la réponse.",
  authorizationMissing: "Confirmez que vous êtes autorisé à transmettre ces informations.",
  invalidData: "Données de dépôt invalides.",
} as const;

/** Texte enregistré pour une réponse et ses liens (déjà normalisés). */
export function contributionBodyText(note: string, normalizedLinks: readonly string[]): string {
  return [
    note || "Pièces ou liens déposés pour ce dossier.",
    ...normalizedLinks.map((value) => `Lien transmis : ${value}`),
  ].join("\n\n");
}

export type ContributionDraft = {
  senderName: string;
  senderEmail: string;
  note: string;
  /** Un lien par entrée, tels que saisis. */
  links: readonly string[];
  fileCount: number;
  authorizedToTransmit: boolean;
};

/**
 * Contrôles du serveur, dans l'ordre où le formulaire les montre. Renvoie la première erreur et le
 * champ fautif, ou `null`. Les valeurs sont rognées comme le fait le schéma du serveur.
 */
export function validateContributionDraft(draft: ContributionDraft): ContributionFieldError | null {
  const name = draft.senderName.trim();
  const email = draft.senderEmail.trim();
  const note = draft.note.trim();
  const links = draft.links.map((link) => link.trim());

  if (name.length < CONTRIBUTION_LIMITS.senderNameMin) {
    return { field: "senderName", message: CONTRIBUTION_FIELD_MESSAGES.senderNameMissing };
  }
  if (name.length > CONTRIBUTION_LIMITS.senderNameMax) {
    return { field: "senderName", message: CONTRIBUTION_FIELD_MESSAGES.senderNameTooLong };
  }
  if (email.length > CONTRIBUTION_LIMITS.senderEmailMax) {
    return { field: "senderEmail", message: CONTRIBUTION_FIELD_MESSAGES.senderEmailTooLong };
  }
  if (!isValidContributionEmail(email)) {
    return { field: "senderEmail", message: CONTRIBUTION_FIELD_MESSAGES.senderEmailInvalid };
  }
  if (note.length > CONTRIBUTION_LIMITS.noteMax) {
    return { field: "note", message: CONTRIBUTION_FIELD_MESSAGES.noteTooLong };
  }
  if (links.length > CONTRIBUTION_LIMITS.linksMax) {
    return { field: "externalLinks", message: CONTRIBUTION_FIELD_MESSAGES.linksTooMany };
  }
  if (links.some((link) => link.length > CONTRIBUTION_LIMITS.linkMax)) {
    return { field: "externalLinks", message: CONTRIBUTION_FIELD_MESSAGES.linkTooLong };
  }
  const normalizedLinks = links.map((link) => safeExternalHttpUrl(link));
  if (normalizedLinks.some((link) => !link)) {
    return { field: "externalLinks", message: CONTRIBUTION_FIELD_MESSAGES.linkInvalid };
  }
  if (!note && !links.length && !draft.fileCount) {
    return { field: "note", message: CONTRIBUTION_FIELD_MESSAGES.empty };
  }
  const body = contributionBodyText(
    note,
    normalizedLinks.filter((link): link is string => Boolean(link)),
  );
  if (body.length > CONTRIBUTION_LIMITS.bodyMax) {
    return { field: "note", message: CONTRIBUTION_FIELD_MESSAGES.bodyTooLong };
  }
  if (!draft.authorizedToTransmit) {
    return {
      field: "authorizedToTransmit",
      message: CONTRIBUTION_FIELD_MESSAGES.authorizationMissing,
    };
  }
  return null;
}
