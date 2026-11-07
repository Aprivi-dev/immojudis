export function documentTypeLabel(type: string | null | undefined): string {
  if (!type) return "Document";
  const s = type.toLowerCase();
  const labels: Record<string, string> = {
    source_listing: "Page de l'annonce",
    annonce_vente: "Annonce / insertion",
    pv_huissier: "PV de commissaire de justice",
    pv_descriptif: "PV descriptif",
    pv_notaire: "PV de notaire",
    proces_verbal: "Procès-verbal",
    cahier_conditions_vente: "Cahier des conditions",
    cahier_conditions: "Cahier des conditions",
    conditions_vente: "Conditions de vente",
    diagnostics_techniques: "Diagnostics techniques",
    diagnostics: "Diagnostics techniques",
    bail: "Bail / occupation",
    procedure_saisie: "Procédure de saisie",
    cadastre: "Cadastre / plan",
    copropriete: "Copropriété",
    titre_propriete: "Titre de propriété",
    pdf: "Document PDF",
  };
  return labels[s] ?? type.replaceAll("_", " ");
}
