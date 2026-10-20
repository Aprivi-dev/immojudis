// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapHearingRows, type UpcomingHearingRow } from "@/lib/upcoming-hearings";

const mocks = vi.hoisted(() => ({ hearings: vi.fn(), activity: vi.fn(), mustFail: vi.fn() }));

vi.mock("@/lib/upcoming-hearings.server", () => ({
  tryLoadUpcomingHearings: mocks.hearings,
  mustFailOnHearingsReadError: mocks.mustFail,
}));
vi.mock("@/lib/public-tribunal-activity.server", () => ({
  loadPublicTribunalActivity: mocks.activity,
  PUBLIC_TRIBUNAL_ACTIVITY_REVALIDATE_SECONDS: 3600,
}));

import { PUBLIC_TRIBUNAL_ACTIVITY_REVALIDATE_SECONDS } from "@/lib/public-tribunal-activity.server";
import Page, { generateMetadata, revalidate } from "./page";

/** Mardi 20 octobre 2026, 10 h à Paris. */
const NOW = new Date("2026-10-20T08:00:00Z");

let counter = 0;
function row(overrides: Partial<UpcomingHearingRow> = {}): UpcomingHearingRow {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    sale_date: "2026-10-22T12:00:00Z",
    date_only: false,
    property_type: "apartment",
    city: "Bobigny",
    department: "93",
    tribunal_code: "bobigny",
    tribunal_name: "TJ Bobigny",
    tribunal_city: "Bobigny",
    starting_price_eur: 40_000 + counter,
    total_count: 3,
    ...overrides,
  };
}

function serve(rows: UpcomingHearingRow[], totalCount = rows.length) {
  mocks.hearings.mockResolvedValue({ status: "ok", hearings: mapHearingRows(rows), totalCount });
}

const ACTIVITY_ITEM = {
  code: "bobigny",
  name: "Bobigny",
  searchName: "TJ Bobigny",
  city: "Bobigny",
  department: "93",
  upcomingCount: 9,
  nextSaleDate: null,
  medianStartingPriceEur: null,
  houseCount: 0,
  apartmentCount: 0,
  otherCount: 0,
};

beforeEach(() => {
  counter = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.SITE_URL = "https://immojudis.com";
  mocks.hearings.mockReset();
  mocks.mustFail.mockReset();
  mocks.mustFail.mockReturnValue(false);
  mocks.activity.mockReset();
  mocks.activity.mockResolvedValue({ status: "ok", items: [ACTIVITY_ITEM] });
  serve([
    row(),
    row({ sale_date: "2026-10-22T08:00:00Z", city: "Pantin" }),
    row({ sale_date: "2026-11-05T12:00:00Z", tribunal_code: "paris", tribunal_name: "TJ Paris" }),
  ]);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  delete process.env.SITE_URL;
});

