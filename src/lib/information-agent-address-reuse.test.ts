import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  error: null as { message: string } | null,
  hang: false,
  queries: [] as Array<Array<[string, ...unknown[]]>>,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  class Query {
    private readonly steps: Array<[string, ...unknown[]]> = [];
    private record(name: string, ...args: unknown[]) {
      this.steps.push([name, ...args]);
      return this;
    }
    select(...args: unknown[]) {
      return this.record("select", ...args);
    }
    neq(...args: unknown[]) {
      return this.record("neq", ...args);
    }
    eq(...args: unknown[]) {
      return this.record("eq", ...args);
    }
    ilike(...args: unknown[]) {
      return this.record("ilike", ...args);
    }
    or(...args: unknown[]) {
      return this.record("or", ...args);
    }
    order(...args: unknown[]) {
      return this.record("order", ...args);
    }
    limit(...args: unknown[]) {
      this.record("limit", ...args);
      db.queries.push(this.steps);
      if (db.hang) return new Promise(() => undefined);
      return Promise.resolve({ data: db.error ? null : db.rows, error: db.error });
    }
  }
  return { supabaseAdmin: { from: () => new Query() } };
});

import {
  addressReuseCutoff,
  findReusableInformationAgentAddress,
  isSameInformationAgentProfessional,
  normalizedFrenchPhones,
  phoneLikePattern,
  selectReusableAddress,
  type ReusableAddressRow,
} from "@/lib/information-agent/address-reuse";

const NOW = new Date("2026-10-14T12:00:00Z");
const SALE_ID = "11111111-1111-4111-8111-111111111111";

function row(overrides: Partial<ReusableAddressRow> = {}): ReusableAddressRow {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    source_name: "licitor",
    source_url: "https://www.licitor.com/annonce/2.html",
    sale_date: "2026-09-02T09:00:00Z",
    last_seen_at: "2026-10-10T04:00:00Z",
    lawyer_name: "Me Jean DUPONT",
    lawyer_contact: "12 rue du Palais | Tél.: 05 56 00 00 01 | cabinet@cabinet-dupont.test",
    ...overrides,
  };
}

const select = (rows: ReusableAddressRow[], current: Record<string, string | null> = {}) =>
  selectReusableAddress({
    lawyerName: "Maître Jean Dupont",
    lawyerContact: "Tél. 05.56.00.00.01",
    rows,
    saleId: SALE_ID,
    now: NOW,
    ...current,
  });

describe("téléphones français normalisés", () => {
  it.each([
    ["05 56 00 00 01", ["0556000001"]],
    ["05.56.00.00.01", ["0556000001"]],
    ["0556000001", ["0556000001"]],
    ["+33 5 56 00 00 01", ["0556000001"]],
    ["+33 (0)5 56 00 00 01", ["0556000001"]],
    ["0033 5 56 00 00 01", ["0556000001"]],
    ["Tél.: 05 56 00 00 01 · Fax : 05 56 00 00 02", ["0556000001"]],
    ["33000 Bordeaux", []],
    ["SIRET 12345678901234", []],
    [null, []],
  ])("%s", (text, expected) => {
    expect(normalizedFrenchPhones(text)).toEqual(expected);
  });
});

describe("même identité professionnelle (normalisée comme identity.ts)", () => {
  it.each([
    ["Maître Jean Dupont", "Me Jean DUPONT", true],
    ["Jean Dupont", "DUPONT Jean", true],
    // Ensembles de jetons égaux exigés : un prénom composé n'est pas le même professionnel.
    ["Jean Dupont", "DUPONT Jean-Pierre", false],
    ["Jean Dupont", "Jean-Louis Dupont", false],
    ["Me Frédéric Béranger", "Frederic BERANGER, avocat", true],
    ["SCP Dupont et Associés (Jean Dupont)", "Jean Dupont", true],
    // Un seul jeton de nom : jamais suffisant.
    ["Me Dupont", "Me Dupont", false],
    ["Maître Dupont", "Jean Dupont", false],
    // Même nom de famille, autre prénom.
    ["Jean Dupont", "Marie Dupont", false],
    ["SCP Dupont Martin", "Jean Dupont", false],
    [null, "Jean Dupont", false],
  ])("%s / %s", (left, right, expected) => {
    expect(isSameInformationAgentProfessional(left, right)).toBe(expected);
  });
});

