import "server-only";
import {
  excerptAround,
  normalizeComparableText,
  normalizeWhitespace,
  replyTextForExtraction,
} from "@/lib/information-agent-inbound/text";

export type ExtractedInformationAgentFact = {
  factKey:
    | "surface_m2"
    | "land_surface_m2"
    | "rooms_count"
    | "occupancy_status"
    | "visit_information"
    | "sale_date"
    | "starting_price_eur"
    | "energy_diagnostics"
    | "property_type"
    | "address";
  proposedValue: { value: number | string; unit?: string };
  displayValue: string;
  evidenceExcerpt: string;
  confidence: number;
};

export function extractInformationAgentFacts(bodyText: string): ExtractedInformationAgentFact[] {
  const normalized = replyTextForExtraction(bodyText).replace(/\u00a0/g, " ");
  const facts: ExtractedInformationAgentFact[] = [];
  const surfaceObservation = extractSurfaceObservation(normalized);
  if (surfaceObservation) {
    const { value, index, label } = surfaceObservation;
    if (value > 0 && value <= 1000000 && !hasAmbiguousCorrectionNear(normalized, index)) {
      facts.push({
        factKey: "surface_m2",
        proposedValue: { value, unit: "m2" },
        displayValue: `${label ? `${label} : ` : ""}${value.toLocaleString("fr-FR")} m²`,
        evidenceExcerpt: excerptAround(normalized, index),
        confidence: label ? 0.88 : 0.7,
      });
    }
  }

  const landSurfaceObservation = extractLandSurfaceObservation(normalized);
  if (
    landSurfaceObservation &&
    !hasAmbiguousCorrectionNear(normalized, landSurfaceObservation.index)
  ) {
    facts.push({
      factKey: "land_surface_m2",
      proposedValue: { value: landSurfaceObservation.value, unit: "m2" },
      displayValue: `Terrain : ${landSurfaceObservation.value.toLocaleString("fr-FR")} m²`,
      evidenceExcerpt: excerptAround(normalized, landSurfaceObservation.index),
      confidence: 0.88,
    });
  }

  const roomsMatches = [...normalized.matchAll(/(?<!\d)(\d{1,2})(?!\d)\s+pi[eè]ces?\b/gi)];
  const roomValues = new Set(roomsMatches.map((match) => Number(match[1])));
  const roomsMatch = roomValues.size === 1 ? roomsMatches[0] : undefined;
  if (roomsMatch) {
    const value = Number(roomsMatch[1]);
    if (
      value >= 1 &&
      value <= 100 &&
      !hasAmbiguousCorrectionNear(normalized, roomsMatch.index ?? 0)
    ) {
      facts.push({
        factKey: "rooms_count",
        proposedValue: { value },
        displayValue: `${value} pièce${value > 1 ? "s" : ""}`,
        evidenceExcerpt: excerptAround(normalized, roomsMatch.index ?? 0),
        confidence: 0.86,
      });
    }
  }

  const occupancyPatterns: Array<[RegExp, string, string]> = [
    [
      /\b(?:bien|logement|maison|appartement)\s+(?:(?:est|était|sera|serait)\s+)?occup[ée]e?s?\s+par\s+(?:le|la|les)\s+propri[ée]taire(?:s)?\b/iu,
      "owner_occupied",
      "Bien occupé par le propriétaire",
    ],
    [/\b(?:libre\s+de\s+toute\s+occupation|vacant|inoccup[ée])\b/iu, "vacant", "Bien libre"],
    [/\b(?:bail\s+en\s+cours|locataire|location)\b/iu, "rented", "Bien loué"],
    [
      /\b(?:bien|logement|maison|appartement)\s+(?:(?:est|était|sera|serait)\s+)?libres?(?![\p{L}\p{N}])/iu,
      "vacant",
      "Bien libre",
    ],
    [
      /\b(?:bien|logement|maison|appartement)\s+(?:(?:est|était|sera|serait)\s+)?lou[ée]e?s?(?![\p{L}\p{N}])/iu,
      "rented",
      "Bien loué",
    ],
    [
      /\b(?:bien|logement|maison|appartement)\s+(?:(?:est|était|sera|serait)\s+)?occup[ée]e?s?(?![\p{L}\p{N}])/iu,
      "occupied",
      "Bien occupé",
    ],
    [/\bsquatt[ée]e?s?(?![\p{L}\p{N}])/iu, "squatted", "Bien squatté"],
  ];
  const occupancyMatches = occupancyPatterns.flatMap(([pattern, value, label]) =>
    pattern.test(normalized) ? [{ pattern, value, label }] : [],
  );
  const effectiveOccupancyMatches = occupancyMatches.some(
    (match) => match.value === "owner_occupied",
  )
    ? occupancyMatches.filter((match) => match.value !== "occupied")
    : occupancyMatches;
  if (new Set(effectiveOccupancyMatches.map((match) => match.value)).size === 1) {
    for (const { pattern, value, label } of effectiveOccupancyMatches) {
      const match = normalized.match(pattern);
      if (!match) continue;
      if (
        !hasAmbiguousCorrectionNear(normalized, match.index ?? 0) &&
        !hasNegatedValueNear(normalized, match.index ?? 0)
      ) {
        facts.push({
          factKey: "occupancy_status",
          proposedValue: { value },
          displayValue: label,
          evidenceExcerpt: excerptAround(normalized, match.index ?? 0),
          confidence: 0.82,
        });
      }
      break;
    }
  }

  const visitObservation = extractVisitObservation(normalized);
  if (visitObservation) {
    facts.push({
      factKey: "visit_information",
      proposedValue: { value: visitObservation.value },
      displayValue: visitObservation.value,
      evidenceExcerpt: visitObservation.evidenceExcerpt,
      confidence: 0.72,
    });
  }

  const diagnosticObservation = extractEnergyDiagnosticObservation(normalized);
  if (diagnosticObservation) {
    facts.push({
      factKey: "energy_diagnostics",
      proposedValue: { value: diagnosticObservation.value },
      displayValue: diagnosticObservation.value,
      evidenceExcerpt: diagnosticObservation.evidenceExcerpt,
      confidence: 0.88,
    });
  }

  const propertyTypeObservation = extractPropertyTypeObservation(normalized);
  if (propertyTypeObservation) {
    facts.push({
      factKey: "property_type",
      proposedValue: { value: propertyTypeObservation.value },
      displayValue: propertyTypeObservation.displayValue,
      evidenceExcerpt: propertyTypeObservation.evidenceExcerpt,
      confidence: 0.84,
    });
  }

  const addressObservation = extractAddressObservation(normalized);
  if (addressObservation) {
    facts.push({
      factKey: "address",
      proposedValue: { value: addressObservation.value },
      displayValue: addressObservation.value,
      evidenceExcerpt: addressObservation.evidenceExcerpt,
      confidence: 0.8,
    });
  }

  const saleDateObservations = extractLabeledSaleDates(normalized);
  if (saleDateObservations.length) {
    const values = new Set(saleDateObservations.map((observation) => observation.value));
    if (values.size === 1) {
      const observation = saleDateObservations[0];
      if (observation && !hasAmbiguousCorrectionNear(normalized, observation.index)) {
        facts.push({
          factKey: "sale_date",
          proposedValue: { value: observation.value },
          displayValue: formatFrenchDate(observation.value),
          evidenceExcerpt: excerptAround(normalized, observation.index),
          confidence: 0.94,
        });
      }
    }
  }

  const startingPriceObservations = extractLabeledStartingPrices(normalized);
  if (startingPriceObservations.length) {
    const values = new Set(startingPriceObservations.map((observation) => observation.value));
    if (values.size === 1) {
      const observation = startingPriceObservations[0];
      if (observation && !hasAmbiguousCorrectionNear(normalized, observation.index)) {
        facts.push({
          factKey: "starting_price_eur",
          proposedValue: { value: observation.value, unit: "EUR" },
          displayValue: `${observation.value.toLocaleString("fr-FR")} €`,
          evidenceExcerpt: excerptAround(normalized, observation.index),
          confidence: 0.95,
        });
      }
    }
  }
  return facts;
}

