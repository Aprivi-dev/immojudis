import { asRecordOrNull } from "@/lib/guards";
import {
  categoryFromText,
  dateFrom,
  distanceFrom,
  matchesRequestedCommune,
  type QueryContext,
  type RawFinding,
  records,
  recordValue,
  type SourceSpec,
  text,
  uniqueStrings,
  urlFromRecord,
  values,
  valuesAsText,
} from "@/lib/land-risks/helpers";

export function parseRga(payload: unknown, context: QueryContext): RawFinding[] {
  return records(payload, ["codeExposition", "code_exposition", "exposition"]).flatMap((record) => {
    const exposure = text(record, ["exposition", "libelle", "label"]) ?? "non précisée";
    const code = text(record, ["codeExposition", "code_exposition"]);
    return [
      {
        category: "clay",
        label: `Retrait-gonflement des argiles : ${exposure}`,
        level: code ? `${exposure} (classe ${code})` : exposure,
        description: `Géorisques indique une exposition ${exposure}${code ? ` (code ${code})` : ""}. Le millésime de la donnée n’est pas fourni par cette réponse API.`,
        consequences: [
          "Ne pas déduire la présence ou l’absence d’argile à l’échelle de la parcelle sans étude géotechnique.",
          "Vérifier les règles applicables aux constructions et le classement de la carte RGA en vigueur.",
        ],
        regulatory: false,
        vintage: null,
        precision:
          context.version === "v2" && context.parcelIds.length
            ? "parcelle filtrée par l’API v2"
            : undefined,
        sourceUpdatedAt: dateFrom(record),
      },
    ];
  });
}

export function parseOld(payload: unknown): RawFinding[] {
  return records(payload, ["risque", "commune", "departement", "zoneUrbaine"]).map((record) => {
    const risk = text(record, ["risque", "libelle", "label"]) ?? "zone soumise à vérifier";
    return {
      category: "fire",
      label: `Obligations légales de débroussaillement : ${risk}`,
      level: risk,
      description: `La source Géorisques signale ${risk}. Le périmètre exact, les prescriptions locales et la date d’application doivent être vérifiés auprès de la préfecture/commune.`,
      consequences: [
        "Vérifier l’obligation de débroussaillement, sa distance d’application et les prescriptions locales.",
        "Ne pas assimiler ce résultat à une carte de danger incendie ou à une classe parcellaire précise.",
      ],
      regulatory: true,
      sourceUpdatedAt: dateFrom(record),
    };
  });
}

export function parseMvt(payload: unknown): RawFinding[] {
  return records(payload, ["identifiant", "type", "lieu", "code_insee"]).map((record) => {
    const kind = text(record, ["type", "libelle", "nature"]) ?? "mouvement recensé";
    const place = text(record, ["lieu", "commentaire_lieu", "commentaireLieu"]);
    return {
      category: "ground_movement",
      label: `Mouvement de terrain : ${kind}`,
      level: text(record, ["fiabilite", "precision_lieu", "precisionLieu"]),
      description: `Un mouvement de terrain est recensé${place ? ` (${place})` : ""}. La réponse est issue d’une recherche Géorisques par point, rayon ou commune selon la portée indiquée.`,
      consequences: [
        "Vérifier la localisation exacte, la nature du phénomène et les prescriptions du PPR applicable.",
        "Faire examiner les fondations et le sol si le projet est sensible au mouvement de terrain.",
      ],
      regulatory: false,
      sourceUpdatedAt: dateFrom(record),
      distanceM: distanceFrom(record),
    };
  });
}

export function parseCavities(payload: unknown): RawFinding[] {
  return records(payload, ["identifiant", "type", "nom", "code_insee"]).map((record) => {
    const kind = text(record, ["type", "nom", "libelle"]) ?? "cavité recensée";
    return {
      category: /minier|mine/i.test(kind) ? "cavity_mining" : "cavity_mining",
      label: `Cavité souterraine : ${kind}`,
      description:
        "Une cavité souterraine est recensée dans la recherche Géorisques. La proximité et la précision de localisation sont celles de la source, pas une preuve d’emprise sur la parcelle.",
      consequences: [
        "Vérifier la distance et la précision de localisation dans la fiche source.",
        "Demander un avis géotechnique avant travaux si le projet peut être affecté.",
      ],
      regulatory: false,
      sourceUpdatedAt: dateFrom(record),
      distanceM: distanceFrom(record),
    };
  });
}

