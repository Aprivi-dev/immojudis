import { EMAIL_COLORS, EMAIL_SITE_URL } from "./email-brand";
import {
  emailButton,
  emailHeading,
  emailLayout,
  emailParagraph,
  escapeEmailHtml,
} from "./email-layout";

/**
 * Gabarits des emails d'authentification de Supabase (confirmation d'inscription, mot de passe
 * oublié, changement d'adresse, invitation, lien magique, réauthentification), en français, au modèle
 * unique des emails d'Immojudis (`email-layout.ts` : logo, carte, mode sombre).
 *
 * Les fichiers `supabase/templates/*.html` et `docs/runbooks/emails-authentification/retour-arriere/*.html`
 * sont GÉNÉRÉS d'ici : le test `auth-email-templates.test.ts` échoue s'ils s'en écartent, et les réécrit
 * avec `UPDATE_AUTH_EMAIL_TEMPLATES=1 npx vitest run src/lib/auth-email-templates.test.ts`.
 *
 * Ni `supabase config push` ni aucune commande ne les envoie : `supabase/config.toml` n'est pas appliqué
 * à la production, le propriétaire colle chaque gabarit dans le tableau de bord (Authentication >
 * Emails). Voir `docs/runbooks/emails-authentification.md`.
 *
 * Deux variantes de lien :
 * - `token-hash` (production visée) : `https://immojudis.com/auth/confirmer?token_hash=…&type=…&redirect_to=…`
 *   (origine fixe `EMAIL_SITE_URL` : `{{ .SiteURL }}` porte une barre finale et donnait `//auth/confirmer`),
 *   page d'Immojudis qui ne vérifie qu'au clic (les passerelles anti-hameçonnage ouvrent les liens) ;
 * - `confirmation-url` (retour arrière) : `{{ .ConfirmationURL }}`, le lien de vérification de Supabase,
 *   qui fonctionne sans la page.
 *
 * Variables Go de Supabase employées : `.TokenHash`, `.RedirectTo` (et `.RedirectTo | urlquery` dans le
 * lien affiché en clair), `.ConfirmationURL`, `.Email`, `.NewEmail`, `.Token`. Aucun contenu commercial.
 */

export type AuthEmailTemplateId =
  | "confirmation"
  | "recovery"
  | "email_change"
  | "invite"
  | "magic_link"
  | "reauthentication";

export type AuthEmailLinkVariant = "token-hash" | "confirmation-url";

type AuthEmailTemplateDefinition = {
  id: AuthEmailTemplateId;
  /** Fichier de `supabase/templates/` (et du dossier de retour arrière). */
  file: string;
  /** Objet de l'email (`subject` de `supabase/config.toml`). */
  subject: string;
  /** Texte d'aperçu masqué. */
  preheader: string;
  /** Titre de la carte. */
  heading: string;
  /** Paragraphes du corps, en HTML déjà échappé (variables Go comprises). */
  body: readonly string[];
  /** Bouton ; absent pour la réauthentification, qui n'envoie qu'un code. */
  button?: { text: string; type: "signup" | "recovery" | "email_change" | "invite" | "magiclink" };
  /** Code à saisir (réauthentification). */
  code?: boolean;
};

const BRAND_FOOTER =
  "Message de sécurité lié à votre compte Immojudis (immojudis.com). Il ne contient aucune offre commerciale.";

const e = escapeEmailHtml;

/** Les variables Go sont écrites telles quelles : elles ne passent jamais par l'échappement. */
const EMAIL = "{{ .Email }}";
const NEW_EMAIL = "{{ .NewEmail }}";

/**
 * Textes validés par le propriétaire le 01/11/2026 pour la confirmation, le mot de passe oublié et le
 * changement d'adresse. L'invitation, le lien magique et la réauthentification (aucun n'est émis par
 * l'application aujourd'hui) suivent le même ton : à relire avant de les coller.
 */
