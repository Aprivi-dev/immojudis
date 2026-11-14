/**
 * Acceptation d'une réponse d'avocat par le registre des pièces (lot C du 14/11/2026, T4). Module sans
 * dépendance serveur : la route de relecture et le panneau « Informations à contrôler » le lisent.
 *
 * « Accepter et mettre à jour la fiche » enregistre deux choses, dans cet ordre :
 *  1. l'acceptation du fait de l'agent (`review_information_agent_fact_candidate`), qui écrit le journal de
 *     l'agent et crée l'observation du registre (le pont) ;
 *  2. la décision d'acceptation de l'administrateur au registre, avec SON jeton : la projection écrit la valeur
 *     sur la fiche et la tient contre la collecte, et la décision figure au journal du registre.
 * La base reste juge (migration `20261119100900_information_agent_acceptance_through_registry.sql`) : les copies
 * ci-dessous servent à demander le rattachement au lot et à refuser tôt, avec un message clair. Le test
 * `information-agent-registry-acceptance.test.ts` les compare aux définitions de la base.
 */

/** Faits de l'agent que le pont range en observation du registre, et leur champ (`information_agent_fact_registry_field`). */
export const INFORMATION_AGENT_REGISTRY_FACT_FIELDS: Readonly<Record<string, string>> = {
  surface_m2: "property.surface_m2",
  land_surface_m2: "property.land_surface_m2",
  rooms_count: "property.rooms_count",
  occupancy_status: "property.occupancy_status",
  starting_price_eur: "sale.starting_price_eur",
  sale_date: "sale.sale_date",
  property_type: "property.property_type",
};

/** Le fait devient-il une observation du registre (et sa décision demande-t-elle un rattachement au lot) ? */
export function informationAgentFactRegistryField(factKey: string): string | null {
  return Object.hasOwn(INFORMATION_AGENT_REGISTRY_FACT_FIELDS, factKey)
    ? INFORMATION_AGENT_REGISTRY_FACT_FIELDS[factKey]!
    : null;
}

/**
 * Occupations qu'une pièce peut tenir (`app_private.sale_field_claim_value`) : libre, occupé, loué. Jamais qui
 * occupe ni pourquoi (plan du 11/11/2026, section 6, choix 5).
 */
export const REGISTRY_OCCUPANCY_VALUES = ["vacant", "occupied", "rented"] as const;

export const INFORMATION_AGENT_OCCUPANCY_REFUSED_MESSAGE =
  "Occupation non affichable : la fiche ne dit que « libre », « occupé » ou « loué », jamais qui occupe ni pourquoi. Rejetez cette information.";

/** Une occupation proposée que la fiche ne peut pas afficher (« occupé par le propriétaire », « squatté »…). */
export function informationAgentOccupancyRefused(factKey: string, value: unknown): boolean {
  return (
    factKey === "occupancy_status" &&
    !(REGISTRY_OCCUPANCY_VALUES as readonly unknown[]).includes(value)
  );
}

/** Ce que l'acceptation a donné au registre, rendu par la route de relecture. */
export type InformationAgentRegistryAcceptance = {
  claimId: string | null;
  saleId: string | null;
  /** État du champ après la projection (`held` : affichée et tenue ; nul : champ hors registre). */
  state: string | null;
  /** Décision non enregistrée : le message, déjà lisible. */
  error: string | null;
};

/**
 * Message de l'écran après « Accepter et mettre à jour la fiche ». `tone: "warning"` quand la valeur n'est
 * pas affichée : la réponse est acceptée, mais il reste quelque chose à faire.
 */
export function informationAgentAcceptanceMessage(
  registry: InformationAgentRegistryAcceptance | null,
): {
  tone: "success" | "warning";
  text: string;
} {
  if (!registry) {
    return {
      tone: "success",
      text: "Information contrôlée. La fiche sera réévaluée après enrichissement.",
    };
  }
  const queue = `Reprenez-la dans « Observations à décider »${
    registry.saleId ? ` (vente ${registry.saleId.slice(0, 8)})` : ""
  }.`;
  if (registry.error) {
    return {
      tone: "warning",
      text: `Réponse acceptée, mais la valeur n’est pas encore sur la fiche : ${registry.error} ${queue}`,
    };
  }
  switch (registry.state) {
    case "held":
    case "unchanged":
      return {
        tone: "success",
        text: "Valeur acceptée : affichée sur la fiche et protégée contre la collecte.",
      };
    case null:
      return {
        tone: "success",
        text: "Information acceptée et inscrite au registre. Ce champ n’est pas protégé par le registre : la collecte peut le réécrire.",
      };
    case "conflicted":
      return {
        tone: "warning",
        text: `Décision enregistrée, mais une autre pièce dit autre chose : la fiche n’a pas changé. ${queue}`,
      };
    case "blocked":
      return {
        tone: "warning",
        text: `Décision enregistrée, mais la fiche refuse cette valeur (vente de terrain, ou moins de pièces que de chambres). ${queue}`,
      };
    default:
      return {
        tone: "warning",
        text: `Décision enregistrée, mais la valeur n’est pas affichée (lot non identifié, ou valeur délogée). ${queue}`,
      };
  }
}
