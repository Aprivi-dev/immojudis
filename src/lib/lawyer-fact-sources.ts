/**
 * Origine « avocat poursuivant » des valeurs affichées sur la fiche (proposition 5, étape 2 du plan
 * d'enrichissement). La base rend une projection minimale par clé (`get_public_sale_lawyer_fact_sources`) :
 * la clé, le jour de réception de la réponse et le mode de publication, seulement quand la valeur de la
 * fiche est encore celle transmise. Jamais la valeur, l'extrait, l'expéditeur ni l'identifiant du fait.
 *
 * Module sans dépendance d'exécution : il sert à la fiche publique (rendu serveur) comme à la fiche des comptes.
 */

import type { LawyerFactKey, LawyerFactSource } from "@/lib/types";

export type { LawyerFactKey, LawyerFactSource };

/** Clés qui ont une colonne affichée sur la fiche. */
export const LAWYER_FACT_KEYS = [
  "surface_m2",
  "land_surface_m2",
  "rooms_count",
  "occupancy_status",
  "starting_price_eur",
  "sale_date",
  "property_type",
] as const satisfies readonly LawyerFactKey[];

const KEYS: ReadonlySet<string> = new Set(LAWYER_FACT_KEYS);
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Lignes de la RPC, validées une à une : une ligne hors contrat est ignorée (jamais d'erreur, jamais de
 * mention inventée). Une clé n'apparaît qu'une fois.
 */
export function parseLawyerFactSources(data: unknown): LawyerFactSource[] {
  if (!Array.isArray(data)) return [];
  const sources = new Map<LawyerFactKey, LawyerFactSource>();
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const {
      fact_key: key,
      received_on: receivedOn,
      publication_mode: mode,
    } = row as Record<string, unknown>;
    if (typeof key !== "string" || !KEYS.has(key)) continue;
    if (typeof receivedOn !== "string" || !DAY.test(receivedOn)) continue;
    if (mode !== "manual" && mode !== "auto") continue;
    if (!sources.has(key as LawyerFactKey)) {
      sources.set(key as LawyerFactKey, { key: key as LawyerFactKey, receivedOn, mode });
    }
  }
  return [...sources.values()];
}

type LawyerFactSourcesClient = {
  rpc: (
    fn: "get_public_sale_lawyer_fact_sources",
    args: { p_sale_id: string },
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

/**
 * Lecture de la projection publique (`get_public_sale_lawyer_fact_sources`), faite par la fiche seule
 * (serveur : `readPublicSale` ; navigateur : `loadSaleDetailRouteData`), jamais par le catalogue. Un
 * enrichissement : fonction absente, erreur ou réponse hors contrat donnent une liste vide, et la fiche
 * reste celle d'avant (aucune mention plutôt qu'une mention fausse).
 */
export async function fetchLawyerFactSources(
  client: LawyerFactSourcesClient,
  saleId: string,
): Promise<LawyerFactSource[]> {
  try {
    const { data, error } = await client.rpc("get_public_sale_lawyer_fact_sources", {
      p_sale_id: saleId,
    });
    return error ? [] : parseLawyerFactSources(data);
  } catch {
    return [];
  }
}

/** La vente avec ses sources, inchangée (même objet) quand il n'y en a pas. */
export function withLawyerFactSources<T extends object>(
  sale: T,
  sources: readonly LawyerFactSource[],
): T {
  return sources.length ? { ...sale, lawyer_fact_sources: [...sources] } : sale;
}

function frenchDay(receivedOn: string): string {
  const [, year, month, day] = DAY.exec(receivedOn) ?? [];
  return `${day}/${month}/${year}`;
}

/**
 * Mention affichée à côté de la valeur (texte validé le 10/11/2026). Le mode automatique ajoute
 * « extraite automatiquement ». Ni nom d'avocat, ni extrait du message.
 */
export function lawyerFactMention(source: Pick<LawyerFactSource, "receivedOn" | "mode">): string {
  const automatic = source.mode === "auto" ? ", extraite automatiquement" : "";
  return `Information transmise par l’avocat poursuivant le ${frenchDay(source.receivedOn)}${automatic}, non vérifiée par Immojudis. Vérifiez-la dans le cahier des conditions de vente.`;
}

type SaleWithLawyerSources = {
  lawyer_fact_sources?: readonly LawyerFactSource[] | null;
};

/** La source d'une clé de la fiche, ou `null`. */
export function lawyerFactSource(
  sale: SaleWithLawyerSources,
  key: LawyerFactKey,
): LawyerFactSource | null {
  return sale.lawyer_fact_sources?.find((source) => source.key === key) ?? null;
}
