import type { MarketEstimate } from "@/lib/market.server";
import {
  computeMarketCeiling,
  DEFAULT_MARKET_CEILING_SCENARIO,
  DEFAULTS,
  estimateWorksBudget,
} from "@/lib/profitability";
import type { AuctionSale } from "@/lib/types";

export const EXAMPLE_SALE_KEYS = ["bordeaux", "nantes", "toulouse"] as const;
export type ExampleSaleKey = (typeof EXAMPLE_SALE_KEYS)[number];

// Every figure of the example points to a (fictitious) page of a (fictitious)
// document, so the page shows a source for each field instead of "Source à préciser".
const EXAMPLE_EVIDENCE_URL = "https://immojudis.com/annonce-exemple";

type ExampleFeature = {
  field: string;
  value: unknown;
  document: string;
  page: number;
  excerpt: string;
};

function exampleSourceFeatures(features: ExampleFeature[]) {
  return features.map(({ field, value, document, page, excerpt }) => ({
    field,
    state: "observed",
    value,
    evidence: [
      {
        grade: "A",
        kind: "document",
        source_name: `${document} (exemple fictif)`,
        document_label: `${document} (exemple fictif)`,
        url: `${EXAMPLE_EVIDENCE_URL}#${field}`,
        page,
        excerpt,
      },
    ],
  }));
}

/** One sourced observation per field the example page shows, read from the sale itself. */
function exampleFeatures(
  sale: AuctionSale,
  schedule: { hearing: string; visits: string[] },
): ExampleFeature[] {
  const cahier = "Cahier des conditions de vente";
  const pv = "PV descriptif";
  const apartment = sale.property_type === "apartment";
  const city = sale.city ?? "";
  const location = `${sale.address}, ${sale.postal_code} ${city}`;
  const surface = sale.app_surface_m2 ?? 0;
  const price = sale.starting_price_eur ?? 0;
  const features: ExampleFeature[] = [
    {
      field: "property_type",
      value: sale.property_type,
      document: pv,
      page: 2,
      excerpt: `${apartment ? "Appartement" : "Maison"} de ${sale.rooms_count} pièces.`,
    },
    {
      field: "address",
      value: sale.address,
      document: cahier,
      page: 1,
      excerpt: `Désignation : un bien situé ${location} (adresse fictive).`,
    },
    {
      field: "postal_code",
      value: sale.postal_code,
      document: cahier,
      page: 1,
      excerpt: location + ".",
    },
    { field: "city", value: sale.city, document: cahier, page: 1, excerpt: location + "." },
    {
      field: "department",
      value: sale.department,
      document: cahier,
      page: 1,
      excerpt: `${city} (${sale.department}).`,
    },
    {
      field: apartment ? "surface_carrez_m2" : "surface_habitable_m2",
      value: surface,
      document: pv,
      page: 3,
      excerpt: `Surface ${apartment ? "Carrez" : "habitable"} : ${surface} m².`,
    },
    {
      field: "rooms_count",
      value: sale.rooms_count,
      document: pv,
      page: 2,
      excerpt: `${sale.rooms_count} pièces principales.`,
    },
    {
      field: "bedrooms_count",
      value: sale.bedrooms_count,
      document: pv,
      page: 2,
      excerpt: `${sale.bedrooms_count} chambres.`,
    },
    {
      field: "bathrooms_count",
      value: sale.bathrooms_count,
      document: pv,
      page: 2,
      excerpt: `${sale.bathrooms_count} salle de bains.`,
    },
    {
      field: "condition",
      value: "Rafraîchissement à prévoir",
      document: pv,
      page: 4,
      excerpt: "Peintures et sols à reprendre selon constat visuel.",
    },
    {
      field: "dpe_class",
      value: "D",
      document: "Diagnostics techniques",
      page: 1,
      excerpt: "Classe énergie : D.",
    },
    {
      field: "starting_price_eur",
      value: price,
      document: cahier,
      page: 1,
      excerpt: `Mise à prix : ${price.toLocaleString("fr-FR")} euros.`,
    },
    {
      field: "sale_date",
      value: schedule.hearing,
      document: "Annonce légale de la vente",
      page: 1,
      excerpt: "Audience d'adjudication au jour et à l'heure indiqués.",
    },
    {
      field: "visit_dates",
      value: schedule.visits,
      document: "Annonce légale de la vente",
      page: 1,
      excerpt: "Visites sur place aux deux dates indiquées.",
    },
    {
      field: "participation_mode",
      value: "in_person",
      document: cahier,
      page: 5,
      excerpt: "Les enchères sont portées à l'audience par un avocat.",
    },
    {
      field: "lawyer_required",
      value: true,
      document: cahier,
      page: 5,
      excerpt: "Ministère d'avocat obligatoire pour enchérir.",
    },
    {
      field: "lawyer_name",
      value: sale.lawyer_name,
      document: cahier,
      page: 1,
      excerpt: `Avocat poursuivant : ${sale.lawyer_name} (fictif).`,
    },
    {
      field: "payment_terms",
      value: "60 jours",
      document: cahier,
      page: 12,
      excerpt: "Le prix est payé dans les deux mois de la vente définitive.",
    },
  ];
  if (sale.has_garden) {
    features.push({
      field: "garden",
      value: true,
      document: pv,
      page: 2,
      excerpt: "Jardin attenant au bien.",
    });
  }
  if (sale.has_terrace) {
    features.push({
      field: "terrace",
      value: true,
      document: pv,
      page: 2,
      excerpt: "Terrasse accessible depuis le séjour.",
    });
  }
  if (apartment) {
    features.push(
      {
        field: "floor_number",
        value: 3,
        document: pv,
        page: 2,
        excerpt: "Troisième étage sur quatre.",
      },
      { field: "balcony", value: true, document: pv, page: 2, excerpt: "Balcon donnant sur cour." },
    );
  }
  return features;
}

