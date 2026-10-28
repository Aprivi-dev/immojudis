import { describe, expect, it } from "vitest";
import { PEPITE_CRITERIA } from "./pepite-policy";
import { PEPITE_CRITERION_LABELS, pepiteConfirmLabel, pepitePassLabel } from "./pepite-reasons";
import {
  pepiteCriteriaPayload,
  pepiteCriteriaViews,
  pepiteDetailPayload,
  pepiteDetailView,
  pepiteFloodView,
} from "./sale-pepite-view";

const CODES = [
  "pass:regime_open",
  "pass:sale_upcoming",
  "pass:estimate_actionable",
  "pass:test_c_cost",
  "pass:test_b_chance",
  "stab:entered",
];

const TRIBUNAL_DETAILS = {
  regime: "tribunal",
  startingPriceEur: 50_000,
  referenceCeilingEur: 118_000,
  probablePriceEur: 90_000,
  rangeLowEur: 75_000,
  rangeHighEur: 110_000,
  costRatio: 0.68,
  chanceShare: 0.78,
  chanceAtLeast: false,
  multiplierKey: "q50",
  scenarios: { reliability: "good", courtSample: 42, nationalSample: 900 },
};

const JARGON = /Test [BC]|P10|effectif|porte publique|\bIA\b/;

describe("libellés des critères : le langage de l'investisseur", () => {
  it("aucun libellé affiché ne contient « Test B », « Test C », « P10 », « effectif », « porte publique » ni « IA »", () => {
    for (const id of PEPITE_CRITERIA) {
      for (const regime of [null, "tribunal", "notary_auction", "notary_online"] as const) {
        for (const label of [
          PEPITE_CRITERION_LABELS[id].pass,
          PEPITE_CRITERION_LABELS[id].fail,
          pepitePassLabel(id, regime),
          pepiteConfirmLabel(id, regime),
        ]) {
          expect(label, `${id} / ${regime}`).not.toMatch(JARGON);
        }
      }
    }
  });

  it("reprend les libellés demandés pour les deux tests et pour les vérifications", () => {
    const pass = (id: (typeof PEPITE_CRITERIA)[number]) => PEPITE_CRITERION_LABELS[id].pass;
    expect(pass("test_b_chance")).toBe(
      "Chances de l'emporter : au moins 7 ventes comparables sur 10 adjugées sous l'enchère plafond",
    );
    expect(pass("test_c_cost")).toBe(
      "Coût d'achat estimé nettement sous la valeur : coût total, frais compris, d'au plus 75 % de la valeur estimée (65 % en vente notariale)",
    );
    expect(pass("ceiling_computed")).toBe(
      "Enchère plafond calculée sur une estimation prudente de la valeur",
    );
    expect(pass("scenarios_reliable")).toBe(
      "Assez de ventes passées comparables pour juger les chances",
    );
    expect(pass("estimate_sample")).toBe("Au moins 8 ventes comparables derrière l'estimation");
    expect(pass("public_gap_gate")).toBe("Estimation assez précise pour être affichée");
    expect(pass("no_ai_block")).toBe(
      "Aucune donnée importante contestée à la relecture automatique",
    );
    expect(pass("no_degraded_condition")).toBe(
      "Aucun mauvais état ou gros travaux signalé dans l'annonce",
    );
    expect(pass("risks_qualified")).toBe("Aucun risque signalé laissé sans précision");
    expect(pass("regime_open")).toBe("Type de vente pris en compte");
  });

  it("dit « offre plafond » pour une vente notariale interactive, « enchère plafond » ailleurs", () => {
    expect(pepitePassLabel("ceiling_computed", "notary_online")).toBe(
      "Offre plafond calculée sur une estimation prudente de la valeur",
    );
    expect(pepitePassLabel("ceiling_computed", "tribunal")).toContain("Enchère plafond");
    expect(pepitePassLabel("ceiling_computed", "notary_auction")).toContain("Enchère plafond");
    expect(pepitePassLabel("ceiling_computed", "notary_online")).not.toMatch(/nchère/);
  });
});

