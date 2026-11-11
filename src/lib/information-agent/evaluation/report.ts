import "server-only";
import {
  EVALUATION_FAMILIES,
  EVALUATION_FIELDS,
  type EvaluationCase,
  type EvaluationField,
} from "@/lib/information-agent/evaluation/dataset";
import type { EngineStageEntry, FieldDecision } from "@/lib/information-agent/evaluation/pipeline";

/**
 * Mesures du banc pour une configuration : publications fausses par famille, couverture, liste nominative
 * des échecs, dans les deux états du dossier (celui que le moteur attend, celui que la chaîne écrit). Une
 * publication fausse est une valeur « aurait été publiée » (par n'importe quel message du dossier) alors
 * que la vérité dit « ne doit pas être publié », ou publiée avec une autre valeur que la vérité.
 */

/** Écart toléré entre une valeur publiée et la vérité (arrondi d'une surface décimale). */
const VALUE_TOLERANCE = 0.01;

export type EngineState = "etat_attendu" | "etat_reel";

/**
 * Défaut connu : reconnu par sa signature complète (configuration, état, cas, champ, valeur, message qui
 * porte la valeur, provenance du fait et motifs de la décision du même fait dans l'état réel). Une nouvelle
 * cause sur le même cas change la signature et fait échouer le seuil.
 */
export type KnownDefect = {
  configuration: string;
  etat: EngineState;
  case_id: string;
  field: EvaluationField;
  published_value: number;
  message: string;
  provenance: FieldDecision["provenance"];
  motifs_etat_reel: string[];
  groupe: string;
  cause: string;
};

export type FalsePublication = Omit<KnownDefect, "configuration" | "groupe" | "cause"> & {
  famille: number;
  published_value: number | null;
  verite: string;
  decision_proprietaire: string | null;
  defaut_connu: boolean;
};

type StateReport = {
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
};

/** Contrôle d'une sortie réelle enregistrée : un essai incomplet n'a pas de résultat de sécurité. */
export type TrialCompleteness = {
  cas_non_joues: string[];
  pieces_en_erreur: string[];
  pieces_en_cours: string[];
  pieces_non_appelees_consigne: string[];
  pieces_non_appelees_autres: string[];
};

export type ConfigurationReport = {
  configuration: string;
  modele_reel: boolean;
  description: string;
  /** Configuration qui fait foi pour la sécurité (la plus pessimiste simulée, ou une sortie réelle). */
  fait_foi: boolean;
  resultat: "complet" | "essai incomplet";
  essai: TrialCompleteness | null;
  cas_joues: number;
  cas_non_joues: string[];
  /** Null pour un essai incomplet : il n'affiche jamais « 0 publication fausse ». */
  etat_attendu: StateReport | null;
  etat_reel: StateReport | null;
  decisions_proprietaire: Record<string, { cas: number; publications_fausses: number }>;
};

function truthLabel(evaluationCase: EvaluationCase, field: EvaluationField): string {
  const truth = evaluationCase.verite[field];
  return truth.publiable ? `publiable : ${truth.valeur}` : `non publiable : ${truth.raison}`;
}

function sameValue(left: number | null, right: number): boolean {
  return left !== null && Math.abs(left - right) <= VALUE_TOLERANCE;
}

function signatureOf(item: Omit<KnownDefect, "groupe" | "cause">): string {
  return JSON.stringify([
    item.configuration,
    item.etat,
    item.case_id,
    item.field,
    Math.round(item.published_value * 100) / 100,
    item.message,
    item.provenance,
    [...item.motifs_etat_reel].sort(),
  ]);
}

