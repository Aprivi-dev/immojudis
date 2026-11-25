/**
 * Lecture de l'origine « lecture automatique des pièces » des valeurs de la fiche (lot V3b-2) :
 * `get_public_sale_document_fact_sources`, lignes validées une à une. Chargé par le serveur (`lookupPublicSale`) et,
 * à la demande, par le navigateur (`sale-document-fact-sources.client.ts`) ; l'affichage est dans
 * `document-fact-sources.ts`.
 */

import { documentTypeLabel } from "@/lib/format/documents";
import type { DocumentFactKey, DocumentFactSource } from "@/lib/types";

const KEYS: ReadonlySet<string> = new Set<DocumentFactKey>([
  "app_surface_m2",
  "land_surface_m2",
  "rooms_count",
]);
const DOCUMENT_TYPE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Lignes de la RPC, validées une à une : une ligne hors contrat est ignorée (jamais de mention inventée). Une
 * colonne n'apparaît qu'une fois. Le libellé de la pièce est celui de la liste des pièces de la fiche
 * (`documentTypeLabel`), posé ici pour que la table des libellés reste hors du JavaScript initial de la fiche.
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
      const type =
        typeof documentType === "string" && DOCUMENT_TYPE.test(documentType) ? documentType : null;
      sources.set(key as DocumentFactKey, {
        key: key as DocumentFactKey,
        documentType: type,
        documentLabel: type ? documentTypeLabel(type) : null,
        page,
        documentKey: typeof documentKey === "string" ? documentKey : null,
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
    super(code);
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
