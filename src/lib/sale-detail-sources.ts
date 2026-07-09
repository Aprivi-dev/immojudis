import {
  formatDate,
  formatDateTime,
  formatPrice,
  formatPricePerM2,
  occupancyLabel,
  propertyTypeLabel,
} from "@/lib/format";
import type { EnvironmentalContext, EnvironmentMonthlyPoint } from "@/lib/environment.functions";
import type { MarketEstimate } from "@/lib/market.functions";
import type { MarketCeilingResult } from "@/lib/profitability";
import { parseDocs } from "@/lib/documents";
import { getDisplaySurface, getSaleSurface } from "@/lib/surface";
import { saleSourceLinks } from "@/lib/sale-source-links";
import type { AuctionSale } from "@/lib/types";

type AcquisitionCostLike = {
  acquisitionFeesTotal: number;
  totalCost: number;
  works: number;
};

export type ProductFact = {
  label: string;
  value: string;
  detail?: string;
};

export type ProductAction = {
  label: string;
  detail: string;
  href: string;
  primary?: boolean;
};

export type ProductGroup = {
  title: string;
  facts: ProductFact[];
};

export type ProductRisk = {
  label: string;
  value: string;
  detail: string;
  source: string;
  tone: "low" | "medium" | "high" | "missing";
};

export type ProductHistoryRow = {
  event: string;
  date: string;
  amount: string;
  source: string;
};

export type ProductWeatherMonth = EnvironmentMonthlyPoint;

export type SaleProductSources = {
  priceLabel: string;
  addressLabel: string;
  subtitle: string;
  mainStats: ProductFact[];
  overviewFacts: ProductFact[];
  showingTabs: ProductAction[];
  openHouseRows: ProductFact[];
  aroundFacts: ProductFact[];
  schoolFacts: ProductFact[];
  lifestyleFacts: ProductFact[];
  propertyGroups: ProductGroup[];
  publicRecordGroups: ProductGroup[];
  historyRows: ProductHistoryRow[];
  riskCards: ProductRisk[];
  weatherFacts: ProductFact[];
  weatherMonthly: ProductWeatherMonth[];
  sunFacts: ProductFact[];
  sunMonthly: ProductWeatherMonth[];
  insightFacts: ProductFact[];
  estimateFacts: ProductFact[];
  resourceLinks: ProductAction[];
  agentFacts: ProductFact[];
  sourceFacts: ProductFact[];
};

