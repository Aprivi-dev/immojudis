import { AdminRequiredError } from "@/lib/api-errors";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mesure à blanc et opposition au niveau de la structure, sur une base simulée qui REFUSE toute écriture :
 * la mesure ne fait que lire. Adresses fictives (`example.test`, sous-domaine inexistant de `notaires.fr`).
 */
type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  reads: [] as string[],
  writes: [] as Array<{ table: string; method: string; rows: unknown }>,
  allowWrites: false,
  rpc: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => {
  class Query {
    private filters: Array<(row: Row) => boolean> = [];
    private written: { method: string; rows: unknown } | null = null;
    constructor(private readonly table: string) {}
    select() {
      return this;
    }
    private write(method: string, rows: unknown) {
      if (!db.allowWrites) throw new Error(`écriture interdite : ${method} sur ${this.table}`);
      this.written = { method, rows };
      return this;
    }
    insert(rows: unknown) {
      return this.write("insert", rows);
    }
    upsert(rows: unknown) {
      return this.write("upsert", rows);
    }
    update(rows: unknown) {
      return this.write("update", rows);
    }
    delete() {
      return this.write("delete", null);
    }
    eq(column: string, value: unknown) {
      // Les filtres JSON (`metadata->>observation_channel`) ne sont pas simulés : les lignes du jeu d'essai
      // sont déjà celles que la requête rendrait.
      if (!column.includes("->")) this.filters.push((row) => row[column] === value);
      return this;
    }
    neq(column: string, value: unknown) {
      this.filters.push((row) => row[column] !== value);
      return this;
    }
    is(column: string, value: unknown) {
      this.filters.push((row) => (row[column] ?? null) === value);
      return this;
    }
    in(column: string, values: unknown[]) {
      this.filters.push((row) => values.includes(row[column]));
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    then(resolve: (value: { data: Row[] | null; error: null }) => unknown) {
      if (this.written) {
        db.writes.push({ table: this.table, ...this.written });
        return Promise.resolve({ data: null, error: null }).then(resolve);
      }
      db.reads.push(this.table);
      const rows = (db.tables[this.table] ?? []).filter((row) =>
        this.filters.every((filter) => filter(row)),
      );
      return Promise.resolve({ data: rows, error: null }).then(resolve);
    }
  }
  return { supabaseAdmin: { from: (table: string) => new Query(table), rpc: db.rpc } };
});

import { loadInformationAgentContactSales } from "@/lib/admin-information-agent-sale";
import {
  assertInformationAgentContactAllowed,
  recordInformationAgentStructureOpposition,
} from "@/lib/information-agent/contacts";
import {
  measureInformationAgentRecipients,
  summarizeInformationAgentDryRun,
} from "@/lib/information-agent/dry-run";
import { missionRecipient } from "@/lib/information-agent/mission-identity";
import { recipientOppositionKeys } from "@/lib/information-agent/opposition-keys";

const ADMIN = { isAdmin: true, userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } as never;
const NOT_ADMIN = { isAdmin: false, userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } as never;
const measure = (saleIds: string[]) => measureInformationAgentRecipients({ auth: ADMIN, saleIds });

const id = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
const url = (source: string) => `https://annonces.example.test/${source}/1`;

function saleRow(n: number, source: string, organizerType: string, extra: Row = {}): Row {
  return {
    id: id(n),
    source_name: source,
    primary_source: source,
    source_url: url(source),
    source_urls: [url(source)],
    lawyer_name: null,
    lawyer_contact: null,
    description: null,
    observations: [],
    source_blocks: null,
    source_description: null,
    source_property_features: null,
    payload_sale_procedure: null,
    sale_procedure: { organizer_type: organizerType },
    city: "Bordeaux",
    tribunal: "Tribunal judiciaire de Bordeaux",
    ...extra,
  };
}