// Données fictives destinées à la page publique d'exemple.
export const EXAMPLE_SALE = {
  id: "example-immojudis-bordeaux-t2",
  title: "Appartement T3 avec balcon à Bordeaux",
  description:
    "Appartement de trois pièces avec balcon, situé à Bordeaux, dans un immeuble ancien proche du tribunal.",
  source_description:
    "Appartement de trois pièces avec balcon, situé à Bordeaux, dans un immeuble ancien proche du tribunal.",
  llm_display_description:
    "Appartement de trois pièces situé à Bordeaux, dans un immeuble ancien à proximité du tribunal. Le descriptif d'exemple mentionne un balcon, une surface Carrez de 68 m² et un rafraîchissement à prévoir avant remise en location ou revente.",
  about_description:
    "Appartement de trois pièces situé à Bordeaux, dans un immeuble ancien à proximité du tribunal. Le descriptif d'exemple mentionne un balcon, une surface Carrez de 68 m² et un rafraîchissement à prévoir avant remise en location ou revente.",
  city: "Bordeaux",
  department: "Gironde",
  postal_code: "33000",
  address: "12 rue de l'Exemple", // adresse fictive
  tribunal: "TJ Bordeaux",
  tribunal_code: "tj-bordeaux",
  tribunal_name: "Tribunal judiciaire de Bordeaux",
  tribunal_city: "Bordeaux",
  sale_venue_type: "tribunal",
  sale_legal_framework: "judicial_seizure",
  sale_verification_status: "cross_checked",
  property_type: "apartment",
  starting_price_eur: 95_000,
  sale_date: "2026-10-15T09:30:00+02:00",
  visit_dates: ["2026-10-02 à 14:00", "2026-10-07 à 10:30"],
  lawyer_name: "Me Camille Durand",
  lawyer_contact: "contact-demo@immojudis.fr",
  adjudication_price_eur: null,
  latitude: 44.8378,
  longitude: -0.5792,
  occupancy_status: "unknown",
  habitable_surface_m2: 68,
  carrez_surface_m2: 68,
  land_surface_m2: null,
  app_surface_m2: 68,
  app_surface_kind: "Carrez",
  surface_scope: "lot principal",
  surface_source: "pv_descriptif",
  surface_confidence: 0.91,
  surface_evidence:
    "Le PV descriptif d'exemple mentionne un appartement de trois pièces, surface Carrez 68 m², avec balcon donnant sur cour.",
  rooms_count: 3,
  bedrooms_count: 2,
  bathrooms_count: 1,
  parking_count: null,
  has_garden: false,
  has_terrace: false, // un balcon, pas une terrasse
  has_garage: false,
  has_pool: false,
  has_air_conditioning: false,
  has_double_glazing: true,
  investment_score: 78,
  investment_summary:
    "Mise à prix basse face au marché local, mais occupation et travaux à vérifier avant audience.",
  score_version: "demo-2026-06",
  score_confidence: 0.84,
  score_factors: [
    {
      factor_order: 1,
      factor_key: "starting_price",
      label: "Mise à prix",
      reason: "La mise à prix reste nettement sous la médiane locale observée.",
      delta: 18,
      confidence: 0.88,
      evidence: "Mise à prix 95 000 EUR pour 68 m².",
    },
    {
      factor_order: 2,
      factor_key: "occupation",
      label: "Occupation",
      reason: "L'occupation doit être confirmée dans le PV et le cahier des conditions.",
      delta: -8,
      confidence: 0.72,
      evidence: "Mention d'occupation non stabilisée dans les pièces d'exemple.",
    },
  ],
  risk_notes:
    "Dossier fictif : les risques ci-dessous illustrent les points qu'Immojudis rattache aux pièces.",
  source_name: "Dossier de démonstration Immojudis",
  source_url: "/ressources",
  primary_source: "Annonce d'exemple Immojudis",
  source_urls: ["/ressources"],
  source_blocks: {
    usage: "Habitation",
    ancien_neuf: "Ancien",
    etat: "Rafraîchissement à prévoir",
    nb_etages: "3e étage sur 4",
    dpe_classe: "D",
    consignation: 9_500,
    mode_vente: "Audience d'adjudication",
    seance_paiement: "Frais et consignation selon cahier des conditions",
    auction_location: "Tribunal judiciaire de Bordeaux",
    source_updated_at: "2026-06-20T10:20:00+02:00",
    // Source of each figure shown on the example (all fictitious, like the sale).
    field_sources: {
      starting_price_eur: "Cahier des conditions de vente (exemple fictif)",
      sale_date: "Annonce légale de la vente (exemple fictif)",
      visit_dates: "Annonce légale de la vente (exemple fictif)",
      surface: "PV descriptif, surface Carrez (exemple fictif)",
      rooms_count: "PV descriptif (exemple fictif)",
      address: "Adresse fictive : aucun bien réel ne correspond à cet exemple",
      tribunal: "Référentiel des juridictions compétentes, Ministère de la Justice (data.gouv.fr)",
      lawyer: "Cahier des conditions de vente (exemple fictif)",
      market_value: "Ventes comparables fictives, calibrées sur le format DVF (Cerema)",
    },
    sale_procedure: {
      schema_version: "sale_procedure_v1",
      ruleset_version: "fr_auction_participation_2026-08-20",
      venue_type: "tribunal",
      legal_framework: "judicial_seizure",
      venue_name: "Tribunal judiciaire de Bordeaux",
      venue_address: "30 rue des Frères Bonie, 33000 Bordeaux",
      participation_mode: "in_person",
      organizer_name: "Me Camille Durand",
      organizer_type: "pursuing_lawyer",
      organizer_contact: "contact-demo@immojudis.fr",
      eligible_bar: "Barreau de Bordeaux",
      rules: {
        lawyer_required: true,
        lawyer_note:
          "Les enchères sont portées par un avocat inscrit au barreau du tribunal judiciaire devant lequel la vente est poursuivie.",
        bid_method: "lawyer_mandate",
        guarantee: {
          amount_eur: 9_500,
          rate_pct: 10,
          minimum_eur: 3_000,
          status: "regulatory_verified",
          note: "Garantie légale minimale ; les modalités exactes restent celles du cahier des conditions de vente.",
        },
        financing_condition: false,
        cooling_off_period: false,
        payment_deadline_days: 60,
        overbid: {
          allowed: true,
          minimum_increase_pct: 10,
          window_days: 10,
          note: "La surenchère est formée par acte d'avocat.",
        },
      },
      verification: {
        status: "cross_checked",
        verified_at: "2026-08-20T10:00:00+02:00",
        case_source_count: 2,
        case_sources: [
          {
            kind: "listing",
            label: "Annonce d'exemple — données fictives",
            source_name: "Immojudis",
            url: null,
          },
          {
            kind: "official_reference",
            label: "Référentiel officiel de compétence territoriale",
            source_name: "Ministère de la Justice",
            url: "https://www.data.gouv.fr/fr/datasets/liste-des-juridictions-competentes-pour-les-communes-de-france",
          },
        ],
        regulatory_sources: [
          {
            kind: "legal_basis",
            label: "Code des procédures civiles d'exécution — enchères et garantie",
            source_name: "Légifrance",
            url: "https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000025024948/LEGISCTA000025939153/",
            checked_at: "2026-08-20T10:00:00+02:00",
          },
          {
            kind: "legal_basis",
            label: "Code des procédures civiles d'exécution — surenchère",
            source_name: "Légifrance",
            url: "https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000025024948/LEGISCTA000025939177/",
            checked_at: "2026-08-20T10:00:00+02:00",
          },
        ],
        facts: [
          {
            key: "venue_type",
            value: "tribunal",
            status: "cross_checked",
            evidence: ["Audience d'adjudication", "Référentiel Justice par commune INSEE"],
            source_url: null,
          },
          {
            key: "competent_court",
            value: "Tribunal judiciaire de Bordeaux",
            status: "cross_checked",
            evidence: ["Fiche fictive Immojudis", "Référentiel Justice par commune INSEE"],
            source_url: null,
          },
        ],
        issues: [],
      },
    },
  },
  source_blocks_by_source: {
    "demo:primary": {
      avocat: "Me Camille Durand",
      contact_avocat: "contact-demo@immojudis.fr",
      visites: "2026-10-02 à 14:00 · 2026-10-07 à 10:30",
    },
  },
  dedupe_confidence: "demo",
  quality_flags: [],
  documents: [
    {
      url: "/ressources",
      name: "Cahier des conditions de vente - exemple",
      type: "cahier_conditions_vente",
    },
    {
      url: "/ressources",
      name: "PV descriptif - exemple",
      type: "pv_descriptif",
    },
  ],
  documents_rich: [
    {
      url: "/ressources",
      label: "Cahier des conditions de vente - exemple",
      type: "cahier_conditions_vente",
      document_type: "cahier_conditions_vente",
      extraction_status: "demo",
      download_status: "demo",
      docling_status: "demo",
      text_chars: 18_420,
    },
    {
      url: "/ressources",
      label: "PV descriptif - exemple",
      type: "pv_descriptif",
      document_type: "pv_descriptif",
      extraction_status: "demo",
      download_status: "demo",
      docling_status: "demo",
      text_chars: 9_860,
    },
    {
      url: "/ressources",
      label: "Diagnostics techniques - exemple",
      type: "diagnostics_techniques",
      document_type: "diagnostics_techniques",
      extraction_status: "demo",
      download_status: "demo",
      docling_status: "demo",
      text_chars: 7_240,
    },
  ],
  media: [
    {
      type: "image",
      url: "https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?auto=format&fit=crop&w=1600&q=80",
      source: "Visuel d'exemple",
    },
    {
      type: "image",
      url: "https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=1200&q=80",
      source: "Visuel d'exemple",
    },
    {
      type: "image",
      url: "https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?auto=format&fit=crop&w=1200&q=80",
      source: "Visuel d'exemple",
    },
    {
      type: "image",
      url: "https://images.unsplash.com/photo-1560448075-bb485b067938?auto=format&fit=crop&w=1200&q=80",
      source: "Visuel d'exemple",
    },
  ],
  risks: [
    {
      risk_type: "occupation_to_confirm",
      risk_label: "Occupation à confirmer",
      severity: 2,
      evidence:
        "Le PV descriptif d'exemple signale une présence lors du constat sur place, sans bail annexe au dossier.",
      evidence_json: {
        risk_status: "to_verify",
        reasoning:
          "La situation d'occupation peut modifier le délai de récupération et la valeur exploitable.",
        why_it_matters:
          "Confirmer l'occupation avant audience évite de surestimer la liquidité du bien.",
        document_label: "PV descriptif - exemple",
        document_type: "pv_descriptif",
        page_number: 3,
      },
      confidence: 0.78,
      detector: "demo",
      detector_version: "2026-06",
      score_impact: -8,
      occurrences: [
        {
          document_url: "/ressources",
          document_label: "PV descriptif - exemple",
          document_type: "pv_descriptif",
          page_number: 3,
          excerpt:
            "Présence d'une personne se déclarant occupante ; bail non produit dans les pièces communiquées.",
          confidence: 0.78,
          detector: "demo",
          detector_version: "2026-06",
          matched_terms: ["occupation", "bail non produit"],
          score_impact: -8,
          updated_at: "2026-06-20T10:20:00+02:00",
        },
      ],
    },
    {
      risk_type: "works_budget",
      risk_label: "Travaux à chiffrer",
      severity: 2,
      evidence:
        "Les diagnostics et le PV d'exemple mentionnent des rafraîchissements et une ventilation à vérifier.",
      evidence_json: {
        risk_status: "to_quantify",
        reasoning:
          "Le plafond doit intégrer une enveloppe travaux avant toute stratégie offensive.",
        why_it_matters: "Chaque euro de travaux réduit le montant maximum d'enchère acceptable.",
        document_label: "Diagnostics techniques - exemple",
        document_type: "diagnostics_techniques",
        page_number: 6,
      },
      confidence: 0.73,
      detector: "demo",
      detector_version: "2026-06",
      score_impact: -6,
      occurrences: [
        {
          document_url: "/ressources",
          document_label: "Diagnostics techniques - exemple",
          document_type: "diagnostics_techniques",
          page_number: 6,
          excerpt:
            "Ventilation de la salle d'eau à contrôler ; peintures et sols à reprendre selon constat visuel.",
          confidence: 0.73,
          detector: "demo",
          detector_version: "2026-06",
          matched_terms: ["ventilation", "peintures", "sols"],
          score_impact: -6,
          updated_at: "2026-06-20T10:20:00+02:00",
        },
      ],
    },
  ],
  status: "upcoming",
  created_at: "2026-06-20T10:20:00+02:00",
  updated_at: "2026-06-20T10:20:00+02:00",
} satisfies AuctionSale;

