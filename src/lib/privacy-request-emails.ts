import type { ResendEmailMessage } from "@/lib/email-alerts";
import {
  emailButton,
  emailHeading,
  emailKeyValueRows,
  emailLayout,
  emailLink,
  emailParagraph,
  emailPreheaderFrom,
} from "@/lib/email-layout";
import { formatDate } from "@/lib/format/dates";
import { escapeHtml } from "@/lib/guards";
import { privacyResponseDelayLabel } from "@/lib/privacy-deadline";
import { privacyRequestTypeLabel } from "@/lib/privacy-request-types";

/**
 * Emails de suivi d'une demande de droits (module pur : aucune lecture de la base ni de
 * l'environnement ; l'envoi est dans `privacy-request-notifications.ts`).
 *
 * - À l'exploitation (`OPERATIONS_ALERT_EMAIL_TO`) : nature, dates et lien vers Conformité. JAMAIS
 *   l'adresse ni le message du demandeur.
 * - Au demandeur : accusé de réception au dépôt, puis email de clôture. Pour un effacement, l'email de
 *   clôture reprend mot pour mot la politique de confidentialité publiée (`src/routes/privacy.tsx` ;
 *   `privacy-request-emails.test.ts` vérifie que chaque citation y figure toujours).
 */

/** « Effacement du compte et exceptions » de la politique de confidentialité, cité tel quel. */
export const ACCOUNT_ERASURE_POLICY_TEXT =
  "La suppression du compte entraîne la suppression en cascade des favoris, alertes, rapports, notes, journal des emails liés à votre compte et principaux espaces personnels. Les données strictement nécessaires à une obligation comptable, à la preuve d’un contrat, au traitement d’une demande ou à la défense d’un droit sont isolées et conservées jusqu’à l’expiration de leur durée, puis purgées automatiquement.";

/** Lignes du tableau des traitements de la politique : finalité, puis durée de conservation, citées telles quelles. */
export const ACCOUNT_ERASURE_RETAINED_ROWS: ReadonlyArray<
  readonly [purpose: string, retention: string]
> = [
  [
    "Commande et accès payant",
    "Preuves contractuelles et comptables jusqu’à 10 ans ; données carte conservées par Stripe, pas par Immojudis",
  ],
  ["Exercice des droits et rétractation", "Demandes clôturées supprimées après 5 ans"],
];

/** Phrase de la page de demande du professionnel (`/api/information-agent/rights`), citée telle quelle. */
export const PROFESSIONAL_ERASURE_KEPT_TEXT =
  "Votre adresse restera sur la liste des contacts à ne plus solliciter.";

const CNIL_COMPLAINT_URL = "https://www.cnil.fr/fr/plaintes";

export type PrivacyRequestSubjectKind = "account" | "information_agent_professional";

type Envelope = { from: string; to: string; appUrl: string };

type RequestFacts = {
  requestType: string;
  submittedAt: string;
  dueAt: string;
  subjectKind: PrivacyRequestSubjectKind;
};

const SIGNATURE_TEXT = ["Cordialement,", "L’équipe Immojudis"];
const SIGNATURE = emailParagraph("Cordialement,<br />L’équipe Immojudis", { marginBottom: 0 });

function subjectKindLabel(kind: PrivacyRequestSubjectKind): string {
  return kind === "account" ? "Titulaire d’un compte" : "Professionnel contacté, sans compte";
}