describe("réemploi d'une adresse publiée sur une autre annonce", () => {
  it("retient l'adresse quand le nom et le téléphone concordent", () => {
    expect(select([row()])).toEqual({
      status: "found",
      address: {
        email: "cabinet@cabinet-dupont.test",
        listingLawyerName: "Me Jean DUPONT",
        listing: {
          saleId: "22222222-2222-4222-8222-222222222222",
          sourceName: "licitor",
          sourceUrl: "https://www.licitor.com/annonce/2.html",
          referenceAt: "2026-10-10T04:00:00.000Z",
        },
      },
    });
  });

  it("exige le même téléphone : un autre numéro, ou aucun, ne suffit pas", () => {
    const other = row({ lawyer_contact: "Tél.: 05 56 11 11 11 | cabinet@cabinet-dupont.test" });
    expect(select([other])).toEqual({ status: "none", reason: "no_match" });
    const withoutPhone = row({ lawyer_contact: "cabinet@cabinet-dupont.test" });
    expect(select([withoutPhone])).toEqual({ status: "none", reason: "no_match" });
    // Pas de téléphone sur la vente en préparation : aucun réemploi.
    expect(select([row()], { lawyerContact: "cabinet@cabinet-dupont.test" })).toEqual({
      status: "none",
      reason: "no_phone",
    });
    // Le numéro de télécopie n'est pas un numéro de ligne.
    const fax = row({ lawyer_contact: "Fax : 05 56 00 00 01 | cabinet@cabinet-dupont.test" });
    expect(select([fax])).toEqual({ status: "none", reason: "no_match" });
  });

  it("exige la même identité : même téléphone d'un autre avocat ou nom incomplet refusés", () => {
    expect(select([row({ lawyer_name: "Me Marie Durand" })]).status).toBe("none");
    expect(select([row({ lawyer_name: "Me Dupont" })]).status).toBe("none");
    expect(select([row()], { lawyerName: "Maître Dupont" })).toEqual({
      status: "none",
      reason: "no_name",
    });
  });

  it("refuse une annonce de plus de 6 mois (vente ET dernière observation)", () => {
    const old = row({ sale_date: "2026-03-01T09:00:00Z", last_seen_at: "2026-04-01T04:00:00Z" });
    expect(select([old]).status).toBe("none");
    // Exactement 6 mois : encore admis ; un jour de plus : refusé.
    expect(addressReuseCutoff(NOW).toISOString()).toBe("2026-04-14T12:00:00.000Z");
    expect(select([row({ sale_date: null, last_seen_at: "2026-04-14T12:00:00Z" })]).status).toBe(
      "found",
    );
    expect(select([row({ sale_date: null, last_seen_at: "2026-04-14T11:59:59Z" })]).status).toBe(
      "none",
    );
    // Date inconnue : refusée.
    expect(select([row({ sale_date: null, last_seen_at: null })]).status).toBe("none");
  });

  it("admet une vente à venir ou récente même si l'observation est ancienne", () => {
    const upcoming = row({
      sale_date: "2026-12-01T09:00:00Z",
      last_seen_at: "2026-02-01T04:00:00Z",
    });
    expect(select([upcoming]).status).toBe("found");
    const recentSale = row({ sale_date: "2026-08-01T09:00:00Z", last_seen_at: null });
    expect(select([recentSale]).status).toBe("found");
  });

  it("n'utilise pas la vente en préparation comme source d'elle-même", () => {
    expect(select([row({ id: SALE_ID })]).status).toBe("none");
  });

  it("ignore les adresses exclues : juridiction, RPVA, Ordre, CARPA, noreply", () => {
    for (const excluded of [
      "greffe@tj-bordeaux.justice.fr",
      "me.dupont@avocat-conseil.fr",
      "contact@ordre-avocats-bordeaux.test",
      "carpa@cabinet-dupont.test",
      "noreply@cabinet-dupont.test",
      "dpo@cabinet-dupont.test",
    ]) {
      expect(
        select([row({ lawyer_contact: `Tél.: 05 56 00 00 01 | ${excluded}` })]),
        excluded,
      ).toEqual({ status: "none", reason: "no_match" });
    }
    // L'adresse exclue ne masque pas une adresse valable de la même annonce.
    expect(
      select([
        row({
          lawyer_contact:
            "Tél.: 05 56 00 00 01 | greffe@tj.justice.fr | cabinet@cabinet-dupont.test",
        }),
      ]),
    ).toMatchObject({ status: "found", address: { email: "cabinet@cabinet-dupont.test" } });
  });

  it("ne cite jamais une page non https, un hôte exclu ou une source sans lien", () => {
    expect(select([row({ source_url: "http://www.licitor.com/annonce/2.html" })]).status).toBe(
      "none",
    );
    expect(select([row({ source_url: null })]).status).toBe("none");
    expect(select([row({ source_url: "https://www.pagesjaunes.fr/pros/1" })]).status).toBe("none");
  });

  it("plusieurs adresses différentes : ambiguïté, rien n'est retenu", () => {
    expect(
      select([
        row(),
        row({
          id: "33333333-3333-4333-8333-333333333333",
          lawyer_contact: "Tél.: 05 56 00 00 01 | jean.dupont@cabinet-dupont.test",
        }),
      ]),
    ).toEqual({ status: "ambiguous" });
    expect(
      select([
        row({
          lawyer_contact:
            "Tél.: 05 56 00 00 01 | contact@cabinet-dupont.test | jean.dupont@cabinet-dupont.test",
        }),
      ]),
    ).toEqual({ status: "ambiguous" });
  });

  it("la partie locale de l'adresse doit rappeler le nom (segments entiers) ou être générique", () => {
    const withAddress = (address: string) =>
      select([row({ lawyer_contact: `Tél.: 05 56 00 00 01 | ${address}` })]);
    for (const accepted of [
      "contact@cabinet-dupont.test",
      "secretariat@cabinet-dupont.test",
      "jean.dupont@cabinet-dupont.test",
      "j.dupont@cabinet-dupont.test",
      "dupont-jean@gmail.com",
    ]) {
      expect(withAddress(accepted).status, accepted).toBe("found");
    }
    for (const refused of [
      "archives@cabinet-dupont.test",
      "marie.martin@cabinet-dupont.test",
      "dupont@cabinet-dupont.test",
      "jean@cabinet-dupont.test",
      "jeanne.dupont@cabinet-dupont.test",
      "comptabilite@cabinet-dupont.test",
    ]) {
      expect(withAddress(refused), refused).toEqual({ status: "none", reason: "no_match" });
    }
  });

  it("la même adresse sur plusieurs annonces cite la plus récente", () => {
    const result = select([
      row({
        id: "44444444-4444-4444-8444-444444444444",
        last_seen_at: "2026-08-01T00:00:00Z",
        sale_date: null,
      }),
      row({
        id: "55555555-5555-4555-8555-555555555555",
        last_seen_at: "2026-10-12T00:00:00Z",
        sale_date: null,
      }),
    ]);
    expect(result).toMatchObject({
      status: "found",
      address: { listing: { saleId: "55555555-5555-4555-8555-555555555555" } },
    });
  });
});