export const AUTH_EMAIL_TEMPLATES: readonly AuthEmailTemplateDefinition[] = [
  {
    id: "confirmation",
    file: "confirmation.html",
    subject: "Confirmez votre adresse email pour accéder à Immojudis",
    preheader: "Un clic pour activer votre compte.",
    heading: "Confirmez votre adresse email",
    body: [
      `Vous venez de créer un compte Immojudis avec l’adresse ${EMAIL}. Pour l’activer, confirmez cette adresse. Ce lien est temporaire ; s’il a expiré, demandez-en un nouveau depuis la page de connexion. Si vous n’êtes pas à l’origine de cette inscription, ignorez ce message : aucun compte ne sera activé.`,
    ],
    button: { text: "Confirmer mon adresse", type: "signup" },
  },
  {
    id: "recovery",
    file: "recovery.html",
    subject: "Réinitialisation de votre mot de passe Immojudis",
    preheader: "Choisissez un nouveau mot de passe.",
    heading: "Réinitialisation de votre mot de passe",
    body: [
      `Nous avons reçu une demande de réinitialisation du mot de passe du compte Immojudis associé à ${EMAIL}. Ce lien ne peut servir qu’une fois. Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : votre mot de passe actuel reste valable. Ne transmettez ce lien à personne.`,
    ],
    button: { text: "Choisir un nouveau mot de passe", type: "recovery" },
  },
  {
    id: "email_change",
    file: "email_change.html",
    subject: "Confirmez votre nouvelle adresse email Immojudis",
    preheader: "Votre adresse ne changera qu’après confirmation.",
    heading: "Confirmez votre nouvelle adresse email",
    body: [
      `Vous avez demandé à remplacer l’adresse ${EMAIL} par ${NEW_EMAIL} sur votre compte Immojudis. Le changement ne sera effectif qu’après confirmation. Si vous n’êtes pas à l’origine de cette demande, ignorez ce message et changez votre mot de passe.`,
    ],
    button: { text: "Confirmer le changement", type: "email_change" },
  },
  {
    id: "invite",
    file: "invite.html",
    subject: "Invitation à rejoindre Immojudis",
    preheader: "Un clic pour activer votre compte.",
    heading: "Invitation à rejoindre Immojudis",
    body: [
      `Une invitation à rejoindre Immojudis a été envoyée à l’adresse ${EMAIL}. Pour activer votre compte, acceptez l’invitation. Ce lien est temporaire ; s’il a expiré, demandez-en un nouveau à la personne qui vous a invité. Si vous ne connaissez pas Immojudis, ignorez ce message : aucun compte ne sera activé.`,
    ],
    button: { text: "Accepter l’invitation", type: "invite" },
  },
  {
    id: "magic_link",
    file: "magic_link.html",
    subject: "Votre lien de connexion Immojudis",
    preheader: "Un clic pour vous connecter.",
    heading: "Votre lien de connexion",
    body: [
      `Vous avez demandé à vous connecter à Immojudis avec l’adresse ${EMAIL}. Ce lien ne peut servir qu’une fois. Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : aucune connexion n’aura lieu. Ne transmettez ce lien à personne.`,
    ],
    button: { text: "Me connecter", type: "magiclink" },
  },
  {
    id: "reauthentication",
    file: "reauthentication.html",
    subject: "Votre code de confirmation Immojudis",
    preheader: "Saisissez ce code pour confirmer votre identité.",
    heading: "Confirmez votre identité",
    body: [
      "Pour confirmer votre identité sur Immojudis, saisissez ce code :",
      // Le code est inséré entre ces deux paragraphes (voir `code`).
      "Ce code est temporaire et ne peut servir qu’une fois. Si vous n’êtes pas à l’origine de cette demande, ignorez ce message et changez votre mot de passe. Ne communiquez ce code à personne.",
    ],
    code: true,
  },
];

/** Lien du bouton selon la variante : valeur d'attribut `href`, avec les variables Go non échappées. */
export function authEmailLink(
  variant: AuthEmailLinkVariant,
  type: NonNullable<AuthEmailTemplateDefinition["button"]>["type"],
): string {
  return variant === "token-hash"
    ? `${EMAIL_SITE_URL}/auth/confirmer?token_hash={{ .TokenHash }}&type=${type}&redirect_to={{ .RedirectTo }}`
    : "{{ .ConfirmationURL }}";
}

/**
 * Lien de repli affiché en clair sous le bouton. Supabase rend les gabarits avec `html/template` de Go :
 * dans l'attribut `href`, l'adresse de retour est encodée d'office, mais pas dans le texte visible, où un
 * « & » de `{{ .RedirectTo }}` coupait le lien copié. `urlquery` l'encode ici (fonction prédéfinie de Go,
 * admise en dernière position d'un pipeline par `html/template`). Le `href` du bouton ne change pas.
 */
export function authEmailVisibleLink(
  variant: AuthEmailLinkVariant,
  type: NonNullable<AuthEmailTemplateDefinition["button"]>["type"],
): string {
  return variant === "token-hash"
    ? authEmailLink(variant, type).replace(
        "redirect_to={{ .RedirectTo }}",
        "redirect_to={{ .RedirectTo | urlquery }}",
      )
    : authEmailLink(variant, type);
}

/** Un gabarit complet, prêt à coller dans le tableau de bord Supabase. */
export function buildAuthEmailTemplate(
  definition: AuthEmailTemplateDefinition,
  variant: AuthEmailLinkVariant,
): string {
  const content: string[] = [emailHeading(definition.heading, 1, { marginBottom: 16 })];
  if (definition.code) {
    content.push(
      emailParagraph(e(definition.body[0]), { marginBottom: 12 }),
      // Code à six chiffres de `{{ .Token }}` : monospace large, lisible et copiable.
      `<p class="ej-navy" style="margin:0 0 16px;font-family:Consolas, Menlo, 'Courier New', monospace;font-size:28px;line-height:36px;font-weight:700;letter-spacing:.2em;color:${EMAIL_COLORS.navy};">{{ .Token }}</p>`,
      emailParagraph(e(definition.body[1])),
    );
  } else {
    // Les variables Go (`{{ .Email }}`) ne contiennent aucun caractère échappé par `e`.
    for (const paragraph of definition.body) content.push(emailParagraph(e(paragraph)));
  }
  if (definition.button) {
    const href = authEmailLink(variant, definition.button.type);
    content.push(
      emailButton(href, definition.button.text, { marginBottom: 16 }),
      emailParagraph(e("Le bouton ne fonctionne pas ? Copiez ce lien dans votre navigateur :"), {
        tone: "muted",
        size: "caption",
        marginBottom: 4,
      }),
      emailParagraph(
        `<span class="ej-link" style="color:${EMAIL_COLORS.goldText};font-family:Consolas, Menlo, 'Courier New', monospace;font-size:13px;line-height:19px;word-break:break-all;overflow-wrap:anywhere;">${e(authEmailVisibleLink(variant, definition.button.type))}</span>`,
        { tone: "muted", size: "caption", marginBottom: 16 },
      ),
    );
  }
  content.push(emailParagraph("Cordialement,<br>L’équipe Immojudis", { marginBottom: 0 }));

  return `${emailLayout({
    title: definition.subject,
    preheader: definition.preheader,
    content: content.join(""),
    footer: { reason: BRAND_FOOTER, noReply: true },
  })}\n`;
}
