import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  mission: {} as Record<string, unknown>,
  contacts: [] as Array<Record<string, unknown>>,
  identityOppositions: [] as Array<Record<string, unknown>>,
  writes: [] as Array<[string, string, unknown]>,
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
    "Bonjour Maître Jean Dupont,\n\nPourriez-vous nous transmettre le procès-verbal descriptif ?",
};

beforeEach(() => {
  db.writes.length = 0;
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
      expect(output).not.toContain("outil de recherche automatisé");
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
        "Cette adresse a été retrouvée par un outil de recherche automatisé d’Immojudis, qui consulte ponctuellement des pages publiques ; seuls l’adresse retenue, le lien de la page et la date de consultation sont conservés. Ce message a été relu et validé par un membre de l’équipe avant envoi.",
      );
    }
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
    expect(result.preview.text).not.toContain("outil de recherche automatisé");
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
