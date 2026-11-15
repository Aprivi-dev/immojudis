import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  saleProcedureWithoutListingSource,
  saleWithoutListingSource,
  sourceConflictsWithoutListingSource,
  sourcePresenceWithoutListingSource,
  unlockedSaleProjection,
} from "@/lib/property-report/entitlements";
import type { AuctionSale } from "@/lib/types";

/**
 * The same rules, twice: the TypeScript projections (server side: reports, PDF, favorites) and the SQL
 * functions of the views of a reader without the Analyse offer
 * (supabase/migrations/20261123100000_sale_procedure_without_listing_source.sql):
 * `app_private.sale_procedure_without_listing_source(jsonb, boolean)`,
 * `app_private.source_conflicts_without_listing_source(jsonb)`,
 * `app_private.source_presence_without_listing_source(jsonb)`.
 *
 * The expected values below are the outputs of the SQL functions on `input`, run with PostgreSQL 16
 * when the cases were written (jsonb: key order does not count). `strict` is the discovery view
 * (`p_keep_document_urls` false), `unlocked` the unlocked view (true). supabase/tests/902 asserts cases
 * again in the database through the views. A change of a rule on one side only makes this test fail.
 */
type ProcedureCase = { name: string; input: unknown; strict: unknown; unlocked: unknown };
type Case = { name: string; input: unknown; expected: unknown };

