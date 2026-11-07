import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { table: string; method: string; args: unknown[] };

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  calls: [] as Call[],
  rows: {} as Record<string, unknown[]>,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from },
}));

import { lawyerDirectoryQuerySchema, listLawyerDirectory } from "@/lib/lawyer-directory";

const SALE_ID = "52d72de3-d795-492e-be50-58eb72d2eb47";

function referencedLawyer(id: string, overrides: Record<string, unknown>) {
  return {
    id,
    display_name: `Avocat ${id}`,
    firm_name: null,
    email: null,
    phone: null,
    website_url: null,
    bar_association: null,
    bar_number: null,
    city: null,
    department: null,
    address: null,
    profile_summary: null,
    practice_tags: [],
    accepts_remote_contact: false,
    priority_weight: 0,
    paid_placement_status: "not_started",
    paid_placement_starts_at: null,
    paid_placement_ends_at: null,
    ...overrides,
  };
}

function cnbLawyer(key: string, bar: string, barKey?: string) {
  return {
    ...(barKey ? { bar_key: barKey } : {}),
    source_key: key,
    display_name: `CNB ${key}`,
    firm_name: null,
    address_line_1: null,
    address_line_2: null,
    postal_code: null,
    city: null,
    bar_association: bar,
    specializations: [],
    oath_date: null,
    languages: [],
    source_updated_at: "2026-11-01T00:00:00Z",
  };
}

/** Chaîne Supabase qui enregistre ses appels et se résout avec les lignes de la table lue. */
function queryFor(table: string) {
  const single = { data: mocks.rows[table]?.[0] ?? null, error: null };
  // `eq` filtre les lignes qui portent la colonne (les autres lignes de test l'ignorent).
  const filters: Array<[string, unknown]> = [];
  const rows = () =>
    (mocks.rows[table] ?? []).filter((row) =>
      filters.every(([column, value]) => {
        const record = row as Record<string, unknown>;
        return !(column in record) || record[column] === value;
      }),
    );
  const chain: Record<string, unknown> = {
    then: (resolve: (value: unknown) => unknown) => resolve({ data: rows(), error: null }),
    maybeSingle: () => Promise.resolve(single),
  };
  for (const method of ["select", "eq", "in", "order", "limit"]) {
    chain[method] = (...args: unknown[]) => {
      mocks.calls.push({ table, method, args });
      if (method === "eq") filters.push([args[0] as string, args[1]]);
      return chain;
    };
  }
  return chain;
}

function callsOn(table: string, method: string) {
  return mocks.calls
    .filter((call) => call.table === table && call.method === method)
    .map((call) => call.args);
}

describe("filtres de l'annuaire des avocats", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.calls.length = 0;
    mocks.rows = {};
    mocks.from.mockImplementation(queryFor);
  });

  it("depuis une vente au TJ d'Aix-en-Provence, cherche le barreau d'Aix-en-Provence entier", async () => {
    mocks.rows = {
      auction_sales: [
        {
          id: SALE_ID,
          department: "13",
          tribunal: "TJ Aix-en-Provence",
          tribunal_code: "justice_tj_1_102",
          lawyer_name: null,
          status: "scheduled",
          raw_payload: {},
        },
      ],
      referenced_lawyers: [],
      cnb_lawyer_directory: [cnbLawyer("aix-1", "AIX EN PROVENCE")],
    };

    const directory = await listLawyerDirectory(
      lawyerDirectoryQuerySchema.parse({ saleId: SALE_ID }),
    );

    expect(directory.barAssociation).toBe("Aix-en-Provence");
    expect(directory.sectorLabel).toBe("Barreau de Aix-en-Provence");
    expect(callsOn("cnb_lawyer_directory", "eq")).toEqual([["bar_key", "aix en provence"]]);
    expect(directory.lawyers.map((lawyer) => lawyer.id)).toEqual(["cnb:aix-1"]);
  });

  it("?department= ne garde que les barreaux des tribunaux du département", async () => {
    mocks.rows = {
      tribunals: [
        { canonical_name: "TJ Marseille", city: "Marseille" },
        { canonical_name: "TJ Aix-en-Provence", city: "Aix-en-Provence" },
        { canonical_name: "TJ Tarascon", city: "Tarascon" },
      ],
      referenced_lawyers: [
        referencedLawyer("aix", { bar_association: "Aix-en-Provence" }),
        referencedLawyer("bordeaux", { bar_association: "Bordeaux", department: "33" }),
        referencedLawyer("dept", { bar_association: null, department: "13" }),
      ],
      cnb_lawyer_directory: [
        cnbLawyer("mrs-1", "MARSEILLE", "marseille"),
        cnbLawyer("tar-1", "TARASCON", "tarascon"),
      ],
    };

    const directory = await listLawyerDirectory(
      lawyerDirectoryQuerySchema.parse({ department: "13" }),
    );

    expect(callsOn("tribunals", "eq")).toEqual([["department", "13"]]);
    // Un barreau par requête, chacune limitée comme une recherche sur un seul barreau : la limite de
    // 1 000 lignes d'une réponse ne peut plus faire disparaître les derniers barreaux.
    expect(callsOn("cnb_lawyer_directory", "eq")).toEqual([
      ["bar_key", "marseille"],
      ["bar_key", "aix en provence"],
      ["bar_key", "tarascon"],
    ]);
    expect(callsOn("cnb_lawyer_directory", "in")).toEqual([]);
    expect(callsOn("cnb_lawyer_directory", "limit")).toEqual([[500], [500], [500]]);
    expect(directory.lawyers.map((lawyer) => lawyer.id)).toEqual([
      "aix",
      "dept",
      "cnb:mrs-1",
      "cnb:tar-1",
    ]);
    expect(directory.sectorLabel).toBe("Bouches-du-Rhône (13)");
    expect(directory.barAssociation).toBeNull();
  });

  it("un département sans tribunal connu ne renvoie aucun avocat de l'annuaire officiel", async () => {
    mocks.rows = {
      tribunals: [],
      referenced_lawyers: [referencedLawyer("bordeaux", { bar_association: "Bordeaux" })],
      cnb_lawyer_directory: [cnbLawyer("ain-1", "AIN")],
    };

    const directory = await listLawyerDirectory(
      lawyerDirectoryQuerySchema.parse({ department: "13" }),
    );

    expect(mocks.calls.some((call) => call.table === "cnb_lawyer_directory")).toBe(false);
    expect(directory.lawyers).toEqual([]);
  });

  it("?bar= cherche le barreau demandé, nom composé compris", async () => {
    mocks.rows = { referenced_lawyers: [], cnb_lawyer_directory: [] };

    const directory = await listLawyerDirectory(
      lawyerDirectoryQuerySchema.parse({ bar: "Saint-Étienne" }),
    );

    expect(callsOn("cnb_lawyer_directory", "eq")).toEqual([["bar_key", "saint etienne"]]);
    expect(directory.sectorLabel).toBe("Barreau de Saint-Étienne");
    expect(mocks.calls.some((call) => call.table === "tribunals")).toBe(false);
  });
});