export function buildSaleProductSources({
  sale,
  ceiling,
  primaryCheck,
  primaryDocument,
  action,
  acquisitionCost,
  marketEstimate,
  marketLoading = false,
  marketError = false,
  environmentalContext,
  environmentalLoading = false,
  environmentalError = false,
}: {
  sale: AuctionSale;
  ceiling: MarketCeilingResult;
  primaryCheck: string;
  primaryDocument: string;
  action: string;
  acquisitionCost: AcquisitionCostLike;
  marketEstimate?: MarketEstimate | null;
  marketLoading?: boolean;
  marketError?: boolean;
  environmentalContext?: EnvironmentalContext | null;
  environmentalLoading?: boolean;
  environmentalError?: boolean;
}): SaleProductSources {
  const displaySurface = getDisplaySurface(sale);
  const surface = getSaleSurface(sale).value;
  const allInPerM2 = surface ? acquisitionCost.totalCost / surface : null;
  const marketPerM2 = marketEstimate?.medianPricePerM2 ?? null;
  const marketLabel = marketLoading
    ? "Recherche..."
    : marketError
      ? "Indisponible"
      : formatPricePerM2(marketPerM2);
  const spreadPct =
    allInPerM2 && marketPerM2 ? Math.round((1 - allInPerM2 / marketPerM2) * 100) : null;
  const documentCount = (sale.documents_rich?.length ?? 0) || parseDocs(sale.documents).length;
  const addressLabel = [sale.address, sale.postal_code, sale.city].filter(Boolean).join(", ");
  const cityLabel = sale.city ?? "le secteur";
  const lawyerName =
    sale.lawyer_name ?? textBlock(sale, "avocat", "lawyer_name", "notary_name", "organizer");
  const lawyerContact =
    sale.lawyer_contact ??
    textBlock(sale, "contact_avocat", "lawyer_contact", "contact", "telephone", "phone");
  const visitDates = saleVisitDates(sale);
  const environmentalSourceLabel = environmentalContext
    ? `Open-Meteo ${environmentalContext.period.startYear}-${environmentalContext.period.endYear}`
    : environmentalLoading
      ? "Recherche en cours"
      : environmentalError
        ? "Source indisponible"
        : "Source non disponible";
  const environmentalAddressLabel =
    environmentalContext?.resolvedAddress.label || addressLabel || cityLabel;
  const weatherMonthly = environmentalContext?.weather.monthly ?? fallbackEnvironmentMonths();
  const sunMonthly = environmentalContext?.sun.monthly ?? weatherMonthly;
  const warmestMonth = environmentalContext?.weather.warmestMonth;
  const coldestMonth = environmentalContext?.weather.coldestMonth;
  const sourceLinks = saleSourceLinks(sale);
  const primarySourceLabel = sourceLinks[0]?.label ?? sale.source_name ?? "Source annonce";
  return {
    priceLabel: formatPrice(sale.starting_price_eur),
    addressLabel,
    subtitle: `${propertyTypeLabel(sale.property_type)} en vente judiciaire`,
    mainStats: [
      {
        label: "Plafond",
        value: ceiling.available ? formatPrice(ceiling.maxBid) : "À compléter",
        detail: "recommandé",
      },
      {
        label: displaySurface.metricLabel,
        value: displaySurface.value ? displaySurface.label : "—",
      },
      { label: "Pièces", value: sale.rooms_count != null ? String(sale.rooms_count) : "—" },
      { label: "Chambres", value: sale.bedrooms_count != null ? String(sale.bedrooms_count) : "—" },
    ],
    overviewFacts: [
      {
        label: "Mise à prix",
        value: formatPrice(sale.starting_price_eur),
        detail: "Prix de départ",
      },
      {
        label: "Coût complet",
        value: formatPrice(acquisitionCost.totalCost),
        detail: "Frais inclus",
      },
      {
        label: "Audience",
        value: formatDate(sale.sale_date),
        detail: relativeDateLabel(sale.sale_date),
      },
      { label: "Marché local", value: marketLabel, detail: "Référence DVF" },
      {
        label: "Occupation",
        value: occupancyLabel(sale.occupancy_status),
        detail: primaryDocument,
      },
      {
        label: "Documents",
        value: documentCount ? String(documentCount) : "0",
        detail: `${documentCount > 1 ? "pièces" : "pièce"} au dossier`,
      },
    ],
    showingTabs: [
      {
        label: "Avocat adjudication",
        detail: "Identifier le contact et préparer les questions.",
        href: "#lawyer",
        primary: true,
      },
      {
        label: "Pièces à transmettre",
        detail: "Partager les documents et preuves prioritaires.",
        href: "#documents",
      },
      {
        label: "Consignes d'enchère",
        detail: action,
        href: "#offer-insights",
      },
    ],
    openHouseRows: [
      {
        label: "Audience",
        value: formatDate(sale.sale_date),
        detail: sale.tribunal ?? sale.tribunal_name ?? "Tribunal à confirmer",
      },
      {
        label: "Visites",
        value: visitDates.length ? visitDates.slice(0, 2).join(" · ") : "À vérifier",
        detail:
          visitDates.length > 2 ? `${visitDates.length} créneaux collectés` : "Source annonce",
      },
      {
        label: "Avocat",
        value: lawyerName ?? "À confirmer",
        detail: lawyerContact ? "Coordonnées disponibles" : "Contact à récupérer",
      },
      {
        label: "Consignation",
        value: moneyBlock(sale, "consignation") ?? "À vérifier",
        detail: "Selon cahier des conditions",
      },
    ],
    aroundFacts: [
      { label: "Adresse", value: addressLabel || "À confirmer" },
      {
        label: "Commune",
        value: [sale.city, sale.department].filter(Boolean).join(" · ") || "À confirmer",
      },
      {
        label: "Coordonnées",
        value:
          sale.latitude != null && sale.longitude != null
            ? `${sale.latitude.toFixed(5)}, ${sale.longitude.toFixed(5)}`
            : "Non géocodé",
      },
      {
        label: "Source carte",
        value: sale.latitude != null ? "Carte et vue de rue" : "Carte non disponible",
      },
    ],
    schoolFacts: [
      {
        label: "Écoles",
        value: sale.city ? `Secteur ${sale.city}` : "Secteur à confirmer",
        detail: "Carte scolaire et établissements à vérifier",
      },
      {
        label: "À pied",
        value: sale.latitude != null ? "Carte disponible" : "Non géocodé",
        detail: "Distance aux services à calculer",
      },
      {
        label: "Source",
        value: "Source locale à vérifier",
        detail: "Sectorisation scolaire et services de proximité",
      },
    ],
    lifestyleFacts: [
      { label: "Marche", value: "À évaluer", detail: "Marchabilité du quartier" },
      { label: "Transports", value: "À vérifier", detail: "Accès transports" },
      { label: "Bruit", value: "À vérifier", detail: "Nuisances à documenter" },
      { label: "Services", value: "À vérifier", detail: "Commerces et santé proches" },
    ],
    propertyGroups: [
      {
        title: "Intérieur",
        facts: [
          { label: "Type", value: propertyTypeLabel(sale.property_type) },
          { label: "Surface", value: displaySurface.value ? displaySurface.label : "Non précisée" },
          {
            label: "Pièces",
            value: sale.rooms_count != null ? String(sale.rooms_count) : "Non précisé",
          },
          {
            label: "Chambres",
            value: sale.bedrooms_count != null ? String(sale.bedrooms_count) : "Non précisé",
          },
          {
            label: "Salles de bain",
            value: sale.bathrooms_count != null ? String(sale.bathrooms_count) : "Non précisé",
          },
          { label: "État", value: textBlock(sale, "etat") ?? "À vérifier" },
        ],
      },
      {
        title: "Vente",
        facts: [
          { label: "Tribunal", value: sale.tribunal ?? sale.tribunal_name ?? "À confirmer" },
          {
            label: "Mode de vente",
            value: textBlock(sale, "mode_vente") ?? "Audience d'adjudication",
          },
          { label: "Paiement", value: textBlock(sale, "seance_paiement") ?? "À vérifier" },
          {
            label: "Avocat / Notaire",
            value: textBlock(sale, "notary_name") ?? lawyerName ?? "À confirmer",
          },
          {
            label: "Visites",
            value: visitDates.length ? visitDates.join(" · ") : "À vérifier",
          },
        ],
      },
    ],
    publicRecordGroups: [
      {
        title: "Informations publiques",
        facts: [
          { label: "Identifiant", value: sale.id },
          { label: "Source", value: sale.source_name ?? "À confirmer" },
          { label: "Mise à jour", value: formatDateTime(sale.updated_at) },
          { label: "Occupation", value: occupancyLabel(sale.occupancy_status) },
        ],
      },
      {
        title: "Documents",
        facts: [
          { label: "Pièces disponibles", value: String(documentCount) },
          { label: "Document prioritaire", value: primaryDocument },
          { label: "Point prioritaire", value: primaryCheck },
          { label: "Consignation", value: moneyBlock(sale, "consignation") ?? "À vérifier" },
        ],
      },
    ],
    historyRows: buildHistoryRows(sale, marketEstimate),
    riskCards: buildRiskCards(sale),
    weatherFacts: buildWeatherFacts({
      environmentalContext,
      environmentalLoading,
      environmentalError,
      environmentalSourceLabel,
      environmentalAddressLabel,
      warmestMonth,
      coldestMonth,
    }),
    weatherMonthly,
    sunFacts: [
      {
        label: "Ensoleillement",
        value:
          environmentalContext?.sun.avgAnnualSunshineHours != null
            ? `${Math.round(environmentalContext.sun.avgAnnualSunshineHours)} h/an`
            : environmentalLoading
              ? "Recherche..."
              : environmentalError
                ? "Indisponible"
                : "Non disponible",
        detail: environmentalContext
          ? `${environmentalSourceLabel} · ${environmentalAddressLabel}`
          : "Historique par adresse",
      },
      {
        label: "Orientation",
        value: textBlock(sale, "orientation") ?? "À vérifier",
        detail: "Plan, photos ou dossier technique",
      },
      {
        label: "Radiation",
        value:
          environmentalContext?.sun.avgAnnualRadiationKwhM2 != null
            ? `${Math.round(environmentalContext.sun.avgAnnualRadiationKwhM2)} kWh/m²/an`
            : environmentalLoading
              ? "Recherche..."
              : environmentalError
                ? "Indisponible"
                : "Non disponible",
        detail: "Radiation courte moyenne au sol",
      },
      {
        label: "Source",
        value: environmentalSourceLabel,
        detail: "Exposition de site, hors ombres précises du bâtiment",
      },
    ],
    sunMonthly,
    insightFacts: [
      {
        label: "Mise maximum",
        value: ceiling.available ? formatPrice(ceiling.maxBid) : "À compléter",
        detail: "Consigne plafond",
      },
      {
        label: "Coût complet",
        value: formatPrice(acquisitionCost.totalCost),
        detail: "Simulation",
      },
      {
        label: "Écart marché",
        value: spreadPct == null ? "À compléter" : `${spreadPct > 0 ? "+" : ""}${spreadPct}%`,
        detail: "Coût complet vs médiane",
      },
      { label: "Action", value: action, detail: "Avant audience" },
    ],
    estimateFacts: [
      { label: "Référence retenue", value: marketLabel },
      {
        label: "Fourchette",
        value:
          marketEstimate?.p25PricePerM2 && marketEstimate.p75PricePerM2
            ? `${formatPricePerM2(marketEstimate.p25PricePerM2)} - ${formatPricePerM2(
                marketEstimate.p75PricePerM2,
              )}`
            : marketLabel,
      },
      {
        label: "Transactions DVF",
        value: marketEstimate ? String(marketEstimate.sampleSize) : "À compléter",
      },
      { label: "Coût complet/m²", value: formatPricePerM2(allInPerM2) },
    ],
    resourceLinks: [
      {
        label: `${cityLabel} ventes judiciaires`,
        detail: "Annonces proches",
        href: "/sales",
      },
      {
        label: "Avocats adjudication",
        detail: "Préparation audience",
        href: "#lawyer",
      },
      {
        label: "Données marché",
        detail: "Transactions DVF",
        href: "#estimate",
      },
      {
        label: "Documents publics",
        detail: "Cahier, PV, diagnostics",
        href: "#public-record",
      },
    ],
    agentFacts: [
      { label: "Contact", value: lawyerName ?? "Avocat à confirmer" },
      {
        label: "Réponse",
        value: lawyerContact ? "Coordonnées disponibles" : "À compléter",
        detail: lawyerContact ?? undefined,
      },
      { label: "Préparation", value: action, detail: primaryCheck },
    ],
    sourceFacts: [
      {
        label: "Données fiche",
        value: primarySourceLabel,
        detail: sourceLinks.length > 1 ? `${sourceLinks.length} sources rapprochées` : undefined,
      },
      { label: "Marché", value: marketEstimate?.source ?? "DVF à connecter" },
      { label: "Documents", value: documentCount ? "Pièces indexées" : "Aucune pièce indexée" },
      {
        label: "Risques de dossier",
        value: (sale.risks?.length ?? 0) > 0 ? "Preuves indexées" : "Aucun risque sourcé",
      },
    ],
  };
}

