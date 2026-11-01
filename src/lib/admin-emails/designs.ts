import "server-only";
import { EMAIL_TEMPLATES } from "@/lib/email-templates/registry";
import { forceDarkScheme } from "@/lib/email-templates/preview";
import type { EmailSampleVariant } from "@/lib/email-templates/types";
import { readEmailAddressEnv } from "./env";
import { buildAddressRows } from "./senders";
import { EMAIL_LEVEL_LABELS, type EmailViewBadge } from "./views";

export type DesignTemplate = {
  key: string;
  label: string;
  description: string;
  /** Catégorie, expéditeur effectif et niveau d'édition, déjà formulés. */
  badges: EmailViewBadge[];
  /** Bandeau d'avertissement (emails Supabase). */
  notice?: string;
  variants: EmailSampleVariant[];
  /** Raison pour laquelle aucun aperçu n'existe. */
  unavailable?: string;
};

export type EmailDesigns = {
  dark: boolean;
  /** Explication affichée au-dessus de la galerie. */
  intro: string;
  templates: DesignTemplate[];
};

const INTRO =
  "Aperçus rendus par les vrais gabarits avec des données fictives, sans script. Le mode sombre applique nos propres règles : ce n’est pas l’inversion automatique de Gmail.";

const SUPABASE_NOTICE =
  "Copie de référence : appliquée par le workflow « Apply Supabase Auth Config » (lancement manuel, GitHub Actions) ou à coller dans Supabase (Authentication, Emails).";

/** Le texte brut n'accompagne la variante que sans HTML (formulaire de contact). */
function galleryVariant(variant: EmailSampleVariant, dark: boolean): EmailSampleVariant {
  return {
    ...variant,
    html: variant.html !== null && dark ? forceDarkScheme(variant.html) : variant.html,
    text: variant.html === null ? variant.text : "",
  };
}

/**
 * Galerie des aperçus, rendue ici par les vrais constructeurs d'emails et des données fictives : le
 * navigateur ne reçoit que du HTML à placer dans une iframe `sandbox=""`. Un gabarit dont l'aperçu
 * échoue n'empêche pas les autres.
 */
export async function getEmailDesigns({ dark }: { dark: boolean }): Promise<EmailDesigns> {
  const senders = new Map(
    buildAddressRows(readEmailAddressEnv(), EMAIL_TEMPLATES).map((row) => [
      row.variable,
      row.value,
    ]),
  );
  const templates = await Promise.all(
    EMAIL_TEMPLATES.map(async (definition): Promise<DesignTemplate> => {
      // Expéditeur effectif, après repli ; les emails d'authentification partent du SMTP de Supabase.
      const sender = definition.sender ? senders.get(definition.sender) : "SMTP de Supabase";
      const base: DesignTemplate = {
        key: definition.key,
        label: definition.label,
        description: definition.description,
        badges: [
          { text: `Catégorie : ${definition.category ?? "aucune"}`, tone: "neutral" },
          sender
            ? { text: `Expéditeur : ${sender}`, tone: "neutral" }
            : { text: `Expéditeur : ${definition.sender} non configuré`, tone: "bad" },
          { text: EMAIL_LEVEL_LABELS[definition.level], tone: "neutral" },
        ],
        ...(definition.level === "supabase" ? { notice: SUPABASE_NOTICE } : {}),
        variants: [],
      };
      if (!definition.sample) return { ...base, unavailable: definition.sampleUnavailable };
      try {
        const variants = await definition.sample();
        return { ...base, variants: variants.map((variant) => galleryVariant(variant, dark)) };
      } catch (error) {
        console.error(
          JSON.stringify({
            scope: "admin.emails.designs",
            template: definition.key,
            error: error instanceof Error ? error.name : "Error",
          }),
        );
        return {
          ...base,
          unavailable: "L’aperçu de ce gabarit a échoué : voir les journaux du serveur.",
        };
      }
    }),
  );
  return { dark, intro: INTRO, templates };
}