const PROCEDURE_CASES: ProcedureCase[] = [
  {
    name: "pipeline procedure: listing, documents, official reference, facts, schedule, payment deadline",
    input: {
      schema_version: "sale_procedure_v1",
      venue_type: "tribunal",
      rules: {
        lawyer_required: true,
        payment_deadline_days: 60,
        payment_deadline_source_url: "https://annonce.example/vente/42",
      },
      sale_session: {
        opens_at: "2026-12-01T10:00:00+01:00",
        closes_at: "2026-12-01T12:00:00+01:00",
        source_url: "https://annonce.example/vente/42",
      },
      verification: {
        status: "cross_checked",
        verified_at: "2026-11-01T10:00:00+01:00",
        case_source_count: 4,
        case_sources: [
          {
            kind: "listing",
            label: "Plateforme Privee",
            source_name: "plateforme-privee",
            url: "https://annonce.example/vente/42",
          },
          {
            kind: "document",
            label: "Cahier des conditions de vente",
            source_name: "plateforme-privee",
            url: "https://pieces.example/ccv.pdf",
            document_type: "ccv",
          },
          {
            kind: "official_reference",
            label: "Référentiel officiel de compétence territoriale",
            source_name: "Ministère de la Justice",
            url: "https://www.data.gouv.fr/fr/datasets/competences",
            reference_sha256: "abc",
          },
        ],
        regulatory_sources: [
          {
            kind: "legal_basis",
            label: "Code des procédures civiles d'exécution",
            source_name: "Légifrance",
            url: "https://www.legifrance.gouv.fr/codes/x",
            checked_at: "2026-11-01",
          },
        ],
        facts: [
          {
            key: "venue_type",
            value: "tribunal",
            status: "verified",
            evidence: ["Tribunal judiciaire"],
            source_url: "https://annonce.example/vente/42",
          },
          {
            key: "competent_court",
            value: "TJ Paris",
            status: "verified",
            evidence: ["Commune INSEE 75056"],
            source_url: "https://www.data.gouv.fr/fr/datasets/competences",
          },
        ],
        issues: [],
      },
    },
    strict: {
      rules: {
        lawyer_required: true,
        payment_deadline_days: 60,
      },
      venue_type: "tribunal",
      sale_session: {
        opens_at: "2026-12-01T10:00:00+01:00",
        closes_at: "2026-12-01T12:00:00+01:00",
      },
      verification: {
        facts: [
          {
            key: "venue_type",
            value: "tribunal",
            status: "verified",
            evidence: ["Tribunal judiciaire"],
          },
          {
            key: "competent_court",
            value: "TJ Paris",
            status: "verified",
            evidence: ["Commune INSEE 75056"],
          },
        ],
        issues: [],
        status: "cross_checked",
        verified_at: "2026-11-01T10:00:00+01:00",
        case_sources: [
          {
            kind: "document",
            label: "Cahier des conditions de vente",
            document_type: "ccv",
          },
          {
            url: "https://www.data.gouv.fr/fr/datasets/competences",
            kind: "official_reference",
            label: "Référentiel officiel de compétence territoriale",
            source_name: "Ministère de la Justice",
            reference_sha256: "abc",
          },
        ],
        case_source_count: 4,
        regulatory_sources: [
          {
            url: "https://www.legifrance.gouv.fr/codes/x",
            kind: "legal_basis",
            label: "Code des procédures civiles d'exécution",
            checked_at: "2026-11-01",
            source_name: "Légifrance",
          },
        ],
      },
      schema_version: "sale_procedure_v1",
    },
    unlocked: {
      rules: {
        lawyer_required: true,
        payment_deadline_days: 60,
      },
      venue_type: "tribunal",
      sale_session: {
        opens_at: "2026-12-01T10:00:00+01:00",
        closes_at: "2026-12-01T12:00:00+01:00",
      },
      verification: {
        facts: [
          {
            key: "venue_type",
            value: "tribunal",
            status: "verified",
            evidence: ["Tribunal judiciaire"],
          },
          {
            key: "competent_court",
            value: "TJ Paris",
            status: "verified",
            evidence: ["Commune INSEE 75056"],
          },
        ],
        issues: [],
        status: "cross_checked",
        verified_at: "2026-11-01T10:00:00+01:00",
        case_sources: [
          {
            url: "https://pieces.example/ccv.pdf",
            kind: "document",
            label: "Cahier des conditions de vente",
            document_type: "ccv",
          },
          {
            url: "https://www.data.gouv.fr/fr/datasets/competences",
            kind: "official_reference",
            label: "Référentiel officiel de compétence territoriale",
            source_name: "Ministère de la Justice",
            reference_sha256: "abc",
          },
        ],
        case_source_count: 4,
        regulatory_sources: [
          {
            url: "https://www.legifrance.gouv.fr/codes/x",
            kind: "legal_basis",
            label: "Code des procédures civiles d'exécution",
            checked_at: "2026-11-01",
            source_name: "Légifrance",
          },
        ],
      },
      schema_version: "sale_procedure_v1",
    },
  },
  {
    name: "unknown and malformed case sources are removed (closed by default)",
    input: {
      verification: {
        case_sources: [
          {
            kind: "kind-inconnu",
            source_name: "autre",
            url: "https://autre.example",
          },
          {
            label: "sans kind",
            url: "https://sans-kind.example",
          },
          {
            kind: ["document"],
            url: "https://tableau.example",
          },
          {
            kind: "DOCUMENT",
            url: "https://majuscules.example",
          },
          "document",
          null,
          {
            kind: "document",
            label: "Pièce",
            url: "https://pieces.example/pv.pdf",
          },
        ],
      },
    },
    strict: {
      verification: {
        case_sources: [
          {
            kind: "document",
            label: "Pièce",
          },
        ],
      },
    },
    unlocked: {
      verification: {
        case_sources: [
          {
            url: "https://pieces.example/pv.pdf",
            kind: "document",
            label: "Pièce",
          },
        ],
      },
    },
  },
  {
    name: "document without url, official reference without url",
    input: {
      verification: {
        case_sources: [
          {
            kind: "document",
            label: "Pièce sans adresse",
            source_name: "plateforme-privee",
          },
          {
            kind: "official_reference",
            label: "Référentiel",
          },
        ],
      },
    },
    strict: {
      verification: {
        case_sources: [
          {
            kind: "document",
            label: "Pièce sans adresse",
          },
          {
            kind: "official_reference",
            label: "Référentiel",
          },
        ],
      },
    },
    unlocked: {
      verification: {
        case_sources: [
          {
            kind: "document",
            label: "Pièce sans adresse",
          },
          {
            kind: "official_reference",
            label: "Référentiel",
          },
        ],
      },
    },
  },
  {
    name: "source_url keys at any depth, the other keys kept",
    input: {
      source_url: "https://annonce.example/1",
      sale_window: {
        opens_at: "2026-12-01",
        source_url: "https://annonce.example/1",
      },
      nested: [
        {
          deep: {
            listing_source_url: "https://annonce.example/1",
            url: "https://garde.example",
            source_urls: ["https://garde-liste.example"],
            source_url_note: "garde",
          },
        },
      ],
    },
    strict: {
      nested: [
        {
          deep: {
            url: "https://garde.example",
            source_urls: ["https://garde-liste.example"],
            source_url_note: "garde",
          },
        },
      ],
      sale_window: {
        opens_at: "2026-12-01",
      },
    },
    unlocked: {
      nested: [
        {
          deep: {
            url: "https://garde.example",
            source_urls: ["https://garde-liste.example"],
            source_url_note: "garde",
          },
        },
      ],
      sale_window: {
        opens_at: "2026-12-01",
      },
    },
  },
  {
    name: "no verification object: only the source_url keys go",
    input: {
      verification: "texte",
      rules: {
        payment_deadline_source_url: "https://annonce.example/2",
      },
    },
    strict: {
      rules: {},
      verification: "texte",
    },
    unlocked: {
      rules: {},
      verification: "texte",
    },
  },
  {
    name: "case_sources not an array: becomes empty (closed by default)",
    input: {
      verification: {
        case_sources: {
          kind: "listing",
          url: "https://annonce.example/3",
        },
      },
    },
    strict: {
      verification: {
        case_sources: [],
      },
    },
    unlocked: {
      verification: {
        case_sources: [],
      },
    },
  },
  {
    name: "case_sources null: becomes empty",
    input: {
      verification: {
        status: "pending",
        case_sources: null,
      },
    },
    strict: {
      verification: {
        status: "pending",
        case_sources: [],
      },
    },
    unlocked: {
      verification: {
        status: "pending",
        case_sources: [],
      },
    },
  },
  {
    name: "only a listing: case_sources becomes empty",
    input: {
      verification: {
        status: "pending",
        case_sources: [
          {
            kind: "listing",
            source_name: "plateforme-privee",
            url: "https://annonce.example/4",
          },
        ],
      },
    },
    strict: {
      verification: {
        status: "pending",
        case_sources: [],
      },
    },
    unlocked: {
      verification: {
        status: "pending",
        case_sources: [],
      },
    },
  },
  {
    name: "empty object",
    input: {},
    strict: {},
    unlocked: {},
  },
  {
    name: "top-level array: source_url keys of its objects go",
    input: [
      {
        source_url: "https://annonce.example/5",
        kind: "listing",
      },
    ],
    strict: [
      {
        kind: "listing",
      },
    ],
    unlocked: [
      {
        kind: "listing",
      },
    ],
  },
  {
    name: "scalar",
    input: "texte",
    strict: "texte",
    unlocked: "texte",
  },
  {
    name: "null",
    input: null,
    strict: null,
    unlocked: null,
  },
];