function buildWeatherFacts({
  environmentalContext,
  environmentalLoading,
  environmentalError,
  environmentalSourceLabel,
  environmentalAddressLabel,
  warmestMonth,
  coldestMonth,
}: {
  environmentalContext?: EnvironmentalContext | null;
  environmentalLoading: boolean;
  environmentalError: boolean;
  environmentalSourceLabel: string;
  environmentalAddressLabel: string;
  warmestMonth?: EnvironmentMonthlyPoint | null;
  coldestMonth?: EnvironmentMonthlyPoint | null;
}): ProductFact[] {
  if (environmentalContext) {
    return [
      {
        label: "Température",
        value:
          warmestMonth?.avgHighC != null && coldestMonth?.avgLowC != null
            ? `${Math.round(coldestMonth.avgLowC)}° / ${Math.round(warmestMonth.avgHighC)}°C`
            : "Historique disponible",
        detail:
          warmestMonth && coldestMonth
            ? `${coldestMonth.label} le plus froid · ${warmestMonth.label} le plus chaud`
            : environmentalAddressLabel,
      },
      {
        label: "Précipitation",
        value:
          environmentalContext.weather.avgAnnualPrecipitationMm != null
            ? `${Math.round(environmentalContext.weather.avgAnnualPrecipitationMm)} mm/an`
            : "À confirmer",
        detail: "Moyenne annuelle historique",
      },
      {
        label: "Vent",
        value:
          environmentalContext.weather.avgAnnualWindKmh != null
            ? `${Math.round(environmentalContext.weather.avgAnnualWindKmh)} km/h`
            : "À confirmer",
        detail: "Vitesse max quotidienne moyenne",
      },
      {
        label: "Source",
        value: environmentalSourceLabel,
        detail: environmentalAddressLabel,
      },
    ];
  }

  const value = environmentalLoading
    ? "Recherche..."
    : environmentalError
      ? "Indisponible"
      : "Non disponible";
  return [
    { label: "Température", value, detail: `Historique météo ${environmentalAddressLabel}` },
    { label: "Précipitation", value, detail: "Open-Meteo Archive" },
    { label: "Vent", value, detail: "Vitesse max quotidienne" },
    { label: "Source", value: environmentalSourceLabel, detail: "Adresse ou coordonnées annonce" },
  ];
}

