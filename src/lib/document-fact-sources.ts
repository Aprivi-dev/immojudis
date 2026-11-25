/**
 * Origine « lecture automatique des pièces » des valeurs affichées sur la fiche (lot V3b-2). La passe d'écriture
 * du pipeline (`services/data-pipeline/src/document_vision_pass.py`) remplit des cases vides (surface habitable ou
 * Carrez, terrain, nombre de pièces) ; la base rend, par colonne affichée dont la valeur est encore celle écrite
 * (`get_public_sale_document_fact_sources`), le type de la pièce, sa page et l'empreinte SHA-256 de son adresse.
 * Jamais la valeur, la citation ni l'adresse.
 *
 * Une seule règle décide où la mention s'affiche (`documentSourceForDisplayedValue`), pour la fiche publique comme
 * pour la fiche des comptes. La mention devient un lien vers la pièce seulement quand la vue de la fiche sert déjà
 * cette pièce (offre Analyse, vente débloquée) : `documentFactLinks` (`document-fact-links.ts`, chargé avec la fiche
 * des comptes seulement) compare l'empreinte aux adresses des pièces que la vente porte, sans recopier la règle
 * d'accès des vues. La lecture et la validation des lignes de la base sont dans `document-fact-sources-read.ts`
 * (serveur, et module chargé à la demande par le navigateur) : ce module-ci reste léger dans le JavaScript initial
 * de la fiche.
 */

import type { DocumentFactKey, DocumentFactSource } from "@/lib/types";

export type { DocumentFactKey, DocumentFactSource };

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
  return (
    (shown === positive(sale.app_surface_m2) && sourceOf(sale, "app_surface_m2")) ||
    (shown === positive(sale.land_surface_m2) && sourceOf(sale, "land_surface_m2")) ||
    null
  );
}

/**
 * Une valeur de la fiche dans la mention : son nom et le participe accordé (« surface relevée », « nombre de pièces
 * relevé »). Deux valeurs d'une même page se disent ensemble, au masculin pluriel (« Surface et nombre de pièces
 * relevés ») : la mention ne nomme que la surface et le nombre de pièces.
 */
export type DocumentNoteLabel = { noun: string; participle: string };

export const DOCUMENT_SURFACE_LABEL: DocumentNoteLabel = { noun: "surface", participle: "relevée" };
export const DOCUMENT_ROOMS_LABEL: DocumentNoteLabel = {
  noun: "nombre de pièces",
  participle: "relevé",
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

/**
 * Texte de la mention d'un bloc : une phrase par pièce et par page, qui nomme les valeurs concernées
 * (« Surface et nombre de pièces relevés automatiquement dans la pièce « Cahier des conditions », page 12 »).
 * Le type de la pièce est celui de la liste des pièces de la fiche (`documentLabel`, posé à la lecture).
 */
export function documentNoteSentences(items: readonly DocumentNoteItem[]): DocumentNoteSentence[] {
  const groups = new Map<string, { source: DocumentFactSource; labels: DocumentNoteLabel[] }>();
  for (const { source, label } of items) {
    if (!source) continue;
    const id = `${source.documentKey}|${source.documentLabel}|${source.page}`;
    const group = groups.get(id) ?? { source, labels: [] };
    group.labels.push(label);
    groups.set(id, group);
  }
  return [...groups.values()].map(({ source, labels }) => {
    const nouns = labels.map((label) => label.noun).join(" et ");
    const participle = labels.length > 1 ? "relevés" : labels[0].participle;
    const piece = source.documentLabel
      ? `la pièce « ${source.documentLabel} »`
      : "une pièce du dossier";
    return {
      lead: `${nouns[0].toUpperCase()}${nouns.slice(1)} ${participle} automatiquement dans`,
      piece: `${piece}, page ${source.page}`,
      page: source.page,
      documentKey: source.documentKey,
    };
  });
}