const SALES: Row[] = [
  saleRow(1, "notaires", "notary", {
    source_property_features: {
      contact: { name: "Jean Martin", email: "jean.martin@example.test" },
      listing: { office_crpcen: "33001" },
    },
  }),
  saleRow(2, "cessions_etat", "state_service", {
    source_property_features: {
      manager: {
        manager_name: "Claire Durand",
        email: "pgp.domaine@service-etat.example.test",
        direction_email: "pgp.domaine@service-etat.example.test",
        managers: [
          { name: "Claire Durand", email: "claire.durand@service-etat.example.test" },
          { name: "Paul Petit", email: "paul.petit@service-etat.example.test" },
        ],
      },
    },
  }),
  saleRow(3, "encheres_immobilieres", "pursuing_lawyer", {
    lawyer_name: "Maître Anne Leroy",
    lawyer_contact: "anne.leroy@cabinet-leroy.example.test",
    source_property_features: {
      lawyer: { name: "Maître Anne Leroy", email: "anne.leroy@cabinet-leroy.example.test" },
    },
  }),
  saleRow(4, "avoventes", "pursuing_lawyer", {
    lawyer_name: "SELARL Durand Avocats",
    source_property_features: {
      lawyer: { name: "SELARL Durand Avocats", email: "contact@cabinet-durand.example.test" },
    },
  }),
  saleRow(5, "licitor", "pursuing_lawyer", { lawyer_name: "Maître Jeanne Exemple" }),
  // Deux avocats de cabinets différents dans le champ de la vente : l'administrateur tranche.
  saleRow(6, "licitor", "pursuing_lawyer", {
    lawyer_contact: "a.un@cabinet-un.example.test / b.deux@cabinet-deux.example.test",
  }),
  // Aucune adresse.
  saleRow(7, "licitor", "pursuing_lawyer", { lawyer_contact: "Tél. : 05 00 00 00 07" }),
  // Adresse en opposition globale.
  saleRow(8, "avoventes", "pursuing_lawyer", {
    lawyer_contact: "maitre.oppose@cabinet-oppose.example.test",
  }),
];

beforeEach(() => {
  db.reads.length = 0;
  db.writes.length = 0;
  db.allowWrites = false;
  db.rpc.mockReset();
  db.tables = {
    auction_sales: SALES,
    information_agent_contacts: [
      {
        scope_sale_id: id(5),
        normalized_email: "jeanne.exemple@cabinet-exemple.example.test",
        email: "jeanne.exemple@cabinet-exemple.example.test",
        display_name: "Maître Jeanne Exemple, Avocat",
        role: "lawyer",
        source_name: "licitor",
        source_url: url("licitor"),
        source_kind: "sale_listing",
        observed_at: "2026-11-10T10:00:00.000Z",
        opposition_status: "unknown",
        bounce_status: "none",
      },
      {
        scope_sale_id: null,
        normalized_email: "maitre.oppose@cabinet-oppose.example.test",
        email: "maitre.oppose@cabinet-oppose.example.test",
        role: "lawyer",
        source_kind: null,
        opposition_status: "opposed",
        bounce_status: "none",
      },
    ],
    information_agent_identity_oppositions: [],
  };
});

