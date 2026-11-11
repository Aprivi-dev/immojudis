import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  AUTO_PUBLICATION_ELIGIBLE_FIELDS,
  type AutoPublicationEligibleField,
} from "@/lib/information-agent/auto-publication-policy";

/**
 * Jeu d'évaluation de la publication automatique (étape 4 du plan d'enrichissement, proposition 8) :
 * 200 réponses FICTIVES d'avocats, 8 familles de pièges de 25 cas, chacune avec sa vérité de terrain pour les
 * trois champs de la liste fermée. Fichiers JSON communs avec le pipeline Python
 * (`services/data-pipeline/tests/fixtures/information_agent_evaluation/`). Module réservé aux tests : il lit
 * le disque et n'est importé par aucune page.
 */

export const EVALUATION_ROOT = "services/data-pipeline/tests/fixtures/information_agent_evaluation";

/** Familles de pièges : numéro, fichier et libellé. 25 cas chacune. */
export const EVALUATION_FAMILIES = [
  { number: 1, file: "famille_1_nettes.json", label: "réponses nettes, contexte compris" },
  { number: 2, file: "famille_2_reserves.json", label: "conditionnel, approximation, réserve" },
  { number: 3, file: "famille_3_lots.json", label: "plusieurs lots, autre lot, lot non nommé" },
  {
    number: 4,
    file: "famille_4_corrections.json",
    label: "valeur corrigée, périmée, contradictoire",
  },
  { number: 5, file: "famille_5_confusions.json", label: "confusion de champs" },
  { number: 6, file: "famille_6_ne_pas_publier.json", label: "ne pas publier, confidentialité" },
  {
    number: 7,
    file: "famille_7_manipulation.json",
    label: "manipulation du modèle, contenu trompeur",
  },
  { number: 8, file: "famille_8_tiers.json", label: "particuliers, tiers, pièce jointe" },
] as const;
export const CASES_PER_FAMILY = 25;

const numberOrNull = z.number().finite().nullable();

const modelReading = z
  .object({
    valeur: z.number().finite().positive(),
    /** Citation recopiée du texte (corps ou pièce jointe), telle qu'un modèle exact la rendrait. */
    citation: z.string().min(1),
    /** `corps` ou le nom d'une pièce jointe du cas. */
    source: z.string().min(1),
  })
  .strict();

const fieldTruth = z.discriminatedUnion("publiable", [
  z
    .object({
      publiable: z.literal(true),
      valeur: z.number().finite().positive(),
      citation: z.string().min(1),
    })
    .strict(),
  z
    .object({
      publiable: z.literal(false),
      /** Raison humaine de la non-publication. */
      raison: z.string().min(10),
      /**
       * Ce qu'un modèle exact lirait pour ce champ (la valeur que le texte attribue vraiment au bien), ou
       * `null` s'il ne doit rien proposer. Sert à la configuration « modèle idéal ».
       */
      lecture_modele: modelReading.nullable(),
    })
    .strict(),
]);

const caseSchema = z
  .object({
    id: z.string().regex(/^F[1-8]-\d{2}$/u),
    famille: z.number().int().min(1).max(8),
    titre: z.string().min(5),
    message: z
      .object({
        expediteur: z.string().email(),
        objet: z.string().min(1),
        corps: z.string().min(20),
        pieces_jointes: z
          .array(
            z
              .object({ nom: z.string().regex(/^[\w.-]+\.txt$/u), texte: z.string().min(20) })
              .strict(),
          )
          .max(3),
      })
      .strict(),
    contexte: z
      .object({
        type_de_bien: z
          .enum([
            "apartment",
            "house",
            "building",
            "commercial",
            "mixed",
            "land",
            "parking",
            "other",
          ])
          .nullable(),
        quality_flags: z.array(z.string()),
        lot_vendu: z
          .object({
            lot_number: z.number().int().positive(),
            lot_count: z.number().int().positive().nullable(),
          })
          .strict()
          .nullable(),
        fiche: z
          .object({
            surface_m2: numberOrNull,
            app_surface_m2: numberOrNull,
            habitable_surface_m2: numberOrNull,
            carrez_surface_m2: numberOrNull,
            land_surface_m2: numberOrNull,
            rooms_count: numberOrNull,
            app_surface_kind: z.string().nullable(),
            surface_scope: z.string().nullable(),
          })
          .strict(),
        destinataire: z.enum(["source_lawyer", "source_contact", "manual_professional"]),
        expediteur_est_destinataire: z.boolean(),
        authentification: z
          .object({
            dkim: z.enum(["pass", "fail", "none"]),
            dmarc: z.enum(["pass", "fail", "none"]),
          })
          .strict(),
        /** Jours entre l'envoi de notre demande et la réception de la réponse. */
        delai_jours: z.number().min(0).max(120),
        /** Messages entrants du même dossier reçus après celui-ci (en relecture, comme dans la vraie chaîne). */
        messages_posterieurs: z.array(z.object({ objet: z.string(), corps: z.string() }).strict()),
      })
      .strict(),
    verite: z
      .object({
        surface_m2: fieldTruth,
        land_surface_m2: fieldTruth,
        rooms_count: fieldTruth,
      })
      .strict(),
  })
  .strict();

const familyFileSchema = z
  .object({
    _comment: z.string(),
    famille: z.number().int().min(1).max(8),
    libelle: z.string(),
    cas: z.array(caseSchema),
  })
  .strict();

export type EvaluationCase = z.infer<typeof caseSchema>;
export type FieldTruth = z.infer<typeof fieldTruth>;
export type EvaluationField = AutoPublicationEligibleField;
export const EVALUATION_FIELDS: readonly EvaluationField[] = AUTO_PUBLICATION_ELIGIBLE_FIELDS;

/** Lit et valide les 8 fichiers de familles (erreur détaillée au premier écart). */
export function loadEvaluationCases(root = process.cwd()): EvaluationCase[] {
  return EVALUATION_FAMILIES.flatMap(({ number, file }) => {
    const raw: unknown = JSON.parse(
      readFileSync(join(root, EVALUATION_ROOT, "cases", file), "utf8"),
    );
    const parsed = familyFileSchema.parse(raw);
    if (parsed.famille !== number) {
      throw new Error(`${file} : famille ${parsed.famille}, attendu ${number}`);
    }
    for (const evaluationCase of parsed.cas) {
      if (evaluationCase.famille !== number || !evaluationCase.id.startsWith(`F${number}-`)) {
        throw new Error(
          `${file} : le cas ${evaluationCase.id} n'appartient pas à la famille ${number}`,
        );
      }
    }
    return parsed.cas;
  });
}

/** Lit un fichier JSON du jeu (étapes intermédiaires, défauts connus). */
export function readEvaluationJson(relativePath: string, root = process.cwd()): unknown {
  return JSON.parse(readFileSync(join(root, EVALUATION_ROOT, relativePath), "utf8"));
}
