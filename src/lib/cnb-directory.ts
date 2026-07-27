export const CNB_DIRECTORY_URL = "https://cnb.avocat.fr/annuaire-des-avocats-de-france";
export const CNB_SEARCH_URL = "https://annuaire.avocat.fr/eAnnuaire/resultats";
export const CNB_REAL_ESTATE_SPECIALIZATION_CODE = "29";

type CnbBarAssociation = {
  code: string;
  label: string;
};

const CNB_BAR_ASSOCIATIONS: CnbBarAssociation[] = [
  { code: "0001", label: "ABBEVILLE" },
  { code: "0002", label: "AGEN" },
  { code: "0003", label: "AIX-EN-PROVENCE" },
  { code: "0004", label: "AJACCIO" },
  { code: "0005", label: "ALBERTVILLE" },
  { code: "0006", label: "ALBI" },
  { code: "0007", label: "ALENÇON" },
  { code: "0008", label: "ALES" },
  { code: "0009", label: "AMIENS" },
  { code: "0010", label: "ANGERS" },
  { code: "0011", label: "CHARENTE (ANGOULEME)" },
  { code: "0012", label: "ANNECY" },
  { code: "0013", label: "ARGENTAN" },
  { code: "0014", label: "ARRAS" },
  { code: "0015", label: "GERS" },
  { code: "0016", label: "AURILLAC" },
  { code: "0017", label: "AUXERRE" },
  { code: "0018", label: "AVESNES-SUR-HELPE" },
  { code: "0019", label: "AVIGNON" },
  { code: "0020", label: "AVRANCHES" },
  { code: "0021", label: "MEUSE (BAR-LE-DUC/VERDUN)" },
  { code: "0022", label: "BASTIA" },
  { code: "0023", label: "BAYONNE" },
  { code: "0024", label: "BEAUVAIS" },
  { code: "0025", label: "BELFORT" },
  { code: "0026", label: "BELLEY" },
  { code: "0027", label: "BERGERAC" },
  { code: "0028", label: "BERNAY" },
  { code: "0029", label: "BESANÇON" },
  { code: "0030", label: "BETHUNE" },
  { code: "0031", label: "BEZIERS" },
  { code: "0032", label: "BLOIS" },
  { code: "0033", label: "SEINE-SAINT-DENIS (BOBIGNY)" },
  { code: "0034", label: "BONNEVILLE" },
  { code: "0035", label: "BORDEAUX" },
  { code: "0036", label: "BOULOGNE-SUR-MER" },
  { code: "0037", label: "AIN" },
  { code: "0038", label: "BOURGES" },
  { code: "0039", label: "BOURGOIN-JALLIEU" },
  { code: "0040", label: "BRESSUIRE" },
  { code: "0041", label: "BREST" },
  { code: "0042", label: "BRIEY" },
  { code: "0043", label: "BRIVE" },
  { code: "0044", label: "CAEN" },
  { code: "0045", label: "LOT (CAHORS)" },
  { code: "0046", label: "CAMBRAI" },
  { code: "0047", label: "CARCASSONNE" },
  { code: "0048", label: "CARPENTRAS" },
  { code: "0049", label: "CASTRES" },
  { code: "0050", label: "GUYANE (CAYENNE)" },
  { code: "0051", label: "CHALON-SUR-SAÔNE" },
  { code: "0052", label: "CHALONS-EN-CHAMPAGNE" },
  { code: "0053", label: "CHAMBERY" },
  { code: "0054", label: "ARDENNES (CHARLEVILLE-MEZIERES)" },
  { code: "0055", label: "CHARTRES" },
  { code: "0056", label: "CHÂTEAUROUX" },
  { code: "0057", label: "HAUTE-MARNE" },
  { code: "0058", label: "CHERBOURG" },
  { code: "0059", label: "CLERMONT-FERRAND" },
  { code: "0060", label: "COLMAR" },
  { code: "0061", label: "COMPIEGNE" },
  { code: "0062", label: "COUTANCES" },
  { code: "0063", label: "VAL-DE-MARNE (CRETEIL)" },
  { code: "0064", label: "CUSSET/VICHY" },
  { code: "0065", label: "DAX" },
  { code: "0066", label: "DIEPPE" },
  { code: "0067", label: "ALPES DE HAUTE-PROVENCE (DIGNE)" },
  { code: "0068", label: "DIJON" },
  { code: "0069", label: "DINAN" },
  { code: "0070", label: "DOLE" },
  { code: "0071", label: "DOUAI" },
  { code: "0072", label: "DRAGUIGNAN" },
  { code: "0073", label: "DUNKERQUE" },
  { code: "0074", label: "EPINAL" },
  { code: "0075", label: "EURE" },
  { code: "0076", label: "ESSONNE" },
  { code: "0077", label: "ARIEGE" },
  { code: "0078", label: "FONTAINEBLEAU" },
  { code: "0079", label: "MARTINIQUE (FORT-DE-FRANCE)" },
  { code: "0080", label: "HAUTES-ALPES" },
  { code: "0081", label: "GRASSE" },
  { code: "0082", label: "GRENOBLE" },
  { code: "0083", label: "CREUSE (GUERET)" },
  { code: "0084", label: "GUINGAMP/LANNION" },
  { code: "0085", label: "HAZEBROUCK" },
  { code: "0086", label: "LA ROCHE-SUR-YON" },
  { code: "0087", label: "LA ROCHELLE-ROCHEFORT" },
  { code: "0088", label: "LAON" },
  { code: "0089", label: "LAVAL" },
  { code: "0090", label: "LE HAVRE" },
  { code: "0091", label: "LE MANS" },
  { code: "0092", label: "HAUTE-LOIRE (LE PUY-EN-VELAY)" },
  { code: "0093", label: "LES SABLES D'OLONNE" },
  { code: "0094", label: "LIBOURNE" },
  { code: "0095", label: "LILLE" },
  { code: "0096", label: "LIMOGES" },
  { code: "0097", label: "LISIEUX" },
  { code: "0098", label: "JURA (LONS-LE-SAUNIER)" },
  { code: "0099", label: "LORIENT" },
  { code: "0100", label: "LURE" },
  { code: "0101", label: "LYON" },
  { code: "0102", label: "MÂCON/CHAROLLES" },
  { code: "0103", label: "MARMANDE" },
  { code: "0104", label: "MARSEILLE" },
  { code: "0105", label: "MEAUX" },
  { code: "0106", label: "MELUN" },
  { code: "0107", label: "LOZERE" },
  { code: "0108", label: "METZ" },
  { code: "0109", label: "MILLAU" },
  { code: "0110", label: "MONT-DE-MARSAN" },
  { code: "0111", label: "MONTARGIS" },
  { code: "0112", label: "TARN & GARONNE" },
  { code: "0113", label: "MONTBELIARD" },
  { code: "0114", label: "MONTBRISON" },
  { code: "0115", label: "MONTLUÇON" },
  { code: "0116", label: "MONTPELLIER" },
  { code: "0117", label: "MORLAIX" },
  { code: "0118", label: "MOULINS" },
  { code: "0119", label: "MULHOUSE" },
  { code: "0120", label: "NANCY" },
  { code: "0121", label: "HAUTS-DE-SEINE" },
  { code: "0122", label: "NANTES" },
  { code: "0123", label: "NARBONNE" },
  { code: "0124", label: "NEVERS" },
  { code: "0125", label: "NICE" },
  { code: "0126", label: "NÎMES" },
  { code: "0127", label: "DEUX-SEVRES" },
  { code: "0128", label: "NOUMEA" },
  { code: "0129", label: "ORLEANS" },
  { code: "0130", label: "PAPEETE" },
  { code: "0131", label: "PARIS" },
  { code: "0132", label: "PAU" },
  { code: "0133", label: "PERIGUEUX" },
  { code: "0134", label: "PERONNE" },
  { code: "0135", label: "PYRENEES-ORIENTALES" },
  { code: "0136", label: "GUADELOUPE/SAINT-MARTIN/SAINT-BARTHELEMY" },
  { code: "0137", label: "POITIERS" },
  { code: "0138", label: "VAL D'OISE" },
  { code: "0139", label: "ARDECHE" },
  { code: "0140", label: "QUIMPER" },
  { code: "0141", label: "REIMS" },
  { code: "0142", label: "RENNES" },
  { code: "0143", label: "RIOM" },
  { code: "0144", label: "ROANNE" },
  { code: "0145", label: "ROCHEFORT-SUR-MER" },
  { code: "0146", label: "AVEYRON" },
  { code: "0147", label: "ROUEN" },
  { code: "0148", label: "SAINT-BRIEUC" },
  { code: "0149", label: "SAINT-DENIS-DE-LA-REUNION" },
  { code: "0150", label: "SAINT-DIE" },
  { code: "0151", label: "SAINT-ETIENNE" },
  { code: "0152", label: "SAINT-GAUDENS" },
  { code: "0153", label: "SAINT MALO-DINAN" },
  { code: "0154", label: "SAINT-NAZAIRE" },
  { code: "0155", label: "SAINT-OMER" },
  { code: "0156", label: "SAINT-PIERRE-DE-LA-REUNION" },
  { code: "0157", label: "SAINT-QUENTIN" },
  { code: "0158", label: "SAINTES" },
  { code: "0159", label: "SARREGUEMINES" },
  { code: "0160", label: "SAUMUR" },
  { code: "0161", label: "SAVERNE" },
  { code: "0162", label: "SENLIS" },
  { code: "0163", label: "SENS" },
  { code: "0164", label: "SOISSONS" },
  { code: "0165", label: "STRASBOURG" },
  { code: "0166", label: "TARASCON" },
  { code: "0167", label: "TARBES" },
  { code: "0168", label: "THIONVILLE" },
  { code: "0169", label: "THONON-LES-BAINS, DU LEMAN ET DU GENEVOIS" },
  { code: "0170", label: "TOULON" },
  { code: "0171", label: "TOULOUSE" },
  { code: "0172", label: "TOURS" },
  { code: "0173", label: "AUBE (TROYES)" },
  { code: "0174", label: "TULLE" },
  { code: "0175", label: "VALENCE" },
  { code: "0176", label: "VALENCIENNES" },
  { code: "0177", label: "VANNES" },
  { code: "0178", label: "VERSAILLES" },
  { code: "0179", label: "HAUTE-SAONE (VESOUL)" },
  { code: "0180", label: "VIENNE" },
  { code: "0181", label: "VILLEFRANCHE-SUR-SAONE" },
  { code: "0182", label: "MAYOTTE (MAMOUDZOU)" },
  { code: "0183", label: "SAINT-PIERRE ET MIQUELON" },
];

