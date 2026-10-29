import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type DbError = { code?: string; message: string } | null;

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  rpc: vi.fn(),
  tables: {} as Record<string, { rows: unknown[]; error: DbError }>,
  reads: [] as string[],
  /** Les lectures de table et le contrôle d'indépendance ne rendent jamais la main (base qui ne répond plus). */
  hang: false,
  /** Réponse de `admin_pepite_independence_sales` (une seule fonction agrégée), et nombre d'appels. */
  independence: { data: { evaluable: 0, pepites: 0, sales: [] }, error: null } as {
    data: unknown;
    error: DbError;
  },
  independenceCalls: 0,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("next/cache", () => ({
  revalidateTag: mocks.revalidateTag,
  revalidatePath: mocks.revalidatePath,
  unstable_cache: (load: (...args: unknown[]) => unknown) => load,
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.requireAuth,
}));

class FakeQuery implements PromiseLike<{ data: unknown; error: DbError }> {
  private ids: string[] | null = null;
  private page: [number, number] = [0, 999];
  constructor(private readonly table: string) {}
  select() {
    return this;
  }
  in(column: string, values: string[]) {
    if (column === "id") this.ids = values;
    return this;
  }
  eq() {
    return this;
  }
  order() {
    return this;
  }
  range(from: number, to: number) {
    this.page = [from, to];
    return this;
  }
  then<TResult1 = { data: unknown; error: DbError }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: unknown; error: DbError }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    mocks.reads.push(this.table);
    if (mocks.hang) return new Promise<never>(() => {});
    const entry = mocks.tables[this.table] ?? { rows: [], error: null };
    if (entry.error)
      return Promise.resolve({ data: null, error: entry.error }).then(onfulfilled, onrejected);
    const rows = this.ids
      ? (entry.rows as Row[]).filter((row) => this.ids?.includes(row.id as string))
      : (entry.rows as Row[]).slice(this.page[0], this.page[1] + 1);
    return Promise.resolve({ data: rows, error: null }).then(onfulfilled, onrejected);
  }
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: (name: string, args?: unknown) => {
      if (name === "admin_pepite_independence_sales") {
        mocks.independenceCalls += 1;
        if (mocks.hang) return new Promise<never>(() => {});
        return Promise.resolve(mocks.independence);
      }
      return mocks.rpc(name, args);
    },
    from: (table: string) => new FakeQuery(table),
  },
}));

import {
  INDEPENDENCE_ALERT_POINTS,
  computePepiteIndependence,
  getAdminPepites,
  parseAdminPepiteRow,
  pepiteFeesDefaultStat,
  pepiteRate,
  suspendAdminPepites,
  unavailablePepites,
} from "./admin-pepites";

const NOW = new Date("2026-11-01T12:00:00Z");

const counters = [
  {
    venue: "tribunal",
    evaluated: 40,
    pepites: 3,
    pending: 1,
    not_pepite: 30,
    not_applicable: 0,
    insufficient: 6,
    evaluable: 34,
    only_gap_guard: 12,
  },
  {
    venue: "notary",
    evaluated: 10,
    pepites: 1,
    pending: 0,
    not_pepite: 8,
    not_applicable: 0,
    insufficient: 1,
    evaluable: 9,
    only_gap_guard: 0,
  },
  {
    venue: "other",
    evaluated: 5,
    pepites: 0,
    pending: 0,
    not_pepite: 0,
    not_applicable: 5,
    insufficient: 0,
    evaluable: 0,
    only_gap_guard: 0,
  },
];

const row = {
  sale_id: "sale-1",
  status: "pepite",
  is_pepite: true,
  favorable_streak: 2,
  frozen_at: null,
  reason_codes: ["pass:test_c_cost", "pass:estimate_sample", "stab:entered"],
  details: {
    referenceCeilingEur: 190000,
    probablePriceEur: 120000,
    rangeLowEur: 96000,
    rangeHighEur: 160000,
    chanceShare: 0.74,
    chanceAtLeast: false,
    costRatio: 0.58,
  },
  evaluated_at: "2026-11-01T10:00:00Z",
  first_pepite_at: "2026-11-01T10:00:00Z",
  venue: "tribunal",
  title: "Appartement 3 pièces",
  city: "Bordeaux",
  tribunal: "Tribunal judiciaire de Bordeaux",
  sale_venue_type: "tribunal",
  starting_price_eur: 80000,
  sale_date: "2026-12-15T10:00:00Z",
};

