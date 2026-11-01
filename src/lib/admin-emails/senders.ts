import {
  resolveEmailAlertDeliveryConfig,
  resolveReplyTo,
  resolveTransactionalEmailConfig,
} from "@/lib/email-alerts";
import type { EmailTemplateDefinition } from "@/lib/email-templates/types";
import type { EmailAddressEnv, EmailAddressVariable } from "./env";

/** Une ligne de la rubrique « Expéditeurs et adresses » : la valeur effective, pas seulement la variable. */
export type EmailAddressRow = {
  variable: EmailAddressVariable;
  label: string;
  /** Valeur effective après repli ; `null` quand rien n'est configuré. */
  value: string | null;
  /** `configured` : la variable porte la valeur ; `fallback` : une autre source la remplace. */
  origin: "configured" | "fallback" | "missing";
  /** Source du repli, en clair. */
  fallbackFrom?: string;
  /** Ce qui se passe quand la valeur manque. */
  consequence?: string;
  /** Domaine à retrouver dans Resend (expéditeurs) ou à interroger en DNS (domaine de réception). */
  domain: string | null;
  usedBy: string[];
};

const filled = (value: string | undefined) => value?.trim() || null;

/** Domaine de `Nom <adresse@domaine>` ou de `adresse@domaine`, en minuscules ; `null` sinon. */
export function addressDomain(value: string | null): string | null {
  const match = value?.match(/@([a-z0-9.-]+\.[a-z]{2,})>?\s*$/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Expéditeurs effectifs, par les fonctions mêmes qui décident à l'envoi (`resolve…` de `email-alerts`)
 * appliquées à la seule liste blanche de variables. Aucun secret n'entre dans cette configuration.
 */
export function buildAddressRows(
  env: EmailAddressEnv,
  templates: readonly EmailTemplateDefinition[],
): EmailAddressRow[] {
  const bySender = (variable: string) =>
    templates.filter((template) => template.sender === variable).map((template) => template.label);
  const byKey = (...keys: string[]) =>
    templates.filter((template) => keys.includes(template.key)).map((template) => template.label);

  const alertFrom = resolveEmailAlertDeliveryConfig(env).from;
  const transactionalFrom = resolveTransactionalEmailConfig(env).from;
  const replyTo = resolveReplyTo(env);
  const contactTo = filled(env.CONTACT_EMAIL_TO) ?? filled(env.NEXT_PUBLIC_LEGAL_CONTACT_EMAIL);
  const inboundDomain = filled(env.INFORMATION_AGENT_INBOUND_DOMAIN)?.toLowerCase() ?? null;

  const row = (
    variable: EmailAddressVariable,
    label: string,
    value: string | null,
    options: {
      fallbackFrom?: string;
      consequence?: string;
      domain?: string | null;
      usedBy?: string[];
    } = {},
  ): EmailAddressRow => ({
    variable,
    label,
    value,
    origin: !value ? "missing" : options.fallbackFrom ? "fallback" : "configured",
    ...(value && options.fallbackFrom ? { fallbackFrom: options.fallbackFrom } : {}),
    ...(!value && options.consequence ? { consequence: options.consequence } : {}),
    domain: options.domain === undefined ? null : options.domain,
    usedBy: options.usedBy ?? [],
  });

  return [
    row("ALERT_EMAIL_FROM", "Expéditeur des alertes et des messages aux comptes", alertFrom, {
      fallbackFrom: filled(env.ALERT_EMAIL_FROM)
        ? undefined
        : "RESEND_FROM_EMAIL (ancienne variable)",
      consequence: "Aucun email aux comptes ne part.",
      domain: addressDomain(alertFrom),
      usedBy: bySender("ALERT_EMAIL_FROM"),
    }),
    row(
      "TRANSACTIONAL_EMAIL_FROM",
      "Expéditeur de la facturation et des commandes",
      transactionalFrom,
      {
        fallbackFrom: filled(env.TRANSACTIONAL_EMAIL_FROM) ? undefined : "ALERT_EMAIL_FROM",
        consequence: "Aucun email de facturation ne part.",
        domain: addressDomain(transactionalFrom),
        usedBy: bySender("TRANSACTIONAL_EMAIL_FROM"),
      },
    ),
    row(
      "INFORMATION_AGENT_EMAIL_FROM",
      "Expéditeur de l’agent d’information",
      filled(env.INFORMATION_AGENT_EMAIL_FROM),
      {
        consequence: "L’envoi de l’agent est bloqué (aucun repli sur les alertes).",
        domain: addressDomain(filled(env.INFORMATION_AGENT_EMAIL_FROM)),
        usedBy: bySender("INFORMATION_AGENT_EMAIL_FROM"),
      },
    ),
    row(
      "CONTACT_EMAIL_FROM",
      "Expéditeur du formulaire de contact",
      filled(env.CONTACT_EMAIL_FROM),
      {
        consequence: "Le formulaire de contact répond qu’il est indisponible.",
        domain: addressDomain(filled(env.CONTACT_EMAIL_FROM)),
        usedBy: bySender("CONTACT_EMAIL_FROM"),
      },
    ),
    row("EMAIL_REPLY_TO", "Adresse de réponse des emails aux comptes", replyTo, {
      fallbackFrom:
        replyTo && replyTo !== filled(env.EMAIL_REPLY_TO)
          ? "NEXT_PUBLIC_LEGAL_CONTACT_EMAIL"
          : undefined,
      consequence: "Une réponse part vers l’expéditeur technique, qu’aucune personne ne lit.",
      usedBy: [...bySender("ALERT_EMAIL_FROM"), ...bySender("TRANSACTIONAL_EMAIL_FROM")],
    }),
    row(
      "NEXT_PUBLIC_LEGAL_CONTACT_EMAIL",
      "Adresse de contact publiée",
      filled(env.NEXT_PUBLIC_LEGAL_CONTACT_EMAIL),
      { consequence: "Pas de contact légal publié ; ni réponse ni destinataire de repli." },
    ),
    row("CONTACT_EMAIL_TO", "Destinataire du formulaire de contact", contactTo, {
      fallbackFrom:
        contactTo && !filled(env.CONTACT_EMAIL_TO) ? "NEXT_PUBLIC_LEGAL_CONTACT_EMAIL" : undefined,
      consequence: "Le formulaire de contact n’a pas de destinataire.",
      usedBy: byKey("contact_message"),
    }),
    row(
      "OPERATIONS_ALERT_EMAIL_TO",
      "Destinataire des incidents d’exploitation",
      filled(env.OPERATIONS_ALERT_EMAIL_TO),
      {
        consequence: "Aucun email d’incident : seul le canal GitHub prévient.",
        usedBy: byKey("operations_incident"),
      },
    ),
    row("INFORMATION_AGENT_INBOUND_DOMAIN", "Domaine de réception de l’agent", inboundDomain, {
      consequence: "L’agent ne peut ni envoyer ni recevoir de réponses.",
      domain: inboundDomain,
      usedBy: bySender("INFORMATION_AGENT_EMAIL_FROM"),
    }),
  ];
}