type SurfaceObservation = { value: number; index: number; label: string | null };

function extractSurfaceObservation(text: string): SurfaceObservation | null {
  const labelledPattern =
    /\b(surface(?:\s+(?:habitable|carrez|privative|utile|totale|au\s+sol))?)[^\d]{0,45}(\d{1,8}(?:[.,]\d{1,2})?)\s*m(?:²|2)(?![\p{L}\p{N}])/giu;
  const genericPattern = /(?<![\d.,])(\d{1,8}(?:[.,]\d{1,2})?)\s*m(?:²|2)(?![\p{L}\p{N}])/giu;
  const labelled: SurfaceObservation[] = [];
  for (const match of text.matchAll(labelledPattern)) {
    const rawValue = match[2];
    const matchIndex = match.index ?? 0;
    const trailingClause =
      text
        .slice(matchIndex + (match[0]?.length ?? 0), matchIndex + (match[0]?.length ?? 0) + 60)
        .split(/[.!?\n;]/u, 1)[0] ?? "";
    if (
      !rawValue ||
      isLandSurfaceContext(text, matchIndex) ||
      /\b(?:terrain|parcelle|contenance)\b/iu.test(match[0] ?? "") ||
      hasExplicitUncertainty(match[0] ?? "") ||
      hasExplicitUncertainty(trailingClause)
    )
      continue;
    const value = Number(rawValue.replace(",", "."));
    if (Number.isFinite(value) && value > 0 && value <= 1_000_000) {
      labelled.push({
        value,
        index: matchIndex,
        label: normalizeWhitespace(match[1] ?? "surface"),
      });
    }
  }

  const generic: SurfaceObservation[] = [];
  for (const match of text.matchAll(genericPattern)) {
    const value = Number((match[1] ?? "").replace(",", "."));
    const index = match.index ?? 0;
    if (
      !Number.isFinite(value) ||
      value <= 0 ||
      value > 1_000_000 ||
      isLandSurfaceContext(text, index) ||
      hasExplicitUncertainty(
        text.slice(
          Math.max(0, index - 70),
          Math.min(text.length, index + (match[0]?.length ?? 0) + 70),
        ),
      ) ||
      labelled.some((observation) => observation.index === index)
    ) {
      continue;
    }
    generic.push({ value, index, label: null });
  }
  const genericValues = new Set(generic.map((observation) => observation.value));
  const preferred = labelled.filter((observation) =>
    /habitable|privative|utile|totale|au sol/i.test(observation.label ?? ""),
  );
  const carrez = labelled.filter((observation) => /carrez/i.test(observation.label ?? ""));
  for (const candidates of [preferred, carrez, labelled]) {
    const values = new Set(candidates.map((observation) => observation.value));
    if (values.size > 1) return null;
    const candidate = candidates[0];
    if (candidate && [...genericValues].every((value) => value === candidate.value)) {
      return candidate;
    }
  }
  const values = new Set(generic.map((observation) => observation.value));
  return values.size === 1 ? (generic[0] ?? null) : null;
}