beforeEach(() => {
  mocks.requireAuth.mockReset();
  mocks.rpc.mockReset();
  mocks.tables = {};
  mocks.independence = { data: { evaluable: 0, pepites: 0, sales: [] }, error: null };
  mocks.independenceCalls = 0;
  mocks.reads = [];
  mocks.hang = false;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("pepiteRate", () => {
  it("compte les pépites publiées et à confirmer parmi les ventes évaluables", () => {
    expect(pepiteRate(3, 1, 40)).toMatchObject({
      share: 0.1,
      pepites: 4,
      evaluable: 40,
      alert: null,
    });
  });

  it("alerte sous 2 % et au-dessus de 15 %, pas aux bornes", () => {
    expect(pepiteRate(1, 0, 100).alert).toBe("below");
    expect(pepiteRate(2, 0, 100).alert).toBeNull();
    expect(pepiteRate(15, 0, 100).alert).toBeNull();
    expect(pepiteRate(16, 0, 100).alert).toBe("above");
    expect(pepiteRate(0, 0, 100).alert).toBe("below");
  });

  it("sans vente évaluable : pas de taux, pas d'alerte", () => {
    expect(pepiteRate(0, 0, 0)).toMatchObject({ share: null, alert: null });
  });

  it("donne la plage d'alerte et la cible", () => {
    expect(pepiteRate(0, 0, 0)).toMatchObject({
      alertMin: 0.02,
      alertMax: 0.15,
      targetMin: 0.05,
      targetMax: 0.1,
    });
  });
});

describe("parseAdminPepiteRow", () => {
  it("lit une pépite publiée avec ses montants et ses critères en clair", () => {
    const parsed = parseAdminPepiteRow(row);

    expect(parsed).toMatchObject({
      saleId: "sale-1",
      category: "pepite",
      title: "Appartement 3 pièces",
      city: "Bordeaux",
      venue: "tribunal",
      venueLabel: "Tribunal",
      referenceCeilingEur: 190000,
      probablePriceEur: 120000,
      rangeLowEur: 96000,
      rangeHighEur: 160000,
      chanceShare: 0.74,
      costRatio: 0.58,
      startingPriceEur: 80000,
      href: "/sales/sale-1",
    });
    expect(parsed?.passed.join(" ")).toContain("Coût d'achat estimé nettement sous la valeur");
    expect(parsed?.passed.join(" ")).toContain("ventes comparables");
    expect(parsed?.stability).toEqual(["Publiée : 2 évaluations favorables consécutives"]);
    expect(parsed?.missed).toEqual([]);
  });

  it("distingue, pour « aucun risque d'inondation élevé », ce que le verdict enregistré veut dire", () => {
    const withFlood = (flood: Record<string, unknown> | undefined) =>
      parseAdminPepiteRow({
        ...row,
        reason_codes: ["pass:no_high_flood_risk", "pass:flood_risk_known"],
        details: { ...(row.details as Record<string, unknown>), flood },
      })?.passed.find(
        (label) =>
          !label.startsWith("Risque d’inondation contrôlé") && /inondation|PPRi|TRI/.test(label),
      ) ?? "";

    const noneFound = withFlood({ verdict: "none_found", ppriChecked: true });
    expect(noneFound).toMatch(/TRI et périmètres de PPRi consultés/);
    const triOnly = withFlood({ verdict: "none_found", ppriChecked: false });
    expect(triOnly).toMatch(/périmètres de PPRi non lus/);
    const exposed = withFlood({ verdict: "exposed", ppriChecked: true });
    expect(exposed).toMatch(/Dans le périmètre d’un PPRi/);
    expect(exposed).toMatch(/zonage à vérifier/);
    const noSignal = withFlood({ verdict: "no_signal", ppriChecked: true });
    expect(noSignal).toMatch(/Position imprécise dans une commune sans TRI/);
    // Quatre libellés différents ; sans verdict enregistré, le libellé générique.
    expect(new Set([noneFound, triOnly, exposed, noSignal]).size).toBe(4);
    expect(withFlood(undefined)).toBe("Aucun risque d’inondation élevé identifié");
  });

  it("lit le DPE, le coût énergétique, le marché local et les badges du détail (pepite-v1.2)", () => {
    const parsed = parseAdminPepiteRow({
      ...row,
      reason_codes: [
        "pass:size_value_supported",
        "pass:market_liquid",
        "fail:market_not_declining",
        "fail:no_copro_distress",
      ],
      details: {
        ...(row.details as Record<string, unknown>),
        dpeClass: "G",
        energyRenovationEur: 24_000,
        market: {
          propertyType: "Maison",
          aggregateAbsent: false,
          sales12Months: 41,
          trendEvaluated: true,
          declinePct: 18.5,
        },
        badges: [{ key: "double_exit", label: "Double sortie" }, { key: "x" }, null],
      },
    });
    expect(parsed).toMatchObject({
      dpeClass: "G",
      energyRenovationEur: 24_000,
      badges: ["Double sortie"],
      marketNote:
        "Marché local (Maison) : 41 ventes sur 12 mois, prix médian au m² en baisse de 18.5 % en 3 ans",
    });
    expect(parsed?.passed.some((label) => /au plus 250 m² habitables/.test(label))).toBe(true);
    expect(parsed?.passed.some((label) => /Marché local liquide/.test(label))).toBe(true);
    expect(parsed?.missed.some((label) => /baisse de plus de 15 %/.test(label))).toBe(true);
    expect(parsed?.missed.some((label) => /Copropriété en difficulté/.test(label))).toBe(true);
  });

  it("note l'absence de DPE, de marché et de badge pour une évaluation d'une version antérieure", () => {
    const parsed = parseAdminPepiteRow(row);
    expect(parsed).toMatchObject({
      dpeClass: null,
      energyRenovationEur: null,
      marketNote: null,
      badges: [],
    });
    const absent = parseAdminPepiteRow({
      ...row,
      details: {
        ...(row.details as Record<string, unknown>),
        market: { propertyType: "Maison", aggregateAbsent: true },
      },
    });
    expect(absent?.marketNote).toBe(
      "Marché local : aucune donnée DVF pour la commune (Maison), critères réussis faute de donnée",
    );
  });

  it("classe : publiée, à confirmer, presque pépite", () => {
    expect(parseAdminPepiteRow({ ...row, is_pepite: false, status: "pepite" })?.category).toBe(
      "pending",
    );
    expect(parseAdminPepiteRow({ ...row, is_pepite: false, status: "not_pepite" })?.category).toBe(
      "near",
    );
  });

  it("lit les frais par défaut du détail et compte leur part parmi les pépites (publiées et à confirmer)", () => {
    const withDefault = parseAdminPepiteRow({
      ...row,
      details: { ...row.details, feesDefault: true },
    });
    const read = parseAdminPepiteRow({ ...row, details: { ...row.details, feesDefault: false } });
    const pending = parseAdminPepiteRow({
      ...row,
      sale_id: "sale-3",
      is_pepite: false,
      status: "pepite",
      details: { ...row.details, feesDefault: true },
    });
    const near = parseAdminPepiteRow({
      ...row,
      sale_id: "sale-4",
      is_pepite: false,
      status: "not_pepite",
      details: { ...row.details, feesDefault: true },
    });
    expect(withDefault?.feesDefault).toBe(true);
    expect(read?.feesDefault).toBe(false);
    expect(parseAdminPepiteRow(row)?.feesDefault).toBe(false);
    const rows = [withDefault, read, pending, near].filter((item) => item != null);
    // Une presque pépite n'entre pas dans la part : elle n'est pas publiée.
    expect(pepiteFeesDefaultStat(rows)).toEqual({ pepites: 3, withDefaultFees: 2, share: 2 / 3 });
    expect(pepiteFeesDefaultStat([])).toEqual({ pepites: 0, withDefaultFees: 0, share: null });
  });

  it("écrit le critère manqué en clair", () => {
    const parsed = parseAdminPepiteRow({
      ...row,
      is_pepite: false,
      status: "not_pepite",
      reason_codes: ["pass:test_c_cost", "fail:gap_significant"],
    });
    expect(parsed?.missed).toHaveLength(1);
    expect(parsed?.missed[0]).toContain("Écart aberrant");
  });

  it("ignore un code inconnu d'une autre version de la règle et un détail illisible", () => {
    const parsed = parseAdminPepiteRow({
      ...row,
      reason_codes: ["pass:critere_futur", "fail:autre", "pass:test_c_cost", 42],
      details: "pas un objet",
    });
    expect(parsed?.passed).toHaveLength(1);
    expect(parsed?.missed).toEqual([]);
    expect(parsed?.referenceCeilingEur).toBeNull();
  });

  it("refuse une ligne sans identifiant de vente", () => {
    expect(parseAdminPepiteRow({ ...row, sale_id: null })).toBeNull();
    expect(parseAdminPepiteRow("x")).toBeNull();
  });

  it("un type de vente inconnu est « autre »", () => {
    expect(parseAdminPepiteRow({ ...row, venue: "state" })?.venue).toBe("other");
  });
});

describe("computePepiteIndependence", () => {
  const sponsored = {
    id: "lawyer-sponsored",
    display_name: "Jean Dupont",
    bar_association: "Barreau de Bordeaux",
    paid_placement_status: "active",
    paid_placement_starts_at: null,
    paid_placement_ends_at: null,
  };
  const free = {
    id: "lawyer-free",
    display_name: "Marie Martin",
    bar_association: "Barreau de Bordeaux",
    paid_placement_status: "none",
    paid_placement_starts_at: null,
    paid_placement_ends_at: null,
  };

  function sale(id: string, lawyerName: string | null) {
    return {
      id,
      lawyer_name: lawyerName,
      tribunal: "Tribunal judiciaire de Bordeaux",
      sale_date: "2026-12-15T10:00:00Z",
    };
  }

  type Evaluation = { sale_id: string; status: string; is_pepite: boolean };

  /**
   * La réponse de `admin_pepite_independence_sales` pour ces évaluations et ces ventes : les deux effectifs sur toutes
   * les ventes évaluables, et les champs de rapprochement des SEULES ventes dont l'avocat poursuivant est nommé
   * (migration 20261108110300).
   */
  function setIndependence(evaluations: Evaluation[], sales: Array<ReturnType<typeof sale>>) {
    const evaluable = evaluations.filter(
      (evaluation) => evaluation.status === "pepite" || evaluation.status === "not_pepite",
    );
    const pending = (evaluation: Evaluation) =>
      evaluation.status === "pepite" && !evaluation.is_pepite;
    mocks.independence = {
      error: null,
      data: {
        evaluable: evaluable.length,
        pepites: evaluable.filter((evaluation) => evaluation.is_pepite || pending(evaluation))
          .length,
        sales: evaluable.flatMap((evaluation) => {
          const found = sales.find((candidate) => candidate.id === evaluation.sale_id);
          if (!found || found.lawyer_name == null) return [];
          return [{ ...found, is_pepite: evaluation.is_pepite, pending: pending(evaluation) }];
        }),
      },
    };
  }

  it("compare la part des pépites sponsorisées à celle de l'ensemble des ventes évaluées", async () => {
    // 10 ventes évaluables : 4 d'un avocat sponsorisé, 2 d'un avocat non sponsorisé, 4 sans avocat rapproché.
    // Les 2 pépites sont toutes deux d'un avocat sponsorisé.
    setIndependence(
      [
        { sale_id: "s1", status: "pepite", is_pepite: true },
        { sale_id: "s2", status: "pepite", is_pepite: true },
        ...["s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10"].map((sale_id) => ({
          sale_id,
          status: "not_pepite",
          is_pepite: false,
        })),
      ],
      [
        sale("s1", "Jean Dupont"),
        sale("s2", "DUPONT Jean"),
        sale("s3", "Jean Dupont"),
        sale("s4", "Jean Dupont"),
        sale("s5", "Marie Martin"),
        sale("s6", "Marie Martin"),
        sale("s7", null),
        sale("s8", "SCP Dupont et associés"),
        sale("s9", "Me Dupont"),
        sale("s10", "Paul Durand"),
      ],
    );
    mocks.tables.referenced_lawyers = { error: null, rows: [sponsored, free] };

    const result = await computePepiteIndependence(NOW);

    expect(result).toMatchObject({
      evaluatedSales: 10,
      evaluatedSponsored: 4,
      pepiteSales: 2,
      pepiteSponsored: 2,
      alertPoints: INDEPENDENCE_ALERT_POINTS,
    });
    expect(result.evaluatedShare).toBeCloseTo(0.4, 6);
    expect(result.pepiteShare).toBeCloseTo(1, 6);
    expect(result.gapPoints).toBeCloseTo(60, 6);
    // Moins de 10 pépites : l'échantillon ne permet pas d'alerter.
    expect(result.alert).toBe(false);
  });

  it("une seule fonction agrégée remplace les lectures par pages et par tranches d'identifiants", async () => {
    setIndependence(
      [{ sale_id: "s1", status: "pepite", is_pepite: true }],
      [sale("s1", "Jean Dupont")],
    );
    mocks.tables.referenced_lawyers = { error: null, rows: [sponsored] };

    await computePepiteIndependence(NOW);

    expect(mocks.independenceCalls).toBe(1);
    // Ni les évaluations ni les ventes ne sont plus lues table par table : seuls les avocats le sont.
    expect(mocks.reads).toEqual(["referenced_lawyers"]);
  });

  it("alerte quand la part des pépites dépasse celle de l'ensemble d'au moins 10 points, sur 10 pépites", async () => {
    const ids = Array.from({ length: 30 }, (_, index) => `s${index}`);
    setIndependence(
      ids.map((sale_id, index) => ({
        sale_id,
        status: index < 10 ? "pepite" : "not_pepite",
        is_pepite: index < 10,
      })),
      ids.map((id, index) =>
        sale(id, index < 6 || (index >= 10 && index < 13) ? "Jean Dupont" : null),
      ),
    );
    mocks.tables.referenced_lawyers = { error: null, rows: [sponsored] };

    const result = await computePepiteIndependence(NOW);

    // Pépites : 6 sur 10 sponsorisées (60 %) ; ensemble : 9 sur 30 (30 %).
    expect(result).toMatchObject({ evaluatedSponsored: 9, pepiteSponsored: 6, pepiteSales: 10 });
    expect(result.gapPoints).toBeCloseTo(30, 6);
    expect(result.alert).toBe(true);
  });

  it("une période de sponsoring terminée ou pas encore commencée ne compte pas", async () => {
    setIndependence(
      [
        { sale_id: "s1", status: "pepite", is_pepite: true },
        { sale_id: "s2", status: "not_pepite", is_pepite: false },
      ],
      [sale("s1", "Jean Dupont"), sale("s2", "Jean Dupont")],
    );
    for (const placement of [
      { paid_placement_ends_at: "2026-10-01T00:00:00Z" },
      { paid_placement_starts_at: "2026-12-01T00:00:00Z" },
    ]) {
      mocks.tables.referenced_lawyers = { error: null, rows: [{ ...sponsored, ...placement }] };
      expect((await computePepiteIndependence(NOW)).evaluatedSponsored).toBe(0);
    }
    mocks.tables.referenced_lawyers = {
      error: null,
      rows: [
        {
          ...sponsored,
          paid_placement_status: "trial",
          paid_placement_ends_at: "2026-12-01T00:00:00Z",
        },
      ],
    };
    expect((await computePepiteIndependence(NOW)).evaluatedSponsored).toBe(2);
  });

  it("une pépite à confirmer compte parmi les pépites, une pas pépite non", async () => {
    setIndependence(
      [
        { sale_id: "s1", status: "pepite", is_pepite: false },
        { sale_id: "s2", status: "not_pepite", is_pepite: false },
        { sale_id: "s3", status: "insufficient", is_pepite: false },
      ],
      [sale("s1", "Jean Dupont"), sale("s2", "Jean Dupont"), sale("s3", "Jean Dupont")],
    );
    mocks.tables.referenced_lawyers = { error: null, rows: [sponsored] };

    const result = await computePepiteIndependence(NOW);

    expect(result).toMatchObject({
      evaluatedSales: 2,
      evaluatedSponsored: 2,
      pepiteSales: 1,
      pepiteSponsored: 1,
    });
  });

  it("sans vente évaluable : aucune part, et les avocats ne sont même pas lus", async () => {
    const result = await computePepiteIndependence(NOW);
    expect(result).toMatchObject({
      evaluatedSales: 0,
      evaluatedShare: null,
      pepiteShare: null,
      alert: false,
    });
    expect(mocks.independenceCalls).toBe(1);
    expect(mocks.reads).toEqual([]);
  });

  it("une erreur de la fonction d'indépendance lève (la page affichera « non mesuré »)", async () => {
    mocks.independence = { data: null, error: { code: "PGRST202", message: "absente" } };
    await expect(computePepiteIndependence(NOW)).rejects.toMatchObject({ code: "PGRST202" });
  });
});

describe("getAdminPepites", () => {
  function rpcAnswer(overrides: Row = {}) {
    return {
      data: {
        generated_at: "2026-11-01T12:00:00Z",
        mode: "shadow",
        counters,
        rows: [row],
        ...overrides,
      },
      error: null,
    };
  }

  it("refuse un compte qui n'est pas administrateur, sans rien lire", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: false });

    await expect(getAdminPepites("jeton", NOW)).rejects.toThrow(/administrateur/);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.reads).toEqual([]);
  });

  it("refuse un jeton invalide", async () => {
    mocks.requireAuth.mockRejectedValue(new Error("Unauthorized"));

    await expect(getAdminPepites("jeton", NOW)).rejects.toThrow("Unauthorized");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rend le mode, les compteurs par type, les totaux, le taux, la liste et le contrôle d'indépendance", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: true });
    mocks.rpc.mockResolvedValue(rpcAnswer());

    const result = await getAdminPepites("jeton", NOW);

    expect(mocks.requireAuth).toHaveBeenCalledWith("jeton");
    expect(mocks.rpc).toHaveBeenCalledWith("admin_list_sale_pepites", {
      p_now: NOW.toISOString(),
      p_limit: 300,
    });
    expect(result.migrated).toBe(true);
    expect(result.mode).toBe("shadow");
    expect(result.ruleVersion).toBe("pepite-v1.2");
    expect(result.counters.map((counter) => counter.venue)).toEqual([
      "tribunal",
      "notary",
      "other",
    ]);
    expect(result.counters[0]).toMatchObject({
      label: "Tribunal",
      evaluated: 40,
      pepites: 3,
      pending: 1,
      notPepite: 30,
      insufficient: 6,
      evaluable: 34,
      onlyGapGuard: 12,
    });
    expect(result.totals).toEqual({
      evaluated: 55,
      pepites: 4,
      pending: 1,
      notPepite: 38,
      notApplicable: 5,
      insufficient: 7,
      evaluable: 43,
      onlyGapGuard: 12,
    });
    // 4 pépites publiées + 1 à confirmer sur 43 ventes évaluables.
    expect(result.rate.share).toBeCloseTo(5 / 43, 6);
    expect(result.rate.alert).toBeNull();
    expect(result.rows).toHaveLength(1);
    expect(result.independence).toMatchObject({ evaluatedSales: 0 });
  });

  describe("ventes d'inondation en attente de réobservation", () => {
    const answerByName = (counter: unknown) =>
      mocks.rpc.mockImplementation(async (name: string) =>
        name === "admin_count_flood_reobservation_pending" ? counter : rpcAnswer(),
      );

    it("lit le nombre par la fonction du compteur (jamais la table d'inondation)", async () => {
      mocks.requireAuth.mockResolvedValue({ isAdmin: true });
      mocks.tables.auction_sale_pepites = { error: null, rows: [] };
      answerByName({ data: 531, error: null });

      const result = await getAdminPepites("jeton", NOW);

      expect(mocks.rpc).toHaveBeenCalledWith("admin_count_flood_reobservation_pending", {
        p_now: NOW.toISOString(),
      });
      expect(result.floodReobservationPending).toBe(531);
      expect(mocks.reads).not.toContain("auction_sale_flood_risk");
    });

    it.each([
      [
        "fonction absente (migration en retard)",
        { data: null, error: { code: "PGRST202", message: "absente" } },
      ],
      ["erreur de la base", { data: null, error: { code: "XX000", message: "boom" } }],
      ["réponse inattendue", { data: { pas: "un nombre" }, error: null }],
    ])("%s : non mesuré, la page s'affiche quand même", async (_label, answer) => {
      mocks.requireAuth.mockResolvedValue({ isAdmin: true });
      mocks.tables.auction_sale_pepites = { error: null, rows: [] };
      answerByName(answer);

      const result = await getAdminPepites("jeton", NOW);

      expect(result.floodReobservationPending).toBeNull();
      expect(result.rows).toHaveLength(1);
    });

    it("une exception du client est aussi « non mesuré »", async () => {
      mocks.requireAuth.mockResolvedValue({ isAdmin: true });
      mocks.tables.auction_sale_pepites = { error: null, rows: [] };
      mocks.rpc.mockImplementation(async (name: string) => {
        if (name === "admin_count_flood_reobservation_pending") throw new Error("réseau");
        return rpcAnswer();
      });

      expect((await getAdminPepites("jeton", NOW)).floodReobservationPending).toBeNull();
    });
  });

  it("une lecture du contrôle d'indépendance en échec ne fait pas tomber la page", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: true });
    mocks.rpc.mockResolvedValue(rpcAnswer());
    mocks.independence = { data: null, error: { message: "lecture impossible" } };

    const result = await getAdminPepites("jeton", NOW);

    expect(result.independence).toBeNull();
    expect(result.rows).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("lecture impossible");
  });

  it("lance le contrôle d'indépendance en même temps que la liste, sans l'attendre", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: true });
    let release: (value: unknown) => void = () => {};
    mocks.rpc.mockReturnValue(new Promise((resolve) => (release = resolve)));

    const pending = getAdminPepites("jeton", NOW);
    // La liste n'a pas répondu, et la lecture du contrôle est déjà partie.
    await vi.waitFor(() => expect(mocks.independenceCalls).toBe(1));
    expect(mocks.rpc).toHaveBeenCalledTimes(1);

    release(rpcAnswer());
    expect((await pending).independence).toMatchObject({ evaluatedSales: 0 });
  });

  it("un contrôle d'indépendance trop long est « non mesuré », la page s'affiche quand même", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: true });
    mocks.rpc.mockResolvedValue(rpcAnswer());
    mocks.hang = true;

    const result = await getAdminPepites("jeton", NOW, { independenceBudgetMs: 30 });

    expect(result.independence).toBeNull();
    expect(result.rows).toHaveLength(1);
    expect(result.mode).toBe("shadow");
  });

  it("le contrôle d'indépendance s'arrête quand le délai de la route est dépassé", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(computePepiteIndependence(NOW, controller.signal)).rejects.toThrow(/délai/);
  });

  it("avant la migration (fonction absente) : « pas migré », sans erreur", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: true });
    for (const code of ["PGRST202", "42883", "PGRST205", "42P01"]) {
      mocks.rpc.mockResolvedValue({ data: null, error: { code, message: "absent" } });
      expect(await getAdminPepites("jeton", NOW)).toEqual(unavailablePepites());
    }
    expect(unavailablePepites()).toMatchObject({
      migrated: false,
      mode: "unknown",
      rows: [],
      independence: null,
      floodReobservationPending: null,
    });
  });

  it("une autre erreur de la base lève", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: true });
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });

    await expect(getAdminPepites("jeton", NOW)).rejects.toMatchObject({ message: "boom" });
  });

  it("un mode inconnu de la base vaut « unknown »", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: true });
    mocks.rpc.mockResolvedValue(rpcAnswer({ mode: "peut-etre" }));

    expect((await getAdminPepites("jeton", NOW)).mode).toBe("unknown");
  });
});

