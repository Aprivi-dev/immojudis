import type { AdminPepiteRow, AdminPepitesResponse } from "@/lib/admin-pepites";

/**
 * Ce que la page « /admin/pepites » affiche, déjà mis en forme côté serveur (montants, parts, dates,
 * critères en clair). La page n'est qu'un afficheur de sections : la mise en forme ne passe pas dans le
 * JavaScript du navigateur, dont le budget de build est presque épuisé (voir
 * `scripts/check-build-budgets.mjs`). Module pur, sans donnée ni import serveur.
 */
export type PepitesViewCell = {
  /** Texte de la cellule. */
  t: string;
  /** Lien (la cellule est alors un lien). */
  h?: string;
  /** Précision sous le texte (petits caractères). */
  s?: string;
  /** Détail repliable sous le texte (critères réussis ou manqués). */
  l?: string[];
  /** Un détail à signaler (critère manqué) : affiché en couleur d'alerte. */
  bad?: string[];
};

export type PepitesViewTable = {
  caption: string;
  head: string[];
  /** Chaque ligne : la première cellule est l'en-tête de la ligne. */
  rows: PepitesViewCell[][];
};

export type PepitesViewSection = {
  id: string;
  title: string;
  paragraphs: string[];
  /** Une alerte à lire (taux hors plage, dérive d'indépendance). */
  alert: string | null;
  table: PepitesViewTable | null;
};

export type AdminPepitesView = {
  sections: PepitesViewSection[];
  /** Le mode est « on » : la page propose « Suspendre les pépites » (arrêt d'urgence). */
  canSuspend: boolean;
};

const MODE_TEXT: Record<AdminPepitesResponse["mode"], string> = {
  off: "Arrêté : le calcul ne tourne pas.",
  shadow:
    "Observation (shadow) : les résultats sont calculés et stockés, rien n’est visible du public.",
  on: "Ouvert (on) : les pépites sont publiques.",
  unknown: "Inconnu : la migration n’est pas appliquée ou le mode est illisible.",
};

const CATEGORY_TEXT: Record<AdminPepiteRow["category"], string> = {
  pepite: "Pépite",
  pending: "À confirmer",
  near: "Presque pépite",
};

const integer = new Intl.NumberFormat("fr-FR");
const euros = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});
const dateTime = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Paris",
});

const percent = (share: number | null, digits = 0) =>
  share == null
    ? "—"
    : `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: digits }).format(share * 100)} %`;
const euro = (value: number | null) => (value == null ? "—" : euros.format(value));
const when = (value: string | null) => (value ? dateTime.format(new Date(value)) : "—");

function rowCells(row: AdminPepiteRow): PepitesViewCell[] {
  const range =
    row.rangeLowEur != null && row.rangeHighEur != null
      ? `${euro(row.rangeLowEur)} à ${euro(row.rangeHighEur)}`
      : undefined;
  return [
    {
      t: row.title ?? "Vente sans titre",
      h: row.href,
      s: [
        CATEGORY_TEXT[row.category],
        row.venueLabel,
        row.city,
        row.saleDate ? when(row.saleDate) : null,
      ]
        .filter(Boolean)
        .join(" · "),
    },
    { t: euro(row.startingPriceEur) },
    { t: euro(row.referenceCeilingEur) },
    { t: euro(row.probablePriceEur), s: range },
    // Une décimale : une part de 69,6 % ne doit pas s'afficher « 70 % » à côté du seuil de 70 %.
    row.chanceShare == null
      ? { t: "—" }
      : row.chanceAtLeast
        ? { t: `≥ ${percent(row.chanceShare, 1)}`, s: "plancher" }
        : { t: percent(row.chanceShare, 1) },
    { t: percent(row.costRatio, 1) },
    {
      t: `${row.passed.length} réussi${row.passed.length > 1 ? "s" : ""}, ${row.missed.length} manqué${row.missed.length > 1 ? "s" : ""}`,
      bad: row.missed.map((label) => `Manqué : ${label}`),
      l: [...row.passed, ...row.stability],
    },
    { t: when(row.evaluatedAt || null) },
  ];
}

