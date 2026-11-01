/**
 * Porte d'activation des modèles de valorisation, côté publication.
 *
 * `scripts/publish-valuation-models.mjs` ne doit JAMAIS activer un modèle que la porte de
 * `services/data-pipeline/src/valuation_training.py` (`decide_activation`) n'a pas validé. Avant
 * ce garde-fou, le script ne regardait que les métriques absolues du lot et activait tout ce qui
 * se trouvait dans `deployment/valuation-models/`, même un brouillon refusé par la porte.
 *
 * Il exige donc, à côté de chaque lot `<segment>-<version>.json`, le rapport de la porte
 * `<segment>-<version>.report.json` (écrit par l'entraînement) et en relit les chiffres :
 *   - la porte a décidé d'activer (`promotion.activate === true`) ;
 *   - au moins `MIN_ACTIVATION_TEST_ROWS` ventes de test chronologiques ;
 *   - l'intervalle bootstrap apparié de l'écart d'erreur médian avec le repère naïf, et avec le
 *     modèle actif quand il existe, est entièrement sous zéro ;
 *   - la couverture de l'intervalle servi atteint le plancher de promotion.
 * Les nombres ci-dessous sont les mêmes que dans `valuation_training.py` : un test Python
 * (`test_the_javascript_publication_gate_uses_the_same_numbers`) échoue s'ils divergent.
 */
export const MIN_ACTIVATION_TEST_ROWS = 300;
export const MIN_COVERAGE_PCT = 70;

/** Nom du rapport de porte qui accompagne le lot `bundleFile` (`apartment-v1.json`). */
export function reportFileName(bundleFile) {
  return bundleFile.replace(/\.json$/, ".report.json");
}

/** Vrai pour les fichiers `*.report.json` : ce sont des rapports, pas des lots à publier. */
export function isReportFile(file) {
  return file.endsWith(".report.json");
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function gapProblem(gap, reference) {
  const high = finiteNumber(gap?.ci_high_pp);
  if (high == null) return `intervalle bootstrap de l'écart avec ${reference} absent`;
  if (!(high < 0)) {
    return `intervalle bootstrap de l'écart avec ${reference} [${gap.ci_low_pp}, ${high}] pas entièrement sous zéro`;
  }
  return null;
}

/**
 * Les raisons pour lesquelles `report` n'autorise pas la publication active de `bundle`.
 * Tableau vide : la porte est franchie.
 */
export function promotionGateProblems(bundle, report) {
  if (!report || typeof report !== "object") return ["rapport de la porte d'activation absent"];
  const problems = [];
  if (report.segment !== bundle.segment || report.version !== bundle.version) {
    problems.push(
      `le rapport (${report.segment}/${report.version}) ne décrit pas ce lot (${bundle.segment}/${bundle.version})`,
    );
  }
  if (report.promotion?.activate !== true) {
    const reasons = Array.isArray(report.promotion?.reasons) ? report.promotion.reasons : [];
    problems.push(
      `la porte d'activation n'a pas validé ce modèle${reasons.length ? ` : ${reasons.join(" ; ")}` : ""}`,
    );
  }
  const testRows = finiteNumber(report.split?.test_rows);
  if (testRows == null || testRows < MIN_ACTIVATION_TEST_ROWS) {
    problems.push(
      `${testRows ?? "nombre inconnu de"} ventes de test, moins que les ${MIN_ACTIVATION_TEST_ROWS} requises`,
    );
  }
  const naive = gapProblem(report.error_gap?.vs_naive, "le repère naïf");
  if (naive) problems.push(naive);
  if (report.active?.status === "evaluated") {
    const active = gapProblem(
      report.error_gap?.vs_active,
      `le modèle actif ${report.active.version}`,
    );
    if (active) problems.push(active);
  } else if (report.active?.status !== "none") {
    problems.push("le modèle actif n'a pas pu être évalué : une régression n'est pas exclue");
  }
  const coverage = finiteNumber(report.coverage?.served_interval_pct);
  if (coverage == null || coverage < MIN_COVERAGE_PCT) {
    problems.push(
      `couverture de l'intervalle servi ${coverage ?? "non mesurée"} %, sous le plancher de ${MIN_COVERAGE_PCT} %`,
    );
  }
  return problems;
}

/** Lève une erreur si le rapport n'autorise pas la publication active du lot. */
export function assertPromotionGate(bundle, report) {
  const problems = promotionGateProblems(bundle, report);
  if (problems.length) {
    throw new Error(
      `Model ${bundle.segment}/${bundle.version} refused by the activation gate: ${problems.join(" | ")}`,
    );
  }
}
