import { describe, expect, it } from "vitest";
import {
  HEARINGS_RPC_DAYS,
  HEARINGS_WINDOW_DAYS,
  dedupeHearings,
  hearingsPageDescription,
  isHearingsPageIndexable,
  mapHearingRows,
  windowHearings,
  type PublicHearing,
  type UpcomingHearingRow,
} from "./upcoming-hearings";

/** Mardi 20 octobre 2026, 10 h à Paris (heure d'été). */
const NOW = new Date("2026-10-20T08:00:00Z");

function row(overrides: Partial<UpcomingHearingRow> = {}): UpcomingHearingRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    sale_date: "2026-10-22T12:00:00Z",
    date_only: false,
    property_type: "apartment",
    city: "Bobigny",
    department: "93",
    tribunal_code: "bobigny",
    tribunal_name: "TJ Bobigny",
    tribunal_city: "Bobigny",
    starting_price_eur: "40500",
    total_count: 1,
    ...overrides,
  };
}

function hearing(overrides: Partial<UpcomingHearingRow> = {}): PublicHearing {
  return mapHearingRows([row(overrides)])[0];
}

describe("mapHearingRows", () => {
  it("lit la date, le jour et l'heure à Paris", () => {
    const mapped = hearing({ sale_date: "2026-10-22T12:00:00Z" });
    expect(mapped.dayKey).toBe("2026-10-22");
    expect(mapped.time).toBe("14 h 00");
    expect(mapped.startingPriceEur).toBe(40_500);
    expect(mapped.tribunalLabel).toBe("Tribunal judiciaire de Bobigny");
  });

  it("date du jour de Paris une audience tardive en UTC", () => {
    expect(hearing({ sale_date: "2026-10-21T22:30:00Z" }).dayKey).toBe("2026-10-22");
  });

  it("n'invente aucune heure quand elle n'est pas connue", () => {
    const mapped = hearing({ date_only: true, sale_date: "2026-10-21T22:00:00Z" });
    expect(mapped.time).toBeNull();
    expect(mapped.dayKey).toBe("2026-10-22");
  });

  it("nomme le tribunal sans le nom doublé du référentiel", () => {
    expect(hearing({ tribunal_name: "TJ Tribunal judiciaire du Puy-en-Velay" }).tribunalLabel).toBe(
      "Tribunal judiciaire du Puy-en-Velay",
    );
  });

  it("écarte une ligne sans date lisible ou sans tribunal", () => {
    expect(
      mapHearingRows([
        row({ sale_date: null }),
        row({ sale_date: "pas une date" }),
        row({ tribunal_code: null, tribunal_name: null }),
      ]),
    ).toEqual([]);
  });

  it("regroupe par le nom du tribunal quand le code manque", () => {
    expect(hearing({ tribunal_code: null }).tribunalKey).toBe("TJ Bobigny");
    expect(hearing({ tribunal_code: null }).tribunalCode).toBeNull();
  });

  it("ne laisse sortir aucune adresse", () => {
    const mapped = hearing() as Record<string, unknown>;
    const withPrivate = mapHearingRows([
      { ...row(), address: "1 rue Privée", latitude: 48.9 } as UpcomingHearingRow,
    ])[0] as Record<string, unknown>;
    expect(Object.keys(withPrivate).sort()).toEqual(Object.keys(mapped).sort());
    expect(JSON.stringify(withPrivate)).not.toContain("Privée");
  });
});

describe("dedupeHearings", () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  it("ne garde qu'une fois la même vente publiée par deux sources (tribunal, jour, mise à prix)", () => {
    const kept = dedupeHearings(
      mapHearingRows([
        row({ id: id(2), sale_date: "2026-10-22T12:00:00Z" }),
        row({ id: id(1), sale_date: "2026-10-22T12:00:00Z" }),
        row({ id: id(3), sale_date: "2026-10-22T07:00:00Z" }),
      ]),
    );
    // La plus tôt dans la journée est gardée.
    expect(kept.map((item) => item.id)).toEqual([id(3)]);
  });

  it("à égalité d'heure, garde la plus petite identité", () => {
    const kept = dedupeHearings(mapHearingRows([row({ id: id(2) }), row({ id: id(1) })]));
    expect(kept.map((item) => item.id)).toEqual([id(1)]);
  });

  it("garde deux ventes qui diffèrent par le prix, le jour ou le tribunal", () => {
    const kept = dedupeHearings(
      mapHearingRows([
        row({ id: id(1) }),
        row({ id: id(2), starting_price_eur: 41_000 }),
        row({ id: id(3), sale_date: "2026-10-23T12:00:00Z" }),
        row({ id: id(4), tribunal_code: "paris", tribunal_name: "TJ Paris" }),
      ]),
    );
    expect(kept).toHaveLength(4);
  });

  it("garde les ventes sans mise à prix chiffrée : rien ne dit que c'est la même", () => {
    const kept = dedupeHearings(
      mapHearingRows([
        row({ id: id(1), starting_price_eur: null }),
        row({ id: id(2), starting_price_eur: null }),
        row({ id: id(3), starting_price_eur: 0 }),
        row({ id: id(4), starting_price_eur: 0 }),
      ]),
    );
    expect(kept).toHaveLength(4);
  });
});