function stateReport(
  configuration: string,
  state: EngineState,
  cases: EvaluationCase[],
  decisions: Map<string, EngineStageEntry>,
  realState: Map<string, EngineStageEntry>,
  known: Set<string>,
): StateReport {
  const families = Object.fromEntries(EVALUATION_FAMILIES.map(({ number }) => [String(number), 0]));
  const coverageByFamily = Object.fromEntries(
    EVALUATION_FAMILIES.map(({ number }) => [
      String(number),
      { publiables: 0, publiees_justes: 0 },
    ]),
  );
  const falsePublications: FalsePublication[] = [];
  const notPublished: StateReport["non_publiees"] = [];
  let publications = 0;
  let publishable = 0;
  let publishedRight = 0;
  for (const evaluationCase of cases) {
    const entry = decisions.get(evaluationCase.id);
    if (!entry) continue;
    const family = String(evaluationCase.famille);
    for (const field of EVALUATION_FIELDS) {
      const truth = evaluationCase.verite[field];
      const published = entry[field].filter((decision) => decision.outcome === "would_publish");
      publications += published.length;
      for (const decision of published) {
        if (truth.publiable && sameValue(decision.value, truth.valeur)) continue;
        families[family]! += 1;
        // Motifs du même fait dans l'état réel (même ordre des candidats dans les deux passes).
        const index = entry[field].indexOf(decision);
        const real = realState.get(evaluationCase.id)?.[field][index];
        const item = {
          etat: state,
          case_id: evaluationCase.id,
          field,
          published_value: decision.value,
          message: decision.role,
          provenance: decision.provenance,
          motifs_etat_reel: [...(real?.reasons ?? [])].sort(),
        };
        falsePublications.push({
          ...item,
          famille: evaluationCase.famille,
          verite: truthLabel(evaluationCase, field),
          decision_proprietaire: evaluationCase.decision_proprietaire ?? null,
          defaut_connu:
            decision.value !== null &&
            known.has(signatureOf({ ...item, configuration, published_value: decision.value })),
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
  }
  return {
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
  };
}

export function buildConfigurationReport({
  configuration,
  modeleReel,
  description,
  faitFoi,
  essai,
  cases,
  decisions,
  realStateDecisions,
  missing,
  knownDefects,
}: {
  configuration: string;
  modeleReel: boolean;
  description: string;
  faitFoi: boolean;
  essai: TrialCompleteness | null;
  cases: EvaluationCase[];
  decisions: Map<string, EngineStageEntry>;
  realStateDecisions: Map<string, EngineStageEntry>;
  missing: string[];
  knownDefects: KnownDefect[];
}): ConfigurationReport {
  const known = new Set(
    knownDefects
      .filter((defect) => defect.configuration === configuration)
      .map((defect) => signatureOf(defect)),
  );
  const incomplete =
    missing.length > 0 ||
    (essai !== null &&
      (essai.cas_non_joues.length > 0 ||
        essai.pieces_en_erreur.length > 0 ||
        essai.pieces_en_cours.length > 0 ||
        essai.pieces_non_appelees_autres.length > 0));
  const attendu = incomplete
    ? null
    : stateReport(configuration, "etat_attendu", cases, decisions, realStateDecisions, known);
  const reel = incomplete
    ? null
    : stateReport(configuration, "etat_reel", cases, realStateDecisions, realStateDecisions, known);
  const owner: ConfigurationReport["decisions_proprietaire"] = {};
  for (const evaluationCase of cases) {
    const label = evaluationCase.decision_proprietaire;
    if (!label) continue;
    owner[label] ??= { cas: 0, publications_fausses: 0 };
    owner[label].cas += 1;
    owner[label].publications_fausses +=
      attendu?.publications_fausses.liste.filter((item) => item.case_id === evaluationCase.id)
        .length ?? 0;
  }
  return {
    configuration,
    modele_reel: modeleReel,
    description,
    fait_foi: faitFoi,
    resultat: incomplete ? "essai incomplet" : "complet",
    essai,
    cas_joues: cases.filter((evaluationCase) => decisions.has(evaluationCase.id)).length,
    cas_non_joues: missing,
    etat_attendu: attendu,
    etat_reel: reel,
    decisions_proprietaire: owner,
  };
}
