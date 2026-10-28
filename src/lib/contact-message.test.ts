import { describe, expect, it, vi } from "vitest";
import { LAWYER_CONTACT_HREF } from "./lawyer-placement-label";
import {
  buildContactEmail,
  contactFailureLine,
  contactPrefill,
  contactReportPath,
  deliverContact,
  validateContact,
} from "./contact-message";

/** Limiteur de test : autorise `max` envois, puis refuse. */
function limiterAllowing(max = Infinity) {
  let used = 0;
  return { consume: vi.fn(() => ++used <= max) };
}

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

describe("deliverContact", () => {
  const deps = () => ({
    limiter: limiterAllowing(),
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
    const d = { ...deps(), limiter: limiterAllowing(1) };
    await deliverContact(valid, "ip-1", d);
    const second = await deliverContact(valid, "ip-1", d);
    expect(second.status).toBe("error");
    expect(second.message).toContain("Trop de messages envoyés");
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it("dit que le formulaire est indisponible quand l'envoi n'est pas configuré", async () => {
    const state = await deliverContact(valid, "ip-1", {
      limiter: limiterAllowing(),
      to: null,
      from: null,
    });
    expect(state.status).toBe("error");
    expect(state.message).toContain("pas disponible");
  });

  it("masque l'erreur technique du fournisseur d'envoi", async () => {
    const d = {
      ...deps(),
      log: vi.fn(),
      send: vi.fn().mockResolvedValue({ error: { message: "API key invalid re_123" } }),
    };
    const state = await deliverContact(valid, "ip-1", d);
    expect(state.status).toBe("error");
    expect(state.message).not.toMatch(/re_123|API key/);
  });

  it("journalise un échec d'envoi sans donnée personnelle et le dit à la personne", async () => {
    const log = vi.fn();
    const d = {
      ...deps(),
      log,
      send: vi.fn().mockResolvedValue({
        error: {
          name: "validation_error",
          statusCode: 422,
          message: "Invalid reply_to claire@example.fr",
        },
      }),
    };
    const state = await deliverContact(valid, "ip-1", d);
    expect(state.status).toBe("error");
    expect(state.message).toContain("n’a pas pu être envoyé");
    expect(state.values?.message).toBe(valid.message);
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0] as string;
    expect(JSON.parse(line)).toMatchObject({
      scope: "contact",
      event: "send_failed",
      errorName: "validation_error",
      statusCode: 422,
    });
    for (const personal of ["claire", "example.fr", "Claire Martin", "Bordeaux", "annonce"]) {
      expect(line).not.toContain(personal);
    }
  });

  it("journalise aussi un envoi qui lève, et ne dit pas « envoyé »", async () => {
    const log = vi.fn();
    const d = { ...deps(), log, send: vi.fn().mockRejectedValue(new Error("fetch failed")) };
    const state = await deliverContact(valid, "ip-1", d);
    expect(state.status).toBe("error");
    expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({
      event: "send_failed",
      message: "fetch failed",
    });
  });

  it("n'envoie rien et prévient quand le limiteur partagé est indisponible", async () => {
    const log = vi.fn();
    const d = {
      ...deps(),
      log,
      limiter: { consume: vi.fn().mockRejectedValue(new Error("database down")) },
    };
    const state = await deliverContact(valid, "ip-1", d);
    expect(state.status).toBe("error");
    expect(d.send).not.toHaveBeenCalled();
    expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({
      event: "limiter_unavailable",
      message: "database down",
    });
  });

  it("accepte un limiteur asynchrone", async () => {
    const d = { ...deps(), limiter: { consume: vi.fn().mockResolvedValue(false) } };
    const state = await deliverContact(valid, "ip-1", d);
    expect(state.message).toContain("Trop de messages envoyés");
    expect(d.send).not.toHaveBeenCalled();
  });
});

describe("contactFailureLine", () => {
  it("masque toute adresse email et tronque le message", () => {
    const line = contactFailureLine("send_failed", new Error(`${"x".repeat(300)} a.b@c.fr`));
    const parsed = JSON.parse(line);
    expect(parsed.message.length).toBeLessThanOrEqual(200);
    expect(line).not.toContain("a.b@c.fr");
    expect(
      JSON.parse(contactFailureLine("send_failed", new Error("a.b@c.fr refused"))).message,
    ).toBe("[email] refused");
  });

  it("accepte une valeur qui n'est pas une erreur", () => {
    expect(JSON.parse(contactFailureLine("send_failed", "boom"))).toMatchObject({
      event: "send_failed",
      message: "boom",
      errorName: null,
      statusCode: null,
    });
    expect(JSON.parse(contactFailureLine("send_failed", null)).message).toBe("");
  });
});

describe("signalement depuis une fiche", () => {
  const SALE = "4655881c-249d-4eab-beba-f2624d8a1af0";

  it("compose l'adresse du formulaire prérempli", () => {
    expect(contactReportPath(SALE)).toBe(`/contact?sujet=erreur&vente=${SALE}&rubrique=fiche`);
    expect(contactReportPath(SALE, "prix")).toContain("rubrique=prix");
  });

  it("préremplit le sujet et un message avec l'identifiant et la rubrique", () => {
    const params = new URLSearchParams(contactReportPath(SALE, "prix").split("?")[1]);
    const prefill = contactPrefill(params);
    expect(prefill.subject).toBe("erreur");
    expect(prefill.message).toContain(`Vente concernée : ${SALE}`);
    expect(prefill.message).toContain("Rubrique : Mise à prix");
  });

  it.each([
    ["pepite", "Repère Pépite"],
    ["plafond", "Enchère ou offre plafond"],
  ] as const)("signale une erreur sur la rubrique « %s »", (topic, label) => {
    const params = new URLSearchParams(contactReportPath(SALE, topic).split("?")[1]);
    expect(params.get("rubrique")).toBe(topic);
    expect(contactPrefill(params).message).toContain(`Rubrique : ${label}`);
  });

  it("préremplit le sujet « avocat » d'après le lien de /avocats, et l'accepte à l'envoi", () => {
    const prefill = contactPrefill(new URLSearchParams(LAWYER_CONTACT_HREF.split("?")[1]));
    expect(prefill).toEqual({ subject: "avocat" });
    expect(validateContact({ ...valid, subject: "avocat" }).ok).toBe(true);
  });

  it("ignore tout ce qui n'est pas dans les listes ou n'a pas la forme d'un identifiant", () => {
    const hostile = new URLSearchParams({
      sujet: "<script>",
      vente: "x\nBcc: attaquant@example.test",
      rubrique: "__proto__",
    });
    expect(contactPrefill(hostile)).toEqual({});
    expect(contactPrefill(new URLSearchParams({ sujet: "donnees" }))).toEqual({
      subject: "donnees",
    });
    expect(
      contactPrefill(new URLSearchParams({ vente: SALE, rubrique: "constructor" })).message,
    ).not.toContain("Rubrique");
  });
});