describe("critères d'une pépite", () => {
  it("sépare les deux tests (en tête) des vérifications de fiabilité, dans l'ordre du catalogue", () => {
    const payload = pepiteCriteriaPayload(pepiteCriteriaViews(CODES, [], "tribunal"));
    expect(payload.tests.map((view) => view.id)).toEqual(["test_b_chance", "test_c_cost"]);
    expect(payload.checks.map((view) => view.id)).toEqual([
      "regime_open",
      "sale_upcoming",
      "estimate_actionable",
    ]);
    expect(payload.count).toBe(2);
    expect(payload.checksPassed).toBe(3);
    // Plus de champ « criteria » (les 19 critères réunis) : deux tests et une liste repliée.
    expect(payload).not.toHaveProperty("criteria");
  });

  it("en vente notariale, un seul test est présent", () => {
    const payload = pepiteCriteriaPayload(
      pepiteCriteriaViews(["pass:test_c_cost", "pass:ceiling_above_start"], [], "notary_auction"),
    );
    expect(payload.tests.map((view) => view.id)).toEqual(["test_c_cost"]);
    expect(payload.count).toBe(1);
    expect(payload.checks.map((view) => view.id)).toEqual(["ceiling_above_start"]);
  });

  it("écrit un test « à confirmer » avec son seuil de maintien, jamais avec le seuil d'entrée", () => {
    const views = pepiteCriteriaViews(["pass:test_c_cost", "fail:test_b_chance"], [], "tribunal");
    const b = views.find((view) => view.id === "test_b_chance")!;
    expect(b.state).toBe("confirm");
    expect(b.label).toBe(
      "Chances de l'emporter toujours au-dessus du seuil de maintien (65 % des ventes comparables adjugées sous l'enchère plafond), à confirmer à la prochaine mise à jour",
    );
    expect(b.label).not.toContain("70");
    const c = pepiteCriteriaViews(["fail:test_c_cost"], [], "tribunal")[0];
    expect(c.label).toContain("seuil de maintien");
    expect(c.label).toContain("80 %");
    expect(c.label).not.toContain("75 %");
    expect(pepiteCriteriaViews(["fail:test_c_cost"], [], "notary_online")[0].label).toContain(
      "70 %",
    );
    // Un critère « à confirmer » ne compte pas parmi les critères remplis.
    expect(pepiteCriteriaPayload(views).count).toBe(1);
  });

  it("ne présente jamais comme « à confirmer » un critère qui ferait sortir la vente ou un signal bloquant", () => {
    expect(
      pepiteCriteriaViews(["fail:test_b_chance", "fail:no_ai_block"], ["test_b_chance"]),
    ).toEqual([]);
  });

  it("ignore un code inconnu (version plus récente de la règle)", () => {
    expect(pepiteCriteriaViews(["pass:critere_futur", "pass:regime_open"])).toHaveLength(1);
  });

  it("le niveau « criteria » ne porte ni montant, ni valeur, ni détail", () => {
    const payload = pepiteCriteriaPayload(pepiteCriteriaViews(CODES, [], "tribunal"));
    expect(Object.keys(payload).sort()).toEqual([
      "access",
      "checks",
      "checksPassed",
      "count",
      "flood",
      "tests",
    ]);
    expect(payload.access).toBe("criteria");
    expect(JSON.stringify(payload)).not.toMatch(
      /€|EUR|\b\d{1,3}[\s\u00a0\u202f]\d{3}\b|referenceCeiling|probablePrice|rangeLow|rangeHigh|costRatio|chanceShare/,
    );
    for (const view of [...payload.tests, ...payload.checks]) {
      expect(Object.keys(view).sort()).toEqual(["id", "label", "state"]);
    }
  });
});

