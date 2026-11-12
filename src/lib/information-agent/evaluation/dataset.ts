import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  renderInformationAgentEmailContent,
} from "@/lib/information-agent-email-template";
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
  { number: 9, file: "famille_9_complements.json", label: "compléments de la relecture" },
] as const;
/** Cas par famille : 25 pour les 8 familles de pièges, 15 pour la série de compléments. */
export const CASES_PER_FAMILY: Record<number, number> = {
  1: 25,
  2: 25,
  3: 25,
  4: 25,
  5: 25,
  6: 25,
  7: 25,
  8: 25,
  9: 15,
};
export const EVALUATION_CASE_COUNT = 215;

/** Source d'une valeur : le corps du message évalué ou un message voisin du dossier. */
const messageSource = z.string().regex(/^(?:corps|anterieur-\d|posterieur-\d)$/u);

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
      /** Message qui porte la valeur (corps du message évalué par défaut). */
      source: messageSource.optional(),
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
    id: z.string().regex(/^F[1-9]-\d{2}$/u),
    famille: z.number().int().min(1).max(9),
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
        /** Messages entrants du même dossier reçus avant et après celui-ci : ils passent par la même chaîne. */
        messages_anterieurs: z
          .array(z.object({ objet: z.string(), corps: z.string() }).strict())
          .max(3),
        messages_posterieurs: z
          .array(z.object({ objet: z.string(), corps: z.string() }).strict())
          .max(3),
      })
      .strict(),
    /**
     * Cas dont la vérité dépend d'un choix prudent que le propriétaire peut assouplir (compté à part) :
     * collaborateur du cabinet nommé en signature, données de tiers sans nom.
     */
    decision_proprietaire: z
      .enum(["collaborateur_en_signature", "donnees_de_tiers_sans_nom"])
      .optional(),
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
    famille: z.number().int().min(1).max(9),
    libelle: z.string(),
    cas: z.array(caseSchema),
  })
  .strict();

export type EvaluationCase = z.infer<typeof caseSchema>;
export type EvaluationField = AutoPublicationEligibleField;
export const EVALUATION_FIELDS: readonly EvaluationField[] = AUTO_PUBLICATION_ELIGIBLE_FIELDS;

/** Texte de notre demande actuelle, cité sous les réponses du jeu (`demande_actuelle.txt`). */
export const CURRENT_REQUEST_FILE = "demande_actuelle.txt";

/**
 * Notre demande telle que le gabarit du code la rend aujourd'hui, avec des valeurs fictives fixes. Le jeu la
 * cite mot pour mot ; un changement du gabarit change ce texte et fait échouer le test qui le fige.
 */
export function renderCurrentRequest(): string {
  return renderInformationAgentEmailContent({
    template: DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
    values: {
      recipient_name: "Maître Aurore Fictel",
      salutation: "Bonjour Maître Fictel,",
      sale_title: "Appartement T3",
      sale_subject_title: "Appartement T3 à Valmont-sur-Exemple",
      sale_reference:
        "Appartement T3, 8 rue du Témoin, 99100 Valmont-sur-Exemple (tribunal judiciaire de Valmont-sur-Exemple)",
      location: "Valmont-sur-Exemple",
      tribunal: "tribunal judiciaire de Valmont-sur-Exemple",
      hearing_date: "14/01/2027",
      hearing_line: "Audience annoncée : 14/01/2027",
      subject_date: "audience du 14/01/2027",
      starting_price: "60 000 €",
      price_line: "Mise à prix annoncée : 60 000 €",
      questions: [
        "- Pouvez-vous confirmer séparément la surface habitable, la surface Carrez et, le cas échéant, la surface du terrain ?",
        "- Pouvez-vous confirmer la composition du bien, le nombre de pièces et les éventuelles annexes en distinguant celles incluses dans le lot ?",
      ].join("\n"),
    },
  }).bodyText;
}

/** Lit et valide les fichiers de familles (erreur détaillée au premier écart). */
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