function fallbackEnvironmentMonths(): ProductWeatherMonth[] {
  return [
    "Jan",
    "Fév",
    "Mar",
    "Avr",
    "Mai",
    "Juin",
    "Juil",
    "Août",
    "Sep",
    "Oct",
    "Nov",
    "Déc",
  ].map((label, index) => ({
    month: index + 1,
    label,
    avgLowC: null,
    avgHighC: null,
    avgPrecipitationMm: null,
    avgWindKmh: null,
    avgSunshineHours: null,
    avgDaylightHours: null,
    sunshineRatioPct: null,
    avgRadiationKwhM2: null,
  }));
}

function buildHistoryRows(
  sale: AuctionSale,
  marketEstimate?: MarketEstimate | null,
): ProductHistoryRow[] {
  return [
    {
      event: "Mise en ligne",
      date: formatDateTime(sale.created_at),
      amount: formatPrice(sale.starting_price_eur),
      source: sale.source_name ?? "Annonce",
    },
    {
      event: "Mise à jour",
      date: formatDateTime(sale.updated_at),
      amount: "—",
      source: sale.primary_source ?? "Immojudis",
    },
    {
      event: "Date d'audience",
      date: formatDate(sale.sale_date),
      amount: formatPrice(sale.starting_price_eur),
      source: sale.tribunal ?? sale.tribunal_name ?? "Tribunal",
    },
    ...(marketEstimate?.addressHistory ?? []).slice(0, 3).map((item) => ({
      event: "Vente proche",
      date: formatDate(item.date),
      amount: formatPrice(item.totalPrice),
      source: formatPricePerM2(item.pricePerM2),
    })),
  ];
}

