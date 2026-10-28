import { track } from "@vercel/analytics";
import { isAudienceOptedOut } from "@/lib/audience-opt-out";
import { LOGIN_REASONS } from "@/lib/navigation";

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
  "signup_submitted",
  "signup_confirmed",
  "alert_created",
  "favorite_added",
  "sample_report_viewed",
  "offers_viewed",
  "checkout_started",
  "checkout_returned",
  "opening_notification_requested",
  "fees_simulator_used",
  "home_example_used",
  "pepite_block_viewed",
  "pepite_filter_used",
] as const;

export type ProductEventName = (typeof PRODUCT_EVENT_NAMES)[number];

/**
 * D'où vient l'inscription : la raison du détour par la page de connexion (`LOGIN_REASONS`, dont
 * « exemple » pour l'annonce exemple) ou `direct` (page ouverte sans raison). Valeurs fermées.
 */
export const SIGNUP_ENTRIES = [...LOGIN_REASONS, "direct"] as const;
export type SignupEntry = (typeof SIGNUP_ENTRIES)[number];

export type ProductEventProperties = {
  signup_submitted: { entry: SignupEntry };
  signup_confirmed: undefined;
  alert_created: { email_consent: boolean; pepite_only?: boolean };
  favorite_added: undefined;
  sample_report_viewed: undefined;
  offers_viewed: undefined;
  checkout_started: undefined;
  checkout_returned: { status: "success" | "cancelled" };
  opening_notification_requested: undefined;
  fees_simulator_used: undefined;
  home_example_used: undefined;
  /** `locked` : noms des critères seuls (visiteur, compte Découverte) ; `detail` : détail ouvert. */
  pepite_block_viewed: { access: "locked" | "detail" };
  pepite_filter_used: undefined;
};

type PropertySpec = { kind: "boolean" } | { kind: "enum"; values: readonly string[] };

/** Propriétés admises par événement, avec leur domaine de valeurs. */
const PROPERTY_SPECS: { [N in ProductEventName]: Record<string, PropertySpec> } = {
  signup_submitted: { entry: { kind: "enum", values: SIGNUP_ENTRIES } },
  signup_confirmed: {},
  alert_created: { email_consent: { kind: "boolean" }, pepite_only: { kind: "boolean" } },
  favorite_added: {},
  sample_report_viewed: {},
  offers_viewed: {},
  checkout_started: {},
  checkout_returned: { status: { kind: "enum", values: ["success", "cancelled"] } },
  opening_notification_requested: {},
  fees_simulator_used: {},
  home_example_used: {},
  pepite_block_viewed: { access: { kind: "enum", values: ["locked", "detail"] } },
  pepite_filter_used: {},
};

type TrackArguments<N extends ProductEventName> = ProductEventProperties[N] extends undefined
  ? []
  : [properties: ProductEventProperties[N]];

/**
 * `@vercel/analytics` n'installe `window.va` qu'à l'injection de son script, que `AudienceMeasurement`
 * attend d'un navigateur inactif : un événement envoyé au montage d'une page (`offers_viewed`,
 * `sample_report_viewed`) serait perdu. On installe donc la même file d'attente que le paquet
 * (`window.vaq`), que le script vide en arrivant ; le paquet la laisse en place si elle existe.
 */
function ensureVercelQueue(): void {
  if (window.va) return;
  window.va = function queueVercelAnalyticsEvent(...params) {
    (window.vaq ??= []).push(params);
  };
}

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
    ensureVercelQueue();
    const properties = sanitizeProductEventProperties(name, args[0]);
    if (properties) track(name, properties);
    else track(name);
  } catch {
    // La mesure ne doit jamais gêner le parcours.
  }
}