export const EXAMPLE_MARKET_ESTIMATE = {
  source: "DVF Cerema",
  engineVersion: "v2",
  segment: "apartment",
  surfaceBasis: "built",
  actionable: true,
  collectionComplete: true,
  missingYears: [],
  effectiveSampleSize: 8.4,
  estimationLevel: "reliable",
  subjectSurfaceM2: 68,
  subjectSurfaceEstimated: false,
  subjectSurfaceAssumption: null,
  subjectSurfaceUncertaintyPct: null,
  locationSource: "provided",
  locationApproximate: false,
  estimatedValueEur: 230_000,
  estimatedValueLowEur: 215_000,
  estimatedValueHighEur: 247_000,
  radiusM: 100,
  yearsBack: 6,
  areaKind: "urban",
  commune: "Bordeaux",
  sampleSize: 12,
  parcelSampleSize: 12,
  totalNearbySampleSize: 38,
  outliersRemoved: 2,
  qualityScore: 84,
  qualityLabel: "forte",
  qualityWarnings: [],
  comparableMode: "surface_matched",
  surfaceMinM2: 49,
  surfaceMaxM2: 88,
  landSurfaceMinM2: null,
  landSurfaceMaxM2: null,
  medianPricePerM2: 3_382,
  p25PricePerM2: 3_050,
  p75PricePerM2: 3_700,
  minPricePerM2: 2_650,
  maxPricePerM2: 4_300,
  deviationPct: null,
  addressHistory: [
    {
      date: "2024-09-12",
      totalPrice: 226_000,
      surface: 67,
      pricePerM2: 3_373,
      type: "Appartement",
    },
  ],
  recentTransactions: [
    {
      date: "2025-11-18",
      pricePerM2: 3_520,
      surface: 60,
      totalPrice: 211_200,
      type: "Appartement",
      distanceM: 84,
    },
    {
      date: "2025-07-04",
      pricePerM2: 3_280,
      surface: 65,
      totalPrice: 213_200,
      type: "Appartement",
      distanceM: 62,
    },
    {
      date: "2024-12-09",
      pricePerM2: 3_650,
      surface: 71,
      totalPrice: 259_150,
      type: "Appartement",
      distanceM: 93,
    },
    {
      date: "2024-05-22",
      pricePerM2: 3_145,
      surface: 76,
      totalPrice: 239_020,
      type: "Appartement",
      distanceM: 71,
    },
  ],
} satisfies MarketEstimate;

