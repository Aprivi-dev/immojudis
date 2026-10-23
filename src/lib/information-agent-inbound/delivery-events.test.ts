import type { EmailBouncedEvent, EmailComplainedEvent } from "resend";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  existing: null as { bounce_status: string } | null,
  upserts: [] as Array<{ table: string; row: Record<string, unknown>; options: unknown }>,
  failUpsert: false,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => ({
        is: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: db.existing, error: null }) }),
        }),
      }),
      upsert: async (row: Record<string, unknown>, options: unknown) => {
        db.upserts.push({ table, row, options });
        return { error: db.failUpsert ? new Error("write failed") : null };
      },
    }),
  },
}));

import {
  bounceStatusOf,
  deliveryActionOf,
  informationAgentSenderAddress,
  processDeliveryEvent,
} from "./delivery-events";

const ENV = { INFORMATION_AGENT_EMAIL_FROM: "Assistant Immojudis <assistant@immojudis.com>" };

function bounced(
  type: string,
  overrides: Partial<EmailBouncedEvent["data"]> = {},
): EmailBouncedEvent {
  return {
    type: "email.bounced",
    created_at: "2026-10-23T10:00:00.000Z",
    data: {
      created_at: "2026-10-23T10:00:00.000Z",
      email_id: "email-1",
      message_id: "message-1",
      from: "Assistant Immojudis <assistant@immojudis.com>",
      to: ["Cabinet <Contact@Example.test>"],
      subject: "Informations complémentaires",
      bounce: { message: "mailbox does not exist", subType: "General", type },
      ...overrides,
    },
  } as EmailBouncedEvent;
}

function complained(overrides: Partial<EmailComplainedEvent["data"]> = {}): EmailComplainedEvent {
  return {
    type: "email.complained",
    created_at: "2026-10-23T11:00:00.000Z",
    data: {
      created_at: "2026-10-23T11:00:00.000Z",
      email_id: "email-2",
      message_id: "message-2",
      from: "assistant@immojudis.com",
      to: ["contact@example.test"],
      subject: "Informations complémentaires",
      ...overrides,
    },
  } as EmailComplainedEvent;
}

beforeEach(() => {
  db.existing = null;
  db.upserts = [];
  db.failUpsert = false;
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("deliveryActionOf", () => {
  const agent = informationAgentSenderAddress(ENV);

  it("lit l'adresse d'expéditeur de l'agent, sans le nom affiché", () => {
    expect(agent).toBe("assistant@immojudis.com");
    expect(informationAgentSenderAddress({})).toBeNull();
    expect(informationAgentSenderAddress({ INFORMATION_AGENT_EMAIL_FROM: "pas une adresse" })).toBe(
      null,
    );
  });

  it("transforme un rebond définitif en `permanent`, un rebond passager ou indéterminé en `temporary`", () => {
    expect(deliveryActionOf(bounced("Permanent"), agent)).toMatchObject({
      kind: "bounce",
      status: "permanent",
      emails: ["contact@example.test"],
      at: "2026-10-23T10:00:00.000Z",
    });
    for (const type of ["Transient", "Undetermined", "", "inconnu"]) {
      expect(deliveryActionOf(bounced(type), agent)).toMatchObject({
        kind: "bounce",
        status: "temporary",
      });
    }
    expect(bounceStatusOf(undefined)).toBe("temporary");
    expect(bounceStatusOf(" permanent ")).toBe("permanent");
  });

  it("traite une plainte comme une opposition, pour chaque destinataire distinct", () => {
    expect(
      deliveryActionOf(
        complained({ to: ["a@example.test", "A@example.test", "b@example.test"] }),
        agent,
      ),
    ).toEqual({
      kind: "complaint",
      emails: ["a@example.test", "b@example.test"],
      at: "2026-10-23T11:00:00.000Z",
    });
  });

  it("ignore un email qui n'est pas celui de l'agent (alertes aux comptes) ou sans destinataire lisible", () => {
    expect(
      deliveryActionOf(bounced("Permanent", { from: "Immojudis <alertes@immojudis.com>" }), agent),
    ).toBeNull();
    expect(deliveryActionOf(bounced("Permanent"), null)).toBeNull();
    expect(deliveryActionOf(bounced("Permanent", { to: ["pas une adresse"] }), agent)).toBeNull();
    expect(deliveryActionOf(bounced("Permanent", { to: [] }), agent)).toBeNull();
  });
});

describe("processDeliveryEvent", () => {
  it("écrit `bounce_status = permanent` et la date sur l'adresse, sans portée de vente", async () => {
    const result = await processDeliveryEvent(bounced("Permanent"), ENV);
    expect(result).toEqual({ accepted: true });
    expect(db.upserts).toEqual([
      {
        table: "information_agent_contacts",
        row: {
          sale_id: null,
          scope_sale_id: null,
          email: "contact@example.test",
          bounce_status: "permanent",
          bounced_at: "2026-10-23T10:00:00.000Z",
        },
        options: { onConflict: "scope_sale_id,normalized_email" },
      },
    ]);
  });

  it("n'écrit un rebond passager que s'il ne défait pas un rebond définitif", async () => {
    db.existing = { bounce_status: "permanent" };
    await processDeliveryEvent(bounced("Transient"), ENV);
    expect(db.upserts).toEqual([]);
    db.existing = { bounce_status: "none" };
    await processDeliveryEvent(bounced("Transient"), ENV);
    expect(db.upserts[0].row).toMatchObject({ bounce_status: "temporary" });
  });

  it("enregistre l'opposition de l'adresse après une plainte", async () => {
    await processDeliveryEvent(complained(), ENV);
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0].row).toMatchObject({
      email: "contact@example.test",
      opposition_status: "opposed",
      opposed_at: "2026-10-23T11:00:00.000Z",
    });
  });

  it("ne touche à rien pour un autre expéditeur, et le dit sans écrire", async () => {
    const result = await processDeliveryEvent(
      bounced("Permanent", { from: "alertes@immojudis.com" }),
      ENV,
    );
    expect(result).toEqual({ accepted: true, ignored: true });
    expect(db.upserts).toEqual([]);
  });

  it("laisse remonter une erreur d'écriture : le fournisseur rejouera l'évènement", async () => {
    db.failUpsert = true;
    await expect(processDeliveryEvent(bounced("Permanent"), ENV)).rejects.toThrow("write failed");
  });

  it("ne met aucune adresse dans le journal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await processDeliveryEvent(bounced("Permanent"), ENV);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({ event: "bounce_permanent", recipients: 1 });
    expect(line).not.toMatch(/@|example\.test/);
  });
});
