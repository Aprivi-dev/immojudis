import type { LandReport, LandScope, LandSourceStatus } from "./land-report-types";

export const LAND_REPORT_HEADINGS = [
  "Parcelles et localisation",
  "Document d’urbanisme et zonage",
  "Règles repérées dans les documents",
  "Contraintes et servitudes",
  "Risques et portée des informations",
  "Votre projet : points à vérifier",
  "Couverture des sources",
  "Limites de l’analyse",
] as const;

export const LAND_SCOPE_LABELS: Record<LandScope, string> = {
  parcel: "Parcelle",
  point: "Point recherché",
  commune: "Commune",
  radius: "À proximité",
  document: "Document",
};
export const LAND_SOURCE_STATUS_LABELS: Record<LandSourceStatus, string> = {
  available: "Source consultée",
  empty: "Aucun enregistrement dans cette couche",
  partial: "Vérification partielle",
  unavailable: "Source indisponible",
  not_configured: "Source non raccordée",
  not_checked: "Non vérifié",
};

export function landReportToLines(report: LandReport, address: string): string[] {
  const lines = [
    address,
    `Vérification du ${new Date(report.generatedAt).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}`,
    LAND_REPORT_HEADINGS[0],
    ...report.planning.parcels.map(
      (parcel) =>
        `${parcel.id} - ${parcel.city ?? parcel.codeInsee} - ${parcel.surfaceM2 != null ? `${parcel.surfaceM2} m²` : "surface non fournie"} - ${parcel.match === "address_point" ? "candidat issu du point" : "référence à recouper avec le CCV"}`,
    ),
    LAND_REPORT_HEADINGS[1],
    ...report.planning.zones.map(
      (zone) => `${zone.label} - ${zone.description} - ${zone.documentName}`,
    ),
    ...report.planning.documents.flatMap((doc) => [
      `${doc.title} (${doc.name}) - statut GPU ${doc.legalStatus ?? "non renseigné"} / ${doc.effectiveStatus ?? "non renseigné"}`,
      `Publication : ${doc.publicationDate ?? "non renseignée"} - mise à jour : ${doc.updatedAt ?? "non renseignée"}`,
      doc.sourceUrl,
    ]),
    LAND_REPORT_HEADINGS[2],
    ...report.rules.rules.flatMap((rule) => [
      `${rule.title} - ${rule.zoneLabels.join(", ")} - ${rule.article ?? "article non identifié"}, page PDF ${rule.page}`,
      rule.text,
      ...rule.conditions,
      rule.sourceUrl,
    ]),
    LAND_REPORT_HEADINGS[3],
    ...report.planning.constraints.flatMap((constraint) => [
      `${constraint.label}${constraint.isEnvelope ? " - enveloppe : classe réglementaire à déterminer" : ""}`,
      constraint.detail ?? "",
      constraint.documentUrl ?? "",
    ]),
    LAND_REPORT_HEADINGS[4],
    ...report.risks.findings.flatMap((risk) => [
      `${risk.label} - ${LAND_SCOPE_LABELS[risk.scope]}${risk.level ? ` - ${risk.level}` : ""}`,
      risk.description,
      ...risk.consequences,
      `Millésime : ${risk.vintage ?? "non renseigné"} - source : ${risk.sourceLabel}`,
      risk.sourceUrl,
    ]),
    LAND_REPORT_HEADINGS[5],
    ...report.projects.flatMap((project) => [
      project.title,
      project.summary,
      ...project.checks,
      ...project.missingInformation.map((item) => `À renseigner : ${item}`),
    ]),
    LAND_REPORT_HEADINGS[6],
    ...[...report.planning.checks, ...report.risks.checks, ...report.rules.checks].flatMap(
      (check) => [
        `${check.label} - ${LAND_SOURCE_STATUS_LABELS[check.status]} - ${LAND_SCOPE_LABELS[check.scope]}`,
        check.message ?? "",
        check.sourceUrl,
      ],
    ),
    LAND_REPORT_HEADINGS[7],
    ...new Set([...report.planning.warnings, ...report.risks.warnings, ...report.rules.warnings]),
    "La couverture dépend des sources disponibles. Un résultat vide, une panne ou une donnée communale ne prouvent pas l’absence de risque sur le bien.",
    "Les règles repérées doivent être lues avec les dispositions générales, les OAP, les servitudes, le règlement PPR et les pièces de vente. Le dossier ne constitue pas une autorisation d’urbanisme.",
    "Le certificat d’urbanisme opérationnel indique si le terrain peut être utilisé pour une opération décrite. Il ne vaut pas autorisation de travaux.",
    "https://www.service-public.gouv.fr/particuliers/vosdroits/F1633",
  ];
  return lines.filter(Boolean);
}