type ExampleSaleConfig = {
  key: Exclude<ExampleSaleKey, "bordeaux">;
  id: string;
  title: string;
  description: string;
  city: string;
  department: string;
  postalCode: string;
  address: string;
  tribunalCode: string;
  tribunalName: string;
  tribunalAddress: string;
  bar: string;
  propertyType: "apartment" | "house";
  startingPrice: number;
  surface: number;
  landSurface: number | null;
  rooms: number;
  bedrooms: number;
  bathrooms: number;
  latitude: number;
  longitude: number;
  score: number;
  investmentSummary: string;
  hasGarden: boolean;
  hasTerrace: boolean;
  media: string[];
  marketValue: number;
  marketLow: number;
  marketHigh: number;
  medianPricePerM2: number;
};

function createExampleSale(config: ExampleSaleConfig): AuctionSale {
  const guarantee = Math.round(config.startingPrice * 0.1);
  const procedure = EXAMPLE_SALE.source_blocks.sale_procedure;
  const description = `${config.description} Cette fiche fictive illustre l'analyse complète Immojudis : marché local, risques, frais, pièces et enchère plafond avant audience.`;

  return {
    ...EXAMPLE_SALE,
    id: config.id,
    title: config.title,
    description: config.description,
    source_description: config.description,
    llm_display_description: description,
    about_description: description,
    city: config.city,
    department: config.department,
    postal_code: config.postalCode,
    address: config.address,
    tribunal: `TJ ${config.city}`,
    tribunal_code: config.tribunalCode,
    tribunal_name: config.tribunalName,
    tribunal_city: config.city,
    property_type: config.propertyType,
    starting_price_eur: config.startingPrice,
    latitude: config.latitude,
    longitude: config.longitude,
    habitable_surface_m2: config.surface,
    carrez_surface_m2: config.propertyType === "apartment" ? config.surface : null,
    land_surface_m2: config.landSurface,
    app_surface_m2: config.surface,
    app_surface_kind: config.propertyType === "apartment" ? "Carrez" : "Habitable",
    surface_scope: config.propertyType === "apartment" ? "lot principal" : "bâtiment principal",
    surface_evidence: `Le PV descriptif d'exemple mentionne une surface de ${config.surface.toLocaleString("fr-FR")} m².`,
    rooms_count: config.rooms,
    bedrooms_count: config.bedrooms,
    bathrooms_count: config.bathrooms,
    has_garden: config.hasGarden,
    has_terrace: config.hasTerrace,
    investment_score: config.score,
    investment_summary: config.investmentSummary,
    score_factors: [
      {
        ...EXAMPLE_SALE.score_factors[0],
        evidence: `Mise à prix ${config.startingPrice.toLocaleString("fr-FR")} EUR pour ${config.surface.toLocaleString("fr-FR")} m².`,
      },
      EXAMPLE_SALE.score_factors[1],
    ],
    source_blocks: {
      ...EXAMPLE_SALE.source_blocks,
      consignation: guarantee,
      auction_location: config.tribunalName,
      sale_procedure: {
        ...procedure,
        venue_name: config.tribunalName,
        venue_address: config.tribunalAddress,
        eligible_bar: config.bar,
        rules: {
          ...procedure.rules,
          guarantee: {
            ...procedure.rules.guarantee,
            amount_eur: guarantee,
          },
        },
        verification: {
          ...procedure.verification,
          facts: procedure.verification.facts.map((fact) =>
            fact.key === "competent_court" ? { ...fact, value: config.tribunalName } : fact,
          ),
        },
      },
    },
    media: config.media.map((url) => ({
      type: "image" as const,
      url,
      source: "Visuel d'exemple",
    })),
  };
}