describe("/audiences-a-venir : génération et indexation", () => {
  it("est rafraîchie toutes les heures", () => {
    expect(revalidate).toBe(3600);
    expect(revalidate).toBe(PUBLIC_TRIBUNAL_ACTIVITY_REVALIDATE_SECONDS);
  });

  it("est indexable avec trois audiences, avec canonical et Open Graph", async () => {
    const metadata = await generateMetadata();
    expect(metadata.robots).toBeUndefined();
    expect(metadata.title).toBe("Audiences de ventes judiciaires à venir");
    expect(metadata.alternates?.canonical).toBe("/audiences-a-venir");
    expect(metadata.openGraph).toMatchObject({ url: "/audiences-a-venir", siteName: "Immojudis" });
    expect(String(metadata.description)).toContain(
      "3 audiences de ventes judiciaires dans les 30 prochains jours (dont 2 dans les 7 prochains)",
    );
    expect(String(metadata.description).length).toBeLessThanOrEqual(158);
  });

  it("passe en noindex, follow sous le seuil de trois audiences, et reste servie", async () => {
    serve([row(), row({ sale_date: "2026-10-23T12:00:00Z" })]);
    const metadata = await generateMetadata();
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBe("/audiences-a-venir");
    render(await Page());
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
  });

  it("compte une vente publiée par deux sources une seule fois (même clé d'adresse source)", async () => {
    serve([
      row({ id: "a", starting_price_eur: 50_000, source_group: "group-1" }),
      row({ id: "b", starting_price_eur: 50_000, source_group: "group-1" }),
      row({ id: "c", starting_price_eur: 60_000 }),
    ]);
    const metadata = await generateMetadata();
    expect(String(metadata.description)).toContain("2 audiences");
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it("garde deux lots distincts du même tribunal, du même jour et au même prix", async () => {
    serve([
      row({ id: "a", starting_price_eur: 50_000, source_group: "group-1" }),
      row({ id: "b", starting_price_eur: 50_000, source_group: "group-2" }),
      row({ id: "c", starting_price_eur: 50_000 }),
    ]);
    const metadata = await generateMetadata();
    expect(String(metadata.description)).toContain("3 audiences");
  });

  it("répond noindex et dit l'indisponibilité quand la lecture échoue pendant le build", async () => {
    mocks.hearings.mockResolvedValue({ status: "error" });
    const metadata = await generateMetadata();
    expect(metadata.robots).toEqual({ index: false, follow: true });
    render(await Page());
    expect(
      screen.getByRole("heading", { name: "Audiences momentanément indisponibles" }),
    ).toBeTruthy();
    expect(screen.queryByText("Aucune audience à date annoncée")).toBeNull();
  });

  it("lève l'erreur à l'exécution : la dernière bonne page reste servie", async () => {
    mocks.hearings.mockResolvedValue({ status: "error" });
    mocks.mustFail.mockReturnValue(true);
    await expect(generateMetadata()).rejects.toThrow("indisponibles");
    await expect(Page()).rejects.toThrow("indisponibles");
  });
});

describe("/audiences-a-venir : contenu", () => {
  it("transmet l'origine à la fiche dans le navigateur seulement (« Retour aux audiences »)", async () => {
    render(await Page());
    const link = screen.getAllByRole("link", { name: /Pantin/ })[0]!;
    expect(link.getAttribute("href")).toBe("/sales/00000000-0000-4000-8000-000000000002");
    fireEvent.pointerEnter(link);
    expect(link.getAttribute("href")).toBe(
      "/sales/00000000-0000-4000-8000-000000000002?from=%2Faudiences-a-venir",
    );
  });

  it("groupe par fenêtre, par jour puis par tribunal, avec un lien vers chaque fiche", async () => {
    render(await Page());

    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([
      "Audiences de ventes judiciaires à venir",
    ]);
    const week = screen.getByRole("region", { name: /Dans les 7 prochains jours/ });
    expect(week.textContent).toContain("2 audiences");
    const day = within(week).getByRole("region", { name: /jeudi 22 octobre 2026/ });
    expect(within(day).getByRole("heading", { level: 4 }).textContent).toBe(
      "Tribunal judiciaire de Bobigny",
    );
    const links = within(day)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    // La page du tribunal, puis les deux fiches (la plus tôt dans la journée d'abord).
    expect(links).toEqual([
      "/tribunaux/bobigny",
      "/sales/00000000-0000-4000-8000-000000000002",
      "/sales/00000000-0000-4000-8000-000000000001",
    ]);
    expect(day.textContent).toContain("Pantin (93)");
    expect(day.textContent).toContain("à 10 h 00");
    expect(day.textContent).toContain("Mise à prix");

    const later = screen.getByRole("region", { name: /Du 8e au 30e jour/ });
    expect(later.textContent).toContain("1 audience");
    expect(within(later).getByRole("heading", { level: 4 }).textContent).toBe(
      "Tribunal judiciaire de Paris",
    );
  });

  it("dit « aujourd'hui » et « demain » et « heure à confirmer » quand l'heure est inconnue", async () => {
    serve([
      row({ sale_date: "2026-10-19T22:00:00Z", date_only: true }),
      row({ sale_date: "2026-10-20T22:00:00Z", date_only: true }),
    ]);
    render(await Page());
    expect(
      screen.getByRole("region", { name: /mardi 20 octobre 2026 \(aujourd’hui\)/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: /mercredi 21 octobre 2026 \(demain\)/ }),
    ).toBeTruthy();
    expect(document.body.textContent).toContain("heure à confirmer");
    expect(document.body.textContent).not.toMatch(/ à 0 h|à 00 h/);
  });

  it("ne met « aujourd'hui » et « demain » que dans le navigateur : le HTML du serveur n'en porte pas", async () => {
    serve([
      row({ sale_date: "2026-10-19T22:00:00Z", date_only: true }),
      row({ sale_date: "2026-10-20T22:00:00Z", date_only: true }),
    ]);
    const html = renderToString(await Page());
    // La page est servie jusqu'à une heure : le jour relatif dépend de l'horloge du lecteur.
    expect(html).toContain("mardi 20 octobre 2026");
    expect(html).toContain("mercredi 21 octobre 2026");
    expect(html).not.toContain("aujourd’hui");
    expect(html).not.toContain("demain");
    expect(html).toContain('<time dateTime="2026-10-20">');
  });

  it("recalcule « aujourd'hui » avec l'horloge du lecteur, pas avec celle de la génération", async () => {
    serve([
      row({ sale_date: "2026-10-19T22:00:00Z", date_only: true }),
      row({ sale_date: "2026-10-20T22:00:00Z", date_only: true }),
    ]);
    const view = await Page();
    // Le lecteur ouvre la page le lendemain : le jour qui était « aujourd'hui » n'a plus de repère.
    vi.setSystemTime(new Date("2026-10-21T08:00:00Z"));
    render(view);
    const first = screen.getByText(/mardi 20 octobre 2026/);
    expect(first.textContent).toBe("mardi 20 octobre 2026");
    expect(screen.getByText(/mercredi 21 octobre 2026/).textContent).toBe(
      "mercredi 21 octobre 2026 (aujourd’hui)",
    );
  });

  it("tient l'introduction en une phrase, avec les termes définis, et replie la mise en garde", async () => {
    const { container } = render(await Page());
    const header = container.querySelector("header") as HTMLElement;
    const intro = header.querySelector("details")?.previousElementSibling as HTMLElement;
    expect(intro.textContent).toBe(
      "Les audiences d’adjudication des 7 puis des 30 prochains jours, avec la mise à prix de chaque bien, jour par jour et tribunal par tribunal.",
    );
    expect(within(intro).getByRole("button", { name: "Définition : adjudication" })).toBeTruthy();
    expect(within(intro).getByRole("button", { name: "Définition : mise à prix" })).toBeTruthy();
    // La mise en garde est repliée, et dit qu'une date peut changer sans prétendre qu'aucun report n'y est.
    const warning = header.querySelector("details") as HTMLDetailsElement;
    expect(warning.open).toBe(false);
    expect(warning.textContent).toContain(
      "Les ventes dont le report est connu n’y figurent pas ; une date peut encore changer.",
    );
    expect(warning.textContent).not.toContain("une vente reportée n’y est pas");
  });

  it("n'affiche aucune adresse exacte", async () => {
    mocks.hearings.mockResolvedValue({
      status: "ok",
      hearings: mapHearingRows([
        {
          ...row(),
          address: "12 rue Privée",
          latitude: 48.9,
          longitude: 2.4,
        } as UpcomingHearingRow,
      ]),
      totalCount: 1,
    });
    const { container } = render(await Page());
    expect(container.textContent).not.toContain("Privée");
    expect(container.textContent).not.toContain("48.9");
  });

  it("nomme le tribunal sans lien quand l'activité des tribunaux est indisponible", async () => {
    mocks.activity.mockResolvedValue({ status: "error" });
    render(await Page());
    const heading = screen.getAllByRole("heading", { level: 4 })[0];
    expect(heading.textContent).toBe("Tribunal judiciaire de Bobigny");
    expect(within(heading).queryByRole("link")).toBeNull();
  });

  it("dit qu'aucune audience n'est annoncée plutôt que d'afficher une page vide", async () => {
    serve([]);
    render(await Page());
    expect(screen.getByRole("heading", { name: "Aucune audience à date annoncée" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: /Dans les 7 prochains jours/ })).toBeNull();
    const metadata = await generateMetadata();
    expect(metadata.robots).toEqual({ index: false, follow: true });
    // Le mot des annonces, pas le jargon interne « date sourcée ».
    expect(String(metadata.description)).toContain("à date annoncée");
    expect(String(metadata.description)).not.toContain("sourcée");
  });

  it("signale une liste tronquée par la limite de lecture", async () => {
    serve([row(), row(), row()], 1500);
    render(await Page());
    expect(screen.getByRole("note").textContent).toContain("limitée aux premières audiences");
  });

  it("rappelle que la date vient de l'annonce, sans conseil", async () => {
    const { container } = render(await Page());
    const intro = container.querySelector("header")?.textContent ?? "";
    expect(intro).toContain("Date issue de l’annonce, à vérifier auprès de l’avocat poursuivant.");
    expect(intro).toContain("ne constitue pas un conseil juridique");
    expect(intro).not.toMatch(/investir|rentab|opportunit/i);
  });

  it("émet un fil d'Ariane", async () => {
    const { container } = render(await Page());
    const blocks = [...container.querySelectorAll('script[type="application/ld+json"]')].map(
      (script) => JSON.parse(script.textContent ?? "{}"),
    );
    const breadcrumb = blocks.find((block) => block["@type"] === "BreadcrumbList");
    expect(breadcrumb.itemListElement.map((item: { name: string }) => item.name)).toEqual([
      "Accueil",
      "Tribunaux",
      "Audiences à venir",
    ]);
    expect(breadcrumb.itemListElement.at(-1).item).toBe("https://immojudis.com/audiences-a-venir");
  });
});
