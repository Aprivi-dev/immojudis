import { describe, expect, it } from "vitest";
import { unavailablePepites, type AdminPepitesResponse } from "@/lib/admin-pepites";
import { buildAdminPepitesView } from "./admin-pepites-view";

const baseRow = {
  saleId: "sale-1",
  category: "pepite" as const,
  title: "Appartement 3 pièces",
  city: "Bordeaux",
  tribunal: "Tribunal judiciaire de Bordeaux",
  venue: "tribunal" as const,
  venueLabel: "Tribunal",
  saleDate: "2026-12-15T10:00:00Z",
  startingPriceEur: 80_000,
  referenceCeilingEur: 190_000,
  probablePriceEur: 120_000,
  rangeLowEur: 96_000,
  rangeHighEur: 160_000,
  chanceShare: 0.74,
  chanceAtLeast: false,
  costRatio: 0.58,
  passed: ["Test C : coût total sous le seuil", "Surface enregistrée"],
  missed: [],
  stability: ["Publiée : 2 évaluations favorables consécutives"],
  evaluatedAt: "2026-11-01T10:00:00Z",
  frozenAt: null,
  feesDefault: false,
  dpeClass: null,
  energyRenovationEur: null,
  marketNote: null,
  badges: [],
  href: "/sales/sale-1",
};

function data(overrides: Partial<AdminPepitesResponse> = {}): AdminPepitesResponse {
  const counter = (venue: "tribunal" | "notary" | "other", label: string, values: number[]) => ({
    venue,
    label,
    evaluated: values[0],
    pepites: values[1],
    pending: values[2],
    notPepite: values[3],
    notApplicable: values[4],
    insufficient: values[5],
    evaluable: values[6],
    onlyGapGuard: values[7],
  });
  return {
    migrated: true,
    generatedAt: "2026-11-01T12:00:00Z",
    mode: "shadow",
    ruleVersion: "pepite-v1.1",
    counters: [
      counter("tribunal", "Tribunal", [40, 3, 1, 30, 0, 6, 34, 12]),
      counter("notary", "Vente notariale", [10, 1, 0, 8, 0, 1, 9, 0]),
      counter("other", "Autre ou inconnu", [5, 0, 0, 0, 5, 0, 0, 0]),
    ],
    totals: {
      evaluated: 55,
      pepites: 4,
      pending: 1,
      notPepite: 38,
      notApplicable: 5,
      insufficient: 7,
      evaluable: 43,
      onlyGapGuard: 12,
    },
    rate: {
      share: 5 / 43,
      pepites: 5,
      evaluable: 43,
      alert: null,
      alertMin: 0.02,
      alertMax: 0.15,
      targetMin: 0.05,
      targetMax: 0.1,
    },
    rows: [
      baseRow,
      {
        ...baseRow,
        saleId: "sale-2",
        category: "near",
        title: "Maison de ville",
        missed: ["Écart aberrant entre la mise à prix et la valeur estimée"],
        passed: ["Test C : coût total sous le seuil"],
        stability: [],
        chanceShare: null,
        rangeLowEur: null,
        rangeHighEur: null,
        href: "/sales/sale-2",
      },
    ],
    feesDefault: { pepites: 1, withDefaultFees: 1, share: 1 },
    independence: {
      evaluatedSales: 43,
      evaluatedSponsored: 9,
      evaluatedShare: 9 / 43,
      pepiteSales: 5,
      pepiteSponsored: 1,
      pepiteShare: 0.2,
      gapPoints: -0.9,
      alert: false,
      alertPoints: 10,
      minPepites: 10,
    },
    floodReobservationPending: 0,
    ...overrides,
  };
}

/** Les espaces insécables des nombres fr-FR deviennent des espaces simples, pour comparer. */
const plain = (value: unknown) =>
  (typeof value === "string" ? value : JSON.stringify(value)).replace(/[\u00a0\u202f]/g, " ");
const section = (view: ReturnType<typeof buildAdminPepitesView>, id: string) =>
  view.sections.find((item) => item.id === id)!;