function extractLandSurfaceObservation(text: string): { value: number; index: number } | null {
  const pattern =
    /\b(?:surface\s+(?:du|de\s+la)\s+terrain|terrain|parcelle|contenance)[^\d]{0,60}(\d{1,10}(?:[.,]\d{1,2})?)\s*m(?:²|2)(?![\p{L}\p{N}])/giu;
  const observations: Array<{ value: number; index: number }> = [];
  for (const match of text.matchAll(pattern)) {
    const value = Number((match[1] ?? "").replace(",", "."));
    if (Number.isFinite(value) && value > 0 && value <= 100_000_000) {
      observations.push({ value, index: match.index ?? 0 });
    }
  }
  const values = new Set(observations.map((observation) => observation.value));
  return values.size === 1 ? (observations[0] ?? null) : null;
}

function isLandSurfaceContext(text: string, index: number): boolean {
  return /\b(?:terrain|parcelle|contenance)\b/i.test(text.slice(Math.max(0, index - 70), index));
}

function extractVisitObservation(text: string): { value: string; evidenceExcerpt: string } | null {
  const pattern = /\bvisites?\b/giu;
  const observations: Array<{ value: string; evidenceExcerpt: string }> = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const source = text.slice(start, Math.min(text.length, start + 240));
    const nextLabel =
      /\b(?:DPE|GES|mise\s+[àa]\s+prix|date\s+de\s+la\s+vente|surface|diagnostic|frais)\b/iu.exec(
        source.slice(match[0].length),
      );
    let end = nextLabel ? match[0].length + (nextLabel.index ?? 0) : source.length;
    for (let index = match[0].length; index < end; index++) {
      const character = source[index];
      if (
        character === "\n" ||
        character === "\r" ||
        character === ";" ||
        character === "!" ||
        character === "?"
      ) {
        end = index;
        break;
      }
      if (character === "." && !isDigit(source[index - 1]) && !isDigit(source[index + 1])) {
        end = index;
        break;
      }
      if (character === "." && !isDigit(source[index + 1])) {
        end = index;
        break;
      }
    }
    const raw = normalizeWhitespace(source.slice(0, end));
    const detail = raw.replace(/^visites?\b\s*[:-]?\s*/iu, "").trim();
    const rawWithPrefix = normalizeWhitespace(
      `${text.slice(Math.max(0, start - 40), start)} ${raw}`,
    );
    if (
      !detail ||
      /\b(?:aucun(?:e)?|pas\s+de)\s+visites?\b|\bvisites?\s+(?:impossible|indisponible|non\s+(?:possible|disponible)|pas\s+possible|à\s+confirmer|a\s+confirmer)\b/iu.test(
        rawWithPrefix,
      ) ||
      /^(?:aucun(?:e)?|pas\s+de|impossible|indisponible|non\s+(?:possible|disponible)|pas\s+possible)\b/iu.test(
        detail,
      ) ||
      !hasVisitSignal(detail)
    )
      continue;
    const value = raw ? `${raw.slice(0, 1).toLocaleUpperCase("fr-FR")}${raw.slice(1)}` : raw;
    observations.push({
      value: value.slice(0, 500),
      evidenceExcerpt: excerptAround(text, match.index ?? 0),
    });
  }
  const unique = new Map(
    observations.map((observation) => [observation.value.toLowerCase(), observation]),
  );
  return unique.size === 1 ? (unique.values().next().value ?? null) : null;
}