function createExampleMarketEstimate(config: ExampleSaleConfig): MarketEstimate {
  const recentSurfaces = [0.88, 0.96, 1.05, 1.12].map((ratio) =>
    Math.round(config.surface * ratio),
  );
  const recentPricesPerM2 = [1.04, 0.97, 1.08, 0.93].map((ratio) =>
    Math.round(config.medianPricePerM2 * ratio),
  );

  return {
    ...EXAMPLE_MARKET_ESTIMATE,
    segment: config.propertyType,
    subjectSurfaceM2: config.surface,
    estimatedValueEur: config.marketValue,
    estimatedValueLowEur: config.marketLow,
    estimatedValueHighEur: config.marketHigh,
    commune: config.city,
    surfaceMinM2: Math.round(config.surface * 0.72),
    surfaceMaxM2: Math.round(config.surface * 1.3),
    landSurfaceMinM2: config.landSurface == null ? null : Math.round(config.landSurface * 0.65),
    landSurfaceMaxM2: config.landSurface == null ? null : Math.round(config.landSurface * 1.4),
    medianPricePerM2: config.medianPricePerM2,
    p25PricePerM2: Math.round(config.medianPricePerM2 * 0.9),
    p75PricePerM2: Math.round(config.medianPricePerM2 * 1.11),
    minPricePerM2: Math.round(config.medianPricePerM2 * 0.78),
    maxPricePerM2: Math.round(config.medianPricePerM2 * 1.3),
    addressHistory: [],
    recentTransactions: recentSurfaces.map((surface, index) => ({
      date: ["2025-11-18", "2025-07-04", "2024-12-09", "2024-05-22"][index],
      pricePerM2: recentPricesPerM2[index],
      surface,
      totalPrice: surface * recentPricesPerM2[index],
      type: config.propertyType === "house" ? "Maison" : "Appartement",
      distanceM: [118, 174, 226, 291][index],
    })),
  };
}

