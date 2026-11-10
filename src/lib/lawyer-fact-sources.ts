/**
 * Origine « avocat poursuivant » des valeurs affichées sur la fiche (proposition 5, étape 2 du plan
 * d'enrichissement). La base rend une projection minimale par clé (`get_public_sale_lawyer_fact_sources`) :
 * la clé, le jour de réception de la réponse et le mode de publication, seulement quand la réponse venait
 * d'un dossier adressé à l'avocat poursuivant et que la valeur de la fiche est encore celle transmise. Jamais
 * la valeur, l'extrait, l'expéditeur ni l'identifiant du fait.
 *
 * Une seule règle décide où la mention s'affiche (`lawyerSourceForDisplayedValue`), pour la fiche publique
 * comme pour la fiche des comptes. Module sans dépendance d'exécution, chargé par la fiche seule.
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
 * Lignes de la RPC, validées une à une : une ligne hors contrat est ignorée (jamais de mention inventée).
 * Une clé n'apparaît qu'une fois.
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

/** Lecture en échec (autre que la fonction absente) : le code seul, jamais le message ni la vente. */
export class LawyerFactSourcesReadError extends Error {
  constructor(readonly code: string) {
    super(`get_public_sale_lawyer_fact_sources failed (${code})`);
    this.name = "LawyerFactSourcesReadError";
  }
}

const MISSING_FUNCTION_CODES = new Set(["PGRST202", "42883"]);

/**
 * Lecture de la projection publique, par la fiche seule (serveur : `lookupPublicSale` ; navigateur :
 * la requête de la page de la vente). Une base sans la fonction (pas encore migrée) répond « aucune
 * mention ». Toute autre erreur est levée (`LawyerFactSourcesReadError`) : l'appelant ne la met jamais
 * en cache comme « aucune mention ».
 */
export async function fetchLawyerFactSources(
  client: LawyerFactSourcesClient,
  saleId: string,
): Promise<LawyerFactSource[]> {
  let answer: { data: unknown; error: unknown };
  try {
    answer = await client.rpc("get_public_sale_lawyer_fact_sources", { p_sale_id: saleId });
  } catch {
    throw new LawyerFactSourcesReadError("network");
  }
  if (answer.error) {
    const code = String((answer.error as { code?: unknown }).code ?? "unknown");
    if (MISSING_FUNCTION_CODES.has(code)) return [];
    throw new LawyerFactSourcesReadError(code);
  }
  return parseLawyerFactSources(answer.data);
}

/** Trace d'une lecture en échec : une ligne JSON avec le code d'erreur seul. */
export function warnLawyerFactSourcesFailure(error: unknown): void {
  console.warn(
    JSON.stringify({
      scope: "public-sale-lawyer-fact-sources",
      level: "warn",
      event: "rpc_failed",
      code: error instanceof LawyerFactSourcesReadError ? error.code : "exception",
    }),
  );
}

/** La vente avec ses sources, inchangée (même objet) quand il n'y en a pas. */
export function withLawyerFactSources<T extends object>(
  sale: T,
  sources: readonly LawyerFactSource[] | null | undefined,
): T {
  return sources?.length ? { ...sale, lawyer_fact_sources: [...sources] } : sale;
}

function frenchDay(receivedOn: string): string {
  const [, year, month, day] = DAY.exec(receivedOn) ?? [];
  return `${day}/${month}/${year}`;
}

/**
 * Mention affichée sous une seule valeur (texte validé le 10/11/2026). Le mode automatique ajoute
 * « extraite automatiquement ». Ni nom d'avocat, ni extrait du message.
 */
export function lawyerFactMention(source: Pick<LawyerFactSource, "receivedOn" | "mode">): string {
  const automatic = source.mode === "auto" ? ", extraite automatiquement" : "";
  return `Information transmise par l’avocat poursuivant le ${frenchDay(source.receivedOn)}${automatic}, non vérifiée par Immojudis. Vérifiez-la dans le cahier des conditions de vente.`;
}

/** Valeurs de la fiche qui peuvent porter la mention. */
export type LawyerDisplayedValue =
  | "property_type"
  | "surface"
  | "rooms_count"
  | "occupancy_status"
  | "starting_price_eur"
  | "sale_date";

