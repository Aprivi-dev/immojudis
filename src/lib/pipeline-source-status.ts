import type { PipelineSourceState } from "./pipeline-status";

const labels: Record<string, string> = {
  available: "Disponible",
  unavailable: "Indisponible",
  access_denied: "Accès refusé",
  partial: "Collecte partielle",
  unknown: "Non vérifiée",
  unchecked: "Non vérifiée",
};

export function pipelineSourceStatus(source: PipelineSourceState) {
  const coverage = source.coverage;
  const error = source.last_error ?? "";
  if (source.availability === "access_denied") {
    return {
      label: "Accès refusé",
      detail: "Le site refuse les requêtes. Reprise après le délai indiqué.",
    };
  }
  if (
    /Execution budget exceeded/.test(error) ||
    ["execution_budget", "source_budget_exhausted"].includes(coverage?.stop_reason ?? "")
  ) {
    return {
      label: "Collecte à reprendre",
      detail: "Durée maximale atteinte. La progression sauvegardée sera reprise.",
    };
  }
  if (
    (coverage?.publication_pending ?? 0) > 0 ||
    (coverage?.publication_failed ?? 0) > 0 ||
    coverage?.publication_status === "partial_or_failed" ||
    (source.availability === "available" && Boolean(error))
  ) {
    return {
      label: "Publication partielle",
      detail: "Certaines fiches collectées restent à publier.",
    };
  }
  if (coverage?.scoped_inventory_complete && !error) {
    return {
      label: "Catalogue accessible vérifié",
      detail: "Les archives vendues sans lien restent hors du périmètre certifié.",
    };
  }
  if (/timed out|timeout/i.test(error)) {
    return {
      label: "Délai de réponse dépassé",
      detail: "Le site n’a pas répondu dans le délai prévu.",
    };
  }
  return { label: labels[source.availability] ?? source.availability, detail: null };
}
