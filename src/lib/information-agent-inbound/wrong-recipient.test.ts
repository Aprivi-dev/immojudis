import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  missions: [] as Array<{ recipient_identity_keys: string[] | null; metadata: unknown }>,
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({ limit: async () => ({ data: db.missions, error: null }) }),
      }),
    }),
    rpc: async (name: string, args: Record<string, unknown>) => {
      db.rpcs.push({ name, args });
      return { error: null };
    },
  },
}));

import { detectWrongRecipientSignal } from "./reply-intent";
import { applyWrongRecipient } from "./wrong-recipient";

beforeEach(() => {
  db.missions = [];
  db.rpcs = [];
});

describe("détection « ce n'est pas moi »", () => {
  it.each([
    "Bonjour, ce n'est pas moi qui suis en charge, vous vous trompez de destinataire.",
    "Je ne suis pas l'avocat poursuivant de ce dossier.",
    "Je ne suis pas l’avocat de cette vente.",
    "Erreur de destinataire, merci de vérifier.",
    "Mauvais destinataire.",
    "Je ne suis pas la bonne personne pour ce dossier.",
    "Je ne suis pas concerné par ce dossier.",
    "I am not the right person for this.",
    "Wrong recipient, sorry.",
  ])("formule sans ambiguïté : %s", (text) => {
    expect(detectWrongRecipientSignal(text)).toBe("strong");
  });

  it.each([
    "Ce dossier est suivi par un autre cabinet.",
    "Je ne suis pas concernée.",
    "Je vous invite à contacter mon confrère.",
    "Ce n'est pas notre dossier.",
  ])("vocabulaire voisin : le doute va en relecture humaine (%s)", (text) => {
    expect(detectWrongRecipientSignal(text)).toBe("possible");
  });

  it.each([
    "Bonjour, voici le cahier des conditions de vente. Cordialement.",
    "Oui, d'accord, pièces ci-jointes.",
    "",
  ])("aucun signal : %j", (text) => {
    expect(detectWrongRecipientSignal(text)).toBeNull();
  });

  it("ignore l'historique cité", () => {
    expect(
      detectWrongRecipientSignal(
        "Merci, voici les pièces.\n\n> Le 12/10, X a écrit :\n> ce n'est pas moi, mauvais destinataire",
      ),
    ).toBeNull();
  });
});

describe("applyWrongRecipient", () => {
  it("après un envoi du pilote : exclut l'identité, journalise et arrête le pilote (wrong_recipient)", async () => {
    db.missions = [
      {
        recipient_identity_keys: ["lawyer|bordeaux|dupont jean"],
        metadata: { trigger: "autopilot" },
      },
    ];

    const result = await applyWrongRecipient({ caseId: "case-1", source: "reply" });

    expect(result).toEqual({ stopped: true, excludedIdentities: 1 });
    expect(db.rpcs.map((call) => call.name)).toEqual([
      "record_information_agent_autopilot_exclusions",
      "record_information_agent_autopilot_event",
      "record_information_agent_autopilot_auto_stop",
    ]);
    expect(db.rpcs[0].args).toMatchObject({ p_identity_keys: ["lawyer|bordeaux|dupont jean"] });
    expect(db.rpcs[1].args).toMatchObject({ p_kind: "wrong_recipient" });
    expect(db.rpcs[2].args).toMatchObject({ p_reason: "wrong_recipient" });
    expect(JSON.stringify(db.rpcs)).not.toMatch(/@/);
  });

  it("après un envoi manuel : l'identité repasse en validation manuelle, le pilote n'est pas arrêté", async () => {
    db.missions = [{ recipient_identity_keys: ["lawyer|paris|martin anne"], metadata: {} }];

    const result = await applyWrongRecipient({ caseId: "case-2", source: "admin" });

    expect(result).toEqual({ stopped: false, excludedIdentities: 1 });
    expect(db.rpcs.map((call) => call.name)).not.toContain(
      "record_information_agent_autopilot_auto_stop",
    );
  });

  it("sans clé d'identité : journalisé, aucune exclusion inventée", async () => {
    db.missions = [{ recipient_identity_keys: [], metadata: {} }];
    const result = await applyWrongRecipient({ caseId: "case-3", source: "admin" });
    expect(result.excludedIdentities).toBe(0);
    expect(db.rpcs.map((call) => call.name)).toEqual(["record_information_agent_autopilot_event"]);
  });
});