describe("suspendAdminPepites", () => {
  beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => undefined));

  it("refuse un compte qui n'est pas administrateur, sans rien appeler", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: false, userId: "u" });

    await expect(suspendAdminPepites("jeton")).rejects.toThrow(/administrateur/);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("repasse en shadow par défaut et consigne l'administrateur", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: true, userId: "admin-1" });
    mocks.rpc.mockResolvedValue({ data: "shadow", error: null });

    expect(await suspendAdminPepites("jeton")).toEqual({ mode: "shadow" });
    expect(mocks.rpc).toHaveBeenCalledWith("suspend_sale_pepites", {
      p_mode: "shadow",
      p_user_id: "admin-1",
    });
  });

  it("accepte « off » et rend le mode obtenu, « on » si rien n'a changé n'étant jamais une ouverture", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: true, userId: "admin-1" });
    mocks.rpc.mockResolvedValue({ data: "off", error: null });
    expect(await suspendAdminPepites("jeton", { mode: "off" })).toEqual({ mode: "off" });
    // Un mode « on » ne peut pas être demandé.
    await expect(suspendAdminPepites("jeton", { mode: "on" } as never)).rejects.toThrow();
  });

  it("lève sur une erreur de la base", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: true, userId: "admin-1" });
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });

    await expect(suspendAdminPepites("jeton")).rejects.toMatchObject({ message: "boom" });
  });

  describe("expiration des caches après l'arrêt d'urgence", () => {
    beforeEach(() => {
      mocks.revalidateTag.mockReset();
      mocks.revalidatePath.mockReset();
      mocks.requireAuth.mockResolvedValue({ isAdmin: true, userId: "admin-1" });
    });

    it("expire la liste publique, les lectures de chaque fiche et les pages des fiches", async () => {
      mocks.rpc.mockResolvedValue({ data: "shadow", error: null });

      await suspendAdminPepites("jeton");

      expect(mocks.revalidateTag).toHaveBeenCalledWith("public-catalogue", { expire: 0 });
      expect(mocks.revalidateTag).toHaveBeenCalledWith("public-sales", { expire: 0 });
      expect(mocks.revalidatePath).toHaveBeenCalledWith("/sales/[id]", "page");
    });

    it("n'expire rien quand l'arrêt échoue ou n'est pas permis", async () => {
      mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
      await expect(suspendAdminPepites("jeton")).rejects.toBeDefined();
      mocks.requireAuth.mockResolvedValue({ isAdmin: false, userId: "u" });
      await expect(suspendAdminPepites("jeton")).rejects.toBeDefined();
      expect(mocks.revalidateTag).not.toHaveBeenCalled();
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    });

    it("un échec de l'expiration (hors requête) ne défait pas l'arrêt déjà enregistré", async () => {
      mocks.rpc.mockResolvedValue({ data: "shadow", error: null });
      mocks.revalidateTag.mockImplementation(() => {
        throw new Error("hors requête");
      });
      vi.spyOn(console, "warn").mockImplementation(() => undefined);

      await expect(suspendAdminPepites("jeton")).resolves.toEqual({ mode: "shadow" });
    });
  });
});