export function parseRisques(payload: unknown, context: QueryContext): RawFinding[] {
  const result: RawFinding[] = [];
  for (const record of records(payload, [
    "risques_detail",
    "code_insee",
    "libelle_commune",
    "libelle",
    "idGaspar",
    "uuid",
    "communes",
  ]).filter((record) => matchesRequestedCommune(record, context.codeInsee))) {
    const details = values(record, ["risques_detail", "risquesDetail"]);
    const candidates = details.length ? details : [record];
    for (const detail of candidates) {
      const label =
        text(detail, ["libelle_risque_long", "libelle", "label", "risque"]) ?? "Risque recensé";
      const commune = text(record, ["libelle_commune", "commune", "nom_commune"]);
      result.push({
        category: categoryFromText(label),
        label,
        // Gaspar's numeric code identifies the hazard type; it is not a
        // severity scale and must not be rendered as one.
        level: null,
        scope: "commune",
        description: `${commune ? `La commune ${commune}` : "La commune interrogée"} est associée à « ${label} » dans Gaspar. Cette réponse ne constitue pas à elle seule un classement précis de la parcelle.`,
        consequences: [
          "Ouvrir le document réglementaire ou l’état des risques correspondant pour vérifier le périmètre.",
          "Conserver la portée communale ou de proximité lors de toute décision d’achat.",
        ],
        regulatory: null,
        sourceUpdatedAt: dateFrom(detail) ?? dateFrom(record),
      });
    }
  }
  return result;
}

export function parseCatNat(payload: unknown, context: QueryContext): RawFinding[] {
  return records(payload, ["code_national_catnat", "libelle_risque_jo", "code_insee"])
    .filter((record) => matchesRequestedCommune(record, context.codeInsee))
    .map((record) => {
      const risk =
        text(record, ["libelle_risque_jo", "libelle_risque", "libelle"]) ?? "arrêté CatNat";
      const start = text(record, ["date_debut_evt", "dateDebutEvt"]);
      const end = text(record, ["date_fin_evt", "dateFinEvt"]);
      const commune = text(record, ["libelle_commune", "commune", "nom_commune"]);
      return {
        category: categoryFromText(risk),
        label: `Historique CatNat : ${risk}`,
        scope: "commune",
        status: "history",
        description: `Un arrêté de catastrophe naturelle est recensé pour ${commune ? `la commune ${commune}` : "la commune interrogée"}${start ? ` (événement du ${start}${end ? ` au ${end}` : ""})` : ""}. Cet historique communal ne prouve pas à lui seul un dommage sur le bien.`,
        consequences: [
          "Vérifier si le bien a été effectivement touché et si un sinistre a été indemnisé.",
          "Lire l’état des risques et les documents de prévention applicables à la parcelle.",
        ],
        regulatory: null,
        sourceUpdatedAt: dateFrom(record),
      };
    });
}

export function parsePprn(payload: unknown): RawFinding[] {
  return records(payload, ["idGaspar", "libPpr", "zonageReglementaire"]).map((record) => {
    const title = text(record, ["libPpr", "libelle", "libBassinRisques"]) ?? "PPR naturel";
    const textValue = valuesAsText(record, [
      "libPpr",
      "libBassinRisques",
      "modeleProcedure",
      "zonageReglementaire",
    ]);
    const category = categoryFromText(textValue);
    const zone = asRecordOrNull(
      recordValue(record, ["zonageReglementaire", "zonage_reglementaire"]),
    );
    const zoneExists = Boolean(recordValue(zone, ["zoneRegExists", "zoneReglementaire", "exists"]));
    return {
      category,
      label: `Plan de prévention des risques naturels : ${title}`,
      level: zoneExists ? "zonage réglementaire signalé" : text(record, ["etatRevision", "etat"]),
      description: `Un PPR naturel est associé au territoire interrogé${zoneExists ? ", avec un zonage réglementaire signalé par l’API" : ""}. Le niveau ou la couleur de zone doit être lu dans le règlement et la carte officielle.`,
      consequences: [
        "Télécharger et lire la carte de zonage et le règlement du PPR avant de conclure sur la constructibilité.",
        "Ne pas transformer une enveloppe de procédure en classement rouge, bleu ou en exposition parcellaire sans intersection de la carte réglementaire.",
      ],
      regulatory: true,
      sourceUpdatedAt: dateFrom(record, ["dateModification", "date_modification"]),
      documentUrls: urlFromRecord(record),
    };
  });
}