const CONFLICT_CASES: Case[] = [
  {
    name: "dedupe conflict: only the field stays",
    input: [
      {
        field: "sale_date",
        selected: "2026-12-01",
        observed_primary: "2026-12-02",
        alternative: "2026-12-02",
        selected_source: "https://annonce-privee.example/a",
        alternative_source: "https://annonce-privee.example/b",
        observed_primary_source: "https://annonce-privee.example/a",
      },
    ],
    expected: [
      {
        field: "sale_date",
      },
    ],
  },
  {
    name: "malformed conflicts: one empty object each, order kept",
    input: [
      {
        selected_source: "https://annonce-privee.example/a",
      },
      "texte",
      null,
      [1],
      {
        field: 12,
      },
      {
        field: "tribunal",
      },
    ],
    expected: [
      {},
      {},
      {},
      {},
      {},
      {
        field: "tribunal",
      },
    ],
  },
  {
    name: "not an array",
    input: {
      field: "sale_date",
    },
    expected: [],
  },
  {
    name: "null",
    input: null,
    expected: [],
  },
  {
    name: "empty",
    input: [],
    expected: [],
  },
];

const PRESENCE_CASES: Case[] = [
  {
    name: "compact presence and legacy extras: re-keyed, availability and state only",
    input: {
      vench: {
        availability: "available",
        state: "present",
        checked_at: "2026-11-01T10:00:00Z",
        attempted_at: "2026-11-01T10:00:00Z",
        run_id: "run-1",
        url: "https://annonce-privee.example/a",
        _raw_entry: "https://annonce-privee.example/a",
      },
      licitor: {
        availability: "unavailable",
        state: null,
        source_name: "licitor",
      },
      Avoventes: {
        _raw_entry: "x",
      },
    },
    expected: {
      source_1: {},
      source_2: {
        state: null,
        availability: "unavailable",
      },
      source_3: {
        state: "present",
        availability: "available",
      },
    },
  },
  {
    name: "an entry that is not an object becomes empty",
    input: {
      "plateforme-privee": "https://annonce-privee.example/a",
    },
    expected: {
      source_1: {},
    },
  },
  {
    name: "not an object",
    input: ["vench"],
    expected: {},
  },
  {
    name: "null",
    input: null,
    expected: {},
  },
  {
    name: "empty",
    input: {},
    expected: {},
  },
];

const MIGRATION = readFileSync(
  new URL(
    "../../../supabase/migrations/20261123100000_sale_procedure_without_listing_source.sql",
    import.meta.url,
  ),
  "utf8",
);

function sqlFunction(name: string): string {
  return (
    new RegExp(`create or replace function app_private\\.${name}\\([\\s\\S]*?\\$\\$;`).exec(
      MIGRATION,
    )?.[0] ?? ""
  );
}