function buildRiskCards(sale: AuctionSale): ProductRisk[] {
  const judicialRisks = (sale.risks ?? []).slice(0, 3).map((risk) => ({
    label: risk.risk_label || risk.risk_type,
    value: severityLabel(risk.severity),
    detail: risk.evidence || "À vérifier dans les pièces.",
    source: risk.occurrences?.[0]?.document_label ?? "Dossier",
    tone:
      risk.severity == null
        ? "missing"
        : risk.severity >= 3
          ? "high"
          : risk.severity >= 2
            ? "medium"
            : "low",
  })) satisfies ProductRisk[];

  if (judicialRisks.length > 0) return judicialRisks;

  return [
    {
      label: "Risques sourcés",
      value: "À vérifier",
      detail: "Aucun risque documenté n'est encore indexé automatiquement pour ce dossier.",
      source: "Pièces du dossier",
      tone: "missing",
    },
  ];
}

function textBlock(sale: AuctionSale, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = sourceBlockValue(sale, key);
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function moneyBlock(sale: AuctionSale, key: string): string | null {
  const value = sourceBlockValue(sale, key);
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) && amount > 0 ? formatPrice(amount) : null;
}

function sourceBlockValue(sale: AuctionSale, key: string): unknown {
  const direct = sale.source_blocks?.[key];
  if (direct != null && direct !== "") return direct;
  for (const blocks of Object.values(sale.source_blocks_by_source ?? {})) {
    if (!blocks || typeof blocks !== "object") continue;
    const value = blocks[key];
    if (value != null && value !== "") return value;
  }
  return null;
}

function saleVisitDates(sale: AuctionSale): string[] {
  const raw = Array.isArray(sale.visit_dates) ? sale.visit_dates : [];
  const collected = raw.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  const blockVisit = textBlock(
    sale,
    "visites",
    "visite",
    "date_de_visite",
    "detail_date_de_visite",
    "visit_dates",
  );
  return [...collected, ...(blockVisit ? [blockVisit] : [])].filter(
    (value, index, values) => values.indexOf(value) === index,
  );
}

function relativeDateLabel(value: string | null | undefined): string {
  if (!value) return "À confirmer";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "À confirmer";
  const days = Math.ceil((date.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (days < 0) return "Audience passée";
  if (days === 0) return "Aujourd'hui";
  if (days === 1) return "Demain";
  return `${days} jours`;
}

function severityLabel(severity: number | null | undefined): string {
  if (severity == null) return "À vérifier";
  if (severity >= 3) return "Élevé";
  if (severity >= 2) return "Modéré";
  return "Faible";
}