describe("détail d'une pépite du tribunal", () => {
  const criteria = pepiteCriteriaViews(CODES, [], "tribunal");

  it("écrit la condition (valeur mesurée à côté du seuil), le plafond de référence et le prix de référence en toutes lettres", () => {
    const detail = pepiteDetailView(TRIBUNAL_DETAILS, "2026-11-05T09:00:00.000Z", criteria)!;
    expect(detail.regime).toBe("tribunal");
    expect(detail.ceilingTerm).toBe("enchère plafond");
    expect(detail.condition).toBe(
      "Sur les ventes comparables passées du tribunal, complétées par la tendance nationale, 78 % ont été adjugées sous l'enchère plafond estimée. Le critère est rempli à partir de 70 %. Au prix de référence, le coût total estimé représente 68 % de la valeur estimée ; le critère est rempli jusqu'à 75 %.",
    );
    expect(detail.ceilingLine).toMatch(
      /^Enchère plafond estimée : 118\s000\s€ \(hypothèses par défaut : habiter, profil équilibré, sans travaux\)$/u,
    );
    expect(detail.referenceCeilingEur).toBe(118_000);
    expect(detail.priceLine).toMatch(
      /^Prix de référence : environ 90\s000\s€ \(fourchette 75\s000\s€ – 110\s000\s€\)$/u,
    );
    expect(detail.calculatedAt).toBe("2026-11-05T09:00:00.000Z");
  });

  it("reprend le texte validé sur le prix, mot pour mot", () => {
    const detail = pepiteDetailView(TRIBUNAL_DETAILS, null, criteria)!;
    expect(detail.priceNote).toBe(
      "Repère statistique tiré de 42 ventes comparables passées du tribunal (fiabilité bonne). La moitié de ces ventes s'est conclue dans la fourchette indiquée, l'autre moitié en dehors. Ce n'est pas une prévision du prix final : les enchères peuvent dépasser ce montant.",
    );
    expect(detail.priceNote).not.toContain("peut être inférieur ou supérieur");
  });

  it("écrit la part mesurée, arrondie vers le bas, avec « au moins » pour un plancher, à côté du seuil", () => {
    const measured = (details: Record<string, unknown>) =>
      pepiteDetailView({ ...TRIBUNAL_DETAILS, ...details }, null, criteria)!.condition;
    expect(measured({})).toContain(
      ", 78 % ont été adjugées sous l'enchère plafond estimée. Le critère",
    );
    expect(measured({ chanceShare: 0.7, chanceAtLeast: true })).toContain(
      ", au moins 70 % ont été adjugées",
    );
    // Jamais plus que la mesure : 0,69 donne 69 %, pas 70 %, et la phrase ne contredit pas le seuil.
    expect(measured({ chanceShare: 0.699 })).toContain(", 69 % ont été adjugées");
    expect(measured({ chanceShare: 1 })).toContain(", 100 % ont été adjugées");
    // Plus de ligne « N ventes sur 10 » : la valeur est dans la condition.
    expect(pepiteDetailView(TRIBUNAL_DETAILS, null, criteria)).not.toHaveProperty("chanceLine");
    // Part inconnue : on le dit, sans seuil inventé à côté d'un chiffre.
    expect(measured({ chanceShare: null })).toContain(
      "la part adjugée sous l'enchère plafond estimée n'est pas disponible",
    );
  });

  it("explique la mise à prix très basse (multiplicateur q75)", () => {
    const low = pepiteDetailView({ ...TRIBUNAL_DETAILS, multiplierKey: "q75" }, null, criteria)!;
    expect(low.priceLowNote).toBe(
      "La mise à prix est très basse : nous retenons le prix atteint par 3 ventes sur 4.",
    );
    expect(pepiteDetailView(TRIBUNAL_DETAILS, null, criteria)!.priceLowNote).toBeNull();
  });

  it("dit d'où vient la cohorte d'après le calcul : tribunal complété dès 10 ventes, fourchette nationale sous 20", () => {
    const cohort = (courtSample: number) =>
      pepiteDetailView(
        {
          ...TRIBUNAL_DETAILS,
          scenarios: { reliability: "medium", courtSample, nationalSample: 800 },
        },
        null,
        criteria,
      )!;
    // 20 ventes et plus : part lissée avec la tendance nationale, fourchette du tribunal seul.
    const local = cohort(42);
    expect(local.condition).toContain(
      "Sur les ventes comparables passées du tribunal, complétées par la tendance nationale,",
    );
    expect(local.priceNote).toContain(
      "42 ventes comparables passées du tribunal (fiabilité moyenne)",
    );

    // De 10 à 19 ventes : la part reste celle du tribunal complétée, mais la fourchette est nationale.
    const mixed = cohort(15);
    expect(mixed.condition).toContain("du tribunal, complétées par la tendance nationale");
    expect(mixed.priceNote).toContain("800 ventes comparables passées de toute la France");
    expect(mixed.priceNote).not.toContain("15 ventes");

    // Dès 20 ventes, la fourchette est celle du tribunal.
    expect(cohort(20).priceNote).toContain("20 ventes comparables passées du tribunal");

    // Moins de 10 ventes : tout est national.
    const national = cohort(6);
    expect(national.condition).toContain("Sur les ventes comparables passées de toute la France,");
    expect(national.condition).not.toContain("tribunal");
    expect(national.priceNote).toContain("800 ventes comparables passées de toute la France");
    expect(national.priceNote).not.toContain("passées du tribunal");
  });

  it("énonce le seuil de maintien d'un critère « à confirmer », à côté du seuil d'entrée", () => {
    const confirmCriteria = pepiteCriteriaViews(
      ["fail:test_b_chance", "fail:test_c_cost"],
      [],
      "tribunal",
    );
    const detail = pepiteDetailView(TRIBUNAL_DETAILS, null, confirmCriteria)!;
    expect(detail.condition).toContain("Le critère est rempli à partir de 70 % ;");
    expect(detail.condition).toContain(
      "la mention est maintenue jusqu'à 65 % (à confirmer à la prochaine mise à jour)",
    );
    expect(detail.condition).toContain("la mention est maintenue jusqu'à 80 %");
  });

  it("un bien loué : le coût est rapporté à la valeur diminuée de la décote, et le texte le dit", () => {
    const detail = pepiteDetailView(
      { ...TRIBUNAL_DETAILS, occupancyDiscountPct: 10 },
      null,
      criteria,
    )!;
    expect(detail.condition).toContain(
      "représente 68 % de la valeur estimée, diminuée de la décote d'un bien loué (10 %)",
    );
    expect(
      pepiteDetailView({ ...TRIBUNAL_DETAILS, occupancyDiscountPct: 0 }, null, criteria)!.condition,
    ).not.toContain("décote");
  });
});

