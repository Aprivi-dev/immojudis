import {
  compareListingZone,
  landConstraintsOverview,
  landReportReliability,
  landZoneVerdict,
  parcelSurfaceGap,
  rulesUnavailableReason,
} from "./land-report-coherence";
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

/** What the listing says, to check against the official report (same checks as on screen). */
export type LandReportListingContext = {
  listingZone?: string | null;
  landSurfaceM2?: number | null;
};

/** Count of sources that could not be read, as a sentence for the coverage section. */
function unavailableSourcesLine(report: LandReport): string | null {
  const count = [...report.planning.checks, ...report.risks.checks, ...report.rules.checks].filter(
    (check) => check.status === "unavailable",
  ).length;
  return count
    ? `${count} source${count > 1 ? "s" : ""} indisponible${count > 1 ? "s" : ""} lors de la consultation : les rubriques concernées ne sont pas vérifiées.`
    : null;
}

export function landReportToLines(
  report: LandReport,
  address: string,
  listing: LandReportListingContext = {},
): string[] {
  const reliability = landReportReliability(report.planning);
  const surfaceGap = parcelSurfaceGap(report.planning.parcels, listing.landSurfaceM2);
  const zoneCheck = compareListingZone(listing.listingZone ?? null, report.planning.zones);
  const constraints = landConstraintsOverview(report.planning);
  const lines = [
    address,
    `Sources consultées le ${new Date(report.generatedAt).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}`,
    landZoneVerdict(report.planning.zones) ?? "",
    LAND_REPORT_HEADINGS[0],
    reliability.text,
    surfaceGap ?? "",
    ...report.planning.parcels.map(
      (parcel) =>
        `${parcel.id} - ${parcel.city ?? parcel.codeInsee} - ${parcel.surfaceM2 != null ? `${parcel.surfaceM2} m²` : "surface non fournie"} - ${parcel.match === "address_point" ? "candidat issu du point" : "référence à recouper avec le CCV"}`,
    ),
    LAND_REPORT_HEADINGS[1],
    ...(report.planning.zones.length
      ? report.planning.zones.map(
          (zone) => `${zone.label} - ${zone.description} - ${zone.documentName}`,
        )
      : ["Aucun zonage n’a été identifié pour cette parcelle."]),
    zoneCheck
      ? `Zone citée dans l’annonce : ${zoneCheck.zone}${
          zoneCheck.matches === true
            ? " - concorde avec le zonage officiel."
            : zoneCheck.matches === false
              ? " - diffère du zonage officiel : à vérifier dans le cahier des conditions de vente."
              : " - aucun zonage officiel à comparer."
        }`
      : "",
    ...report.planning.documents.flatMap((doc) => [
      `${doc.title} (${doc.name}) - statut au Géoportail de l’urbanisme (GPU) ${doc.legalStatus ?? "non renseigné"} / ${doc.effectiveStatus ?? "non renseigné"}`,
      `Publication : ${doc.publicationDate ?? "non renseignée"} - mise à jour : ${doc.updatedAt ?? "non renseignée"}`,
      doc.sourceUrl,
    ]),
    LAND_REPORT_HEADINGS[2],
    ...(report.rules.rules.length ? [] : [rulesUnavailableReason(report.rules.checks)]),
    ...(report.rules.completeCoverage
      ? []
      : [
          "Lecture partielle du règlement : les extraits ne couvrent pas toutes les dispositions, annexes et exceptions applicables.",
        ]),
    ...report.rules.rules.flatMap((rule) => [
      `${rule.title} - ${rule.zoneLabels.join(", ")} - ${rule.article ?? "article non identifié"}, page PDF ${rule.page}`,
      rule.text,
      ...rule.conditions,
      rule.sourceUrl,
    ]),
    LAND_REPORT_HEADINGS[3],
    constraints.status === "unverified"
      ? `Servitudes non vérifiées : ${constraints.reason}. Cela ne prouve pas qu’il n’y en a pas.`
      : constraints.status === "none"
        ? "Aucune servitude ni prescription repérée dans les couches consultées."
        : "",
    ...report.planning.constraints.flatMap((constraint) => [
      `${constraint.label}${constraint.isEnvelope ? " - enveloppe : classe réglementaire à déterminer" : ""}`,
      constraint.detail ?? "",
      constraint.documentUrl ?? "",
    ]),
    LAND_REPORT_HEADINGS[4],
    report.risks.findings.length
      ? ""
      : "Aucun constat de risque retourné : cela ne permet pas de conclure à l’absence de risque.",
    ...report.risks.findings.flatMap((risk) => [
      `${risk.label} - ${LAND_SCOPE_LABELS[risk.scope]}${risk.level ? ` - ${risk.level}` : ""}`,
      risk.description,
      ...risk.consequences,
      `Millésime (année des données) : ${risk.vintage ?? "non renseigné"} - source : ${risk.sourceLabel}`,
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
    unavailableSourcesLine(report) ?? "",
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
    "Les règles repérées doivent être lues avec les dispositions générales, les orientations d’aménagement et de programmation (OAP), les servitudes, le règlement du plan de prévention des risques (PPR) et les pièces de vente. Le dossier ne constitue pas une autorisation d’urbanisme.",
    "Le certificat d’urbanisme, délivré par la mairie sur demande, précise les règles applicables à un terrain (certificat d’information) ou indique si un projet précis est réalisable (certificat opérationnel). Il ne vaut pas autorisation de construire. Pour en savoir plus (service-public.gouv.fr) :",
    "https://www.service-public.gouv.fr/particuliers/vosdroits/F1633",
  ];
  return lines.filter(Boolean);
}