const NANTES_EXAMPLE_CONFIG = {
  key: "nantes",
  id: "example-immojudis-nantes-maison",
  title: "Maison de ville en pierre avec dépendance à Nantes",
  description:
    "Maison de ville en pierre avec dépendance et petite cour, située à Nantes dans un secteur résidentiel proche du centre.",
  city: "Nantes",
  department: "Loire-Atlantique",
  postalCode: "44000",
  address: "12 rue de l'Exemple", // adresse fictive
  tribunalCode: "tj-nantes",
  tribunalName: "Tribunal judiciaire de Nantes",
  tribunalAddress: "19 quai François Mitterrand, 44000 Nantes",
  bar: "Barreau de Nantes",
  propertyType: "house",
  startingPrice: 138_500,
  surface: 83,
  landSurface: 142,
  rooms: 4,
  bedrooms: 3,
  bathrooms: 1,
  latitude: 47.218371,
  longitude: -1.553621,
  score: 71,
  investmentSummary:
    "Potentiel familial intéressant, sous réserve de chiffrer les frais et de contrôler l'état de la dépendance.",
  hasGarden: true,
  hasTerrace: true,
  media: [
    "/media/landing/auction-nantes.webp",
    "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1200&q=80",
    "https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?auto=format&fit=crop&w=1200&q=80",
  ],
  marketValue: 286_000,
  marketLow: 264_000,
  marketHigh: 309_000,
  medianPricePerM2: 3_430,
} satisfies ExampleSaleConfig;