/** La page des pépites, section par section. */
export function buildAdminPepitesView(data: AdminPepitesResponse): AdminPepitesView {
  if (!data.migrated) {
    return {
      canSuspend: false,
      sections: [
        {
          id: "migration",
          title: "Pépites",
          paragraphs: [
            "La migration des pépites n’est pas encore appliquée : le calcul ne tourne pas et la lecture publique rend « pas de pépite ».",
          ],
          alert: null,
          table: null,
        },
      ],
    };
  }

  const { rate, independence, feesDefault } = data;
  const counterRows = [...data.counters, { ...data.totals, venue: "total", label: "Total" }];
  const sections: PepitesViewSection[] = [
    {
      id: "mode",
      title: `Mode : ${data.mode}`,
      paragraphs: [
        `${MODE_TEXT[data.mode]} Règle ${data.ruleVersion}${data.generatedAt ? `, lue le ${when(data.generatedAt)}` : ""}. Le passage en « on » se décide après contrôle de cette liste ; il n’y a pas de bouton ici.`,
      ],
      alert: null,
      table: null,
    },
    {
      id: "counters",
      title: "Ventes évaluées par type de vente",
      paragraphs: [
        "« À confirmer » : une évaluation favorable de plus avant la publication. « Écart aberrant seul » : pas pépites arrêtées uniquement par le garde-fou sur la mise à prix (sous 10 % de la valeur, ou au-dessus de 150 %) : à regarder avant le passage en « on ».",
      ],
      alert: null,
      table: {
        caption: "Compteurs par type de vente",
        head: [
          "Type",
          "Évaluées",
          "Pépites",
          "À confirmer",
          "Pas pépites",
          "Non applicables",
          "Données insuffisantes",
          "Écart aberrant seul",
        ],
        rows: counterRows.map((row) => [
          { t: row.label },
          ...[
            row.evaluated,
            row.pepites,
            row.pending,
            row.notPepite,
            row.notApplicable,
            row.insufficient,
            row.onlyGapGuard,
          ].map((value) => ({ t: integer.format(value) })),
        ]),
      },
    },
    {
      id: "rate",
      title: "Taux de pépites",
      paragraphs: [
        `${percent(rate.share, 1)} des ventes évaluables (${integer.format(rate.pepites)} sur ${integer.format(rate.evaluable)}), pépites publiées et à confirmer. Cible : ${percent(rate.targetMin)} à ${percent(rate.targetMax)}.`,
      ],
      alert: rate.alert
        ? `Taux ${rate.alert === "below" ? "sous" : "au-dessus de"} la plage d’alerte de ${percent(rate.alertMin)} à ${percent(rate.alertMax)} : ${
            rate.alert === "below"
              ? "la règle est peut-être trop stricte, ou une donnée manque."
              : "la règle est peut-être trop large : le repère perdrait son sens."
          }`
        : null,
      table: null,
    },
    {
      id: "fees",
      title: "Frais par défaut",
      paragraphs: [
        "Pépites (publiées et à confirmer) dont le coût d’achat repose sur au moins un frais par défaut (frais préalables du cahier non lus, honoraires de négociation ou frais de publicité non lus). Au tribunal ces défauts restent admis ; en vente notariale, la règle refuse la pépite tant qu’ils ne sont pas lus.",
        feesDefault.pepites === 0
          ? "Aucune pépite dans la liste."
          : `${percent(feesDefault.share, 1)} des pépites de la liste (${integer.format(feesDefault.withDefaultFees)} sur ${integer.format(feesDefault.pepites)}).`,
      ],
      alert: null,
      table: null,
    },
    {
      id: "list",
      title: "Pépites et presque pépites",
      paragraphs: data.rows.length === 0 ? ["Aucune vente à afficher pour le moment."] : [],
      alert: null,
      table:
        data.rows.length === 0
          ? null
          : {
              caption: "Pépites, pépites à confirmer et presque pépites",
              head: [
                "Vente",
                "Mise à prix",
                "Plafond de référence",
                "Prix probable",
                "Part B",
                "Ratio C",
                "Critères",
                "Évaluée",
              ],
              rows: data.rows.map(rowCells),
            },
    },
    {
      id: "independence",
      title: "Contrôle d’indépendance",
      paragraphs: [
        "Part des ventes dont l’avocat poursuivant est un avocat référencé sponsorisé. Mesure d’information : aucune donnée d’avocat ni de sponsoring n’entre dans le calcul d’une pépite.",
        ...(independence
          ? [
              `Pépites (publiées et à confirmer) : ${percent(independence.pepiteShare, 1)} (${integer.format(independence.pepiteSponsored)} sur ${integer.format(independence.pepiteSales)}).`,
              `Toutes les ventes évaluables : ${percent(independence.evaluatedShare, 1)} (${integer.format(independence.evaluatedSponsored)} sur ${integer.format(independence.evaluatedSales)}).`,
            ]
          : ["Non mesuré : lecture impossible ou délai dépassé."]),
      ],
      alert: independence?.alert
        ? `La part des pépites dépasse de ${integer.format(Math.round(independence.gapPoints ?? 0))} points celle de l’ensemble (alerte à ${independence.alertPoints} points, sur au moins ${independence.minPepites} pépites) : examiner la règle.`
        : null,
      table: null,
    },
  ];
  return { sections, canSuspend: data.mode === "on" };
}