function hasVisitSignal(value: string): boolean {
  return /\b(?:\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?|\d{1,2}\s+(?:janv|févr|fevr|mars|avr|mai|juin|juil|ao[uû]t|sept?|oct|nov|déc|dec)[a-zéû]*|\d{1,2}\s*h|rendez[- ]vous|inscription|sur\s+rendez|organis|possible|aucune?|pas\s+de|contact)\b/iu.test(
    value,
  );
}

function extractEnergyDiagnosticObservation(
  text: string,
): { value: string; evidenceExcerpt: string } | null {
  const diagnosticPattern =
    /\b(?:DPE|diagnostic\s+de\s+performance\s+[ée]nerg[ée]tique)\b[^\n.]{0,180}/giu;
  const observations: Array<{ value: string; evidenceExcerpt: string }> = [];
  for (const match of text.matchAll(diagnosticPattern)) {
    const segment = normalizeWhitespace(match[0] ?? "");
    if (containsUncertainQualifier(segment)) continue;
    const dpe =
      /\b(?:DPE|classe\s+(?:énerg(?:ie|étique)|energie|energetique)|étiquette\s+énergie)\s*[:-]?\s*([A-G])\b/iu
        .exec(segment)?.[1]
        ?.toUpperCase();
    const ges = /\bGES\s*[:-]?\s*([A-G])\b/iu.exec(segment)?.[1]?.toUpperCase();
    if (!dpe && !ges && !/\b(?:disponible|réalis[ée]|a[nn]ex[ée]|joint|transmis)/iu.test(segment))
      continue;
    const value =
      [dpe ? `DPE ${dpe}` : null, ges ? `GES ${ges}` : null].filter(Boolean).join(" · ") || segment;
    observations.push({
      value: value.slice(0, 500),
      evidenceExcerpt: excerptAround(text, match.index ?? 0),
    });
  }
  const unique = new Map(
    observations.map((observation) => [observation.value.toLowerCase(), observation]),
  );
  return unique.size === 1 ? (unique.values().next().value ?? null) : null;
}