const TOULOUSE_EXAMPLE_CONFIG = {
  key: "toulouse",
  id: "example-immojudis-toulouse-maison",
  title: "Maison ancienne avec jardin arboré à Toulouse",
  description:
    "Maison ancienne avec jardin arboré, située à Toulouse, avec une distribution familiale et des travaux de remise à niveau à anticiper.",
  city: "Toulouse",
  department: "Haute-Garonne",
  postalCode: "31000",
  address: "12 rue de l'Exemple", // adresse fictive
  tribunalCode: "tj-toulouse",
  tribunalName: "Tribunal judiciaire de Toulouse",
  tribunalAddress: "2 allées Jules Guesde, 31000 Toulouse",
  bar: "Barreau de Toulouse",
  propertyType: "house",
  startingPrice: 121_000,
  surface: 96,
  landSurface: 318,
  rooms: 5,
  bedrooms: 3,
  bathrooms: 2,
  latitude: 43.604652,
  longitude: 1.444209,
  score: 69,
  investmentSummary:
    "Décote apparente élevée, mais le budget travaux et la situation d'occupation doivent être sécurisés avant l'audience.",
  hasGarden: true,
  hasTerrace: false,
  media: [
    "/media/landing/auction-toulouse.webp",
    "https://images.unsplash.com/photo-1600607687920-4e2a09cf159d?auto=format&fit=crop&w=1200&q=80",
    "https://images.unsplash.com/photo-1600585152915-d208bec867a1?auto=format&fit=crop&w=1200&q=80",
  ],
  marketValue: 304_000,
  marketLow: 278_000,
  marketHigh: 332_000,
  medianPricePerM2: 3_170,
} satisfies ExampleSaleConfig;

export const EXAMPLE_SALE_RECORDS: Record<
  ExampleSaleKey,
  { sale: AuctionSale; marketEstimate: MarketEstimate }
> = {
  bordeaux: { sale: EXAMPLE_SALE, marketEstimate: EXAMPLE_MARKET_ESTIMATE },
  nantes: {
    sale: createExampleSale(NANTES_EXAMPLE_CONFIG),
    marketEstimate: createExampleMarketEstimate(NANTES_EXAMPLE_CONFIG),
  },
  toulouse: {
    sale: createExampleSale(TOULOUSE_EXAMPLE_CONFIG),
    marketEstimate: createExampleMarketEstimate(TOULOUSE_EXAMPLE_CONFIG),
  },
};

/** The example hearing is always this many days after the page is generated. */
export const EXAMPLE_HEARING_LEAD_DAYS = 21;

function parisOffsetMinutes(instant: number): number {
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Paris",
    timeZoneName: "longOffset",
  })
    .formatToParts(new Date(instant))
    .find(({ type }) => type === "timeZoneName")?.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(label ?? "");
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "+" ? minutes : -minutes;
}

/** Europe/Paris wall-clock time of a calendar day, as an instant. */
function parisWallClock(day: Date, hour: number, minute: number): Date {
  const wall = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute);
  const first = wall - parisOffsetMinutes(wall) * 60_000;
  return new Date(wall - parisOffsetMinutes(first) * 60_000);
}