const CNB_BAR_ALIASES: Record<string, string> = {
  auch: "0015",
  "bourg en bresse": "0037",
  chaumont: "0057",
  evreux: "0075",
  evry: "0076",
  foix: "0077",
  gap: "0080",
  mende: "0107",
  montauban: "0112",
  nanterre: "0121",
  niort: "0127",
  "basse terre": "0136",
  "pointe a pitre": "0136",
  pontoise: "0138",
  privas: "0139",
  rodez: "0146",
};

const CNB_BAR_BY_CODE = new Map(CNB_BAR_ASSOCIATIONS.map((bar) => [bar.code, bar]));
const CNB_BAR_BY_KEY = buildBarIndex();

export function findCnbBarAssociation(value: string | null | undefined): CnbBarAssociation | null {
  const key = normalizeCnbBarKey(value);
  if (!key) return null;

  const aliasCode = CNB_BAR_ALIASES[key];
  if (aliasCode) return CNB_BAR_BY_CODE.get(aliasCode) ?? null;

  const exact = CNB_BAR_BY_KEY.get(key);
  if (exact) return exact;

  if (key.length < 4) return null;
  const candidates = Array.from(CNB_BAR_BY_KEY.entries())
    .filter(([candidateKey]) => candidateKey.includes(key) || key.includes(candidateKey))
    .sort(
      ([left], [right]) => Math.abs(left.length - key.length) - Math.abs(right.length - key.length),
    );
  return candidates[0]?.[1] ?? null;
}

function buildBarIndex() {
  const index = new Map<string, CnbBarAssociation>();
  for (const bar of CNB_BAR_ASSOCIATIONS) {
    const aliases = new Set<string>([bar.label]);
    const parenthetical = bar.label.match(/\(([^)]+)\)/)?.[1];
    if (parenthetical) {
      aliases.add(parenthetical);
      for (const segment of parenthetical.split("/")) aliases.add(segment);
    }
    aliases.add(bar.label.replace(/\s*\([^)]+\)\s*/g, " "));
    for (const segment of bar.label.split("/")) aliases.add(segment);

    for (const alias of aliases) {
      const key = normalizeCnbBarKey(alias);
      if (key && !index.has(key)) index.set(key, bar);
    }
  }
  return index;
}

function normalizeCnbBarKey(value: string | null | undefined) {
  const key = value
    ?.trim()
    .replace(/^ordre\s+des\s+avocats\s+du\s+/i, "")
    .replace(/^barreau\s+(?:de\s+|du\s+|d['’]\s*)?/i, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr")
    .replace(/&/g, " et ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return key || null;
}
