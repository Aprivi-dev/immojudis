/**
 * Origine « lecture automatique des pièces » des valeurs affichées sur la fiche (lot V3b-2). La passe d'écriture
 * du pipeline (`services/data-pipeline/src/document_vision_pass.py`) remplit des cases vides (surface habitable ou
 * Carrez, terrain, nombre de pièces) ; la base rend, par colonne affichée dont la valeur est encore celle écrite
 * (`get_public_sale_document_fact_sources`), le type de la pièce, sa page et l'empreinte SHA-256 de son adresse.
 * Jamais la valeur, la citation ni l'adresse.
 *
 * Une seule règle décide où la mention s'affiche (`documentSourceForDisplayedValue`), pour la fiche publique comme
 * pour la fiche des comptes. La mention devient un lien vers la pièce seulement quand la vue de la fiche sert déjà
 * cette pièce (offre Analyse, vente débloquée) : `documentFactLinks` compare l'empreinte aux adresses des pièces
 * que la vente porte, sans recopier la règle d'accès des vues.
 */

import { safeDocumentUrl } from "@/lib/withdrawn-sources";
import { documentTypeLabel } from "@/lib/format/documents";
import type { DocumentFactKey, DocumentFactSource } from "@/lib/types";

export type { DocumentFactKey, DocumentFactSource };

const KEYS: ReadonlySet<string> = new Set<DocumentFactKey>([
  "app_surface_m2",
  "land_surface_m2",
  "rooms_count",
]);
const DOCUMENT_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const DOCUMENT_KEY = /^[0-9a-f]{64}$/;

/**
 * Lignes de la RPC, validées une à une : une ligne hors contrat est ignorée (jamais de mention inventée). Une
 * colonne n'apparaît qu'une fois.
 */
export function parseDocumentFactSources(data: unknown): DocumentFactSource[] {
  if (!Array.isArray(data)) return [];
  const sources = new Map<DocumentFactKey, DocumentFactSource>();
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const {
      fact_key: key,
      document_type: documentType,
      page_number: page,
      document_key: documentKey,
    } = row as Record<string, unknown>;
    if (typeof key !== "string" || !KEYS.has(key)) continue;
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1) continue;
    if (!sources.has(key as DocumentFactKey)) {
      sources.set(key as DocumentFactKey, {
        key: key as DocumentFactKey,
        documentType:
          typeof documentType === "string" && DOCUMENT_TYPE.test(documentType)
            ? documentType
            : null,
        page,
        documentKey:
          typeof documentKey === "string" && DOCUMENT_KEY.test(documentKey) ? documentKey : null,
      });
    }
  }
  return [...sources.values()];
}

