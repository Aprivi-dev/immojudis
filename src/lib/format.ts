export function formatPrice(value: number | null | undefined): string {
  if (value == null) return "Prix non communiqué";
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatPricePerM2(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat("fr-FR", {
    maximumFractionDigits: 0,
  }).format(value)} €/m²`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "Date à confirmer";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "Date à confirmer";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(d);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function formatSurface(m2: number | null | undefined): string {
  if (m2 == null) return "—";
  return `${Math.round(m2)} m²`;
}

export function occupancyLabel(status: string | null | undefined): string {
  if (!status) return "Non renseigné";
  const s = status.toLowerCase();
  if (s === "unknown" || s === "inconnu") return "À confirmer";
  if (s.includes("libre") || s === "vacant" || s === "free") return "Libre";
  if (s.includes("occup")) return "Occupé";
  if (s.includes("loué") || s.includes("loue") || s.includes("rented")) return "Loué";
  return status;
}

export function propertyTypeLabel(t: string | null | undefined): string {
  if (!t) return "Bien";
  const s = t.toLowerCase();
  if (s === "unknown" || s === "other") return "Bien à qualifier";
  if (s.includes("apart") || s.includes("apt")) return "Appartement";
  if (s === "studio" || s.includes("studio")) return "Appartement";
  if (s.includes("house") || s.includes("maison")) return "Maison";
  if (s.includes("building") || s.includes("immeuble")) return "Immeuble";
  if (s.includes("land") || s.includes("terrain")) return "Terrain";
  if (s.includes("garage") || s.includes("park")) return "Garage / Parking";
  if (s.includes("commerce") || s.includes("commercial") || s.includes("local")) {
    return "Local commercial";
  }
  return t;
}

export function saleStatusLabel(status: string | null | undefined): string | null {
  if (!status) return null;
  const s = status.toLowerCase();
  const labels: Record<string, string> = {
    upcoming: "Vente à venir",
    active: "Vente active",
    unknown: "Statut à confirmer",
    past: "Vente passée",
    adjudicated: "Adjugée",
    cancelled: "Annulée",
    withdrawn: "Retirée",
  };
  return labels[s] ?? status;
}

export function surfaceSourceLabel(source: string | null | undefined): string | null {
  if (!source) return null;
  const s = source.toLowerCase();
  const labels: Record<string, string> = {
    llm: "extraction documentaire",
    llm_extraction: "extraction documentaire",
    pdf: "document PDF",
    document: "document PDF",
    docling: "extraction PDF",
    source_listing: "page de l'annonce",
    listing: "page de l'annonce",
    surface_m2_fallback: "surface déclarée",
    built_surface_text: "texte du dossier",
    habitable_surface_m2: "surface habitable",
    carrez_surface_m2: "surface Carrez",
    land_surface_m2: "surface terrain",
  };
  return labels[s] ?? source.replaceAll("_", " ");
}

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
    pdf: "Document PDF",
  };
  return labels[s] ?? type.replaceAll("_", " ");
}

export function documentTypeHelp(type: string | null | undefined): string {
  if (!type) return "Document source utilisé comme indice, à relire avant de décider.";
  const s = type.toLowerCase();
  const descriptions: Record<string, string> = {
    source_listing:
      "Page de l'annonce : utile pour les informations commerciales, mais moins probante qu'un acte ou un diagnostic.",
    annonce_vente:
      "Annonce ou insertion : bonne source de contexte, à confirmer dans les pièces officielles.",
    pv_huissier:
      "PV de commissaire de justice : décrit ce qui a été constaté sur place, souvent très utile pour l'état réel et l'occupation.",
    pv_descriptif:
      "PV descriptif : pièce centrale pour comprendre l'état, l'occupation et les éléments visibles du bien.",
    pv_notaire:
      "PV de notaire : source juridique utile pour les conditions et éléments officiels de la vente.",
    proces_verbal:
      "Procès-verbal : document de constat ou de procédure, à lire avec son contexte exact.",
    cahier_conditions_vente:
      "Cahier des conditions de vente : pièce clé pour les règles de vente, charges, servitudes et contraintes juridiques.",
    cahier_conditions:
      "Cahier des conditions de vente : pièce clé pour les règles de vente, charges, servitudes et contraintes juridiques.",
    conditions_vente:
      "Conditions de vente : précise les règles, frais et obligations liés à l'adjudication.",
    diagnostics_techniques:
      "Diagnostics techniques : source prioritaire pour amiante, plomb, DPE, termites et autres risques réglementaires.",
    diagnostics:
      "Diagnostics techniques : source prioritaire pour amiante, plomb, DPE, termites et autres risques réglementaires.",
    bail: "Bail ou pièce d'occupation : utile pour comprendre qui occupe le bien, à quelles conditions et avec quel impact locatif.",
    procedure_saisie:
      "Procédure de saisie : document de contexte juridique, pas toujours directement lié à l'état du bien.",
    cadastre:
      "Cadastre ou plan : utile pour la parcelle, les accès et le périmètre, mais ne suffit pas pour qualifier un risque.",
    pdf: "Document PDF : source documentaire importée, à qualifier selon son contenu exact.",
  };
  return (
    descriptions[s] ??
    "Document source utilisé comme indice, à relire dans son contexte avant de décider."
  );
}