/** Email interne à l'exploitation : une demande vient d'être déposée. */
export function buildPrivacyRequestOperatorMessage(
  facts: RequestFacts,
  { from, to, appUrl }: Envelope,
): ResendEmailMessage {
  const label = privacyRequestTypeLabel(facts.requestType);
  const panelUrl = `${appUrl}/admin/compliance`;
  const subject = `[Immojudis] Nouvelle demande de droits : ${label}`;
  const rows = [
    ["Nature", label],
    ["Demandeur", subjectKindLabel(facts.subjectKind)],
    ["Déposée le", formatDate(facts.submittedAt)],
    ["Échéance", `${formatDate(facts.dueAt)} (${privacyResponseDelayLabel(facts.requestType)})`],
  ] as const;
  const privacyNote =
    "L’adresse et le message du demandeur ne sont pas repris ici : ils se lisent dans Conformité.";
  const text = [
    "Nouvelle demande de droits",
    "",
    ...rows.map(([key, value]) => `${key} : ${value}`),
    "",
    `Traiter la demande : ${panelUrl}`,
    "",
    privacyNote,
  ].join("\n");
  const html = emailLayout({
    title: subject,
    preheader: emailPreheaderFrom(`${label} · échéance ${formatDate(facts.dueAt)}`),
    content: [
      emailHeading("Nouvelle demande de droits"),
      emailKeyValueRows(rows),
      emailButton(panelUrl, "Ouvrir Conformité"),
      emailParagraph(escapeHtml(privacyNote), {
        tone: "muted",
        size: "caption",
        marginBottom: 0,
      }),
    ].join(""),
    // Email interne : le cadre commun sans pied (comme les alertes d'exploitation).
    footer: null,
  });
  return { from, to, replyTo: null, subject, html, text };
}

/** Accusé de réception au demandeur. */
export function buildPrivacyRequestAcknowledgementMessage(
  facts: RequestFacts,
  { from, to, appUrl }: Envelope,
): ResendEmailMessage {
  const label = privacyRequestTypeLabel(facts.requestType);
  const subject = `Nous avons bien reçu votre demande : ${label}`;
  const rightsUrl = `${appUrl}/mes-droits`;
  const rows = [
    ["Nature de la demande", label],
    ["Déposée le", formatDate(facts.submittedAt)],
    [
      "Échéance de réponse",
      `${formatDate(facts.dueAt)} (${privacyResponseDelayLabel(facts.requestType)})`,
    ],
  ] as const;
  const follow =
    facts.subjectKind === "account"
      ? "Vous pouvez suivre son avancement depuis l’espace Mes droits de votre compte."
      : "La réponse vous sera adressée à cette adresse email.";
  const text = [
    "Bonjour,",
    "",
    "Nous avons bien reçu votre demande. Elle est enregistrée et sera traitée au plus tard à l’échéance indiquée.",
    "",
    ...rows.map(([key, value]) => `${key} : ${value}`),
    "",
    follow,
    ...(facts.subjectKind === "account" ? [rightsUrl] : []),
    "",
    ...SIGNATURE_TEXT,
  ].join("\n");
  const html = emailLayout({
    title: subject,
    preheader: emailPreheaderFrom(
      `Demande enregistrée le ${formatDate(facts.submittedAt)}, réponse au plus tard le ${formatDate(facts.dueAt)}.`,
    ),
    content: [
      emailParagraph("Bonjour,"),
      emailParagraph(
        "Nous avons bien reçu votre demande. Elle est enregistrée et sera traitée au plus tard à l’échéance indiquée.",
      ),
      emailKeyValueRows(rows),
      emailParagraph(escapeHtml(follow)),
      ...(facts.subjectKind === "account" ? [emailButton(rightsUrl, "Suivre ma demande")] : []),
      SIGNATURE,
    ].join(""),
    footer: {},
  });
  return { from, to, subject, html, text };
}

export type PrivacyRequestClosure = {
  status: "completed" | "rejected";
  closedAt: string;
  /** Exécution de l'effacement (compte ou professionnel) : l'email dit ce qui a été effacé et ce qui reste. */
  erasureExecuted: boolean;
  /** Réponse de l'équipe au demandeur (suites données, motifs d'un refus), texte brut. */
  response: string | null;
};

