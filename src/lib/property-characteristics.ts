import type { AuctionSale } from "./types";
import { formatDate, formatDateTime, formatPrice } from "./format";
import { asRecordOrNull, stringValue } from "./guards";

/**
 * Modèle d'affichage du bloc « Caractéristiques du bien ».
 *
 * Source riche : `source_blocks.caracteristiques_bien`, écrit par la pipeline
 * pour les cessions de l'État (tuiles libellé/valeur, nature du bien, surfaces
 * par portée, galerie, pièces jointes, procédure, gestionnaire) et pour les
 * annonces judiciaires Vench, Avoventes et Info-Enchères (caractéristiques,
 * consignation, frais, visites, pièces, parcelles).
 * Source générique : les faits typés de `source_blocks.listing_completeness
 * .source_property_features` qu'une autre source aurait observés.
 * Fonction pure, sans accès réseau ; une valeur absente n'est jamais inventée.
 */

export type CharacteristicItem = { label: string; value: string };
type CharacteristicGroup = { key: string; title: string; items: CharacteristicItem[] };
type CharacteristicAttachment = { label: string; count: number };
type CharacteristicsProcedure = {
  method: string | null;
  pending: boolean;
  facts: CharacteristicItem[];
  visits: string[];
};
export type PropertyCharacteristics = {
  origin: "source" | "generic";
  /** Fiche d'un service de l'État (cessions) plutôt qu'une annonce d'un site d'enchères. */
  official: boolean;
  nature: string[];
  category: string | null;
  groups: CharacteristicGroup[];
  surfaces: CharacteristicItem[];
  media: CharacteristicItem[];
  attachments: CharacteristicAttachment[];
  procedure: CharacteristicsProcedure | null;
  dates: CharacteristicItem[];
  location: CharacteristicItem[];
  manager: { service: string | null; email: string | null } | null;
};

const DEFAULT_GROUPS: Record<string, string> = {
  identification: "Identification",
  surfaces: "Surfaces",
  urbanisme: "Urbanisme et terrain",
  batiment: "Bâtiment",
  equipements: "Équipements",
  situation: "Situation et occupation",
  diagnostics: "Diagnostics",
  divers: "Autres informations",
};

const SURFACE_LABELS: Record<string, string> = {
  published_surface_m2: "Superficie publiée",
  habitable_surface_m2: "Surface habitable",
  carrez_surface_m2: "Surface loi Carrez",
  built_surface_m2: "Surface bâtie",
  land_surface_m2: "Terrain",
  outbuildings_surface_m2: "Dépendances",
  surface_unscoped_m2: "Surface publiée (portée non précisée)",
};

const MEDIA_LABELS: Record<string, string> = {
  photos: "Photos",
  plans: "Plans",
  videos: "Vidéos",
  staging: "Mises en scène",
  virtual_tours: "Visites virtuelles",
};

const PRICE_LABELS: Record<string, string> = {
  starting_price_eur: "Mise à prix",
  preliminary_fees_eur: "Frais préalables",
  asking_price_eur: "Prix demandé",
  minimum_price_eur: "Prix minimum attendu",
  reserve_price_eur: "Prix de réserve",
  floor_price_eur: "Prix plancher",
  deposit_eur: "Consignation",
  bid_increment_eur: "Pas des enchères",
  property_tax_eur: "Taxe foncière",
};

const DEADLINE_LABELS: Record<string, string> = {
  adjudication: "Adjudication",
  sale_window_close: "Fin des enchères",
  offer_deadline: "Date limite de dépôt des offres",
};

const GENERIC_LABELS: Record<string, string> = {
  floor: "Étage",
  heating: "Chauffage",
  year_built: "Année de construction",
  rooms_count: "Pièces",
  bedrooms_count: "Chambres",
  bathrooms_count: "Salles de bain",
  wc_count: "Toilettes",
  showers_count: "Salles d’eau",
  orientation: "Orientation",
  flooring: "Revêtement de sol",
  coownership: "Copropriété",
  coownership_charges: "Charges de copropriété",
  occupancy_physical: "Occupation",
  legal_possession: "Situation juridique",
  dpe_class: "DPE",
  ges_class: "GES",
  elevator: "Ascenseur",
  parking: "Stationnement",
};

const STATE_SOURCES = new Set(["cessions_etat"]);

function text(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Oui" : "Non";
  const result = stringValue(value)?.trim();
  return result ? result : null;
}