describe("mesure à blanc des destinataires", () => {
  it("rend le destinataire, son rôle et l'origine, sans rien écrire ni envoyer", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const report = await measure([...SALES.map((row) => String(row.id)), id(9)]);

    expect(
      report.rows.map((row) => [row.sourceName, row.outcome, row.recipient?.roleLabel]),
    ).toEqual([
      ["notaires", "selected", "Notaire"],
      ["cessions_etat", "selected", "Service de l’État"],
      ["encheres_immobilieres", "selected", "Avocat"],
      ["avoventes", "selected", "Avocat"],
      ["licitor", "selected", "Avocat"],
      ["licitor", "ambiguous", undefined],
      ["licitor", "none", undefined],
      ["avoventes", "blocked", "Avocat"],
      [null, "not_found", undefined],
    ]);
    expect(report.rows[0].recipient).toEqual({
      email: "jean.martin@example.test",
      role: "notary",
      roleLabel: "Notaire",
      structureKind: "notary_office",
      addressKind: "nominative",
      confidence: "high",
      questionAudience: "notary",
      origin: {
        kind: "source_block",
        field: "source_property_features.contact.email",
        sourceName: "notaires",
        sourceUrl: url("notaires"),
      },
    });
    expect(report.rows[1].recipient).toMatchObject({
      email: "pgp.domaine@service-etat.example.test",
      addressKind: "generic",
      questionAudience: "state_service",
      origin: { sourceUrl: url("cessions_etat") },
    });
    expect(report.rows[2].recipient?.questionAudience).toBe("lawyer");
    expect(report.rows[7].blockedBy).toBe("address_opposed_or_bounced");

    expect(report.summary).toEqual({
      total: 9,
      byOutcome: { selected: 5, ambiguous: 1, none: 1, blocked: 1, not_found: 1 },
      selectedByRole: { notary: 1, "organizer:state_service": 1, lawyer: 3 },
      selectedByAddressKind: { nominative: 3, generic: 2 },
      bySource: {
        notaires: { selected: 1 },
        cessions_etat: { selected: 1 },
        encheres_immobilieres: { selected: 1 },
        avoventes: { selected: 1, blocked: 1 },
        licitor: { selected: 1, ambiguous: 1, none: 1 },
        unknown: { not_found: 1 },
      },
      blockedBy: { address_opposed_or_bounced: 1 },
      refused: { nominative_other_person: 1 },
      registryReadable: true,
    });

    // Aucune écriture (la base simulée lève sur insert, upsert, update, delete), aucun appel de fonction
    // de base, aucun appel réseau : ni brouillon, ni ligne de registre, ni envoi.
    expect(db.writes).toEqual([]);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(new Set(db.reads)).toEqual(
      new Set([
        "auction_sales",
        "information_agent_contacts",
        "information_agent_identity_oppositions",
      ]),
    );
    fetchSpy.mockRestore();
  });

  it("la mesure a sa propre garde d'administrateur, avant toute lecture", async () => {
    // Liste vide : la lecture des ventes (qui a sa garde aussi) n'est jamais atteinte. Seule la garde de la
    // mesure peut donc refuser.
    await expect(
      measureInformationAgentRecipients({ auth: NOT_ADMIN, saleIds: [] }),
    ).rejects.toThrow(AdminRequiredError);
    await expect(
      measureInformationAgentRecipients({ auth: NOT_ADMIN, saleIds: [id(1)] }),
    ).rejects.toThrow(AdminRequiredError);
    expect(db.reads).toEqual([]);
  });

  it("la lecture des ventes a sa propre garde d'administrateur", async () => {
    await expect(
      loadInformationAgentContactSales({ auth: { isAdmin: false }, saleIds: [id(1)] }),
    ).rejects.toThrow(AdminRequiredError);
    expect(db.reads).toEqual([]);
    const loaded = await loadInformationAgentContactSales({
      auth: { isAdmin: true },
      saleIds: [id(1)],
    });
    expect([...loaded.sales.keys()]).toEqual([id(1)]);
  });

  it("source `notaires` sans organisateur déclaré, office opposé, autre adresse dans `lawyer_contact` : aucun destinataire", async () => {
    db.tables.information_agent_identity_oppositions = [{ identity_key: "structure|office|33001" }];
    db.tables.auction_sales = [
      saleRow(1, "notaires", "unknown", {
        source_property_features: {
          contact: { name: "Jean Martin", email: "jean.martin@example.test" },
          listing: { office_crpcen: "33001" },
        },
        lawyer_contact: "autre.notaire@exemple-fictif.notaires.fr",
      }),
    ];
    const [row] = (await measure([id(1)])).rows;
    expect(row).toMatchObject({
      organizerType: "unknown",
      outcome: "blocked",
      blockedBy: "structure_opposed",
      recipient: null,
      candidateCount: 0,
    });
  });

  it("le résumé ne contient ni adresse ni identifiant de vente", async () => {
    const report = await measure(SALES.map((row) => String(row.id)));
    const summary = JSON.stringify(summarizeInformationAgentDryRun(report.rows, true));
    expect(summary).not.toContain("@");
    expect(summary).not.toContain("example.test");
    for (const row of SALES) expect(summary).not.toContain(String(row.id));
  });

  it("une structure opposée écarte toutes ses adresses, génériques ou nominatives", async () => {
    db.tables.information_agent_identity_oppositions = [
      { identity_key: "structure|office|33001" },
      { identity_key: "structure|domain|cabinet-leroy.example.test" },
    ];
    const report = await measure([id(1), id(3), id(4)]);
    expect(report.rows.map((row) => [row.outcome, row.blockedBy])).toEqual([
      ["blocked", "structure_opposed"],
      ["blocked", "structure_opposed"],
      ["selected", null],
    ]);
  });

  it("office opposé, autre adresse du même office : aucun destinataire", async () => {
    db.tables.information_agent_identity_oppositions = [{ identity_key: "structure|office|33001" }];
    // Le registre porte une autre adresse de l'office, sans code : elle reçoit celui de la vente.
    db.tables.information_agent_contacts.push({
      scope_sale_id: id(1),
      normalized_email: "autre.notaire@exemple-fictif.notaires.fr",
      email: "autre.notaire@exemple-fictif.notaires.fr",
      display_name: "Autre Notaire",
      role: "notary",
      source_name: "notaires",
      source_url: url("notaires"),
      source_kind: "sale_listing",
      observed_at: "2026-11-10T10:00:00.000Z",
      opposition_status: "unknown",
      bounce_status: "none",
    });
    const [row] = (await measure([id(1)])).rows;
    expect(row).toMatchObject({
      outcome: "blocked",
      blockedBy: "structure_opposed",
      recipient: null,
      candidateCount: 0,
    });
  });
});

