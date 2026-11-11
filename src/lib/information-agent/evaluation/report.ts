import "server-only";
import {
  EVALUATION_FAMILIES,
  EVALUATION_FIELDS,
  type EvaluationCase,
  type EvaluationField,
} from "@/lib/information-agent/evaluation/dataset";
import type { EngineStageEntry } from "@/lib/information-agent/evaluation/pipeline";

/**
 * Mesures du banc pour une configuration : publications fausses par famille, couverture, liste nominative
 * des échecs. Une publication fausse est une valeur « aurait été publiée » alors que la vérité dit « ne doit
 * pas être publié », ou publiée avec une autre valeur que la vérité.
 */

/** Écart toléré entre une valeur publiée et la vérité (arrondi d'une surface décimale). */
const VALUE_TOLERANCE = 0.01;

export type KnownDefect = {
  configuration: string;
  case_id: string;
  field: EvaluationField;
  published_value: number;
  cause: string;
};

export type FalsePublication = {
  case_id: string;
  famille: number;
  field: EvaluationField;
  published_value: number | null;
  verite: string;
  defaut_connu: boolean;
};

export type ConfigurationReport = {
  configuration: string;
  /** Vrai seulement pour une sortie réelle du modèle enregistrée par l'essai. */
  modele_reel: boolean;
  description: string;
  cas_joues: number;
  cas_non_joues: string[];
  publications: number;
  publications_fausses: {
    total: number;
    defauts_connus: number;
    par_famille: Record<string, number>;
    liste: FalsePublication[];
  };
  couverture: {
    valeurs_publiables: number;
    publiees_justes: number;
    taux: number;
    par_famille: Record<string, { publiables: number; publiees_justes: number }>;
  };
  /** Valeurs publiables restées en relecture, avec les motifs du moteur (codes). */
  non_publiees: Array<{ case_id: string; field: EvaluationField; motifs: string[] }>;
  /** Publications avec l'état réel du dossier après traitement (voir la variante `etat_reel`). */
  publications_etat_reel: number;
};

function truthLabel(evaluationCase: EvaluationCase, field: EvaluationField): string {
  const truth = evaluationCase.verite[field];
  return truth.publiable ? `publiable : ${truth.valeur}` : `non publiable : ${truth.raison}`;
}

function sameValue(left: number | null, right: number): boolean {
  return left !== null && Math.abs(left - right) <= VALUE_TOLERANCE;
}

export function buildConfigurationReport({
  configuration,
  modeleReel,
  description,
  cases,
  decisions,
  realStateDecisions,
  missing,
  knownDefects,
}: {
  configuration: string;
  modeleReel: boolean;
  description: string;
  cases: EvaluationCase[];
  decisions: Map<string, EngineStageEntry>;
  realStateDecisions: Map<string, EngineStageEntry>;
  missing: string[];
  knownDefects: KnownDefect[];
}): ConfigurationReport {
  const families = Object.fromEntries(EVALUATION_FAMILIES.map(({ number }) => [String(number), 0]));
  const coverageByFamily = Object.fromEntries(
    EVALUATION_FAMILIES.map(({ number }) => [String(number), { publiables: 0, publiees_justes: 0 }]),
  );
  const falsePublications: FalsePublication[] = [];
  const notPublished: ConfigurationReport["non_publiees"] = [];
  let publications = 0;
  let publishable = 0;
  let publishedRight = 0;
  let realStatePublications = 0;
  const played = cases.filter((evaluationCase) => decisions.has(evaluationCase.id));

  for (const evaluationCase of played) {
    const entry = decisions.get(evaluationCase.id)!;
    const family = String(evaluationCase.famille);
    for (const field of EVALUATION_FIELDS) {
      const truth = evaluationCase.verite[field];
      const published = entry[field].filter((decision) => decision.outcome === "would_publish");
      publications += published.length;
      for (const decision of published) {
        const right = truth.publiable && sameValue(decision.value, truth.valeur);
        if (right) continue;
        families[family]! += 1;
        falsePublications.push({
          case_id: evaluationCase.id,
          famille: evaluationCase.famille,
          field,
          published_value: decision.value,
          verite: truthLabel(evaluationCase, field),
          defaut_connu: knownDefects.some(
            (defect) =>
              defect.configuration === configuration &&
              defect.case_id === evaluationCase.id &&
              defect.field === field &&
              sameValue(decision.value, defect.published_value),
          ),
        });
      }
      if (!truth.publiable) continue;
      publishable += 1;
      coverageByFamily[family]!.publiables += 1;
      if (published.some((decision) => sameValue(decision.value, truth.valeur))) {
        publishedRight += 1;
        coverageByFamily[family]!.publiees_justes += 1;
      } else {
        notPublished.push({
          case_id: evaluationCase.id,
          field,
          motifs: [...new Set(entry[field].flatMap((decision) => decision.reasons))].sort(),
        });
      }
    }
    const realState = realStateDecisions.get(evaluationCase.id);
    if (realState) {
      realStatePublications += EVALUATION_FIELDS.flatMap((field) => realState[field]).filter(
        (decision) => decision.outcome === "would_publish",
      ).length;
    }
  }

  return {
    configuration,
    modele_reel: modeleReel,
    description,
    cas_joues: played.length,
    cas_non_joues: missing,
    publications,
    publications_fausses: {
      total: falsePublications.length,
      defauts_connus: falsePublications.filter((item) => item.defaut_connu).length,
      par_famille: families,
      liste: falsePublications,
    },
    couverture: {
      valeurs_publiables: publishable,
      publiees_justes: publishedRight,
      taux: publishable ? Math.round((publishedRight / publishable) * 1000) / 1000 : 0,
      par_famille: coverageByFamily,
    },
    non_publiees: notPublished,
    publications_etat_reel: realStatePublications,
  };
}