type PropertyTypeValue =
  | "house"
  | "apartment"
  | "building"
  | "commercial"
  | "mixed"
  | "land"
  | "parking";

const PROPERTY_TYPE_OBSERVATIONS: Array<{
  value: PropertyTypeValue;
  displayValue: string;
  pattern: RegExp;
}> = [
  { value: "house", displayValue: "Maison", pattern: /\b(?:maison|villa|pavillon)\b/iu },
  {
    value: "apartment",
    displayValue: "Appartement",
    pattern: /\b(?:appartement|studio|duplex|triplex|T\s*[1-9]\d?)\b/iu,
  },
  { value: "building", displayValue: "Immeuble", pattern: /\bimmeuble\b/iu },
  {
    value: "commercial",
    displayValue: "Local commercial",
    pattern: /\b(?:local\s+commercial|commerce|bureau)\b/iu,
  },
  { value: "mixed", displayValue: "Bien mixte", pattern: /\bbien\s+mixte\b/iu },
  {
    value: "land",
    displayValue: "Terrain",
    pattern: /\b(?:terrain|parcelle)\s+(?:à|a)\s+(?:bâtir|batir|construire)\b/iu,
  },
  { value: "parking", displayValue: "Parking", pattern: /\b(?:parking|box\s+(?:fermé|ferme))\b/iu },
];

function extractPropertyTypeObservation(
  text: string,
): { value: string; displayValue: string; evidenceExcerpt: string } | null {
  const observations: Array<{ value: string; displayValue: string; evidenceExcerpt: string }> = [];
  for (const item of PROPERTY_TYPE_OBSERVATIONS) {
    const match = item.pattern.exec(text);
    if (!match) continue;
    if (!hasExplicitPropertyTypeContext(text, match.index ?? 0, match[0].length)) continue;
    observations.push({
      value: item.value,
      displayValue: item.displayValue,
      evidenceExcerpt: excerptAround(text, match.index ?? 0),
    });
  }
  const unique = new Map(observations.map((observation) => [observation.value, observation]));
  return unique.size === 1 ? (unique.values().next().value ?? null) : null;
}