function surfaceText(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const number = Number(raw.replace(",", "."));
  if (!Number.isFinite(number) || number <= 0) return null;
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(number)} m²`;
}

function dateText(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  return /T\d{2}:\d{2}/.test(raw) ? formatDateTime(raw) : formatDate(raw);
}

function humanize(key: string): string {
  const label = key.replace(/_/g, " ").trim();
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function sourceCharacteristics(
  block: Record<string, unknown>,
  saleSource: string | null | undefined,
): PropertyCharacteristics | null {
  const groupTitles = {
    ...DEFAULT_GROUPS,
    ...(asRecordOrNull(block.groups) as Record<string, string> | null),
  };
  const grouped = new Map<string, CharacteristicItem[]>();
  for (const entry of Array.isArray(block.items) ? block.items : []) {
    const record = asRecordOrNull(entry);
    const label = text(record?.label);
    const value = text(record?.value);
    if (!record || !label || !value) continue;
    const group = text(record.group) ?? "divers";
    const nature = text(record.nature);
    const items = grouped.get(group) ?? [];
    items.push({ label: nature ? `${label} (${nature})` : label, value });
    grouped.set(group, items);
  }
  const groups = Object.keys(groupTitles)
    .filter((key) => grouped.has(key))
    .map((key) => ({ key, title: groupTitles[key] ?? humanize(key), items: grouped.get(key)! }));

  const energy = asRecordOrNull(block.energy);
  for (const [key, label] of [
    ["dpe_class", "Performance énergétique (DPE)"],
    ["ges_class", "Émissions de gaz à effet de serre (GES)"],
  ] as const) {
    const value = text(energy?.[key]);
    if (!value) continue;
    const diagnostics = groups.find((group) => group.key === "diagnostics");
    if (diagnostics) diagnostics.items.push({ label, value });
    else
      groups.push({
        key: "diagnostics",
        title: groupTitles.diagnostics,
        items: [{ label, value }],
      });
  }

  const surfacesRecord = asRecordOrNull(block.surfaces);
  const surfaces = Object.entries(SURFACE_LABELS).flatMap(([key, label]) => {
    const value = surfaceText(surfacesRecord?.[key]);
    if (!value) return [];
    const fromDescription =
      key === "built_surface_m2" && surfacesRecord?.built_surface_source === "description";
    return [{ label: fromDescription ? `${label} (descriptif)` : label, value }];
  });

  const mediaRecord = asRecordOrNull(block.media);
  const media = Object.entries(MEDIA_LABELS).flatMap(([key, label]) => {
    const count = Number(mediaRecord?.[key]);
    return Number.isFinite(count) && count > 0 ? [{ label, value: String(count) }] : [];
  });

  const attachmentCounts = new Map<string, number>();
  for (const entry of Array.isArray(block.attachments) ? block.attachments : []) {
    const record = asRecordOrNull(entry);
    const label = text(record?.kind_label) ?? text(record?.label);
    if (label) attachmentCounts.set(label, (attachmentCounts.get(label) ?? 0) + 1);
  }
  const attachments = [...attachmentCounts].map(([label, count]) => ({ label, count }));

  const procedureRecord = asRecordOrNull(block.procedure);
  let procedure: CharacteristicsProcedure | null = null;
  if (procedureRecord) {
    const facts: CharacteristicItem[] = [];
    const deadline = asRecordOrNull(procedureRecord.deadline);
    const deadlineValue = dateText(deadline?.at);
    const window = asRecordOrNull(procedureRecord.window);
    const opens = dateText(window?.opens_at);
    if (opens) facts.push({ label: "Ouverture des enchères", value: opens });
    if (deadlineValue) {
      facts.push({
        label: DEADLINE_LABELS[text(deadline?.kind) ?? ""] ?? "Échéance",
        value: deadlineValue,
      });
    }
    const offerDeadline = dateText(procedureRecord.offer_deadline);
    if (offerDeadline && offerDeadline !== deadlineValue) {
      facts.push({ label: "Date limite de dépôt des offres", value: offerDeadline });
    }
    const listingEnd = dateText(procedureRecord.listing_end_estimate);
    if (listingEnd && !deadlineValue) {
      facts.push({ label: "Annonce en ligne jusqu’au (estimation)", value: listingEnd });
    }
    const prices = asRecordOrNull(procedureRecord.prices);
    for (const [key, label] of Object.entries(PRICE_LABELS)) {
      const amount = Number(prices?.[key]);
      if (Number.isFinite(amount) && amount > 0) facts.push({ label, value: formatPrice(amount) });
    }
    const soldOn = dateText(procedureRecord.sold_on);
    if (soldOn) facts.push({ label: "Vendu le", value: soldOn });
    // Mentions publiées en clair (consignation par chèque, faculté de baisse, audience…).
    for (const entry of Array.isArray(procedureRecord.notes) ? procedureRecord.notes : []) {
      const note = asRecordOrNull(entry);
      const label = text(note?.label);
      const value = text(note?.value);
      if (label && value && !facts.some((fact) => fact.label === label))
        facts.push({ label, value });
    }
    const visits = (Array.isArray(procedureRecord.visits) ? procedureRecord.visits : [])
      .map(text)
      .filter((value): value is string => Boolean(value))
      .slice(0, 4);
    procedure = {
      method: text(procedureRecord.method_label) ?? text(procedureRecord.method_source_label),
      pending: procedureRecord.pending === true && !deadlineValue,
      facts,
      visits,
    };
    if (!procedure.method && !procedure.pending && facts.length === 0 && visits.length === 0)
      procedure = null;
  }

  const datesRecord = asRecordOrNull(block.dates);
  const dates = [
    ["published_on", "Publiée le"],
    ["modified_on", "Mise à jour le"],
  ].flatMap(([key, label]) => {
    const value = dateText(datesRecord?.[key]);
    return value ? [{ label, value }] : [];
  });

  const locationRecord = asRecordOrNull(block.location);
  const location = [
    ["designation", "Désignation cadastrale"],
    ["insee_code", "Code INSEE"],
  ].flatMap(([key, label]) => {
    const value = text(locationRecord?.[key]);
    return value ? [{ label, value }] : [];
  });

  const managerRecord = asRecordOrNull(block.manager);
  const manager = managerRecord
    ? { service: text(managerRecord.service), email: text(managerRecord.email) }
    : null;

  const nature = (Array.isArray(block.nature) ? block.nature : [])
    .map((entry) => text(asRecordOrNull(entry)?.display) ?? text(asRecordOrNull(entry)?.label))
    .filter((value): value is string => Boolean(value));

  const model: PropertyCharacteristics = {
    origin: "source",
    official: STATE_SOURCES.has(text(block.source) ?? saleSource ?? ""),
    nature,
    category: text(block.category),
    groups,
    surfaces,
    media,
    attachments,
    procedure,
    dates,
    location,
    manager: manager && (manager.service || manager.email) ? manager : null,
  };
  return hasContent(model) ? model : null;
}

function genericCharacteristics(sale: AuctionSale): PropertyCharacteristics | null {
  const blocks = asRecordOrNull(sale.source_blocks);
  const completeness = asRecordOrNull(blocks?.listing_completeness);
  const features = asRecordOrNull(completeness?.source_property_features);
  if (!features) return null;
  const items: CharacteristicItem[] = [];
  for (const [key, raw] of Object.entries(features)) {
    if (key.startsWith("_") || key === "schema_version") continue;
    const claim = asRecordOrNull(raw);
    if (!claim) continue;
    const state = text(claim.state);
    if (state && state !== "observed") continue;
    const value = text(claim.value);
    if (!value) continue;
    items.push({ label: GENERIC_LABELS[key] ?? humanize(key), value });
  }
  if (items.length === 0) return null;
  return {
    origin: "generic",
    official: false,
    nature: [],
    category: null,
    groups: [{ key: "source", title: "Caractéristiques publiées par la source", items }],
    surfaces: [],
    media: [],
    attachments: [],
    procedure: null,
    dates: [],
    location: [],
    manager: null,
  };
}

function hasContent(model: PropertyCharacteristics): boolean {
  return Boolean(
    model.groups.length ||
    model.surfaces.length ||
    model.nature.length ||
    model.procedure ||
    model.attachments.length ||
    model.media.length,
  );
}

export function getPropertyCharacteristics(sale: AuctionSale): PropertyCharacteristics | null {
  const blocks = asRecordOrNull(sale.source_blocks);
  const block = asRecordOrNull(blocks?.caracteristiques_bien);
  if (block) {
    const model = sourceCharacteristics(block, sale.source_name);
    if (model) return model;
  }
  return genericCharacteristics(sale);
}

export type StateListingStatus = { label: string; detail: string | null };

const TERMINAL_STATUSES = new Set(["past", "adjudicated", "cancelled", "withdrawn", "quarantined"]);

/**
 * Libellé d'une cession de l'État encore en ligne sans échéance publiée.
 * `null` pour toute vente datée ou d'une autre source.
 */
export function stateListingStatus(
  sale: Pick<AuctionSale, "sale_date" | "source_name" | "status" | "source_blocks"> & {
    sale_venue_type?: AuctionSale["sale_venue_type"];
  },
): StateListingStatus | null {
  if (sale.sale_date) return null;
  const state = sale.sale_venue_type === "state" || STATE_SOURCES.has(sale.source_name ?? "");
  if (!state || TERMINAL_STATUSES.has((sale.status ?? "").toLowerCase())) return null;
  const blocks = asRecordOrNull(sale.source_blocks);
  const block = asRecordOrNull(blocks?.caracteristiques_bien);
  const procedure = asRecordOrNull(block?.procedure);
  if (!procedure) {
    // Aperçu public : la carte ne porte pas le détail de la procédure.
    return { label: "Procédure à venir", detail: null };
  }
  const listingEnd = dateText(procedure.listing_end_estimate);
  if (procedure.pending === true) {
    return {
      label: "Procédure à venir",
      detail: "Le calendrier de la cession n’est pas encore publié par l’État.",
    };
  }
  return {
    label: "Date limite au cahier des charges",
    detail: listingEnd
      ? `Annonce en ligne jusqu’au ${listingEnd} environ ; la date limite exacte figure dans le cahier des charges.`
      : "La date limite exacte figure dans le cahier des charges.",
  };
}