describe("sale_procedure without the listing source: TypeScript and SQL parity", () => {
  it.each(PROCEDURE_CASES)("$name", ({ input, strict, unlocked }) => {
    expect(saleProcedureWithoutListingSource(input, { documentUrls: false })).toEqual(strict);
    expect(saleProcedureWithoutListingSource(input, { documentUrls: true })).toEqual(unlocked);
  });

  it("reads the same kinds, suffix and document keys in the SQL function", () => {
    const sql = sqlFunction("sale_procedure_without_listing_source");
    const kinds = /in \(([^)]*)\)/.exec(sql)?.[1]?.match(/'(\w+)'/g);
    expect(kinds).toEqual(["'document'", "'official_reference'"]);
    expect(sql).toContain("when p_keep_document_urls is true then array['source_name']");
    expect(sql).toContain("else array['source_name', 'url']");
    expect(MIGRATION).toContain("where entry.key !~ 'source_url$'");
    const kept = saleProcedureWithoutListingSource(
      {
        verification: {
          case_sources: ["document", "official_reference", "listing", "legal_basis"].map(
            (kind) => ({
              kind,
            }),
          ),
        },
      },
      { documentUrls: true },
    ) as { verification: { case_sources: Array<{ kind: string }> } };
    expect(kept.verification.case_sources.map((source) => source.kind)).toEqual([
      "document",
      "official_reference",
    ]);
  });
});

describe("source_conflicts without the listing source: TypeScript and SQL parity", () => {
  it.each(CONFLICT_CASES)("$name", ({ input, expected }) => {
    expect(sourceConflictsWithoutListingSource(input)).toEqual(expected);
  });

  it("keeps the same single key in the SQL function", () => {
    const sql = sqlFunction("source_conflicts_without_listing_source");
    expect(sql).toContain("jsonb_build_object('field', conflict.value -> 'field')");
    expect(sql.match(/jsonb_build_object\('(\w+)'/g)).toEqual(["jsonb_build_object('field'"]);
  });
});

describe("source_presence without the listing source: TypeScript and SQL parity", () => {
  it.each(PRESENCE_CASES)("$name", ({ input, expected }) => {
    expect(sourcePresenceWithoutListingSource(input)).toEqual(expected);
  });

  it("keeps the same keys in the SQL function", () => {
    const sql = sqlFunction("source_presence_without_listing_source");
    expect(sql).toContain("where kept.key in ('availability', 'state')");
    expect(sql).toContain('order by presence.key collate "C"');
  });
});

describe("saleWithoutListingSource", () => {
  const [pipeline] = PROCEDURE_CASES;
  const [conflict] = CONFLICT_CASES;
  const [presence] = PRESENCE_CASES;
  const sale = {
    id: "sale-1",
    title: "Appartement",
    quality_flags: ["probable_duplicate"],
    sale_procedure: pipeline!.input,
    source_blocks: { sale_procedure: pipeline!.input, titre: "Appartement" },
    source_conflicts: conflict!.input,
    source_presence: presence!.input,
  } as unknown as AuctionSale;

  it("projects the procedure, the conflicts and the presence, nothing else (discovery)", () => {
    const projected = saleWithoutListingSource(sale, { documentUrls: false });
    expect(projected.sale_procedure).toEqual(pipeline!.strict);
    expect(projected.source_blocks).toEqual({
      sale_procedure: pipeline!.strict,
      titre: "Appartement",
    });
    expect(projected.source_conflicts).toEqual(conflict!.expected);
    expect(projected.source_presence).toEqual(presence!.expected);
    expect(projected.quality_flags).toEqual(["probable_duplicate"]);
    const text = JSON.stringify(projected);
    expect(text).not.toMatch(/annonce(-privee)?\.example|plateforme-privee|vench|licitor/);
    expect(text).not.toContain("https://pieces.example");
  });

  it("keeps the url of the case documents for an unlocked sale", () => {
    const projected = saleWithoutListingSource(sale, { documentUrls: true });
    expect(projected.sale_procedure).toEqual(pipeline!.unlocked);
    expect(JSON.stringify(projected)).toContain("https://pieces.example/ccv.pdf");
    expect(JSON.stringify(projected)).not.toMatch(/annonce(-privee)?\.example|plateforme-privee/);
  });

  it("leaves a sale without these columns as it is", () => {
    const bare = { id: "sale-2", title: "Maison" } as AuctionSale;
    expect(saleWithoutListingSource(bare, { documentUrls: false })).toEqual(bare);
  });

  it("is what the unlock projection applies", () => {
    const unlocked = unlockedSaleProjection(sale);
    const projected = saleWithoutListingSource(sale, { documentUrls: true });
    expect(unlocked.sale_procedure).toEqual(projected.sale_procedure);
    expect(unlocked.source_blocks).toEqual(projected.source_blocks);
    expect(unlocked.source_conflicts).toEqual(projected.source_conflicts);
    expect(unlocked.source_presence).toEqual(projected.source_presence);
  });
});
