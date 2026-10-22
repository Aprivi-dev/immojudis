import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  mission: {} as Record<string, unknown>,
  contacts: [] as Array<Record<string, unknown>>,
  identityOppositions: [] as Array<Record<string, unknown>>,
  writes: [] as Array<[string, string, unknown]>,
  sale: null as Record<string, unknown> | null,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  class Query {
    private filters: Array<[string, unknown]> = [];
    constructor(private readonly table: string) {}
    select() {
      return this;
    }
    eq(column: string, value: unknown) {
      this.filters.push([column, value]);
      return this;
    }
    is(column: string, value: unknown) {
      this.filters.push([column, value]);
      return this;
    }
    in() {
      return this;
    }
    ilike() {
      return this;
    }
    overlaps() {
      return this;
    }
    neq() {
      return this;
    }
    gte() {
      return this;
    }
    lte() {
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    insert(values: unknown) {
      db.writes.push([this.table, "insert", values]);
      return this;
    }
    update(values: unknown) {
      db.writes.push([this.table, "update", values]);
      return this;
    }
    upsert(values: unknown) {
      db.writes.push([this.table, "upsert", values]);
      return this;
    }
    async single() {
      return { data: { ...db.mission }, error: null };
    }
    async maybeSingle() {
      // Relecture de la vente à l'aperçu et à l'envoi : disponible, sans date ni prix.
      return {
        data:
          this.table === "auction_sales"
            ? (db.sale ?? { status: "active", sale_date: null, starting_price_eur: null })
            : null,
        error: null,
      };
    }
    then(onFulfilled: (value: { data: unknown; error: null }) => unknown) {
      const data =
        this.table === "information_agent_contacts"
          ? db.contacts.filter((row) =>
              this.filters.every(([column, value]) => (row[column] ?? null) === value),
            )
          : this.table === "information_agent_identity_oppositions"
            ? db.identityOppositions
            : [];
      return Promise.resolve({ data, error: null }).then(onFulfilled);
    }
  }
  return {
    supabaseAdmin: {
      from: (table: string) => new Query(table),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    },
  };
});

const send = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email-alerts", () => ({ sendResendEmail: send }));

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  INFORMATION_AGENT_NO_QUESTION_MESSAGE,
  INFORMATION_AGENT_ORIGIN_REQUIRED_MESSAGE,
  previewAdminInformationAgentMission,
  runAdminInformationAgentAction,
} from "@/lib/information-agent";

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN = { isAdmin: true, userId: ADMIN_ID } as never;
const SALE_ID = "11111111-1111-4111-8111-111111111111";
const MISSION_ID = "22222222-2222-4222-8222-222222222222";
const content = {
  missionId: MISSION_ID,
  recipientEmail: "cabinet@example.test",
  recipientName: "Maître Jean Dupont",
  subject: "Appartement à Bordeaux — précisions pour Immojudis",
  bodyText:
    "Bonjour Maître Jean Dupont,\n\n- Pourriez-vous nous transmettre le procès-verbal descriptif ?",
};