type DocumentFactSourcesClient = {
  rpc: (
    fn: "get_public_sale_document_fact_sources",
    args: { p_sale_id: string },
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

/** Lecture en échec : le code seul, jamais le message ni la vente. */
export class DocumentFactSourcesReadError extends Error {
  constructor(readonly code: string) {
    super(`get_public_sale_document_fact_sources failed (${code})`);
    this.name = "DocumentFactSourcesReadError";
  }
}

/**
 * Lecture de la projection publique, par la fiche seule (serveur : `lookupPublicSale` ; navigateur : la requête
 * de la page de la vente). Toute erreur est levée (`DocumentFactSourcesReadError`) : l'appelant ne la met jamais
 * en cache comme « aucune mention ».
 */
export async function fetchDocumentFactSources(
  client: DocumentFactSourcesClient,
  saleId: string,
): Promise<DocumentFactSource[]> {
  let answer: { data: unknown; error: unknown };
  try {
    answer = await client.rpc("get_public_sale_document_fact_sources", { p_sale_id: saleId });
  } catch {
    throw new DocumentFactSourcesReadError("network");
  }
  if (answer.error) {
    throw new DocumentFactSourcesReadError(
      String((answer.error as { code?: unknown }).code ?? "unknown"),
    );
  }
  return parseDocumentFactSources(answer.data);
}

/** Trace d'une lecture en échec : une ligne JSON avec le code d'erreur seul. */
export function warnDocumentFactSourcesFailure(error: unknown): void {
  console.warn(
    JSON.stringify({
      scope: "public-sale-document-fact-sources",
      level: "warn",
      event: "rpc_failed",
      code: error instanceof DocumentFactSourcesReadError ? error.code : "exception",
    }),
  );
}

/** La vente avec ses sources, inchangée (même objet) quand il n'y en a pas. */
export function withDocumentFactSources<T extends object>(
  sale: T,
  sources: readonly DocumentFactSource[] | null | undefined,
): T {
  return sources?.length ? { ...sale, document_fact_sources: [...sources] } : sale;
}

type SaleForDocumentSources = {
  document_fact_sources?: readonly DocumentFactSource[] | null;
  app_surface_m2?: number | null;
  land_surface_m2?: number | null;
  rooms_count?: number | null;
};

function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function sourceOf(sale: SaleForDocumentSources, key: DocumentFactKey): DocumentFactSource | null {
  return sale.document_fact_sources?.find((source) => source.key === key) ?? null;
}

/**
 * LA règle : la pièce d'où vient la valeur affichée, ou `null`.
 *  - `blocked` : la valeur est masquée (relecture en cours, valeur absente) : jamais de mention ;
 *  - surface : `surface` est le nombre affiché ; il vient de la lecture s'il est la surface de la fiche écrite par
 *    elle (`app_surface_m2`, déduite de la surface habitable ou Carrez lue) ou le terrain lu (`land_surface_m2`,
 *    vente « terrain seul ») ;
 *  - pièces : le nombre de pièces, jamais les chambres (la lecture ne les relève pas).
 * La base ne rend une colonne que si sa valeur est encore celle écrite par la lecture.
 */
export function documentSourceForDisplayedValue(
  sale: SaleForDocumentSources,
  value: "surface" | "rooms_count",
  options: { blocked?: boolean; surface?: number | null } = {},
): DocumentFactSource | null {
  if (options.blocked || !sale.document_fact_sources?.length) return null;
  if (value === "rooms_count") {
    return positive(sale.rooms_count) != null ? sourceOf(sale, "rooms_count") : null;
  }
  const shown = positive(options.surface ?? sale.app_surface_m2);
  if (shown == null) return null;
  if (shown === positive(sale.app_surface_m2) && sourceOf(sale, "app_surface_m2")) {
    return sourceOf(sale, "app_surface_m2");
  }
  return shown === positive(sale.land_surface_m2) ? sourceOf(sale, "land_surface_m2") : null;
}

/** Une valeur de la fiche dans la mention : son nom, et s'il est féminin (pour l'accord de « relevé »). */
export type DocumentNoteLabel = { noun: string; feminine: boolean };

export const DOCUMENT_SURFACE_LABEL: DocumentNoteLabel = { noun: "surface", feminine: true };
export const DOCUMENT_ROOMS_LABEL: DocumentNoteLabel = {
  noun: "nombre de pièces",
  feminine: false,
};

export type DocumentNoteItem = { label: DocumentNoteLabel; source: DocumentFactSource | null };

/** Une phrase de la mention : les valeurs nommées, la pièce et sa page, et l'empreinte de la pièce. */
export type DocumentNoteSentence = {
  /** « Surface relevée automatiquement dans » : le début de la phrase, avant la pièce. */
  lead: string;
  /** « la pièce « Cahier des conditions », page 12 » : la partie qui devient un lien vers la pièce. */
  piece: string;
  page: number;
  documentKey: string | null;
};

function pieceText(source: DocumentFactSource): string {
  const where = source.documentType
    ? `la pièce « ${documentTypeLabel(source.documentType)} »`
    : "une pièce du dossier";
  return `${where}, page ${source.page}`;
}

function joinNouns(nouns: string[]): string {
  if (nouns.length < 2) return nouns[0] ?? "";
  return `${nouns.slice(0, -1).join(", ")} et ${nouns.at(-1)}`;
}

/**
 * Texte de la mention d'un bloc : une phrase par pièce et par page, qui nomme les valeurs concernées
 * (« Surface et nombre de pièces relevés automatiquement dans la pièce « Cahier des conditions », page 12 »).
 * Le type de la pièce est celui de la liste des pièces de la fiche (`documentTypeLabel`).
 */
export function documentNoteSentences(items: readonly DocumentNoteItem[]): DocumentNoteSentence[] {
  const groups = new Map<string, { source: DocumentFactSource; labels: DocumentNoteLabel[] }>();
  for (const item of items) {
    if (!item.source) continue;
    const id = `${item.source.documentKey ?? ""}|${item.source.documentType ?? ""}|${item.source.page}`;
    const group = groups.get(id) ?? { source: item.source, labels: [] };
    group.labels.push(item.label);
    groups.set(id, group);
  }
  return [...groups.values()].map(({ source, labels }) => {
    const nouns = joinNouns(labels.map((label) => label.noun));
    const feminine = labels.every((label) => label.feminine);
    const participle = `relevé${feminine ? "e" : ""}${labels.length > 1 ? "s" : ""}`;
    return {
      lead: `${nouns.charAt(0).toUpperCase()}${nouns.slice(1)} ${participle} automatiquement dans`,
      piece: pieceText(source),
      page: source.page,
      documentKey: source.documentKey,
    };
  });
}

/** Adresses brutes des pièces que la vue de la fiche sert (vide pour la fiche publique et l'offre Découverte). */
function servedDocumentUrls(sale: { documents_rich?: unknown; documents?: unknown }): string[] {
  const urls: string[] = [];
  for (const list of [sale.documents_rich, sale.documents]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const url =
        typeof entry === "string"
          ? entry
          : entry &&
              typeof entry === "object" &&
              typeof (entry as { url?: unknown }).url === "string"
            ? (entry as { url: string }).url
            : null;
      if (url) urls.push(url);
    }
  }
  return urls;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Liens vers les pièces citées par les mentions, par empreinte : seulement pour une pièce que la vue de la fiche
 * sert déjà, et que la fiche proposerait elle-même (`safeDocumentUrl` : adresse web, source non retirée). Sans
 * pièce servie, aucun calcul. Le lien ouvre la page citée (`#page=N`, lu par les lecteurs PDF des navigateurs).
 */
export async function documentFactLinks(
  sale: { documents_rich?: unknown; documents?: unknown },
  sentences: readonly Pick<DocumentNoteSentence, "documentKey" | "page">[],
): Promise<Map<string, string>> {
  const wanted = new Set(sentences.map((sentence) => sentence.documentKey).filter(Boolean));
  const links = new Map<string, string>();
  if (!wanted.size || typeof crypto === "undefined" || !crypto.subtle) return links;
  const served = new Map<string, string>();
  for (const raw of servedDocumentUrls(sale)) {
    const safe = safeDocumentUrl(raw);
    if (!safe) continue;
    const key = await sha256Hex(raw);
    if (wanted.has(key) && !served.has(key)) served.set(key, safe);
  }
  for (const sentence of sentences) {
    const url = sentence.documentKey ? served.get(sentence.documentKey) : undefined;
    if (!url || !sentence.documentKey) continue;
    links.set(
      `${sentence.documentKey}|${sentence.page}`,
      url.includes("#") ? url : `${url}#page=${sentence.page}`,
    );
  }
  return links;
}
