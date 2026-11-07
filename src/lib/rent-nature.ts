import type { RentReference } from "@/lib/rent-reference";

export function rentNature(reference: RentReference): string {
  if (reference.source === "anil_arrondissements_median") {
    return "Loyer calculé par Immojudis : médiane des estimations ANIL des arrondissements, faute d’estimation propre à celui du bien. Indicatif.";
  }
  if (reference.source === "anil_department_median") {
    return "Loyer calculé par Immojudis : médiane des estimations ANIL des communes du département, faute d’estimation pour la commune du bien. Indicatif.";
  }
  if (reference.source === "anil_maille") {
    return "Loyer de maille : estimation commune à un groupe de communes voisines, la commune comptant trop peu d’annonces pour une estimation propre. Indicatif.";
  }
  if (reference.source === "anil_epci") {
    return "Loyer de l’intercommunalité : estimation indicative, la commune comptant trop peu d’annonces.";
  }
  return reference.reliability === "reliable"
    ? "Estimation calculée sur les annonces de la commune."
    : "Estimation indicative : la commune compte peu d’annonces ou le modèle est peu précis.";
}