function hasExplicitPropertyTypeContext(text: string, index: number, length: number): boolean {
  const before = text.slice(Math.max(0, index - 90), index);
  const after = text.slice(index + length, Math.min(text.length, index + length + 40));
  return (
    /(?:type\s+de\s+bien|nature\s+du\s+bien|cat[ée]gorie|propri[ée]t[ée]|lot)\s*[:=-]?\s*$/iu.test(
      before,
    ) ||
    /(?:\b(?:le\s+)?bien|c['’]est|il\s+s['’]agit)\s+(?:est\s+)?(?:d['’])?(?:un(?:e)?\s+)?$/iu.test(
      before,
    ) ||
    /^\s*(?:à|a)\s+(?:vendre|louer|b[âa]tir|construire)\b/iu.test(after)
  );
}

function extractAddressObservation(
  text: string,
): { value: string; evidenceExcerpt: string } | null {
  const pattern =
    /\b(?:adresse|sis(?:e)?|situ[ée]?(?:\s+(?:au|à|a))?)\b\s*[:-]?\s*([^\n]{5,180})/giu;
  const observations: Array<{ value: string; evidenceExcerpt: string }> = [];
  for (const match of text.matchAll(pattern)) {
    const value = normalizeWhitespace(match[1] ?? "")
      .replace(/[.,;]+$/, "")
      .trim();
    if (!value || hasExplicitUncertainty(value)) continue;
    observations.push({
      value: value.slice(0, 180),
      evidenceExcerpt: excerptAround(text, match.index ?? 0),
    });
  }
  const unique = new Map(
    observations.map((observation) => [observation.value.toLowerCase(), observation]),
  );
  return unique.size === 1 ? (unique.values().next().value ?? null) : null;
}

export function conflictsWithSale(
  fact: ExtractedInformationAgentFact,
  sale: {
    surface_m2: number | null;
    app_surface_m2: number | null;
    land_surface_m2: number | null;
    rooms_count: number | null;
    occupancy_status: string | null;
    sale_date: string | null;
    starting_price_eur: number | null;
    property_type: string | null;
    address: string | null;
  },
) {
  const value = fact.proposedValue.value;
  if (fact.factKey === "surface_m2") {
    const existing = sale.app_surface_m2 ?? sale.surface_m2;
    return existing != null && Math.abs(existing - Number(value)) > 0.5;
  }
  if (fact.factKey === "rooms_count") {
    return sale.rooms_count != null && sale.rooms_count !== Number(value);
  }
  if (fact.factKey === "land_surface_m2") {
    return sale.land_surface_m2 != null && Math.abs(sale.land_surface_m2 - Number(value)) > 0.5;
  }
  if (fact.factKey === "occupancy_status") {
    return sale.occupancy_status != null && sale.occupancy_status !== value;
  }
  if (fact.factKey === "sale_date") {
    return sale.sale_date != null && String(sale.sale_date).slice(0, 10) !== String(value);
  }
  if (fact.factKey === "property_type") {
    return sale.property_type != null && sale.property_type !== String(value);
  }
  if (fact.factKey === "address") {
    return (
      sale.address != null &&
      normalizeComparableText(sale.address) !== normalizeComparableText(String(value))
    );
  }
  if (fact.factKey === "visit_information" || fact.factKey === "energy_diagnostics") {
    return false;
  }
  return (
    sale.starting_price_eur != null && Math.abs(sale.starting_price_eur - Number(value)) > 0.01
  );
}

type LabeledSaleDateObservation = { value: string; index: number };
type LabeledStartingPriceObservation = { value: number; index: number };

const SALE_DATE_LABEL_PATTERN =
  /(?:date\s+(?:de\s+la\s+|de\s+)?vente|date\s+(?:d['’]|de\s+l['’]\s*)adjudication|date\s+(?:d['’]|de\s+l['’]\s*)audience|audience\s+d['’]adjudication|adjudication\s+(?:prévue|prevue)|vente\s+(?:prévue|prevue))\b/giu;
const FRENCH_MONTH_PATTERN =
  "(?:janv(?:ier)?|févr(?:ier)?|fevr(?:ier)?|mars|avr(?:il)?|mai|juin|juil(?:let)?|ao[uû]t|sept?(?:embre)?|oct(?:obre)?|nov(?:embre)?|déc(?:embre)?|dec(?:embre)?)";
const DATE_TOKEN_PATTERN = new RegExp(
  `(?<!\\d)(?:\\d{1,2}[/.\\-]\\d{1,2}[/.\\-]\\d{4}|\\d{4}[/.\\-]\\d{1,2}[/.\\-]\\d{1,2}|\\d{1,2}\\s+${FRENCH_MONTH_PATTERN}\\s+\\d{4})(?!\\d)`,
  "iu",
);
const DATE_TOKEN_GLOBAL_PATTERN = new RegExp(DATE_TOKEN_PATTERN.source, "giu");
const STARTING_PRICE_LABEL_PATTERN =
  /(?:mise\s+[àa]\s+prix|prix\s+(?:de\s+)?(?:départ|depart|initial|d['’]ouverture|ouverture))\b/giu;
const NEXT_INFORMATION_LABEL_PATTERN = new RegExp(
  `(?:${SALE_DATE_LABEL_PATTERN.source}|${STARTING_PRICE_LABEL_PATTERN.source})`,
  "iu",
);
const MONEY_TOKEN_PATTERN = new RegExp(
  "(?<![\\d.,])((?:\\d{1,3}(?:[ .\\u00a0]\\d{3})+(?:[.,]\\d{1,2})?|\\d{4,10}|\\d{1,3}(?:[.,]\\d{1,2})?))(?:\\s*(k|m))?\\s*(?:€|euros?|eur)(?![\\p{L}\\p{N}])",
  "giu",
);

function extractLabeledSaleDates(text: string): LabeledSaleDateObservation[] {
  const observations: LabeledSaleDateObservation[] = [];
  for (const labelMatch of text.matchAll(SALE_DATE_LABEL_PATTERN)) {
    const labelIndex = labelMatch.index ?? 0;
    const clause = labeledClauseAfterLabel(text, labelIndex + labelMatch[0].length);
    const dateMatches = [...clause.text.matchAll(DATE_TOKEN_GLOBAL_PATTERN)];
    if (!dateMatches.length) continue;
    if (dateMatches.length !== 1) return [];
    const dateMatch = dateMatches[0];
    if (!dateMatch?.[0]) return [];
    if (containsUncertainQualifier(clause.text)) return [];
    const value = parseFrenchDate(dateMatch[0]);
    if (!value) return [];
    observations.push({
      value,
      index: clause.start + (dateMatch.index ?? 0),
    });
  }
  return observations;
}

function extractLabeledStartingPrices(text: string): LabeledStartingPriceObservation[] {
  const observations: LabeledStartingPriceObservation[] = [];
  for (const labelMatch of text.matchAll(STARTING_PRICE_LABEL_PATTERN)) {
    const labelIndex = labelMatch.index ?? 0;
    const clause = labeledClauseAfterLabel(text, labelIndex + labelMatch[0].length);
    const moneyMatches = [...clause.text.matchAll(MONEY_TOKEN_PATTERN)];
    if (moneyMatches.length !== 1) continue;
    const moneyMatch = moneyMatches[0];
    if (!moneyMatch?.[1]) continue;
    if (containsUncertainQualifier(clause.text)) return [];
    const value = parseFrenchMoney(moneyMatch[1], moneyMatch[2]);
    if (value == null || value <= 0 || value > 1_000_000_000) return [];
    observations.push({
      value,
      index: clause.start + (moneyMatch.index ?? 0),
    });
  }
  return observations;
}

function labeledClauseAfterLabel(text: string, start: number): { text: string; start: number } {
  const source = text.slice(start, Math.min(text.length, start + 100));
  const nextLabel = NEXT_INFORMATION_LABEL_PATTERN.exec(source);
  let end = nextLabel?.index ?? source.length;
  for (let index = 0; index < end; index++) {
    const character = source[index];
    if (
      character === "\n" ||
      character === "\r" ||
      character === ";" ||
      character === "!" ||
      character === "?"
    ) {
      end = index;
      break;
    }
    if (character === "." && !(isDigit(source[index - 1]) && isDigit(source[index + 1]))) {
      end = index;
      break;
    }
  }
  return { text: source.slice(0, end), start };
}

function isDigit(value: string | undefined): boolean {
  return value != null && value >= "0" && value <= "9";
}

function containsUncertainQualifier(value: string): boolean {
  return /(?<![\p{L}\p{N}])(?:pas|aucun[e]?|inconnu[e]?|non\s+communiqu[ée]e?|non\s+disponible|indisponible|à\s+confirmer|a\s+confirmer|à\s+d[ée]finir|a\s+definir|sous\s+r[ée]serve|report[ée]e?|en\s+attente)(?![\p{L}\p{N}])/iu.test(
    value,
  );
}

function hasExplicitUncertainty(value: string): boolean {
  return /(?<![\p{L}\p{N}])(?:à\s+confirmer|a\s+confirmer|à\s+d[ée]finir|a\s+definir|inconnu[e]?|incertain[e]?|non\s+communiqu[ée]e?|pas\s+communiqu[ée]e?|non\s+disponible|indisponible|sous\s+r[ée]serve|en\s+attente)(?![\p{L}\p{N}])/iu.test(
    value,
  );
}

const AMBIGUOUS_CORRECTION_PATTERN =
  /(?<![\p{L}\p{N}])(?:correction|corrig(?:é|ée|és|ées)|rectification|rectifi(?:é|ée|és|ées)|erratum|erreur|au\s+lieu\s+de|et\s+non)(?![\p{L}\p{N}])/iu;

function hasAmbiguousCorrectionNear(text: string, index: number): boolean {
  const start = Math.max(0, index - 120);
  const end = Math.min(text.length, index + 120);
  return AMBIGUOUS_CORRECTION_PATTERN.test(text.slice(start, end));
}

function hasNegatedValueNear(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 70), index);
  const after = text.slice(index, Math.min(text.length, index + 70));
  return (
    /(?:n['’]est|n['’]était|ne\s+\w+|pas|sans|non)\s+[^.!?\n]{0,35}$/iu.test(before) ||
    /^\s*(?:pas|non)\b/iu.test(after)
  );
}

function parseFrenchDate(value: string): string | null {
  const normalized = value
    .toLocaleLowerCase("fr-FR")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let day: number;
  let month: number;
  let year: number;
  const numeric = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(normalized);
  const iso = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/.exec(normalized);
  const words = new RegExp(`^(\\d{1,2})\\s+(${FRENCH_MONTH_PATTERN})\\s+(\\d{4})$`, "iu").exec(
    normalized,
  );
  if (numeric?.[1] && numeric[2] && numeric[3]) {
    day = Number(numeric[1]);
    month = Number(numeric[2]);
    year = Number(numeric[3]);
  } else if (iso?.[1] && iso[2] && iso[3]) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (words?.[1] && words[2] && words[3]) {
    day = Number(words[1]);
    month = frenchMonthNumber(words[2]);
    year = Number(words[3]);
  } else {
    return null;
  }
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) return null;
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
}

function frenchMonthNumber(value: string): number {
  const normalized = value.toLocaleLowerCase("fr-FR").replace(/[.]/g, "");
  const months: Record<string, number> = {
    janvier: 1,
    janv: 1,
    février: 2,
    fevrier: 2,
    févr: 2,
    fevr: 2,
    mars: 3,
    avril: 4,
    avr: 4,
    mai: 5,
    juin: 6,
    juillet: 7,
    juil: 7,
    août: 8,
    aout: 8,
    septembre: 9,
    sept: 9,
    octobre: 10,
    oct: 10,
    novembre: 11,
    nov: 11,
    décembre: 12,
    decembre: 12,
    déc: 12,
    dec: 12,
  };
  return months[normalized] ?? 0;
}

function parseFrenchMoney(value: string, multiplier: string | undefined): number | null {
  const compact = value.replace(/[ \u00a0]/g, "");
  let parsed: number;
  const separatorCount = (compact.match(/[.,]/g) ?? []).length;
  if (separatorCount > 1) {
    parsed = Number(compact.replace(/[.,]/g, ""));
  } else if (/[.,]/.test(compact)) {
    const separator = compact.includes(",") ? "," : ".";
    const [whole = "", fraction = ""] = compact.split(separator);
    parsed =
      fraction.length === 3 ? Number(`${whole}${fraction}`) : Number(compact.replace(",", "."));
  } else {
    parsed = Number(compact);
  }
  if (!Number.isFinite(parsed)) return null;
  const normalizedMultiplier = multiplier?.toLocaleLowerCase("fr-FR");
  if (normalizedMultiplier === "k") parsed *= 1_000;
  if (normalizedMultiplier === "m") parsed *= 1_000_000;
  return Number.isFinite(parsed) ? parsed : null;
}

function formatFrenchDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}