/** Email de clôture : demande traitée ou refusée. */
export function buildPrivacyRequestClosureMessage(
  facts: RequestFacts,
  closure: PrivacyRequestClosure,
  { from, to, appUrl }: Envelope,
): ResendEmailMessage {
  const label = privacyRequestTypeLabel(facts.requestType);
  const completed = closure.status === "completed";
  const subject = completed
    ? `Votre demande a été traitée : ${label}`
    : `Votre demande est clôturée : ${label}`;
  const intro = completed
    ? `Votre demande « ${label} », déposée le ${formatDate(facts.submittedAt)}, a été traitée le ${formatDate(closure.closedAt)}.`
    : `Votre demande « ${label} », déposée le ${formatDate(facts.submittedAt)}, a été clôturée le ${formatDate(closure.closedAt)} sans que nous puissions y donner suite.`;
  const accountErased = closure.erasureExecuted && facts.subjectKind === "account";
  const professionalErased =
    closure.erasureExecuted && facts.subjectKind === "information_agent_professional";

  const textBlocks: string[][] = [["Bonjour,", "", intro]];
  const htmlBlocks: string[] = [emailParagraph("Bonjour,"), emailParagraph(escapeHtml(intro))];

  if (accountErased) {
    const done = "Votre compte Immojudis et les données qui y sont liées ont été effacés.";
    const kept =
      "Comme l’indique notre politique de confidentialité, certaines données sont conservées pour une durée limitée :";
    textBlocks.push([
      done,
      "",
      ACCOUNT_ERASURE_POLICY_TEXT,
      "",
      kept,
      ...ACCOUNT_ERASURE_RETAINED_ROWS.map(([purpose, retention]) => `- ${purpose} : ${retention}`),
    ]);
    htmlBlocks.push(
      emailParagraph(escapeHtml(done)),
      emailParagraph(escapeHtml(ACCOUNT_ERASURE_POLICY_TEXT)),
      emailParagraph(escapeHtml(kept), { marginBottom: 8 }),
      emailKeyValueRows(ACCOUNT_ERASURE_RETAINED_ROWS),
    );
  }
  if (professionalErased) {
    const done =
      "Les messages, dossiers et pièces de l’agent d’information liés à votre adresse ont été effacés.";
    textBlocks.push([done, PROFESSIONAL_ERASURE_KEPT_TEXT]);
    htmlBlocks.push(emailParagraph(escapeHtml(`${done} ${PROFESSIONAL_ERASURE_KEPT_TEXT}`)));
  }
  if (closure.response?.trim()) {
    const response = closure.response.trim();
    textBlocks.push(["Réponse de notre équipe :", response]);
    htmlBlocks.push(
      emailParagraph("Réponse de notre équipe :", { marginBottom: 8, weight: 700 }),
      emailParagraph(escapeHtml(response).replace(/\n/g, "<br />")),
    );
  }
  // Une demande RGPD refusée : la personne peut saisir la CNIL (art. 12.4 RGPD). La rétractation relève du
  // droit de la consommation, pas de la CNIL.
  if (!completed && facts.requestType !== "contract_withdrawal") {
    const cnil = "Vous pouvez introduire une réclamation auprès de la CNIL :";
    textBlocks.push([`${cnil} ${CNIL_COMPLAINT_URL}`]);
    htmlBlocks.push(
      emailParagraph(
        `${escapeHtml(cnil)} ${emailLink(CNIL_COMPLAINT_URL, escapeHtml("www.cnil.fr/fr/plaintes"))}`,
      ),
    );
  }
  if (facts.subjectKind === "account" && !accountErased) {
    const rightsUrl = `${appUrl}/mes-droits`;
    textBlocks.push([`Retrouvez cette demande dans Mes droits : ${rightsUrl}`]);
    htmlBlocks.push(emailButton(rightsUrl, "Voir mes demandes", { variant: "secondary" }));
  }
  textBlocks.push(SIGNATURE_TEXT);
  htmlBlocks.push(SIGNATURE);

  return {
    from,
    to,
    subject,
    text: textBlocks.map((block) => block.join("\n")).join("\n\n"),
    html: emailLayout({
      title: subject,
      preheader: emailPreheaderFrom(intro),
      content: htmlBlocks.join(""),
      footer: {},
    }),
  };
}