beforeEach(() => {
  db.writes.length = 0;
  db.sale = null;
  db.identityOppositions = [];
  db.contacts = [
    {
      normalized_email: "cabinet@example.test",
      scope_sale_id: SALE_ID,
      source_kind: "sale_listing",
      source_name: "licitor",
      source_url: "https://www.licitor.com/annonce/109972.html",
      observed_at: "2026-10-12T08:00:00Z",
      observed_by: "agent",
      opposition_status: "unknown",
      bounce_status: "none",
    },
  ];
  db.mission = {
    id: MISSION_ID,
    user_id: ADMIN_ID,
    sale_id: SALE_ID,
    case_id: "33333333-3333-4333-8333-333333333333",
    status: "draft",
    recipient_email: "cabinet@example.test",
    recipient_kind: "source_lawyer",
    created_at: "2026-10-13T09:30:00Z",
    sale_snapshot: { title: "Appartement à Bordeaux", tribunal: "Tribunal judiciaire de Bordeaux" },
    metadata: { contact_identity: { role: "lawyer", bar: "Bordeaux", city: "Bordeaux" } },
  };
  vi.stubEnv(
    "INFORMATION_AGENT_PORTAL_SECRET",
    "portal-secret-that-is-at-least-32-characters-long",
  );
  vi.stubEnv("INFORMATION_AGENT_OUTBOUND_ENABLED", "true");
  vi.stubEnv("INFORMATION_AGENT_OUTBOUND_CANARY_ONLY", "false");
  vi.stubEnv("RESEND_API_KEY", "test-key");
  vi.stubEnv("INFORMATION_AGENT_EMAIL_FROM", "agent@example.test");
  vi.stubEnv("INFORMATION_AGENT_INBOUND_DOMAIN", "reponses.example.test");
  vi.stubEnv("SITE_URL", "https://immojudis.example");
  vi.stubEnv("NEXT_PUBLIC_LEGAL_ENTITY_NAME", "Immojudis SAS");
  vi.stubEnv("NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS", "1 rue de la Paix, 33000 Bordeaux");
  vi.stubEnv("NEXT_PUBLIC_LEGAL_CONTACT_EMAIL", "contact@immojudis.example");
  send.mockReset();
  vi.mocked(supabaseAdmin.rpc).mockClear();
});

afterEach(() => vi.unstubAllEnvs());