type SaleForLawyerSources = {
  lawyer_fact_sources?: readonly LawyerFactSource[] | null;
  app_surface_m2?: number | null;
  land_surface_m2?: number | null;
  rooms_count?: number | null;
  property_type?: string | null;
  occupancy_status?: string | null;
  starting_price_eur?: number | null;
  sale_date?: string | null;
};

function sourceOf(sale: SaleForLawyerSources, key: LawyerFactKey): LawyerFactSource | null {
  return sale.lawyer_fact_sources?.find((source) => source.key === key) ?? null;
}

function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * LA règle : la source « avocat poursuivant » de la valeur affichée, ou `null`.
 *  - `blocked` : la valeur est masquée (relecture en cours, valeur absente) : jamais de mention ;
 *  - surface : `surface` est le nombre affiché ; il vient de l'avocat s'il est la surface transmise
 *    (`app_surface_m2`) ou le terrain transmis (`land_surface_m2`, vente « terrain seul ») ;
 *  - date : `displayedDate` est la date affichée ; une date tirée des modalités de vente (autre que la
 *    date de la vente) n'a pas de mention. La mention couvre le jour, jamais l'heure (`LAWYER_DAY_LABEL`) ;
 *  - pièces : la mention couvre le nombre de pièces, jamais les chambres (`LAWYER_ROOMS_LABEL`).
 * La base ne rend une clé que si la colonne est encore égale à la valeur transmise.
 */
export function lawyerSourceForDisplayedValue(
  sale: SaleForLawyerSources,
  value: LawyerDisplayedValue,
  options: { blocked?: boolean; surface?: number | null; displayedDate?: string | null } = {},
): LawyerFactSource | null {
  if (options.blocked || !sale.lawyer_fact_sources?.length) return null;
  switch (value) {
    case "property_type":
      return sale.property_type ? sourceOf(sale, "property_type") : null;
    case "surface": {
      const shown = positive(options.surface ?? sale.app_surface_m2);
      if (shown == null) return null;
      if (shown === positive(sale.app_surface_m2) && sourceOf(sale, "surface_m2")) {
        return sourceOf(sale, "surface_m2");
      }
      return shown === positive(sale.land_surface_m2) ? sourceOf(sale, "land_surface_m2") : null;
    }
    case "rooms_count":
      return positive(sale.rooms_count) != null ? sourceOf(sale, "rooms_count") : null;
    case "occupancy_status":
      return sale.occupancy_status && sale.occupancy_status !== "unknown"
        ? sourceOf(sale, "occupancy_status")
        : null;
    case "starting_price_eur":
      return positive(sale.starting_price_eur) != null
        ? sourceOf(sale, "starting_price_eur")
        : null;
    case "sale_date":
      if (!sale.sale_date) return null;
      if (options.displayedDate !== undefined && options.displayedDate !== sale.sale_date)
        return null;
      return sourceOf(sale, "sale_date");
  }
}

/** Libellés qui bornent la mention à ce que l'avocat a transmis. */
export const LAWYER_DAY_LABEL = "Jour de la vente (sans l’heure)";
export const LAWYER_ROOMS_LABEL = "Nombre de pièces (sans les chambres)";

export type LawyerNoteItem = { label: string; source: LawyerFactSource | null };

function joinLabels(labels: string[]): string {
  if (labels.length < 2) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} et ${labels.at(-1)!.toLocaleLowerCase("fr-FR")}`;
}

/**
 * Texte de la mention d'un bloc : une phrase par jour de réception et mode, qui nomme les valeurs
 * concernées (« Surface et mise à prix : information transmise… Vérifiez-les… »). Une seule valeur sans
 * libellé (`label: ""`) garde le texte validé tel quel.
 */
export function lawyerNoteSentences(items: readonly LawyerNoteItem[]): string[] {
  const groups = new Map<string, { source: LawyerFactSource; labels: string[] }>();
  for (const item of items) {
    if (!item.source) continue;
    const id = `${item.source.receivedOn}|${item.source.mode}`;
    const group = groups.get(id) ?? { source: item.source, labels: [] };
    if (item.label) group.labels.push(item.label);
    groups.set(id, group);
  }
  return [...groups.values()].map(({ source, labels }) => {
    const mention = lawyerFactMention(source);
    if (!labels.length) return mention;
    const sentence = `${joinLabels(labels)} : ${mention.charAt(0).toLocaleLowerCase("fr-FR")}${mention.slice(1)}`;
    return labels.length > 1 ? sentence.replace("Vérifiez-la", "Vérifiez-les") : sentence;
  });
}