export function parsePprt(payload: unknown): RawFinding[] {
  return records(payload, ["idGaspar", "libPpr", "libelle", "libBassinRisques"]).map((record) => {
    const title = text(record, ["libPpr", "libelle", "libBassinRisques"]) ?? "PPR technologique";
    return {
      category: "technological",
      label: `Plan de prévention des risques technologiques : ${title}`,
      level: text(record, ["etatRevision", "etat"]),
      description:
        "Un PPR technologique est associé au territoire interrogé. La zone d’effet et les prescriptions doivent être vérifiées dans les cartes et le règlement officiels.",
      consequences: [
        "Vérifier la carte réglementaire, les servitudes et les prescriptions du PPRT.",
        "Faire confirmer l’impact sur le projet par la collectivité ou le service instructeur.",
      ],
      regulatory: true,
      sourceUpdatedAt: dateFrom(record, ["dateModification", "date_modification"]),
      documentUrls: urlFromRecord(record),
    };
  });
}

export function parseFloodProcedure(payload: unknown): RawFinding[] {
  return records(payload, [
    "code_national_azi",
    "code_national_tri",
    "libelle_azi",
    "libelle_tri",
    "libelle",
  ]).map((record) => {
    const title =
      text(record, ["libelle_azi", "libelle_tri", "libelle", "libBassinRisques"]) ??
      "dispositif d’information inondation";
    return {
      category: "flood",
      label: title,
      description: `La source Géorisques recense « ${title} ». Un atlas ou territoire à risque ne vaut pas automatiquement classement réglementaire de la parcelle.`,
      consequences: [
        "Comparer la parcelle au PPR inondation et à ses prescriptions lorsqu’ils existent.",
        "Vérifier les niveaux d’eau, les accès et les mesures de réduction de vulnérabilité du projet.",
      ],
      regulatory: false,
      sourceUpdatedAt: dateFrom(record),
    };
  });
}

export function parseRadon(payload: unknown): RawFinding[] {
  return records(payload, ["classe_potentiel", "classePotentiel", "code_insee", "codeInsee"]).map(
    (record) => {
      const level =
        text(record, ["classe_potentiel", "classePotentiel", "classe", "niveau"]) ?? "non précisé";
      const displayLevel = /^classe\b/i.test(level) ? level : `Classe ${level}`;
      const levelThree = /(^|\D)3(\D|$)|élev/i.test(level);
      return {
        category: "radon",
        label: `Potentiel radon : ${displayLevel}`,
        level: displayLevel,
        scope: "commune",
        description: `Géorisques classe le potentiel radon de la commune au niveau « ${displayLevel} ». Ce résultat communal ne mesure pas la concentration intérieure du logement.`,
        consequences: [
          "Pour un niveau élevé, vérifier les obligations d’information et envisager une mesure dans le bâtiment.",
          "Prendre en compte la ventilation et les caractéristiques du projet de construction ou de rénovation.",
        ],
        regulatory: levelThree,
        sourceUpdatedAt: dateFrom(record),
      };
    },
  );
}

export function parseSeismic(payload: unknown): RawFinding[] {
  return records(payload, ["code_zone", "zone_sismicite", "zoneSismicite", "typeZone"]).map(
    (record) => {
      const level =
        text(record, ["zone_sismicite", "zoneSismicite", "code_zone", "typeZone"]) ?? "non précisé";
      const numeric = Number.parseInt(level.replace(/\D/g, ""), 10);
      return {
        category: "earthquake",
        label: `Zonage sismique : ${level}`,
        level,
        description: `Le zonage sismique retourné par Géorisques est « ${level} ». Il s’agit d’un zonage réglementaire général, pas d’une estimation de dommage pour le bâtiment.`,
        consequences: [
          "Vérifier les règles parasismiques applicables au type de construction et à la zone.",
          "Faire confirmer la version réglementaire utilisée pour le permis ou les travaux.",
        ],
        regulatory: Number.isFinite(numeric) ? numeric >= 2 : null,
        sourceUpdatedAt: dateFrom(record),
      };
    },
  );
}

export function parseSsp(payload: unknown): RawFinding[] {
  const result: RawFinding[] = [];
  const root = asRecordOrNull(payload);
  const nestedKeys = [
    ["casias", "CASIAS"],
    ["instructions", "Instruction"],
    ["conclusions_sis", "SIS"],
    ["conclusionsSis", "SIS"],
    ["conclusions_sup", "SUP"],
    ["conclusionsSup", "SUP"],
  ] as const;
  if (root) {
    for (const [key, label] of nestedKeys) {
      const nestedValue = recordValue(root, [key]);
      const nested = records(nestedValue, [
        "identifiant",
        "id",
        "code_insee",
        "codeInsee",
        "nom",
        "libelle",
        "adresse",
      ]);
      if (nested.length > 0) result.push(sspSummary(nested, label));
    }
  }
  if (result.length === 0) {
    const fallback = records(payload, ["identifiant", "id", "casias", "code_insee", "codeInsee"]);
    if (fallback.length > 0) result.push(sspSummary(fallback, "site ou sol pollué"));
  }
  return result;
}