describe("lecture en base", () => {
  beforeEach(() => {
    db.rows = [];
    db.error = null;
    db.hang = false;
    db.queries = [];
  });

  it("filtre sur les autres annonces non mises en quarantaine, le téléphone et la date", async () => {
    db.rows = [
      row() as unknown as Record<string, unknown>,
      row({
        id: "66666666-6666-4666-8666-666666666666",
        lawyer_name: "Me Marie Durand",
      }) as unknown as Record<string, unknown>,
    ];
    const result = await findReusableInformationAgentAddress({
      saleId: SALE_ID,
      lawyerName: "Maître Jean Dupont",
      lawyerContact: "Tél. 05 56 00 00 01 / 05.56.00.00.01",
      now: NOW,
    });
    expect(result.status).toBe("found");
    expect(db.queries).toHaveLength(1);
    const steps = db.queries[0]!;
    expect(steps).toContainEqual(["neq", "id", SALE_ID]);
    expect(steps).toContainEqual(["eq", "catalogue_quarantined", false]);
    expect(steps).toContainEqual(["ilike", "lawyer_contact", "%56%00%00%01%"]);
    // Pas de filtre `%@%` redondant : les adresses sont extraites et contrôlées en code.
    expect(steps.filter(([name]) => name === "ilike")).toHaveLength(1);
    expect(steps).toContainEqual([
      "or",
      "last_seen_at.gte.2026-04-14T12:00:00.000Z,sale_date.gte.2026-04-14T12:00:00.000Z",
    ]);
    expect(phoneLikePattern("0556000001")).toBe("%56%00%00%01%");
  });

  it("ne lit rien sans nom complet ou sans téléphone", async () => {
    await findReusableInformationAgentAddress({
      saleId: SALE_ID,
      lawyerName: "Me Dupont",
      lawyerContact: "Tél. 05 56 00 00 01",
      now: NOW,
    });
    await findReusableInformationAgentAddress({
      saleId: SALE_ID,
      lawyerName: "Maître Jean Dupont",
      lawyerContact: "cabinet@cabinet-dupont.test",
      now: NOW,
    });
    expect(db.queries).toEqual([]);
  });

  it("propage une erreur de base (jamais d'autorisation par défaut)", async () => {
    db.error = { message: "base indisponible" };
    await expect(
      findReusableInformationAgentAddress({
        saleId: SALE_ID,
        lawyerName: "Maître Jean Dupont",
        lawyerContact: "Tél. 05 56 00 00 01",
        now: NOW,
      }),
    ).rejects.toMatchObject({ message: "base indisponible" });
  });

  it("signale (journal) et refuse une lecture tronquée à 200 annonces au lieu de la tronquer en silence", async () => {
    db.rows = Array.from({ length: 200 }, (_, index) => ({
      ...row(),
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    })) as unknown as Array<Record<string, unknown>>;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await findReusableInformationAgentAddress({
      saleId: SALE_ID,
      lawyerName: "Maître Jean Dupont",
      lawyerContact: "Tél. 05 56 00 00 01",
      now: NOW,
    });
    expect(result).toEqual({ status: "none", reason: "truncated" });
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain("rows_truncated");
    // Le journal ne contient aucune donnée de personne.
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("dupont");
    warn.mockRestore();
  });

  it("la lecture est bornée par le budget de la recherche", async () => {
    db.hang = true;
    const started = Date.now();
    await expect(
      findReusableInformationAgentAddress({
        saleId: SALE_ID,
        lawyerName: "Maître Jean Dupont",
        lawyerContact: "Tél. 05 56 00 00 01",
        now: NOW,
        timeoutMs: 30,
      }),
    ).rejects.toThrow("trop longue");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
