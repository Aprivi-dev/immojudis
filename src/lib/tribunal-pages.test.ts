import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DepartmentSale } from "@/lib/department-pages";
import {
  mapPublicTribunalActivity,
  type PublicTribunalActivity,
} from "@/lib/public-tribunal-activity";
import {
  TRIBUNAL_PAGE_LISTED_SALES,
  atTribunalPhrase,
  hasReadableTribunalName,
  indexableTribunalPages,
  emptyTribunalActivity,
  isTribunalPageIndexable,
  knownTribunalFromSlug,
  legacyTribunalPages,
  legacyTribunalRedirectPath,
  nextAudienceDate,
  normalizeTribunalSlug,
  tribunalActivityWithoutDuplicates,
  tribunalCodeSlug,
  tribunalLongName,
  tribunalPageDescription,
  tribunalPageFromSlug,
  tribunalPagePath,
  tribunalPages,
  tribunalPageTitle,
  tribunalPlaceName,
  tribunalSlugBase,
} from "./tribunal-pages";

function court(
  searchName: string,
  overrides: Partial<PublicTribunalActivity> = {},
): PublicTribunalActivity {
  const [activity] = mapPublicTribunalActivity([
    {
      tribunal_code: overrides.code ?? `code-${searchName}`,
      tribunal_name: searchName,
      tribunal_city: null,
      department: overrides.department ?? "33",
      upcoming_count: 5,
      next_sale_date: overrides.nextSaleDate ?? null,
      median_starting_price_eur: overrides.medianStartingPriceEur ?? null,
      house_count: 1,
      apartment_count: 1,
      other_count: 0,
    },
  ]);
  return { ...activity, upcomingCount: 5, ...overrides };
}