describe("opposition au niveau de la structure", () => {
  const place = { bar: null, city: "Bordeaux" };

  it("refuse toute adresse d'une structure opposée, avec un message propre", async () => {
    db.tables.information_agent_identity_oppositions = [
      { identity_key: "structure|domain|cabinet-leroy.example.test" },
    ];
    const keysOf = (email: string) =>
      recipientOppositionKeys({ role: "lawyer", name: "Autre Avocat", place, email });
    const opposed = keysOf("autre.avocat@cabinet-leroy.example.test");
    await expect(
      assertInformationAgentContactAllowed({
        email: "autre.avocat@cabinet-leroy.example.test",
        saleId: id(3),
        identityKeys: opposed.identityKeys,
        checkKeys: opposed.checkKeys,
      }),
    ).rejects.toThrow("Cette structure");
    // Sans les clés à contrôler, l'adresse nominative passerait : ses clés portées n'ont pas la structure.
    expect(opposed.identityKeys).not.toContain("structure|domain|cabinet-leroy.example.test");
    const free = keysOf("contact@cabinet-durand.example.test");
    await expect(
      assertInformationAgentContactAllowed({
        email: "contact@cabinet-durand.example.test",
        saleId: id(4),
        identityKeys: free.identityKeys,
        checkKeys: free.checkKeys,
      }),
    ).resolves.toBeUndefined();
  });

  it("enregistre l'opposition par code d'office et par domaine propre, jamais par domaine partagé", async () => {
    db.allowWrites = true;
    await expect(
      recordInformationAgentStructureOpposition({
        auth: ADMIN,
        email: "etude@example.test",
        officeCode: "33001",
        opposedAt: "2026-11-11T10:00:00.000Z",
      }),
    ).resolves.toEqual(["structure|office|33001", "structure|domain|example.test"]);
    expect(db.writes).toEqual([
      {
        table: "information_agent_identity_oppositions",
        method: "upsert",
        rows: [
          { identity_key: "structure|office|33001", opposed_at: "2026-11-11T10:00:00.000Z" },
          { identity_key: "structure|domain|example.test", opposed_at: "2026-11-11T10:00:00.000Z" },
        ],
      },
    ]);
    db.writes.length = 0;
    for (const email of [
      "etude@exemple-fictif.notaires.fr",
      "cabinet.fictif@gmail.test",
      "contact@exemple-fictif.avocat.fr",
    ]) {
      await expect(
        recordInformationAgentStructureOpposition({ auth: ADMIN, email }),
      ).rejects.toThrow("Aucune structure identifiable");
    }
    expect(db.writes).toEqual([]);
  });

  it("l'enregistrement d'une opposition de structure est réservé à un administrateur", async () => {
    db.allowWrites = true;
    await expect(
      recordInformationAgentStructureOpposition({ auth: NOT_ADMIN, email: "etude@example.test" }),
    ).rejects.toThrow(AdminRequiredError);
    expect(db.writes).toEqual([]);
  });

  it("clés d'une mission : la structure est portée par l'adresse générique, contrôlée pour toutes", () => {
    const mission = {
      recipient_kind: "source_contact",
      recipient_name: "Jean Martin",
      metadata: {
        contact_identity: {
          role: "notary",
          bar: null,
          city: "Bordeaux",
          address_kind: "generic",
          office_code: "33001",
          sale_office_code: "33001",
        },
        contact_discovery: { selected_email: "etude@exemple-fictif.notaires.fr" },
        question_audience: "notary",
      },
    } as never;
    const structureKeys = (keys: string[]) => keys.filter((key) => key.startsWith("structure|"));

    // Adresse choisie par le brouillon, générique : elle porte la clé de l'office.
    const drafted = missionRecipient(mission, null, "Etude@exemple-fictif.notaires.fr");
    expect(structureKeys(drafted.keys.identityKeys)).toEqual(["structure|office|33001"]);
    expect(drafted).toMatchObject({
      role: "notary",
      addressKind: "generic",
      // « Jean Martin » est nommé : pied ordinaire, mais l'opposition vaudra pour l'étude.
      structureAddress: null,
      structureOpposition: "notary_office",
      questionAudience: "notary",
    });

    // Adresse nominative saisie sur le domaine partagé : elle ne porte pas la clé, mais l'office de la vente
    // reste contrôlé.
    const typedShared = missionRecipient(mission, null, "autre.notaire@exemple-fictif.notaires.fr");
    expect(structureKeys(typedShared.keys.identityKeys)).toEqual([]);
    expect(structureKeys(typedShared.keys.checkKeys)).toEqual(["structure|office|33001"]);
    expect(typedShared.structureOpposition).toBeNull();

    // Adresse saisie sur un domaine propre : identifiée par ce domaine, pas par l'office de la vente.
    const typedOwn = missionRecipient(mission, null, "jean.martin@example.test");
    expect(structureKeys(typedOwn.keys.identityKeys)).toEqual([]);
    expect(structureKeys(typedOwn.keys.checkKeys)).toEqual(["structure|domain|example.test"]);

    // Structure enregistrée par le brouillon : c'est elle qui choisit le mot du pied. Un service de l'État
    // (rôle `organizer`, que le rôle seul ne distingue pas) ne retombe pas sur la formule générale.
    const stateMission = (structureKind: unknown) =>
      missionRecipient(
        {
          recipient_kind: "source_contact",
          recipient_name: null,
          metadata: {
            contact_identity: {
              role: "organizer",
              city: "Bordeaux",
              structure_kind: structureKind,
              address_kind: "generic",
            },
            contact_discovery: { selected_email: "pgp.domaine@example.test" },
            question_audience: "state_service",
          },
        } as never,
        null,
        "pgp.domaine@example.test",
      );
    expect(stateMission("state_service")).toMatchObject({
      structureAddress: "state_service",
      structureOpposition: "state_service",
    });
    // Valeur enregistrée inconnue : jamais reprise telle quelle.
    expect(stateMission("ministere")).toMatchObject({
      structureAddress: "unknown",
      structureOpposition: "unknown",
    });

    // Brouillon antérieur à ce lot : aucun destinataire enregistré, et aucune valeur supposée à sa place
    // (l'aperçu et l'envoi le refusent : il doit être régénéré).
    const legacy = missionRecipient(
      { recipient_kind: "source_lawyer", recipient_name: null, metadata: {} } as never,
      null,
      "contact@example.test",
    );
    expect(legacy.questionAudience).toBeUndefined();
    // Adresse générique d'un avocat, sans nom : variante « structure », avec le mot du cabinet.
    expect(legacy).toMatchObject({
      role: "lawyer",
      structureAddress: "law_firm",
      structureOpposition: "law_firm",
    });
  });
});
