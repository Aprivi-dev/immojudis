import catalogueJson from "../listing-completeness-runtime-client.json";

export const COMPLETENESS_STATES = [
  "observed",
  "inferred",
  "unknown",
  "explicitly_absent",
  "not_applicable",
  "conflict",
] as const;

export type CompletenessState = (typeof COMPLETENESS_STATES)[number];
export type CompletenessImportance = "critical" | "high" | "medium" | "optional";
export type CompletenessCategoryId =
  | "provenance"
  | "procedure"
  | "location"
  | "property"
  | "energy"
  | "outdoor"
  | "occupancy_and_risk"
  | "documents_and_media";
export type CompletenessProcedure = "judicial" | "notarial" | "state" | "online" | "unknown";
export type CompletenessClass = "incomplet" | "a_enrichir" | "decision_prete" | "riche";

type CatalogApplicability = {
  property_types?: string[];
  procedures?: string[];
  conditions?: string;
};

export type CatalogField = {
  id: string;
  category: CompletenessCategoryId;
  label: string;
  definition?: string;
  type?: string;
  unit?: string | null;
  applicability: CatalogApplicability;
  importance: CompletenessImportance;
};

type CatalogCategory = {
  id: CompletenessCategoryId;
  label: string;
  weight: number;
};

type CompletenessCatalogue = {
  fields: CatalogField[];
  categories: CatalogCategory[];
  scoring: {
    importance_factors: Record<CompletenessImportance, number>;
    state_factors: Record<CompletenessState, number | null>;
  };
};

type CompactCatalogue = {
  c: string;
  f: string;
};

const CLIENT_PROPERTY_TYPES = [
  "all",
  "apartment",
  "house",
  "building",
  "land",
  "commercial",
  "parking",
  "mixed",
];
const CLIENT_PROCEDURES = ["all", "judicial", "notarial", "state", "online"];
const CLIENT_IMPORTANCE: CompletenessImportance[] = ["critical", "high", "medium", "optional"];
export const RAW_FEATURE_CATEGORIES = new Set<CompletenessCategoryId>([
  "property",
  "energy",
  "occupancy_and_risk",
  "outdoor",
]);
export const RAW_FEATURE_EXCEPTIONS = new Set([
  "surface_habitable_m2",
  "surface_carrez_m2",
  "surface_built_m2",
  "surface_scope",
  "surface_provenance",
  "rooms_count",
  "bedrooms_count",
  "bathrooms_count",
  "occupancy_status",
  "environmental_risks",
  "technical_diagnostics",
  "garden",
  "terrace",
  "garage",
  "parking",
]);

function decodeCatalogue(input: CompactCatalogue): CompletenessCatalogue {
  const categories = input.c.split(";").map((row) => {
    const [id, label, weight] = row.split("|");
    return { id: id as CompletenessCategoryId, label, weight: Number(weight) };
  });
  return {
    categories,
    fields: input.f.split(";").map((row) => {
      const [id, label, packedValue, conditions] = row.split("|");
      const packed = Number(packedValue);
      const categoryIndex = packed & 7;
      const propertyMask = (packed >> 3) & 255;
      const procedureMask = (packed >> 11) & 31;
      const importanceIndex = (packed >> 16) & 3;
      return {
        id,
        category: categories[categoryIndex].id,
        label,
        applicability: {
          property_types: CLIENT_PROPERTY_TYPES.filter((_, index) => propertyMask & (1 << index)),
          procedures: CLIENT_PROCEDURES.filter((_, index) => procedureMask & (1 << index)),
          ...(conditions ? { conditions } : {}),
        },
        importance: CLIENT_IMPORTANCE[importanceIndex],
      };
    }),
    scoring: {
      importance_factors: { critical: 3, high: 2, medium: 1, optional: 0.5 },
      state_factors: {
        observed: 1,
        explicitly_absent: 1,
        inferred: 0.6,
        unknown: 0,
        conflict: 0,
        not_applicable: null,
      },
    },
  };
}

export const CATALOGUE = decodeCatalogue(catalogueJson as unknown as CompactCatalogue);

export const LISTING_COMPLETENESS_CATALOGUE = CATALOGUE;
export const LISTING_COMPLETENESS_FIELD_IDS = CATALOGUE.fields.map((field) => field.id);
export const LISTING_COMPLETENESS_FIELD_COUNT = LISTING_COMPLETENESS_FIELD_IDS.length;
