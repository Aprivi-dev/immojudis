import { track } from "@vercel/analytics";
import { isAudienceOptedOut } from "@/lib/audience-opt-out";

/**
 * Mesure du parcours : événements agrégés, sans identifiant de personne ni cookie, envoyés à
 * Vercel Analytics.
 *
 * Règles (voir « Mesure et performance » dans `docs/rgpd-processing-register.md`) :
 * - rien n'est envoyé quand le visiteur s'est opposé à la mesure d'audience dans ce navigateur
 *   (`audience-opt-out.ts`, interrupteur de la politique de confidentialité) ;
 * - la liste des noms et des propriétés est fermée : un événement ou une propriété hors de cette
 *   liste n'est jamais transmis ;
 * - les propriétés sont des catégories (booléen, statut), jamais un email, un identifiant
 *   d'utilisateur ou de vente, ni un texte saisi ;
 * - côté serveur et en test, l'appel ne fait rien.
 */

export const PRODUCT_EVENT_NAMES = [
  "signup_completed",
  "alert_created",
  "favorite_added",
  "sample_report_viewed",
  "offers_viewed",
  "checkout_started",
  "checkout_returned",
  "opening_notification_requested",
  "fees_simulator_used",
] as const;

export type ProductEventName = (typeof PRODUCT_EVENT_NAMES)[number];

export type ProductEventProperties = {
  signup_completed: undefined;
  alert_created: { email_consent: boolean };
  favorite_added: undefined;
  sample_report_viewed: undefined;
  offers_viewed: undefined;
  checkout_started: undefined;
  checkout_returned: { status: "success" | "cancelled" };
  opening_notification_requested: undefined;
  fees_simulator_used: undefined;
};

type PropertySpec = { kind: "boolean" } | { kind: "enum"; values: readonly string[] };

/** Propriétés admises par événement, avec leur domaine de valeurs. */
const PROPERTY_SPECS: { [N in ProductEventName]: Record<string, PropertySpec> } = {
  signup_completed: {},
  alert_created: { email_consent: { kind: "boolean" } },
  favorite_added: {},
  sample_report_viewed: {},
  offers_viewed: {},
  checkout_started: {},
  checkout_returned: { status: { kind: "enum", values: ["success", "cancelled"] } },
  opening_notification_requested: {},
  fees_simulator_used: {},
};

type TrackArguments<N extends ProductEventName> = ProductEventProperties[N] extends undefined
  ? []
  : [properties: ProductEventProperties[N]];

function trackingEnabled(): boolean {
  return typeof window !== "undefined" && process.env.NODE_ENV !== "test" && !isAudienceOptedOut();
}

/** Ne garde que les propriétés déclarées dont la valeur appartient au domaine prévu. */
export function sanitizeProductEventProperties(
  name: ProductEventName,
  properties: unknown,
): Record<string, string | boolean> | undefined {
  const specs = PROPERTY_SPECS[name];
  if (!specs || typeof properties !== "object" || properties === null) return undefined;

  const clean: Record<string, string | boolean> = {};
  for (const [key, spec] of Object.entries(specs)) {
    const value = (properties as Record<string, unknown>)[key];
    if (spec.kind === "boolean" && typeof value === "boolean") clean[key] = value;
    if (spec.kind === "enum" && typeof value === "string" && spec.values.includes(value)) {
      clean[key] = value;
    }
  }
  return Object.keys(clean).length ? clean : undefined;
}

export function trackProductEvent<N extends ProductEventName>(
  name: N,
  ...args: TrackArguments<N>
): void {
  if (!trackingEnabled()) return;
  if (!PRODUCT_EVENT_NAMES.includes(name)) return;
  try {
    const properties = sanitizeProductEventProperties(name, args[0]);
    if (properties) track(name, properties);
    else track(name);
  } catch {
    // La mesure ne doit jamais gêner le parcours.
  }
}