function parisCalendarDay(now: Date): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Paris",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .map(({ type, value }) => [type, value]),
  );
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
}

function addDays(day: Date, days: number): Date {
  return new Date(day.getTime() + days * 86_400_000);
}

function visitLabel(day: Date, hour: number, minute: number): string {
  const date = day.toISOString().slice(0, 10);
  return `${date} à ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Dates of the example, relative to `now`: the hearing is 21 days away and the
 * two visits happen before it. The page therefore never shows a past sale.
 */
export function exampleSaleSchedule(now: Date = new Date()) {
  const today = parisCalendarDay(now);
  const hearing = parisWallClock(addDays(today, EXAMPLE_HEARING_LEAD_DAYS), 9, 30);
  const visits = [visitLabel(addDays(today, 10), 14, 0), visitLabel(addDays(today, 14), 10, 30)];
  const published = parisWallClock(addDays(today, -2), 10, 20);
  return { hearing: hearing.toISOString(), visits, published: published.toISOString() };
}

function withExampleSchedule(sale: AuctionSale, now: Date): AuctionSale {
  const { hearing, visits, published } = exampleSaleSchedule(now);
  return {
    ...sale,
    sale_date: hearing,
    visit_dates: visits,
    created_at: published,
    updated_at: published,
    source_blocks: {
      ...sale.source_blocks,
      source_updated_at: published,
      listing_completeness: {
        ...(sale.source_blocks?.listing_completeness as Record<string, unknown> | undefined),
        source_property_features: exampleSourceFeatures(exampleFeatures(sale, { hearing, visits })),
      },
    },
    source_blocks_by_source: {
      ...sale.source_blocks_by_source,
      "demo:primary": {
        ...(sale.source_blocks_by_source?.["demo:primary"] as Record<string, unknown> | undefined),
        visites: visits.join(" · "),
      },
    },
  };
}

/** The example records with their dates relative to `now` (default: today). */
export function getExampleSaleRecords(
  now: Date = new Date(),
): Record<ExampleSaleKey, { sale: AuctionSale; marketEstimate: MarketEstimate }> {
  return Object.fromEntries(
    EXAMPLE_SALE_KEYS.map((key) => [
      key,
      {
        sale: withExampleSchedule(EXAMPLE_SALE_RECORDS[key].sale, now),
        marketEstimate: EXAMPLE_SALE_RECORDS[key].marketEstimate,
      },
    ]),
  ) as Record<ExampleSaleKey, { sale: AuctionSale; marketEstimate: MarketEstimate }>;
}

/**
 * Figures of the Bordeaux example as the home page presents them. They are
 * computed with the same ceiling engine and default scenario as the example page
 * (refresh works, standard fees, default profile), never typed twice, so the two
 * pages cannot disagree. Amounts are rounded to 100 €, consistently: value -
 * fees and works - margin = ceiling.
 */
export function exampleHeadlineFigures() {
  const { sale, marketEstimate } = EXAMPLE_SALE_RECORDS.bordeaux;
  const surface = sale.app_surface_m2 ?? 0;
  const startingPrice = sale.starting_price_eur ?? 0;
  const result = computeMarketCeiling({
    surface,
    price: startingPrice,
    works: estimateWorksBudget(surface, "rafraichissement"),
    fpt: DEFAULTS.fpt,
    scenario: DEFAULT_MARKET_CEILING_SCENARIO,
    medianPricePerM2: marketEstimate.medianPricePerM2,
    p10PricePerM2: marketEstimate.p10PricePerM2,
    p25PricePerM2: marketEstimate.p25PricePerM2,
    p75PricePerM2: marketEstimate.p75PricePerM2,
    p90PricePerM2: marketEstimate.p90PricePerM2,
  });
  const hundred = (value: number) => Math.round(value / 100) * 100;
  const marketValue = hundred(marketEstimate.estimatedValueEur ?? 0);
  const feesAndWorks = hundred(result.targetTotalCost - result.maxBid);
  const ceiling = hundred(result.maxBid);
  return {
    city: sale.city ?? "",
    surfaceM2: surface,
    startingPrice,
    marketValue,
    feesAndWorks,
    safetyMargin: marketValue - feesAndWorks - ceiling,
    ceiling,
  };
}

export function isExampleSaleKey(value: unknown): value is ExampleSaleKey {
  return typeof value === "string" && EXAMPLE_SALE_KEYS.includes(value as ExampleSaleKey);
}