describe("windowHearings", () => {
  function at(day: string, hour = 12, extra: Partial<UpcomingHearingRow> = {}) {
    return hearing({ sale_date: `${day}T${String(hour).padStart(2, "0")}:00:00Z`, ...extra });
  }

  it("sépare les 7 premiers jours (aujourd'hui compris) du 8e au 30e jour", () => {
    const windows = windowHearings(
      [
        at("2026-10-20"), // aujourd'hui : 1er jour
        at("2026-10-26"), // 7e jour
        at("2026-10-27"), // 8e jour
        at("2026-11-18"), // 30e jour
      ],
      NOW,
    );
    expect(windows.week.map((day) => day.dayKey)).toEqual(["2026-10-20", "2026-10-26"]);
    expect(windows.weekCount).toBe(2);
    expect(windows.later.map((day) => day.dayKey)).toEqual(["2026-10-27", "2026-11-18"]);
    expect(windows.laterCount).toBe(2);
  });

  it("laisse de côté hier et le 31e jour", () => {
    const windows = windowHearings([at("2026-10-19"), at("2026-11-19"), at("2026-12-01")], NOW);
    expect(windows.weekCount + windows.laterCount).toBe(0);
    expect(HEARINGS_WINDOW_DAYS).toBe(30);
    expect(HEARINGS_RPC_DAYS).toBe(29);
  });

  it("groupe par jour puis par tribunal, dans l'ordre des jours, des noms puis des heures", () => {
    const windows = windowHearings(
      [
        at("2026-10-22", 13, { id: "b", city: "Pantin" }),
        at("2026-10-21", 9, { id: "z", tribunal_code: "paris", tribunal_name: "TJ Paris" }),
        at("2026-10-22", 8, { id: "a", city: "Bobigny", starting_price_eur: 1 }),
        at("2026-10-22", 8, { id: "c", tribunal_code: "creteil", tribunal_name: "TJ Créteil" }),
      ],
      NOW,
    );
    expect(windows.week.map((day) => [day.dayKey, day.count])).toEqual([
      ["2026-10-21", 1],
      ["2026-10-22", 3],
    ]);
    const day22 = windows.week[1];
    expect(day22.tribunals.map((group) => group.label)).toEqual([
      "Tribunal judiciaire de Bobigny",
      "Tribunal judiciaire de Créteil",
    ]);
    expect(day22.tribunals[0].hearings.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("compte « aujourd'hui » à Paris, pas en UTC", () => {
    // 23 h 30 à Paris le 20 octobre = 21 h 30 UTC : toujours le 20 pour un visiteur en France.
    const lateEvening = new Date("2026-10-20T21:30:00Z");
    const windows = windowHearings([at("2026-10-20", 21)], lateEvening);
    expect(windows.weekCount).toBe(1);
    // Une minute plus tard il est minuit à Paris : le 21.
    const afterMidnight = new Date("2026-10-20T22:30:00Z");
    expect(windowHearings([at("2026-10-20", 21)], afterMidnight).weekCount).toBe(0);
  });
});

describe("page : seuil et description", () => {
  it("n'est indexable qu'à partir de trois audiences", () => {
    expect(isHearingsPageIndexable(2)).toBe(false);
    expect(isHearingsPageIndexable(3)).toBe(true);
  });

  it("décrit les chiffres de la page en 158 caractères au plus", () => {
    expect(hearingsPageDescription(5, 40)).toBe(
      "45 audiences de ventes judiciaires dans les 30 prochains jours (dont 5 dans les 7 prochains), par jour et par tribunal. Dates issues des annonces.",
    );
    expect(hearingsPageDescription(0, 3)).toContain("3 audiences de ventes judiciaires");
    expect(hearingsPageDescription(0, 3)).not.toContain("dont");
    expect(hearingsPageDescription(1, 0)).toContain("1 audience de vente judiciaire");
    expect(hearingsPageDescription(1234, 5678).length).toBeLessThanOrEqual(158);
    expect(hearingsPageDescription(0, 0)).toContain("Aucune audience");
    expect(hearingsPageDescription(0, 0).length).toBeLessThanOrEqual(158);
  });
});