describe("aperçu obligatoire avant tout envoi manuel", () => {
  it("montre l'e-mail exact sans rien écrire ni envoyer", async () => {
    const result = await previewAdminInformationAgentMission({ auth: ADMIN, input: content });

    expect(result.blockers).toEqual([]);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.addressOrigin).toEqual({
      text: "Votre adresse professionnelle figure dans l’annonce publique de cette vente sur Licitor (https://www.licitor.com/annonce/109972.html), consultée le 12/10/2026.",
      url: "https://www.licitor.com/annonce/109972.html",
      automated: false,
      known: true,
    });
    for (const output of [result.preview.html, result.preview.text]) {
      expect(output).toContain("procès-verbal descriptif");
      expect(output).toContain("Immojudis SAS");
      expect(output).toContain("https://www.licitor.com/annonce/109972.html");
      expect(output).not.toContain("compte professionnel");
      expect(output).not.toContain("service professionnel");
      expect(output).toContain("https://immojudis.example/api/information-agent/opt-out?e=");
      // Pied art. 14 complet : catégories de données, destinataires dont l'IA, durées, droits,
      // opposition et réclamation CNIL.
      expect(output).toContain("Pourquoi ce message");
      expect(output).toContain("Appartement à Bordeaux");
      expect(output).toContain("Ce message ne contient aucune offre commerciale.");
      expect(output).toContain("votre nom, votre fonction, votre adresse professionnelle");
      expect(output).toContain("Replicate (États-Unis)");
      expect(output).toContain("12 mois si vous ne répondez pas");
      expect(output).toContain("12 mois si vous ne répondez pas");
      expect(output).toContain("24 mois après le dernier échange");
      expect(output).toContain("accès, rectification, effacement et limitation");
      expect(output).toContain("vous opposer à tout moment, sans motif");
      expect(output).toContain("https://www.cnil.fr/fr/plaintes");
      expect(output).not.toContain("retrouvée automatiquement");
    }
    expect(db.writes).toEqual([]);
    expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("signale un contact opposé et l'absence d'origine connue comme bloquants", async () => {
    db.contacts = [
      {
        normalized_email: "autre@example.test",
        scope_sale_id: null,
        opposition_status: "opposed",
        bounce_status: "none",
      },
    ];
    const result = await previewAdminInformationAgentMission({
      auth: ADMIN,
      input: { ...content, recipientEmail: "autre@example.test" },
    });

    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining("opposé"),
        INFORMATION_AGENT_ORIGIN_REQUIRED_MESSAGE,
      ]),
    );
    expect(db.writes).toEqual([]);
  });

  it("refuse un envoi dont le contenu a changé après l'aperçu, avant toute écriture", async () => {
    const { fingerprint } = await previewAdminInformationAgentMission({
      auth: ADMIN,
      input: content,
    });
    await expect(
      runAdminInformationAgentAction({
        auth: ADMIN,
        input: {
          action: "approve_and_send",
          approvalConfirmed: true,
          ...content,
          bodyText: `${content.bodyText}\n\nPhrase ajoutée après l'aperçu.`,
          previewFingerprint: fingerprint!,
        },
      }),
    ).rejects.toThrow("depuis l’aperçu");
    expect(db.writes).toEqual([]);
    expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("refuse une adresse saisie à la main sans page publique d'origine", async () => {
    const input = { ...content, recipientEmail: "trouvee@example.test" };
    const { fingerprint } = await previewAdminInformationAgentMission({ auth: ADMIN, input });
    await expect(
      runAdminInformationAgentAction({
        auth: ADMIN,
        input: {
          action: "approve_and_send",
          approvalConfirmed: true,
          ...input,
          previewFingerprint: fingerprint!,
        },
      }),
    ).rejects.toThrow(INFORMATION_AGENT_ORIGIN_REQUIRED_MESSAGE);
    expect(db.writes).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuse un envoi à un contact désinscrit même avec un aperçu valide", async () => {
    db.contacts.push({
      normalized_email: "cabinet@example.test",
      scope_sale_id: null,
      opposition_status: "opposed",
      bounce_status: "none",
    });
    const { fingerprint } = await previewAdminInformationAgentMission({
      auth: ADMIN,
      input: content,
    });
    await expect(
      runAdminInformationAgentAction({
        auth: ADMIN,
        input: {
          action: "approve_and_send",
          approvalConfirmed: true,
          ...content,
          previewFingerprint: fingerprint!,
        },
      }),
    ).rejects.toThrow("opposé");
    expect(db.writes).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("nomme l'annuaire officiel et signale la recherche automatique quand l'agent a trouvé l'adresse", async () => {
    vi.stubEnv("INFORMATION_AGENT_ADDRESS_SEARCH_ENABLED", "true");
    db.contacts = [
      {
        normalized_email: "cabinet@example.test",
        scope_sale_id: SALE_ID,
        source_kind: "official_directory",
        source_directory_name: "annuaire officiel des commissaires de justice",
        source_name: null,
        source_url: "https://annuaire.commissaire-justice.fr/etude-1",
        observed_at: "2026-10-14T10:00:00Z",
        observed_by: "agent",
        opposition_status: "unknown",
        bounce_status: "none",
      },
    ];
    const result = await previewAdminInformationAgentMission({ auth: ADMIN, input: content });

    expect(result.blockers).toEqual([]);
    expect(result.addressOrigin.text).toBe(
      "Votre adresse professionnelle figure sur votre fiche publique de l’annuaire officiel des commissaires de justice (https://annuaire.commissaire-justice.fr/etude-1), consultée le 14/10/2026.",
    );
    expect(result.addressOrigin.text).not.toContain("figure dans l’annonce");
    for (const output of [result.preview.html, result.preview.text]) {
      expect(output).toContain("fiche publique de l’annuaire officiel des commissaires de justice");
      expect(output).toContain(
        "Cette adresse a été retrouvée automatiquement par un outil d’Immojudis à partir d’une page publique (voir l’origine ci-dessus). L’outil ne conserve aucune copie de la page : seuls l’adresse, le lien de la page, la date de relevé et le critère de rapprochement utilisé sont enregistrés. Ce message a été relu et validé par un membre de l’équipe avant son envoi.",
      );
    }
  });

  const AUTOMATED_STATEMENT =
    "Cette adresse a été retrouvée automatiquement par un outil d’Immojudis à partir d’une page publique (voir l’origine ci-dessus). L’outil ne conserve aucune copie de la page : seuls l’adresse, le lien de la page, la date de relevé et le critère de rapprochement utilisé sont enregistrés. Ce message a été relu et validé par un membre de l’équipe avant son envoi.";

  const LISTING_STATEMENT =
    "Cette adresse a été retrouvée automatiquement par un outil d’Immojudis à partir d’une annonce publique déjà enregistrée par Immojudis (voir l’origine ci-dessus). L’outil ne conserve aucune copie de la page : seuls l’adresse, le lien de la page, la date de relevé et le critère de rapprochement utilisé sont enregistrés. Ce message a été relu et validé par un membre de l’équipe avant son envoi.";

  it("recherche niveau 1, source A : libellé « autre annonce » et mention de la recherche automatique", async () => {
    vi.stubEnv("INFORMATION_AGENT_ADDRESS_SEARCH_ENABLED", "true");
    db.contacts = [
      {
        normalized_email: "cabinet@example.test",
        scope_sale_id: SALE_ID,
        source_kind: "other_listing",
        source_name: "licitor",
        source_url: "https://www.licitor.com/annonce/2.html",
        observed_at: "2026-10-14T10:00:00Z",
        observed_by: "agent",
        opposition_status: "unknown",
        bounce_status: "none",
      },
    ];
    const result = await previewAdminInformationAgentMission({ auth: ADMIN, input: content });

    expect(result.blockers).toEqual([]);
    expect(result.addressOrigin).toEqual({
      text: "Votre adresse professionnelle figure dans une autre annonce publique de vente qui vous mentionne comme interlocuteur, sur Licitor (https://www.licitor.com/annonce/2.html) ; Immojudis l’a reprise de cette annonce le 14/10/2026.",
      url: "https://www.licitor.com/annonce/2.html",
      automated: true,
      searchSource: "other_listing",
      known: true,
    });
    expect(result.addressOrigin.text).not.toContain("annonce publique de cette vente");
    for (const output of [result.preview.html, result.preview.text]) {
      expect(output).toContain("figure dans une autre annonce publique de vente");
      expect(output).toContain("https://www.licitor.com/annonce/2.html");
      expect(output).toContain(LISTING_STATEMENT);
      expect(output).not.toContain("à partir d’une page publique");
    }
  });

  it("recherche niveau 1, source B : libellé « site du cabinet » et mention de la recherche automatique", async () => {
    vi.stubEnv("INFORMATION_AGENT_ADDRESS_SEARCH_ENABLED", "true");
    db.contacts = [
      {
        normalized_email: "cabinet@example.test",
        scope_sale_id: SALE_ID,
        source_kind: "firm_website",
        source_name: null,
        source_url: "https://www.cabinet-dupont.test/contact",
        observed_at: "2026-10-14T10:00:00Z",
        observed_by: "agent",
        opposition_status: "unknown",
        bounce_status: "none",
      },
    ];
    const result = await previewAdminInformationAgentMission({ auth: ADMIN, input: content });

    expect(result.blockers).toEqual([]);
    expect(result.addressOrigin).toEqual({
      text: "Votre adresse professionnelle figure sur le site de votre cabinet ou de votre étude (https://www.cabinet-dupont.test/contact), consulté le 14/10/2026.",
      url: "https://www.cabinet-dupont.test/contact",
      automated: true,
      searchSource: "firm_website",
      known: true,
    });
    for (const output of [result.preview.html, result.preview.text]) {
      expect(output).toContain("figure sur le site de votre cabinet ou de votre étude");
      expect(output).toContain("https://www.cabinet-dupont.test/contact");
      expect(output).toContain(AUTOMATED_STATEMENT);
      expect(output).toContain("Immojudis SAS");
    }
  });

  it("une adresse trouvée par l'agent sans lien exact n'est pas acceptée (autre annonce, site)", async () => {
    vi.stubEnv("INFORMATION_AGENT_ADDRESS_SEARCH_ENABLED", "true");
    for (const source_kind of ["other_listing", "firm_website"]) {
      db.contacts = [
        {
          normalized_email: "cabinet@example.test",
          scope_sale_id: SALE_ID,
          source_kind,
          source_url: null,
          observed_at: "2026-10-14T10:00:00Z",
          observed_by: "agent",
          opposition_status: "unknown",
          bounce_status: "none",
        },
      ];
      const result = await previewAdminInformationAgentMission({ auth: ADMIN, input: content });
      expect(result.addressOrigin.known, source_kind).toBe(false);
      expect(result.blockers).toContain(INFORMATION_AGENT_ORIGIN_REQUIRED_MESSAGE);
    }
  });

  describe("adresse retrouvée par l'agent : l'origine vient du seul registre", () => {
    const MISSING =
      "L’adresse retrouvée par la recherche automatique n’a plus de ligne de registre de l’agent";
    const asAgentFound = () => {
      db.mission = {
        ...db.mission,
        metadata: {
          ...(db.mission.metadata as Record<string, unknown>),
          contact_discovery: { method: "agent_search_firm_website" },
        },
      };
    };
    const manualUrl = "https://cabinet-dupont.example.test/contact";

    beforeEach(() => {
      vi.stubEnv("INFORMATION_AGENT_ADDRESS_SEARCH_ENABLED", "true");
      asAgentFound();
    });

    it("sans ligne de registre, une URL saisie à la main ne remplace pas l'origine", async () => {
      db.contacts = [];
      const result = await previewAdminInformationAgentMission({
        auth: ADMIN,
        input: { ...content, recipientOriginUrl: manualUrl },
      });
      expect(result.addressOrigin.known).toBe(false);
      expect(result.blockers).toContain(INFORMATION_AGENT_ORIGIN_REQUIRED_MESSAGE);
      expect(result.blockers.join(" ")).toContain(MISSING);
    });

    it("une ligne de saisie d'administrateur ne remplace pas non plus la ligne de l'agent", async () => {
      db.contacts = [
        {
          normalized_email: "cabinet@example.test",
          scope_sale_id: SALE_ID,
          source_kind: "admin_entry",
          source_url: manualUrl,
          observed_at: "2026-10-14T10:00:00Z",
          observed_by: "admin",
          opposition_status: "unknown",
          bounce_status: "none",
        },
      ];
      const result = await previewAdminInformationAgentMission({
        auth: ADMIN,
        input: { ...content, recipientOriginUrl: manualUrl },
      });
      expect(result.blockers.join(" ")).toContain(MISSING);
    });

    it("refuse l'envoi dans les deux cas, sans rien écrire", async () => {
      db.contacts = [];
      const { fingerprint } = await previewAdminInformationAgentMission({
        auth: ADMIN,
        input: { ...content, recipientOriginUrl: manualUrl },
      });
      await expect(
        runAdminInformationAgentAction({
          auth: ADMIN,
          input: {
            action: "approve_and_send",
            approvalConfirmed: true,
            ...content,
            recipientOriginUrl: manualUrl,
            previewFingerprint: fingerprint!,
          },
        }),
      ).rejects.toThrow(INFORMATION_AGENT_ORIGIN_REQUIRED_MESSAGE);
      expect(db.writes).toEqual([]);
      expect(send).not.toHaveBeenCalled();

      db.contacts = [
        {
          normalized_email: "cabinet@example.test",
          scope_sale_id: SALE_ID,
          source_kind: "admin_entry",
          source_url: manualUrl,
          observed_at: "2026-10-14T10:00:00Z",
          observed_by: "admin",
          opposition_status: "unknown",
          bounce_status: "none",
        },
      ];
      await expect(
        runAdminInformationAgentAction({
          auth: ADMIN,
          input: {
            action: "approve_and_send",
            approvalConfirmed: true,
            ...content,
            recipientOriginUrl: manualUrl,
            previewFingerprint: fingerprint!,
          },
        }),
      ).rejects.toThrow(MISSING);
      expect(db.writes).toEqual([]);
    });

    it("avec sa ligne de registre, l'aperçu est valable (source agent, mention de la recherche)", async () => {
      db.contacts = [
        {
          normalized_email: "cabinet@example.test",
          scope_sale_id: SALE_ID,
          source_kind: "firm_website",
          source_url: "https://www.cabinet-dupont.test/contact",
          observed_at: "2026-10-14T10:00:00Z",
          observed_by: "agent",
          opposition_status: "unknown",
          bounce_status: "none",
        },
      ];
      const result = await previewAdminInformationAgentMission({ auth: ADMIN, input: content });
      expect(result.blockers).toEqual([]);
      expect(result.addressOrigin.automated).toBe(true);
    });

    it("un destinataire modifié par l'administrateur suit la voie ordinaire (page publique saisie)", async () => {
      db.contacts = [];
      const result = await previewAdminInformationAgentMission({
        auth: ADMIN,
        input: {
          ...content,
          recipientEmail: "autre@example.test",
          recipientOriginUrl: manualUrl,
        },
      });
      expect(result.blockers.join(" ")).not.toContain(MISSING);
      expect(result.addressOrigin.known).toBe(true);
    });
  });

  describe("interrupteur de la recherche automatique d'adresse", () => {
    const SWITCH_OFF =
      "La recherche automatique d’adresse est désactivée : cette adresse ne peut pas être utilisée pour un envoi.";
    const agentRow = (source_kind: string, extra: Record<string, unknown> = {}) => ({
      normalized_email: "cabinet@example.test",
      scope_sale_id: SALE_ID,
      source_kind,
      source_name: null,
      source_url: "https://www.cabinet-dupont.test/contact",
      observed_at: "2026-10-14T10:00:00Z",
      observed_by: "agent",
      opposition_status: "unknown",
      bounce_status: "none",
      ...extra,
    });

    it.each([undefined, "", "false", "TRUE", "1", "true "])(
      "bloque l'aperçu d'une adresse trouvée par l'agent quand la variable vaut %j",
      async (value) => {
        if (value !== undefined) vi.stubEnv("INFORMATION_AGENT_ADDRESS_SEARCH_ENABLED", value);
        for (const kind of ["other_listing", "firm_website", "official_directory"]) {
          db.contacts = [
            agentRow(
              kind,
              kind === "official_directory"
                ? { source_directory_name: "annuaire du barreau de Lyon" }
                : {},
            ),
          ];
          const result = await previewAdminInformationAgentMission({ auth: ADMIN, input: content });
          expect(result.blockers, kind).toContain(SWITCH_OFF);
        }
      },
    );

    it("n'affecte ni l'annonce de la vente ni une adresse saisie par un administrateur", async () => {
      // Interrupteur absent : annonce de la vente (beforeEach) et saisie manuelle restent possibles.
      const listing = await previewAdminInformationAgentMission({ auth: ADMIN, input: content });
      expect(listing.blockers).not.toContain(SWITCH_OFF);
      db.contacts = [];
      const manual = await previewAdminInformationAgentMission({
        auth: ADMIN,
        input: { ...content, recipientOriginUrl: "https://cabinet-dupont.example.test/contact" },
      });
      expect(manual.blockers).not.toContain(SWITCH_OFF);
      db.contacts = [agentRow("admin_entry", { observed_by: "admin" })];
      const admin = await previewAdminInformationAgentMission({ auth: ADMIN, input: content });
      expect(admin.blockers).not.toContain(SWITCH_OFF);
    });

    it("n'ajoute aucun motif quand l'interrupteur vaut exactement `true`", async () => {
      vi.stubEnv("INFORMATION_AGENT_ADDRESS_SEARCH_ENABLED", "true");
      db.contacts = [agentRow("firm_website")];
      const result = await previewAdminInformationAgentMission({ auth: ADMIN, input: content });
      expect(result.blockers).toEqual([]);
    });

    it("refuse aussi l'envoi d'une adresse trouvée par l'agent, même avec un aperçu valide", async () => {
      db.contacts = [agentRow("other_listing", { source_name: "licitor" })];
      const { fingerprint } = await previewAdminInformationAgentMission({
        auth: ADMIN,
        input: content,
      });
      await expect(
        runAdminInformationAgentAction({
          auth: ADMIN,
          input: {
            action: "approve_and_send",
            approvalConfirmed: true,
            ...content,
            previewFingerprint: fingerprint!,
          },
        }),
      ).rejects.toThrow(SWITCH_OFF);
      expect(db.writes).toEqual([]);
      expect(send).not.toHaveBeenCalled();
    });
  });

  it("n'accepte pas pour un annuaire une adresse sans lien exact", async () => {
    db.contacts = [
      {
        normalized_email: "cabinet@example.test",
        scope_sale_id: SALE_ID,
        source_kind: "official_directory",
        source_directory_name: "annuaire du barreau de Lyon",
        source_url: null,
        observed_at: "2026-10-14T10:00:00Z",
        observed_by: "agent",
        opposition_status: "unknown",
        bounce_status: "none",
      },
    ];
    const result = await previewAdminInformationAgentMission({ auth: ADMIN, input: content });
    expect(result.addressOrigin.known).toBe(false);
    expect(result.blockers).toContain(INFORMATION_AGENT_ORIGIN_REQUIRED_MESSAGE);
  });

  it("date une adresse saisie à la main du brouillon et cite la page indiquée", async () => {
    db.contacts = [];
    const result = await previewAdminInformationAgentMission({
      auth: ADMIN,
      input: { ...content, recipientOriginUrl: "https://cabinet-dupont.example.test/contact" },
    });
    expect(result.blockers).toEqual([]);
    expect(result.addressOrigin.text).toBe(
      "Votre adresse professionnelle a été relevée par un membre de l’équipe Immojudis sur une page publique (https://cabinet-dupont.example.test/contact), le 13/10/2026.",
    );
    expect(result.addressOrigin.automated).toBe(false);
    expect(result.preview.text).not.toContain("retrouvée automatiquement");
  });

  it("relit la vente : bloque un brouillon devenu inexact ou sans objet", async () => {
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    db.mission = {
      ...db.mission,
      sale_snapshot: { sale_date: future, starting_price_eur: 85000 },
    };
    db.sale = { status: "active", sale_date: future, starting_price_eur: 85000 };
    expect(
      (await previewAdminInformationAgentMission({ auth: ADMIN, input: content })).blockers,
    ).toEqual([]);

    db.sale = { status: "active", sale_date: future, starting_price_eur: 95000 };
    expect(
      (await previewAdminInformationAgentMission({ auth: ADMIN, input: content })).blockers,
    ).toContain(
      "La vente a changé depuis la préparation du brouillon (la mise à prix) : régénérez le brouillon pour que le message reste exact.",
    );

    db.sale = { status: "withdrawn", sale_date: future, starting_price_eur: 85000 };
    expect(
      (await previewAdminInformationAgentMission({ auth: ADMIN, input: content })).blockers.join(
        " ",
      ),
    ).toContain("n’est plus disponible");

    db.sale = { status: "active", sale_date: "2026-01-10T10:00:00Z", starting_price_eur: 85000 };
    expect(
      (await previewAdminInformationAgentMission({ auth: ADMIN, input: content })).blockers.join(
        " ",
      ),
    ).toContain("date annoncée de la vente est passée");
  });

  it("bloque l'aperçu et l'envoi d'un message dont toutes les questions ont été retirées", async () => {
    const input = {
      ...content,
      bodyText: "Bonjour Maître Jean Dupont,\n\nPourriez-vous nous préciser les points suivants ?",
    };
    const { blockers, fingerprint } = await previewAdminInformationAgentMission({
      auth: ADMIN,
      input,
    });
    expect(blockers).toContain(INFORMATION_AGENT_NO_QUESTION_MESSAGE);
    await expect(
      runAdminInformationAgentAction({
        auth: ADMIN,
        input: {
          action: "approve_and_send",
          approvalConfirmed: true,
          ...input,
          previewFingerprint: fingerprint!,
        },
      }),
    ).rejects.toThrow("aucune question");
  });

  it("bloque l'aperçu quand le texte contient une mention commerciale", async () => {
    const result = await previewAdminInformationAgentMission({
      auth: ADMIN,
      input: {
        ...content,
        bodyText: `${content.bodyText}\n\nCréez un compte sur Immojudis pour une mise en avant de vos ventes.`,
      },
    });
    expect(result.blockers.join(" ")).toContain("aucune mention commerciale");
  });

  it("refuse l'envoi d'un texte commercial même avec un aperçu valide", async () => {
    const input = {
      ...content,
      bodyText: `${content.bodyText}\n\nDécouvrez nos offres : https://immojudis.example/offres`,
    };
    const { fingerprint } = await previewAdminInformationAgentMission({ auth: ADMIN, input });
    await expect(
      runAdminInformationAgentAction({
        auth: ADMIN,
        input: {
          action: "approve_and_send",
          approvalConfirmed: true,
          ...input,
          previewFingerprint: fingerprint!,
        },
      }),
    ).rejects.toThrow("aucune mention commerciale");
    expect(db.writes).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("bloque l'aperçu et l'envoi pour un professionnel opposé sous une autre adresse", async () => {
    db.identityOppositions = [{ identity_key: "lawyer|bordeaux|dupont jean" }];
    const result = await previewAdminInformationAgentMission({
      auth: ADMIN,
      input: { ...content, recipientEmail: "nouvelle-adresse@example.test" },
    });
    expect(result.blockers.join(" ")).toContain("s'est opposé à être contacté");

    const { fingerprint } = await previewAdminInformationAgentMission({
      auth: ADMIN,
      input: content,
    });
    await expect(
      runAdminInformationAgentAction({
        auth: ADMIN,
        input: {
          action: "approve_and_send",
          approvalConfirmed: true,
          ...content,
          previewFingerprint: fingerprint!,
        },
      }),
    ).rejects.toThrow("s'est opposé à être contacté");
    expect(db.writes).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("bloque l'aperçu quand le prestataire d'IA configuré n'est pas nommé dans le pied", async () => {
    vi.stubEnv("LLM_PROVIDER", "autre-prestataire");
    const result = await previewAdminInformationAgentMission({ auth: ADMIN, input: content });
    expect(result.blockers.join(" ")).toContain(
      "Prestataire d’IA « autre-prestataire » non identifié",
    );
  });

  it("refuse une adresse de juridiction, de RPVA, de l'Ordre ou technique dans l'aperçu", async () => {
    for (const recipientEmail of [
      "greffe@tj-bordeaux.justice.fr",
      "me@avocat-conseil.fr",
      "carpa@example.test",
      "dpo@cabinet.example.test",
    ]) {
      const result = await previewAdminInformationAgentMission({
        auth: ADMIN,
        input: { ...content, recipientEmail },
      });
      expect(result.blockers.join(" ")).toContain("n’est jamais sollicitée par l’agent");
    }
  });

  it("bloque une adresse saisie dont la page d'origine est un réseau social ou un annuaire exclu", async () => {
    db.contacts = [];
    for (const recipientOriginUrl of [
      "https://www.linkedin.com/in/jean-dupont",
      "https://www.notaires.fr/fr/office/etude-x",
      "https://www.avocatparis.org/annuaire/avocat/1",
    ]) {
      const result = await previewAdminInformationAgentMission({
        auth: ADMIN,
        input: { ...content, recipientOriginUrl },
      });
      expect(result.blockers.join(" ")).toContain("n’est pas une source admise");
    }
  });

  it("refuse l'envoi d'une adresse saisie dont la page d'origine est exclue", async () => {
    db.contacts = [];
    const input = { ...content, recipientOriginUrl: "https://www.facebook.com/cabinet" };
    const { fingerprint } = await previewAdminInformationAgentMission({ auth: ADMIN, input });
    await expect(
      runAdminInformationAgentAction({
        auth: ADMIN,
        input: {
          action: "approve_and_send",
          approvalConfirmed: true,
          ...input,
          previewFingerprint: fingerprint!,
        },
      }),
    ).rejects.toThrow("n’est pas une source admise");
    expect(db.writes).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuse l'envoi sans adresse de contact du responsable de traitement", async () => {
    vi.stubEnv("NEXT_PUBLIC_LEGAL_CONTACT_EMAIL", "");
    const result = await previewAdminInformationAgentMission({ auth: ADMIN, input: content });
    expect(result.blockers.join(" ")).toContain("NEXT_PUBLIC_LEGAL_CONTACT_EMAIL");
  });
});