describe("détail d'une pépite notariale", () => {
  it("vente à la bougie : seuil de 65 %, mise à prix, pas de prix de référence ni de prix de réserve cité", () => {
    const detail = pepiteDetailView(
      {
        regime: "notary_auction",
        startingPriceEur: 60_000,
        referenceCeilingEur: 95_000,
        costRatio: 0.61,
      },
      null,
    )!;
    expect(detail.ceilingTerm).toBe("enchère plafond");
    expect(detail.condition).toContain(
      "le coût total estimé représente 61 % de la valeur estimée ; le critère est rempli jusqu'à 65 %",
    );
    expect(detail.ceilingLine).toMatch(/^Enchère plafond estimée : 95\s000\s€/u);
    expect(detail.priceLine).toMatch(/^Mise à prix : 60\s000\s€$/u);
    expect(detail.priceNote).not.toContain("Prix de réserve du vendeur inconnu");
    expect(detail.priceNote).toContain("Pas de prix de référence");
  });

  it("vente interactive : « offre plafond », première offre possible, prix de réserve inconnu", () => {
    const detail = pepiteDetailView(
      {
        regime: "notary_online",
        startingPriceEur: 40_000,
        referenceCeilingEur: 70_000,
        costRatio: 0.6,
      },
      null,
    )!;
    expect(detail.ceilingTerm).toBe("offre plafond");
    expect(detail.ceilingLine).toMatch(/^Offre plafond estimée : 70\s000\s€/u);
    expect(detail.condition).toContain("première offre possible");
    expect(detail.condition).toContain("L'offre plafond estimée");
    expect(detail.priceLine).toMatch(/^Première offre possible : 40\s000\s€$/u);
    expect(detail.priceNote).toContain("Prix de réserve du vendeur inconnu");
    expect(detail.priceLine).not.toContain("probable");
  });

  it("sans régime lisible, aucun détail n'est inventé", () => {
    expect(pepiteDetailView({ referenceCeilingEur: 1000 }, null)).toBeNull();
  });

  it("assemble la réponse « detail » avec le même décompte de tests", () => {
    const criteria = pepiteCriteriaViews(CODES, [], "tribunal");
    const payload = pepiteDetailPayload(
      criteria,
      pepiteDetailView(TRIBUNAL_DETAILS, null, criteria)!,
    );
    expect(payload.access).toBe("detail");
    expect(payload.count).toBe(pepiteCriteriaPayload(criteria).count);
    expect(payload.tests).toHaveLength(2);
  });
});