describe("tribunalSlugBase", () => {
  it.each([
    ["TJ Bobigny", "bobigny"],
    ["TJ Tribunal judiciaire du Puy-en-Velay", "le-puy-en-velay"],
    ["Tribunal judiciaire du Mans", "le-mans"],
    ["TJ Le Havre", "le-havre"],
    ["TJ Les Sables-d'Olonne", "les-sables-d-olonne"],
    ["TJ Évry-Courcouronnes", "evry-courcouronnes"],
    ["TJ Saint-Étienne", "saint-etienne"],
    ["TJ Aix-en-Provence", "aix-en-provence"],
    ["Tribunal de première instance de Papeete", "papeete"],
    ["Tribunal de première instance de Saint-Pierre-et-Miquelon", "saint-pierre-et-miquelon"],
    ["TJ Châlons-en-Champagne", "chalons-en-champagne"],
  ])("%s → %s", (name, slug) => {
    expect(tribunalSlugBase(name)).toBe(slug);
  });

  it("n'a ni majuscule, ni accent, ni apostrophe, ni tiret double", () => {
    for (const name of [
      "TJ Villefranche-sur-Saône",
      "TJ Mont-de-Marsan",
      "TJ Saint-Denis de la Réunion",
    ]) {
      expect(tribunalSlugBase(name)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });
});

describe("tribunalPages", () => {
  it("donne à chaque tribunal une adresse /tribunaux/<code>", () => {
    const pages = tribunalPages([
      court("TJ Bobigny", { code: "justice_tj_1_93" }),
      court("TJ Tribunal judiciaire du Puy-en-Velay", { code: "justice_tj_1_113" }),
    ]);
    expect(pages.map((page) => page.path)).toEqual([
      "/tribunaux/justice-tj-1-93",
      "/tribunaux/justice-tj-1-113",
    ]);
  });

  it("ne dépend que du code : ni l'ordre, ni les autres tribunaux, ni le nom, ni les ventes", () => {
    const bobigny = court("TJ Bobigny", { code: "justice_tj_1_93" });
    const nantes = court("TJ Nantes", { code: "justice_tj_1_114" });
    const alone = tribunalPages([bobigny])[0].path;
    expect(tribunalPages([nantes, bobigny]).find((page) => page.activity === bobigny)?.path).toBe(
      alone,
    );
    expect(tribunalPages([bobigny, nantes])[0].path).toBe(alone);
    // Le nom corrigé, ou le nombre de ventes, ne déplace pas l'adresse.
    const renamed = court("TJ Bobigny (Seine-Saint-Denis)", {
      code: "justice_tj_1_93",
      upcomingCount: 1,
    });
    expect(tribunalPages([renamed])[0].path).toBe(alone);
  });

  it("n'attribue jamais la même adresse à deux tribunaux de même nom", () => {
    const first = court("TJ Saint-Pierre", { code: "justice_tj_1_97", department: "974" });
    const second = court("Tribunal judiciaire de Saint-Pierre", {
      code: "justice_tj_1_50",
      department: "50",
    });
    expect(tribunalPages([first, second]).map((page) => page.slug)).toEqual([
      "justice-tj-1-97",
      "justice-tj-1-50",
    ]);
    // Le tribunal qui n'a plus de vente ne change pas l'adresse de l'autre.
    expect(tribunalPages([second])[0].slug).toBe("justice-tj-1-50");
  });

  it("ramène le code à des minuscules, chiffres et tirets", () => {
    for (const code of ["justice_tj_1_93", "Justice TJ 1/93", "JUSTICE-TJ-1-93"]) {
      expect(tribunalCodeSlug(code)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
    expect(tribunalCodeSlug("justice_tj_1_93")).toBe("justice-tj-1-93");
    expect(tribunalPagePath("justice_tj_1_93")).toBe("/tribunaux/justice-tj-1-93");
  });

  it("retrouve un tribunal par son adresse exacte seulement", () => {
    const items = [court("TJ Bobigny", { code: "justice_tj_1_93" })];
    expect(tribunalPageFromSlug(items, "justice-tj-1-93")?.activity.searchName).toBe("TJ Bobigny");
    expect(tribunalPageFromSlug(items, "Justice-tj-1-93")).toBeNull();
    expect(tribunalPageFromSlug(items, "justice-tj-1-93/")).toBeNull();
    expect(tribunalPageFromSlug(items, "bobigny")).toBeNull();
  });

  it("ne liste à l'indexation que les tribunaux d'au moins trois ventes", () => {
    const items = [
      court("TJ Bobigny", { code: "b", upcomingCount: 107 }),
      court("TJ Nantes", { code: "n", upcomingCount: 3 }),
      court("TJ Brest", { code: "r", upcomingCount: 2 }),
      court("TJ Foix", { code: "f", upcomingCount: 0 }),
    ];
    expect(indexableTribunalPages(items).map((page) => page.slug)).toEqual(["b", "n"]);
    expect(isTribunalPageIndexable(2)).toBe(false);
    expect(isTribunalPageIndexable(3)).toBe(true);
  });
});

describe("anciennes adresses et tribunaux sans vente", () => {
  const entry = (code: string, name: string, searchName: string, department: string) => ({
    code,
    name,
    searchName,
    city: null,
    department,
  });
  const directory = [
    entry("justice_tj_1_93", "Bobigny", "TJ Bobigny", "93"),
    entry("justice_tj_1_113", "Le Puy-en-Velay", "TJ Tribunal judiciaire du Puy-en-Velay", "43"),
    entry("justice_tj_1_97", "Saint-Pierre", "TJ Saint-Pierre", "974"),
    entry("justice_tj_1_50", "Saint-Pierre", "TJ Saint-Pierre", "50"),
  ];

  it("garde l'algorithme d'origine pour retrouver les anciennes adresses (nom, puis département)", () => {
    const pages = legacyTribunalPages([
      court("TJ Bobigny", { code: "justice_tj_1_93" }),
      court("TJ Saint-Pierre", { code: "justice_tj_1_97", department: "974" }),
      court("TJ Saint-Pierre", { code: "justice_tj_1_50", department: "50" }),
    ]);
    expect(pages.map((page) => page.slug)).toEqual([
      "bobigny",
      "saint-pierre-974",
      "saint-pierre-50",
    ]);
  });

  it("redirige l'ancienne adresse d'un tribunal à ventes vers son adresse par code", () => {
    const items = [court("TJ Bobigny", { code: "justice_tj_1_93" })];
    expect(legacyTribunalRedirectPath(items, directory, "bobigny")).toBe(
      "/tribunaux/justice-tj-1-93",
    );
  });

  it("redirige aussi l'ancienne adresse d'un tribunal sans vente, si le nom est sans ambiguïté", () => {
    expect(legacyTribunalRedirectPath([], directory, "le-puy-en-velay")).toBe(
      "/tribunaux/justice-tj-1-113",
    );
    // Deux tribunaux de même nom : aucune redirection devinée.
    expect(legacyTribunalRedirectPath([], directory, "saint-pierre")).toBeNull();
    expect(legacyTribunalRedirectPath([], directory, "atlantide")).toBeNull();
  });

  it("reconnaît un tribunal du référentiel par son adresse, et seulement elle", () => {
    expect(knownTribunalFromSlug(directory, "justice-tj-1-93")?.searchName).toBe("TJ Bobigny");
    expect(knownTribunalFromSlug(directory, "bobigny")).toBeNull();
    expect(knownTribunalFromSlug(directory, "justice-tj-9-9")).toBeNull();
  });

  it("présente un tribunal sans vente avec des chiffres à zéro et une description honnête", () => {
    const empty = emptyTribunalActivity(directory[0]);
    expect(empty).toMatchObject({ code: "justice_tj_1_93", upcomingCount: 0, nextSaleDate: null });
    expect(isTribunalPageIndexable(empty.upcomingCount)).toBe(false);
    expect(tribunalPageDescription(empty)).toBe(
      "Aucune vente judiciaire à venir au tribunal judiciaire de Bobigny pour le moment.",
    );
  });
});

describe("noms et textes", () => {
  it("n'écrit jamais le nom doublé « TJ Tribunal judiciaire … »", () => {
    const puy = court("TJ Tribunal judiciaire du Puy-en-Velay");
    expect(tribunalLongName(puy)).toBe("Tribunal judiciaire du Puy-en-Velay");
    expect(atTribunalPhrase(puy)).toBe("au tribunal judiciaire du Puy-en-Velay");
    expect(tribunalPlaceName(puy.searchName)).toBe("Le Puy-en-Velay");
    expect(tribunalPageTitle(puy)).toBe("Ventes aux enchères au tribunal du Puy-en-Velay");
    expect(tribunalPageDescription(puy)).not.toMatch(/TJ|judiciaire du tribunal/);
  });

  it("accorde l'article du lieu", () => {
    expect(tribunalLongName(court("TJ Bobigny"))).toBe("Tribunal judiciaire de Bobigny");
    expect(tribunalLongName(court("TJ Le Mans"))).toBe("Tribunal judiciaire du Mans");
    expect(tribunalLongName(court("TJ Les Sables-d'Olonne"))).toBe(
      "Tribunal judiciaire des Sables-d'Olonne",
    );
    expect(tribunalLongName(court("TJ Évry-Courcouronnes"))).toBe(
      "Tribunal judiciaire d’Évry-Courcouronnes",
    );
    expect(tribunalLongName(court("TJ La Rochelle"))).toBe("Tribunal judiciaire de La Rochelle");
    expect(tribunalLongName(court("Tribunal de première instance de Papeete"))).toBe(
      "Tribunal de première instance de Papeete",
    );
  });

  it("garde le titre à 48 caractères pour les noms du référentiel", () => {
    for (const name of [
      "TJ Saint-Denis-de-la-Réunion",
      "TJ Tribunal judiciaire du Puy-en-Velay",
      "TJ Châlons-en-Champagne",
      "TJ Villefranche-sur-Saône",
      "Tribunal de première instance de Saint-Pierre-et-Miquelon",
      "TJ Évry-Courcouronnes",
    ]) {
      expect(tribunalPageTitle(court(name)).length, name).toBeLessThanOrEqual(48);
    }
  });

  it("décrit les chiffres de la page en 158 caractères au plus", () => {
    const now = new Date("2026-10-15T08:00:00Z");
    const full = court("TJ Bobigny", {
      upcomingCount: 107,
      nextSaleDate: "2026-11-10T13:00:00Z",
      medianStartingPriceEur: 40_500,
      pricedCount: 107,
    });
    const text = tribunalPageDescription(full, now);
    expect(text).toContain("107 ventes judiciaires à venir au tribunal judiciaire de Bobigny");
    expect(text).toContain("10 novembre 2026");
    expect(text).toMatch(/40\s500\s€/);
    expect(text.length).toBeLessThanOrEqual(158);

    expect(tribunalPageDescription(court("TJ Bobigny", { upcomingCount: 1 }), now)).toBe(
      "1 vente judiciaire à venir au tribunal judiciaire de Bobigny.",
    );
    const long = court("Tribunal de première instance de Saint-Pierre-et-Miquelon", {
      upcomingCount: 12,
      nextSaleDate: "2026-11-10T13:00:00Z",
      medianStartingPriceEur: 123_456,
      pricedCount: 12,
    });
    expect(tribunalPageDescription(long, now).length).toBeLessThanOrEqual(158);
  });

  it("n'annonce pas une prochaine audience déjà passée", () => {
    const now = new Date("2026-10-15T08:00:00Z");
    const past = court("TJ Bobigny", { nextSaleDate: "2026-09-01T10:00:00Z" });
    expect(tribunalPageDescription(past, now)).not.toContain("prochaine audience");
  });
});

describe("nextAudienceDate", () => {
  const now = new Date("2026-10-15T08:00:00Z");
  const sale = (saleDate: string | null, status: DepartmentSale["status"] = "scheduled") => ({
    saleDate,
    status,
  });

  it("ignore une vente reportée, qui garde son ancienne date", () => {
    expect(
      nextAudienceDate(
        { nextSaleDate: "2026-10-20T10:00:00Z" },
        [sale("2026-10-20T10:00:00Z", "postponed"), sale("2026-12-01T10:00:00Z")],
        now,
      ),
    ).toBe("2026-12-01T10:00:00Z");
  });

  it("ignore les dates passées et choisit la plus proche des autres", () => {
    expect(
      nextAudienceDate(
        { nextSaleDate: null },
        [sale("2026-09-01T10:00:00Z"), sale("2026-12-01T10:00:00Z"), sale("2026-11-02T10:00:00Z")],
        now,
      ),
    ).toBe("2026-11-02T10:00:00Z");
  });

  it("rend null quand la liste n'a aucune audience à venir", () => {
    expect(nextAudienceDate({ nextSaleDate: "2026-11-02T10:00:00Z" }, [], now)).toBeNull();
    expect(
      nextAudienceDate({ nextSaleDate: "2026-11-02T10:00:00Z" }, [sale(null)], now),
    ).toBeNull();
  });

  it("cherche sur toutes les lignes reçues, dans n'importe quel ordre, après les ventes reportées", () => {
    const postponed = Array.from({ length: 29 }, (_, index) =>
      sale(`2026-10-${String(16 + (index % 10)).padStart(2, "0")}T10:00:00Z`, "postponed"),
    );
    expect(
      nextAudienceDate(
        { nextSaleDate: "2026-10-16T10:00:00Z" },
        [...postponed, sale("2027-01-12T10:00:00Z"), sale("2026-12-03T10:00:00Z")],
        now,
      ),
    ).toBe("2026-12-03T10:00:00Z");
  });

  it("rend null (date non connue) quand toutes les lignes reçues sont reportées", () => {
    const postponed = Array.from({ length: 30 }, () => sale("2026-10-20T10:00:00Z", "postponed"));
    expect(nextAudienceDate({ nextSaleDate: "2026-10-20T10:00:00Z" }, postponed, now)).toBeNull();
  });

  it("garde la date de l'activité publique quand la liste n'a pas pu être lue", () => {
    expect(nextAudienceDate({ nextSaleDate: "2026-11-02T10:00:00Z" }, null, now)).toBe(
      "2026-11-02T10:00:00Z",
    );
  });
});

describe("tribunalActivityWithoutDuplicates", () => {
  const listOf = (length: number) => Array.from({ length }, (_, index) => ({ index }));

  it("garde le compteur de l'activité quand la liste n'a pas été lue ou n'a aucun doublon", () => {
    const activity = { upcomingCount: 12 };
    expect(tribunalActivityWithoutDuplicates(activity, null)).toEqual({
      upcomingCount: 12,
      mayCountDuplicates: false,
    });
    expect(tribunalActivityWithoutDuplicates(activity, { status: "error" })).toMatchObject({
      upcomingCount: 12,
      mayCountDuplicates: false,
    });
    expect(
      tribunalActivityWithoutDuplicates(activity, {
        status: "ok",
        sales: listOf(12),
        received: 12,
      }),
    ).toMatchObject({ upcomingCount: 12, mayCountDuplicates: false });
  });

  it("compte la liste dédoublonnée quand elle est complète", () => {
    // 19 lignes reçues (moins que la limite de lecture) dont 4 doublons : 15 ventes.
    expect(
      tribunalActivityWithoutDuplicates(
        { upcomingCount: 19 },
        { status: "ok", sales: listOf(15), received: 19 },
      ),
    ).toEqual({ upcomingCount: 15, mayCountDuplicates: false });
  });

  it("retire les doublons vus d'une liste tronquée et prévient que le total peut en compter d'autres", () => {
    // Bobigny : 30 lignes lues (la limite) dont 11 doublons ; l'activité en compte 41.
    expect(
      tribunalActivityWithoutDuplicates(
        { upcomingCount: 41 },
        { status: "ok", sales: listOf(19), received: TRIBUNAL_PAGE_LISTED_SALES },
      ),
    ).toEqual({ upcomingCount: 30, mayCountDuplicates: true });
  });

  it("ne descend jamais sous le nombre de ventes listées", () => {
    expect(
      tribunalActivityWithoutDuplicates(
        { upcomingCount: 20 },
        { status: "ok", sales: listOf(19), received: TRIBUNAL_PAGE_LISTED_SALES },
      ).upcomingCount,
    ).toBe(19);
  });
});

describe("adresses : normalisation et unicité sur le référentiel", () => {
  /** Les codes de tribunaux du référentiel, tels que les migrations les enregistrent. */
  function referenceCodes(): string[] {
    const migrations = join(process.cwd(), "supabase", "migrations");
    const codes = new Set<string>();
    for (const file of readdirSync(migrations)) {
      if (!file.endsWith(".sql")) continue;
      const sql = readFileSync(join(migrations, file), "utf8");
      for (const [, code] of sql.matchAll(/'(justice_tj_\d+_\d+)'/g)) codes.add(code);
    }
    return [...codes].sort();
  }

  it("donne à chaque code du référentiel une adresse propre, que personne d'autre ne porte", () => {
    const codes = referenceCodes();
    // Le référentiel compte plus d'une centaine de tribunaux judiciaires : la lecture a bien eu lieu.
    expect(codes.length).toBeGreaterThan(100);
    const slugs = codes.map((code) => tribunalCodeSlug(code));
    expect(new Set(slugs).size).toBe(codes.length);
    for (const slug of slugs) expect(slug).toMatch(/^justice-tj-\d+-\d+$/);
    // Chaque adresse retrouve son tribunal, et lui seul.
    const directory = codes.map((code) => ({
      code,
      name: code,
      searchName: code,
      city: null,
      department: null,
    }));
    for (const code of codes) {
      expect(knownTribunalFromSlug(directory, tribunalCodeSlug(code))?.code).toBe(code);
    }
  });

  it("ramène une adresse mal écrite à l'adresse publiée", () => {
    expect(normalizeTribunalSlug("JUSTICE-TJ-1-210")).toBe("justice-tj-1-210");
    expect(normalizeTribunalSlug("justice_tj_1_210")).toBe("justice-tj-1-210");
    expect(normalizeTribunalSlug("Justice%5FTJ%5F1%5F210")).toBe("justice-tj-1-210");
    expect(normalizeTribunalSlug("Bobigny")).toBe("bobigny");
    expect(normalizeTribunalSlug("Évry-Courcouronnes")).toBe("evry-courcouronnes");
    // Une séquence % invalide ne lève pas.
    expect(() => normalizeTribunalSlug("%E0%A4%A")).not.toThrow();
    // L'adresse publiée est un point fixe : pas de redirection en boucle.
    expect(normalizeTribunalSlug("justice-tj-1-210")).toBe("justice-tj-1-210");
  });
});

describe("tribunal sans nom lisible (canonical_name nul)", () => {
  const unnamed = court("justice_tj_1_210", { code: "justice_tj_1_210" });

  it("n'écrit jamais le code brut comme nom", () => {
    expect(hasReadableTribunalName(unnamed)).toBe(false);
    expect(hasReadableTribunalName(court("TJ Bobigny"))).toBe(true);
    expect(tribunalPlaceName("justice_tj_1_210")).toBe("Tribunal à confirmer");
    expect(tribunalLongName(unnamed)).toBe("Tribunal judiciaire (nom à confirmer)");
    expect(atTribunalPhrase(unnamed)).toBe("au tribunal judiciaire (nom à confirmer)");
    for (const text of [
      tribunalPageTitle(unnamed),
      tribunalPageDescription(unnamed),
      tribunalLongName(unnamed),
      unnamed.name,
    ]) {
      expect(text).not.toContain("justice_tj");
    }
  });

  it("sort de la liste des pages indexables, même au-dessus du seuil", () => {
    const named = court("TJ Bobigny", { code: "justice_tj_1_93", upcomingCount: 12 });
    const items = [{ ...unnamed, upcomingCount: 12 }, named];
    expect(indexableTribunalPages(items).map((page) => page.activity.code)).toEqual([
      "justice_tj_1_93",
    ]);
  });
});

describe("tribunalPageTitle : « Ventes aux enchères au tribunal de X »", () => {
  it("nomme le tribunal dans le titre", () => {
    expect(tribunalPageTitle(court("TJ Bordeaux"))).toBe(
      "Ventes aux enchères au tribunal de Bordeaux",
    );
    expect(tribunalPageTitle(court("TJ Le Mans"))).toBe("Ventes aux enchères au tribunal du Mans");
  });

  it("se réduit pour un nom long plutôt que de dépasser 48 caractères", () => {
    expect(tribunalPageTitle(court("TJ Saint-Denis-de-la-Réunion"))).toBe(
      "Ventes aux enchères : Saint-Denis-de-la-Réunion",
    );
    for (const name of [
      "TJ Saint-Denis-de-la-Réunion",
      "TJ Villefranche-sur-Saône",
      "TJ Châlons-en-Champagne",
      "TJ Évry-Courcouronnes",
      "Tribunal de première instance de Saint-Pierre-et-Miquelon",
    ]) {
      const title = tribunalPageTitle(court(name));
      expect(title.length, name).toBeLessThanOrEqual(48);
      expect(title.startsWith("Ventes aux enchères"), name).toBe(true);
    }
  });
});