describe("buildAdminPepitesView", () => {
  it("compose les six sections, dans l'ordre", () => {
    expect(buildAdminPepitesView(data()).sections.map((item) => item.id)).toEqual([
      "mode",
      "counters",
      "rate",
      "flood",
      "fees",
      "list",
      "independence",
    ]);
  });

  describe("ventes d'inondation en attente de réobservation", () => {
    it("aucune : le nombre est dit, sans alerte", () => {
      const flood = section(buildAdminPepitesView(data()), "flood");
      expect(plain(flood.paragraphs)).toContain("0 vente à venir dont la dernière observation");
      expect(flood.alert).toBeNull();
    });

    it("quelques-unes : le nombre est dit et la règle v2 n'est pas prête", () => {
      const flood = section(
        buildAdminPepitesView(data({ floodReobservationPending: 531 })),
        "flood",
      );
      expect(plain(flood.paragraphs)).toContain("531 ventes à venir dont la dernière observation");
      expect(plain(flood.paragraphs)).toContain("pas une panne");
      expect(flood.alert).toContain("pas prête côté inondation");
    });

    it("une seule vente : le singulier", () => {
      const flood = section(buildAdminPepitesView(data({ floodReobservationPending: 1 })), "flood");
      expect(plain(flood.paragraphs)).toContain("1 vente à venir dont");
    });

    it("non mesuré : jamais un zéro rassurant", () => {
      const flood = section(
        buildAdminPepitesView(data({ floodReobservationPending: null })),
        "flood",
      );
      expect(plain(flood.paragraphs)).toContain("Non mesuré");
      expect(plain(flood.paragraphs)).not.toMatch(/\b0 vente/);
      expect(flood.alert).toBeNull();
    });
  });

  it("dit la part des pépites calculées avec des frais par défaut", () => {
    const fees = section(buildAdminPepitesView(data()), "fees");
    expect(plain(fees.paragraphs)).toContain("100 % des pépites de la liste (1 sur 1)");
    const none = section(
      buildAdminPepitesView(data({ feesDefault: { pepites: 0, withDefaultFees: 0, share: null } })),
      "fees",
    );
    expect(plain(none.paragraphs)).toContain("Aucune pépite dans la liste");
  });

  it("dit le mode et que rien n'est visible du public en observation, sans bouton", () => {
    const mode = section(buildAdminPepitesView(data()), "mode");

    expect(mode.title).toBe("Mode : shadow");
    expect(mode.paragraphs[0]).toContain("rien n’est visible du public");
    expect(mode.paragraphs[0]).toContain("Règle pepite-v1.1");
    expect(mode.paragraphs[0]).toContain("il n’y a pas de bouton ici");
  });

  it.each([
    ["off", /ne tourne pas/],
    ["on", /publiques/],
    ["unknown", /migration/],
  ] as const)("dit en clair le mode %s", (mode, text) => {
    expect(section(buildAdminPepitesView(data({ mode })), "mode").paragraphs[0]).toMatch(text);
  });

  it("affiche les compteurs par type de vente et le total", () => {
    const table = section(buildAdminPepitesView(data()), "counters").table!;

    expect(table.head).toEqual([
      "Type",
      "Évaluées",
      "Pépites",
      "À confirmer",
      "Pas des pépites",
      "Non applicables",
      "Données insuffisantes",
      "Écart aberrant seul",
    ]);
    expect(table.rows.map((row) => row.map((cell) => cell.t))).toEqual([
      ["Tribunal", "40", "3", "1", "30", "0", "6", "12"],
      ["Vente notariale", "10", "1", "0", "8", "0", "1", "0"],
      ["Autre ou inconnu", "5", "0", "0", "0", "5", "0", "0"],
      ["Total", "55", "4", "1", "38", "5", "7", "12"],
    ]);
  });

  it("explique les compteurs « à confirmer » et « écart aberrant seul »", () => {
    const text = section(buildAdminPepitesView(data()), "counters").paragraphs[0];
    expect(text).toContain("une évaluation favorable de plus");
    expect(text).toContain("sous 10 % de la valeur");
  });

  describe("taux de pépites", () => {
    it("donne le taux, l'effectif et la cible, sans alerte dans la plage", () => {
      const rate = section(buildAdminPepitesView(data()), "rate");
      expect(rate.paragraphs[0]).toContain("11,6 %");
      expect(rate.paragraphs[0]).toContain("5 sur 43");
      expect(rate.paragraphs[0]).toContain("Cible : 5 % à 10 %");
      expect(rate.alert).toBeNull();
    });

    it("alerte sous la plage de 2 % à 15 %", () => {
      const view = buildAdminPepitesView(
        data({ rate: { ...data().rate, alert: "below", share: 0.01 } }),
      );
      expect(section(view, "rate").alert).toContain("sous la plage d’alerte de 2 % à 15 %");
      expect(section(view, "rate").alert).toContain("trop stricte");
    });

    it("alerte au-dessus de la plage", () => {
      const view = buildAdminPepitesView(
        data({ rate: { ...data().rate, alert: "above", share: 0.2 } }),
      );
      expect(section(view, "rate").alert).toContain("au-dessus de la plage d’alerte de 2 % à 15 %");
      expect(section(view, "rate").alert).toContain("trop large");
    });

    it("sans vente évaluable, pas de taux", () => {
      const view = buildAdminPepitesView(
        data({ rate: { ...data().rate, share: null, evaluable: 0, pepites: 0 } }),
      );
      expect(section(view, "rate").paragraphs[0]).toContain("— des ventes évaluables");
    });
  });

  describe("liste", () => {
    it("une pépite : montants, plafond, prix probable et fourchette, parts et critères en clair", () => {
      const table = section(buildAdminPepitesView(data()), "list").table!;
      const row = table.rows[0];

      expect(table.head).toEqual([
        "Vente",
        "Mise à prix",
        "Plafond de référence",
        "Prix probable",
        "Part B",
        "Ratio C",
        "Critères",
        "Évaluée",
      ]);
      expect(row[0]).toMatchObject({ t: "Appartement 3 pièces", h: "/sales/sale-1" });
      expect(plain(row[0].s)).toContain("Pépite · Tribunal · Bordeaux · 15 déc. 2026");
      expect(plain(row[1].t)).toBe("80 000 €");
      expect(plain(row[2].t)).toContain("190 000");
      expect(plain(row[3])).toContain("120 000");
      expect(plain(row[3].s)).toContain("96 000 € à 160 000 €");
      expect(row[4].t).toBe("74 %");
      expect(row[5].t).toBe("58 %");
      expect(row[6]).toMatchObject({
        t: "2 réussis, 0 manqué",
        bad: [],
        l: [
          "Test C : coût total sous le seuil",
          "Surface enregistrée",
          "Publiée : 2 évaluations favorables consécutives",
        ],
      });
      expect(row[7].t).toContain("1 nov. 2026");
    });

    it("une presque pépite : le critère manqué est écrit en clair", () => {
      const row = section(buildAdminPepitesView(data()), "list").table!.rows[1];

      expect(row[0].t).toBe("Maison de ville");
      expect(row[0].s).toContain("Presque pépite");
      expect(row[3].s).toBeUndefined();
      expect(row[4].t).toBe("—");
      expect(row[6]).toMatchObject({
        t: "1 réussi, 1 manqué",
        bad: ["Manqué : Écart aberrant entre la mise à prix et la valeur estimée"],
      });
    });

    it("un plancher « au moins » est écrit avec « ≥ »", () => {
      const row = section(
        buildAdminPepitesView(data({ rows: [{ ...baseRow, chanceAtLeast: true }] })),
        "list",
      ).table!.rows[0];
      expect(row[4].t).toBe("≥ 74 %");
      expect(row[4].s).toBe("plancher");
    });

    it("pepite-v1.2 : le DPE, son coût, les badges et le marché local s'écrivent dans la ligne", () => {
      const row = section(
        buildAdminPepitesView(
          data({
            rows: [
              {
                ...baseRow,
                dpeClass: "F",
                energyRenovationEur: 15_000,
                badges: ["Double sortie"],
                marketNote: "Marché local (Appartement) : 55 ventes sur 12 mois",
              },
            ],
          }),
        ),
        "list",
      ).table!.rows[0];
      expect(row[0].s?.replace(/\s/g, " ")).toContain("DPE F (+15 000 € de rénovation)");
      expect(row[0].s).toContain("Double sortie");
      expect(row[6].l).toContain("Marché local (Appartement) : 55 ventes sur 12 mois");
      // Sans ces informations, la ligne reste celle d'avant la v1.2.
      const plain = section(buildAdminPepitesView(data()), "list").table!.rows[0];
      expect(plain[0].s).not.toMatch(/DPE|Double sortie/);
    });

    it("un DPE connu sans coût (classe A à E) n'écrit pas de rénovation", () => {
      const row = section(
        buildAdminPepitesView(
          data({ rows: [{ ...baseRow, dpeClass: "D", energyRenovationEur: 0 }] }),
        ),
        "list",
      ).table!.rows[0];
      expect(row[0].s).toContain("DPE D");
      expect(row[0].s).not.toContain("rénovation");
    });

    it("une part B ordinaire n'est pas un plancher", () => {
      const row = section(buildAdminPepitesView(data()), "list").table!.rows[0];
      expect(row[4].s).toBeUndefined();
    });

    it("les parts B et C ont une décimale : 69,6 % ne s'affiche pas « 70 % »", () => {
      const row = section(
        buildAdminPepitesView(
          data({ rows: [{ ...baseRow, chanceShare: 0.6964, costRatio: 0.7449 }] }),
        ),
        "list",
      ).table!.rows[0];
      expect(row[4].t).toBe("69,6 %");
      expect(row[5].t).toBe("74,5 %");
    });

    it("sans vente à afficher : le dit, sans tableau", () => {
      const list = section(buildAdminPepitesView(data({ rows: [] })), "list");
      expect(list.table).toBeNull();
      expect(list.paragraphs).toEqual(["Aucune vente à afficher pour le moment."]);
    });

    it("une vente sans titre ni montant s'affiche sans erreur", () => {
      const row = section(
        buildAdminPepitesView(
          data({
            rows: [
              {
                ...baseRow,
                title: null,
                city: null,
                saleDate: null,
                startingPriceEur: null,
                referenceCeilingEur: null,
                probablePriceEur: null,
                costRatio: null,
                evaluatedAt: "",
              },
            ],
          }),
        ),
        "list",
      ).table!.rows[0];
      expect(row.map((cell) => cell.t)).toEqual([
        "Vente sans titre",
        "—",
        "—",
        "—",
        "74 %",
        "—",
        "2 réussis, 0 manqué",
        "—",
      ]);
    });
  });

  describe("contrôle d'indépendance", () => {
    it("donne les deux parts et dit qu'aucune donnée d'avocat n'entre dans le calcul", () => {
      const independence = section(buildAdminPepitesView(data()), "independence");
      expect(independence.paragraphs.join(" ")).toContain(
        "aucune donnée d’avocat ni de sponsoring n’entre dans le calcul",
      );
      expect(independence.paragraphs).toContain(
        "Pépites (publiées et à confirmer) : 20 % (1 sur 5).",
      );
      expect(independence.paragraphs).toContain(
        "Toutes les ventes évaluables : 20,9 % (9 sur 43).",
      );
      expect(independence.alert).toBeNull();
    });

    it("alerte quand la part des pépites dépasse celle de l'ensemble", () => {
      const view = buildAdminPepitesView(
        data({ independence: { ...data().independence!, gapPoints: 25, alert: true } }),
      );
      expect(section(view, "independence").alert).toBe(
        "La part des pépites dépasse de 25 points celle de l’ensemble (alerte à 10 points, sur au moins 10 pépites) : examiner la règle.",
      );
    });

    it("dit « non mesuré » quand la lecture est impossible", () => {
      const independence = section(
        buildAdminPepitesView(data({ independence: null })),
        "independence",
      );
      expect(independence.paragraphs).toContain(
        "Non mesuré : lecture impossible ou délai dépassé.",
      );
      expect(independence.alert).toBeNull();
    });
  });

  it("propose l'arrêt d'urgence seulement en mode on", () => {
    expect(buildAdminPepitesView(data({ mode: "shadow" })).canSuspend).toBe(false);
    expect(buildAdminPepitesView(data({ mode: "off" })).canSuspend).toBe(false);
    expect(buildAdminPepitesView(data({ mode: "unknown" })).canSuspend).toBe(false);
    expect(buildAdminPepitesView(data({ mode: "on" })).canSuspend).toBe(true);
    expect(buildAdminPepitesView(unavailablePepites()).canSuspend).toBe(false);
  });

  it("avant la migration : une seule section qui le dit, sans compteur", () => {
    const view = buildAdminPepitesView(unavailablePepites());

    expect(view.sections).toHaveLength(1);
    expect(view.sections[0].paragraphs[0]).toContain(
      "migration des pépites n’est pas encore appliquée",
    );
    expect(view.sections[0].table).toBeNull();
  });

  it("ne porte que du texte : aucun montant brut ni identifiant interne n'est exposé", () => {
    const text = plain(buildAdminPepitesView(data()));
    expect(text).not.toContain("190000");
    expect(text).not.toContain("saleId");
  });
});
