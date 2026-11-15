import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  saleProcedureWithoutListingSource,
  saleWithoutListingSource,
  unlockedSaleProjection,
} from "@/lib/property-report/entitlements";
import type { AuctionSale } from "@/lib/types";

/**
 * The same rule, twice: `saleProcedureWithoutListingSource` (server side, reports, PDF, favorites) and
 * `app_private.sale_procedure_without_listing_source` (the views of a reader without the Analyse
 * offer, supabase/migrations/20261123100000_sale_procedure_without_listing_source.sql).
 *
 * `expected` below is the output of the SQL function on `input`, run with PostgreSQL 16 when the cases
 * were written (jsonb: key order does not count). supabase/tests/902 asserts the first cases again in
 * the database through the views. A change of the rule on one side only makes this test fail.
 */
type ParityCase = { name: string; input: unknown; expected: unknown };

const CASES: ParityCase[] = [
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
    expected: {
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
    expected: {
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
    expected: {
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
    expected: {
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
    expected: {
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
    expected: {
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
    expected: {
      verification: {
        status: "pending",
        case_sources: [],
      },
    },
  },
  {
    name: "empty object",
    input: {},
    expected: {},
  },
  {
    name: "top-level array: source_url keys of its objects go",
    input: [
      {
        source_url: "https://annonce.example/5",
        kind: "listing",
      },
    ],
    expected: [
      {
        kind: "listing",
      },
    ],
  },
  {
    name: "scalar",
    input: "texte",
    expected: "texte",
  },
  {
    name: "null",
    input: null,
    expected: null,
  },
];

const MIGRATION = readFileSync(
  new URL(
    "../../../supabase/migrations/20261123100000_sale_procedure_without_listing_source.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("sale_procedure without the listing source: TypeScript and SQL parity", () => {
  it.each(CASES)("$name", ({ input, expected }) => {
    expect(saleProcedureWithoutListingSource(input)).toEqual(expected);
  });

  it("reads the same kinds, the same suffix and the same document key in the SQL function", () => {
    const sql =
      /create or replace function app_private\.sale_procedure_without_listing_source[\s\S]*?\$\$;/.exec(
        MIGRATION,
      )?.[0] ?? "";
    const kinds = /in \(([^)]*)\)/.exec(sql)?.[1]?.match(/'(\w+)'/g);
    expect(kinds).toEqual(["'document'", "'official_reference'"]);
    expect(sql).toContain(
      "when source.value ->> 'kind' = 'document' then source.value - 'source_name'",
    );
    expect(MIGRATION).toContain("where entry.key !~ 'source_url$'");
    // Each kind the SQL keeps is kept here too, and nothing else.
    const kept = saleProcedureWithoutListingSource({
      verification: {
        case_sources: ["document", "official_reference", "listing", "legal_basis"].map((kind) => ({
          kind,
        })),
      },
    }) as { verification: { case_sources: Array<{ kind: string }> } };
    expect(kept.verification.case_sources.map((source) => source.kind)).toEqual([
      "document",
      "official_reference",
    ]);
  });
});

describe("saleWithoutListingSource", () => {
  const [pipeline] = CASES;
  const sale = {
    id: "sale-1",
    title: "Appartement",
    quality_flags: ["probable_duplicate"],
    sale_procedure: pipeline!.input,
    source_blocks: { sale_procedure: pipeline!.input, titre: "Appartement" },
  } as unknown as AuctionSale;

  it("projects sale_procedure and source_blocks.sale_procedure, nothing else", () => {
    const projected = saleWithoutListingSource(sale);
    expect(projected.sale_procedure).toEqual(pipeline!.expected);
    expect(projected.source_blocks).toEqual({
      sale_procedure: pipeline!.expected,
      titre: "Appartement",
    });
    expect(projected.quality_flags).toEqual(["probable_duplicate"]);
    expect(JSON.stringify(projected)).not.toMatch(/annonce\.example|plateforme-privee/);
  });

  it("leaves a sale without a procedure as it is", () => {
    const bare = { id: "sale-2", title: "Maison" } as AuctionSale;
    expect(saleWithoutListingSource(bare)).toEqual(bare);
  });

  it("is what the unlock projection applies to the procedure", () => {
    const unlocked = unlockedSaleProjection(sale);
    expect(unlocked.sale_procedure).toEqual(pipeline!.expected);
    expect(unlocked.source_blocks).toEqual(saleWithoutListingSource(sale).source_blocks);
  });
});
