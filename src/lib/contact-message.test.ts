import { describe, expect, it, vi } from "vitest";
import {
  buildContactEmail,
  createContactLimiter,
  deliverContact,
  validateContact,
} from "./contact-message";

const valid = {
  name: "Claire Martin",
  email: "Claire@Example.fr",
  subject: "annonce",
  message: "Pouvez-vous confirmer la date de la vente de Bordeaux ?",
};

describe("validateContact", () => {
  it("accepte un message complet et normalise l'email", () => {
    const result = validateContact(valid);
    expect(result).toEqual({
      ok: true,
      data: { ...valid, email: "claire@example.fr" },
    });
  });

  it("signale chaque champ manquant en français", () => {
    const result = validateContact({ name: "", email: "x", subject: "inconnu", message: "court" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors).toEqual({
        name: "Indiquez votre nom.",
        email: "Cette adresse email n’est pas valide.",
        subject: "Choisissez un sujet.",
        message: "Décrivez votre demande en quelques phrases.",
      });
    }
  });

  it("refuse un message trop long", () => {
    const result = validateContact({ ...valid, message: "a".repeat(4001) });
    expect(result.ok).toBe(false);
  });
});

describe("buildContactEmail", () => {
  it("répond à l'expéditeur et ne laisse passer aucun retour à la ligne dans le sujet", () => {
    const parsed = validateContact({ ...valid, name: "Claire\r\nBcc: attaquant@example.test" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const email = buildContactEmail(parsed.data, {
      to: "contact@immojudis.test",
      from: "Immojudis <a@b.test>",
    });
    expect(email.replyTo).toBe("claire@example.fr");
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.subject).toContain("Question sur une annonce");
    expect(email.text).toContain("Pouvez-vous confirmer");
  });
});

describe("createContactLimiter", () => {
  it("limite le nombre d'envois par poste sur la fenêtre", () => {
    let now = 0;
    const limiter = createContactLimiter({ perClient: 2, windowMs: 1000, now: () => now });
    expect(limiter.consume("a")).toBe(true);
    expect(limiter.consume("a")).toBe(true);
    expect(limiter.consume("a")).toBe(false);
    expect(limiter.consume("b")).toBe(true);
    now = 1500;
    expect(limiter.consume("a")).toBe(true);
  });

  it("plafonne aussi le total horaire", () => {
    const limiter = createContactLimiter({ perClient: 10, global: 2 });
    expect(limiter.consume("a")).toBe(true);
    expect(limiter.consume("b")).toBe(true);
    expect(limiter.consume("c")).toBe(false);
  });
});

describe("deliverContact", () => {
  const deps = () => ({
    limiter: createContactLimiter(),
    to: "contact@immojudis.test",
    from: "Immojudis <alertes@immojudis.test>",
    send: vi.fn().mockResolvedValue({ error: null }),
  });

  it("envoie l'email puis confirme", async () => {
    const d = deps();
    const state = await deliverContact(valid, "ip-1", d);
    expect(state.status).toBe("sent");
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.send.mock.calls[0][0]).toMatchObject({
      to: "contact@immojudis.test",
      replyTo: "claire@example.fr",
    });
  });

  it("n'envoie rien quand le piège à robots est rempli", async () => {
    const d = deps();
    const state = await deliverContact({ ...valid, website: "http://spam.test" }, "ip-1", d);
    expect(state.status).toBe("sent");
    expect(d.send).not.toHaveBeenCalled();
  });

  it("renvoie les erreurs de champ et conserve la saisie", async () => {
    const d = deps();
    const state = await deliverContact({ ...valid, email: "pas-un-email" }, "ip-1", d);
    expect(state.status).toBe("error");
    expect(state.fieldErrors?.email).toBeTruthy();
    expect(state.values?.name).toBe("Claire Martin");
    expect(d.send).not.toHaveBeenCalled();
  });

  it("applique la limite de débit avec un message en français", async () => {
    const d = { ...deps(), limiter: createContactLimiter({ perClient: 1 }) };
    await deliverContact(valid, "ip-1", d);
    const second = await deliverContact(valid, "ip-1", d);
    expect(second.status).toBe("error");
    expect(second.message).toContain("Trop de messages envoyés");
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it("dit que le formulaire est indisponible quand l'envoi n'est pas configuré", async () => {
    const state = await deliverContact(valid, "ip-1", {
      limiter: createContactLimiter(),
      to: null,
      from: null,
    });
    expect(state.status).toBe("error");
    expect(state.message).toContain("pas disponible");
  });

  it("masque l'erreur technique du fournisseur d'envoi", async () => {
    const d = {
      ...deps(),
      send: vi.fn().mockResolvedValue({ error: { message: "API key invalid re_123" } }),
    };
    const state = await deliverContact(valid, "ip-1", d);
    expect(state.status).toBe("error");
    expect(state.message).not.toMatch(/re_123|API key/);
  });
});