export function summarizeCappedFindings(spec: SourceSpec, findings: RawFinding[]): RawFinding[] {
  if (!findings.length || !["mvt", "cavites"].includes(spec.key) || findings.length < 100) {
    return findings;
  }
  const first = findings[0];
  if (!first) return findings;
  const examples = uniqueStrings(findings.slice(0, 3).map((finding) => finding.label));
  return [
    {
      ...first,
      label: `${spec.label} : ${findings.length} enregistrements sur la première page`,
      level: String(findings.length),
      description: `${spec.label} a retourné ${findings.length} enregistrements sur la première page, qui atteint la limite de l’API. Exemples : ${examples.join(", ")}. La suite doit être vérifiée dans la source paginée ; ces enregistrements ne prouvent pas une emprise sur la parcelle.`,
      consequences: [
        ...first.consequences,
        "Vérifier la pagination et la localisation exacte de chaque phénomène avant de conclure sur le bien.",
      ],
    },
  ];
}

function sspSummary(recordsForKind: Record<string, unknown>[], kind: string): RawFinding {
  const names = uniqueStrings(
    recordsForKind
      .map((record) =>
        text(record, ["nom", "libelle", "raisonSociale", "adresse", "identifiant", "id"]),
      )
      .filter(Boolean),
  ).slice(0, 3);
  const count = recordsForKind.length;
  const countLabel = `${count} enregistrement${count > 1 ? "s" : ""}`;
  const sample = names.length ? ` Exemples : ${names.join(", ")}.` : "";
  return {
    category: "pollution",
    label: `Sites et sols pollués : ${kind} (${countLabel})`,
    level: countLabel,
    description: `La base Géorisques signale ${countLabel} de type ${kind}.${sample} La présence dans la base ne décrit pas à elle seule l’état actuel du sol ni la compatibilité avec le projet.`,
    consequences: [
      "Lire la fiche et les conclusions SIS/SUP lorsqu’elles existent.",
      "Demander une étude de sol et vérifier les restrictions d’usage ou servitudes avant acquisition.",
    ],
    regulatory: /sis|sup/i.test(kind) ? true : null,
    sourceUpdatedAt: recordsForKind.map((record) => dateFrom(record)).find(Boolean),
    documentUrls: recordsForKind.map((record) => urlFromRecord(record)).find(Boolean),
  };
}

export function parseIcpe(payload: unknown): RawFinding[] {
  return records(payload, ["codeAIOT", "code_aiot", "raisonSociale", "siret", "codeInsee"]).map(
    (record) => {
      const name =
        text(record, ["raisonSociale", "raison_sociale", "nom", "codeAIOT"]) ??
        "installation classée";
      const seveso = text(record, ["statutSeveso", "statut_seveso"]);
      return {
        category: "technological",
        label: `Installation classée : ${name}`,
        level: seveso,
        description: `Une installation classée est recensée dans la recherche Géorisques${seveso ? ` (statut Seveso : ${seveso})` : ""}. La distance et les servitudes doivent être vérifiées séparément.`,
        consequences: [
          "Vérifier l’arrêté préfectoral, les servitudes et les périmètres d’effets lorsqu’ils existent.",
          "Ne pas déduire une nuisance ou une zone d’effet à partir du seul référencement ICPE.",
        ],
        regulatory: true,
        sourceUpdatedAt: dateFrom(record),
        distanceM: distanceFrom(record),
        documentUrls: urlFromRecord(record),
      };
    },
  );
}

export function parseNuclear(payload: unknown): RawFinding[] {
  return records(payload, [
    "nomInstallationNucleaire",
    "nom_installation_nucleaire",
    "site",
    "codeInsee",
  ]).map((record) => {
    const name =
      text(record, [
        "nomInstallationNucleaire",
        "nom_installation_nucleaire",
        "site",
        "exploitant",
      ]) ?? "installation nucléaire";
    const radius = text(record, ["rayonPpi", "rayon_ppi"]);
    return {
      category: "technological",
      label: `Installation nucléaire : ${name}`,
      level: radius ? `PPI ${radius}` : null,
      description: `Une installation nucléaire est recensée (${name}). Le périmètre de protection et les effets doivent être vérifiés dans les documents officiels.`,
      consequences: [
        "Consulter le plan particulier d’intervention et les servitudes applicables.",
        "Vérifier la distance réelle au site, qui peut différer de la recherche par rayon.",
      ],
      regulatory: true,
      sourceUpdatedAt: dateFrom(record),
      distanceM: distanceFrom(record),
    };
  });
}