describe("contrôle d'inondation d'une pépite (règle v2)", () => {
  const FLOOD_CODES = [
    ...CODES,
    "pass:flood_risk_known",
    "pass:no_high_flood_risk",
    "fail:flood_risk_known",
  ];

  it("les deux critères d'inondation n'entrent pas dans les listes de critères : ils ont leur propre ligne", () => {
    const views = pepiteCriteriaViews(FLOOD_CODES, [], "tribunal");
    expect(views.map((view) => view.id)).not.toContain("flood_risk_known");
    expect(views.map((view) => view.id)).not.toContain("no_high_flood_risk");
    // Le critère « connu » manqué, toléré au maintien, n'apparaît jamais comme « à confirmer ».
    expect(views.some((view) => view.state === "confirm")).toBe(false);
  });

  it("hors des zones testées : phrase factuelle, icône neutre, date de la carte et de la consultation", () => {
    const view = pepiteFloodView({
      flood: {
        verdict: "none_found",
        observedAt: "2026-11-05T09:00:00.000Z",
        mapDate: "2013-12-18",
      },
    });
    expect(view).toMatchObject({ verdict: "none_found", tone: "neutral" });
    expect(view?.line).toBe(
      "Bien non situé dans la zone de crue fréquente d’un territoire à risque important d’inondation (TRI), ni dans le périmètre d’un plan de prévention des risques d’inondation (PPRi), d’après les cartes consultées.",
    );
    expect(view?.details).toMatch(/^Cartes consultées/);
    expect(view?.details).toContain("Un plan de prévention seulement prescrit n’apparaît pas");
    expect(view?.details).toContain("Un risque d’inondation peut exister en dehors de ces zones.");
    expect(view?.sourceLine).toMatch(
      /^Source : Géorisques .*scénario de crue fréquente ; carte du 18 décembre 2013 ; consulté le 05 novembre 2026\.$/,
    );
    expect(view?.sourceUrl).toBe("https://www.georisques.gouv.fr/");
    expect(view?.warning).toMatch(/sans valeur d’expertise/);
    expect(view?.warning).toContain("état des risques et pollutions, lorsqu’il est exigé");
  });

  it("sans date de carte : seule la date de consultation figure", () => {
    const view = pepiteFloodView({
      flood: { verdict: "none_found", observedAt: "2026-11-05T09:00:00.000Z", mapDate: null },
    });
    expect(view?.sourceLine).toMatch(/crue fréquente ; consulté le 05 novembre 2026\.$/);
    expect(view?.sourceLine).not.toMatch(/carte du/);
  });

  it.each([
    ["tribunal", /cahier des conditions de vente/, /l’avocat poursuivant/],
    ["notary_auction", /cahier des charges/, /le notaire/],
    ["notary_online", /avant-contrat/, /le notaire/],
  ] as const)(
    "texte propre au type de vente (%s) : pièce annexée et interlocuteur",
    (regime, document, who) => {
      const view = pepiteFloodView({ regime, flood: { verdict: "exposed" } });
      expect(view?.warning).toMatch(document);
      expect(view?.details).toMatch(document);
      expect(view?.details).toMatch(who);
      expect(view?.details).toContain("état des risques et pollutions, lorsqu’il est exigé");
      if (regime !== "tribunal") {
        expect(`${view?.warning} ${view?.details}`).not.toMatch(
          /avocat poursuivant|cahier des conditions de vente/,
        );
      }
    },
  );

  it("type de vente inconnu : texte neutre qui nomme les trois pièces possibles", () => {
    const view = pepiteFloodView({ flood: { verdict: "exposed" } });
    expect(view?.warning).toMatch(
      /cahier des conditions de vente, cahier des charges ou avant-contrat/,
    );
  });

  it("PPRI non lu : ligne neutre, sans coche et sans la phrase sur les périmètres de PPRi", () => {
    const view = pepiteFloodView({
      flood: {
        verdict: "none_found",
        ppriChecked: false,
        observedAt: "2026-11-05T09:00:00.000Z",
        mapDate: "2013-12-18",
      },
    });
    expect(view).toMatchObject({ verdict: "tri_only", tone: "neutral", details: null });
    expect(view?.line).toBe(
      "Zone de crue fréquente des TRI consultée ; périmètres de PPRi non contrôlés à ce jour.",
    );
    // Aucune phrase « bien non situé… » ni « cartes consultées … périmètres des PPRi ».
    expect(JSON.stringify(view)).not.toMatch(/Bien non situé/);
    expect(JSON.stringify(view)).not.toMatch(/Cartes consultées/);
    // La source est celle du TRI seul : le Géoportail n'a pas été lu.
    expect(view?.sourceLine).toMatch(/^Source : Géorisques .*consulté le 05 novembre 2026\.$/);
    expect(view?.sourceUrl).toBe("https://www.georisques.gouv.fr/");
    expect(view?.warning).toMatch(/sans valeur d’expertise/);
  });

  it("PPRI lu (ou drapeau absent) : la ligne habituelle, jamais de coche", () => {
    for (const flood of [{ verdict: "none_found", ppriChecked: true }, { verdict: "none_found" }]) {
      expect(pepiteFloodView({ flood })).toMatchObject({ verdict: "none_found", tone: "neutral" });
    }
  });

  it("le drapeau « PPRI non lu » ne change rien aux autres verdicts", () => {
    for (const verdict of ["exposed", "no_signal", "unknown"]) {
      expect(pepiteFloodView({ flood: { verdict, ppriChecked: false } })?.verdict).toBe(verdict);
    }
  });

  it("exposé : pictogramme d'alerte, mention courte, mention développée, source du Géoportail", () => {
    const view = pepiteFloodView({
      flood: { verdict: "exposed", observedAt: "2026-11-05T09:00:00.000Z" },
    });
    expect(view).toMatchObject({ verdict: "exposed", tone: "alert" });
    expect(view?.line).toBe(
      "Dans le périmètre d’un plan de prévention des risques d’inondation (PPRi) : zonage à vérifier.",
    );
    expect(view?.details).toMatch(/Géoportail de l’urbanisme/);
    expect(view?.sourceLine).toMatch(/servitude d’utilité publique PM1/);
    expect(view?.sourceUrl).toBe("https://www.geoportail-urbanisme.gouv.fr/");
  });

  it("aucun signal : ligne neutre, sans coche ni source", () => {
    const view = pepiteFloodView({ flood: { verdict: "no_signal" } });
    expect(view).toMatchObject({ verdict: "no_signal", tone: "neutral", sourceLine: null });
    expect(view?.line).toMatch(/non vérifié au niveau du bien/);
  });

  it("inconnu : ligne neutre qui garde le repère, avec la date du dernier contrôle réussi quand elle existe", () => {
    const without = pepiteFloodView({ flood: { verdict: "unknown", observedAt: null } });
    expect(without).toMatchObject({ verdict: "unknown", tone: "neutral" });
    expect(without?.line).toBe(
      "Risque d’inondation non vérifié à ce jour pour ce bien (position imprécise ou source indisponible). Le repère est conservé sans ce contrôle.",
    );
    const withDate = pepiteFloodView({
      flood: { verdict: "unknown", observedAt: "2026-11-05T09:00:00.000Z" },
    });
    expect(withDate?.line).toMatch(/Dernier contrôle réussi le 05 novembre 2026\.$/);
    // Jamais le libellé générique « à confirmer ».
    expect(withDate?.line).not.toMatch(/à confirmer/);
  });

  it.each([
    ["règle v1 : aucun contrôle enregistré", {}],
    [
      "verdict élevé : une pépite ne l'est jamais, rien ne s'affiche",
      { flood: { verdict: "high" } },
    ],
    ["verdict illisible", { flood: { verdict: "dangerous" } }],
    ["valeur qui n'est pas un objet", { flood: "none_found" }],
  ])("%s : pas de ligne d'inondation", (_name, details) => {
    expect(pepiteFloodView(details)).toBeNull();
  });

  it("le niveau « criteria » porte le contrôle d'inondation, sans montant ; le niveau détail aussi", () => {
    const flood = pepiteFloodView({
      flood: { verdict: "exposed", observedAt: "2026-11-05T09:00:00.000Z" },
    });
    const criteria = pepiteCriteriaViews(CODES, [], "tribunal");
    const open = pepiteCriteriaPayload(criteria, flood);
    expect(open.flood?.verdict).toBe("exposed");
    expect(JSON.stringify(open)).not.toMatch(
      /€|EUR|referenceCeiling|probablePrice|rangeLow|rangeHigh|costRatio|chanceShare/,
    );
    const detail = pepiteDetailView(TRIBUNAL_DETAILS, "2026-11-05T09:00:00.000Z", criteria)!;
    expect(pepiteDetailPayload(criteria, detail, flood).flood?.verdict).toBe("exposed");
    expect(pepiteCriteriaPayload(criteria).flood).toBeNull();
  });
});
