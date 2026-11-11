import { describe, expect, it } from "vitest";
import {
  autopilotBudgetDecision,
  autopilotPhase,
  AUTOPILOT_SHARED_DOMAIN_DAY_CAP,
  AUTOPILOT_STRUCTURE_DAY_CAP,
  AUTOPILOT_STRUCTURE_WEEK_CAP,
  parseAutopilotStats,
  sharedStructureCounts,
  type AutopilotStats,
} from "@/lib/information-agent/autopilot-rules";
import {
  INFORMATION_AGENT_GENERIC_LOCAL_PARTS,
  INFORMATION_AGENT_GENERIC_LOCAL_PARTS_ALONE,
  INFORMATION_AGENT_PROVIDER_MAIL_DOMAINS,
  INFORMATION_AGENT_SHARED_MAIL_DOMAINS,
  informationAgentAddressKind,
  informationAgentCapStructure,
  informationAgentOfficeCodeFor,
  informationAgentStructureCheckKeys,
  informationAgentStructureKeys,
  normalizedOfficeCode,
  ownMailDomainOf,
  sharedMailDomainOf,
} from "@/lib/information-agent/contact-structure";
import {
  personIdentityKeys,
  recipientOppositionKeys,
} from "@/lib/information-agent/opposition-keys";

// Adresses fictives : `example.test` (domaine propre), sous-domaines inexistants des domaines partagés ou
// de profession, `gmail.test` pour une messagerie grand public.
const NOTARY_DOMAIN = "exemple-fictif.notaires.fr";
const STATE_DOMAIN = "exemple-fictif.gouv.fr";

describe("adresse générique ou nominative", () => {
  it("les deux listes de mots génériques sont fermées", () => {
    expect([...INFORMATION_AGENT_GENERIC_LOCAL_PARTS].sort()).toEqual(
      [
        "accueil",
        "cabinet",
        "cessions",
        "contact",
        "contacts",
        "ddfip",
        "dnid",
        "drfip",
        "etude",
        "info",
        "infos",
        "office",
        "pgp",
        "prie",
        "scp",
        "secretariat",
        "selarl",
        "selas",
        "sgami",
      ].sort(),
    );
    expect([...INFORMATION_AGENT_GENERIC_LOCAL_PARTS_ALONE].sort()).toEqual(
      [
        "avocats",
        "bureau",
        "courrier",
        "domaine",
        "domaines",
        "encheres",
        "immobilier",
        "information",
        "informations",
        "negociation",
        "notaires",
        "standard",
        "ventes",
      ].sort(),
    );
  });

  it.each([
    "contact@example.test",
    "accueil@example.test",
    "etude@example.test",
    "office@example.test",
    "cabinet@example.test",
    "secretariat@example.test",
    "Contact@Example.Test",
    "contact.lyon@example.test",
    "etude-martin@example.test",
    "office33001@example.test",
    "scp.durand.martin@example.test",
    "pgp.domaine@example.test",
  ])("%s est générique", (email) => {
    expect(informationAgentAddressKind(email)).toBe("generic");
  });

  it.each([
    "jean.martin@example.test",
    "j.martin@example.test",
    "jmartin@example.test",
    "martin.contact@example.test",
    "contactez@example.test",
    "officier@example.test",
    "maitre.durand@example.test",
  ])("%s est nominative", (email) => {
    expect(informationAgentAddressKind(email)).toBe("nominative");
  });

  it.each(["bureau", "domaine", "courrier", "ventes", "immobilier", "notaires"])(
    "« %s » est ambigu : générique seul ou suivi de chiffres, nominatif suivi d'un nom",
    (word) => {
      expect(informationAgentAddressKind(`${word}@example.test`)).toBe("generic");
      expect(informationAgentAddressKind(`${word}2@example.test`)).toBe("generic");
      // « bureau.martin@ » est M. ou Mme Bureau, « domaine.durand@ » un domaine viticole.
      expect(informationAgentAddressKind(`${word}.martin@example.test`)).toBe("nominative");
      expect(informationAgentAddressKind(`${word}-durand@example.test`)).toBe("nominative");
    },
  );
});

describe("domaine propre, domaine partagé, messagerie", () => {
  it("les listes de domaines sont fermées", () => {
    expect(INFORMATION_AGENT_SHARED_MAIL_DOMAINS).toEqual(["notaires.fr", "gouv.fr"]);
    expect([...INFORMATION_AGENT_PROVIDER_MAIL_DOMAINS].sort()).toEqual(
      [
        "9online.fr",
        "alice.fr",
        "aliceadsl.fr",
        "avocat-conseil.fr",
        "avocat.fr",
        "avocatline.fr",
        "cegetel.net",
        "dartybox.com",
        "justice.fr",
        "libertysurf.fr",
        "nomade.fr",
        "noos.fr",
        "nordnet.fr",
        "tiscali.fr",
        "voila.fr",
      ].sort(),
    );
  });

  it("reconnaît le domaine partagé et ses sous-domaines, jamais un domaine voisin", () => {
    expect(sharedMailDomainOf("notaires.fr")).toBe("notaires.fr");
    expect(sharedMailDomainOf(`office@${NOTARY_DOMAIN}`)).toBe("notaires.fr");
    expect(sharedMailDomainOf(`pgp@${STATE_DOMAIN}`)).toBe("gouv.fr");
    expect(sharedMailDomainOf("etude-notaires.fr")).toBeNull();
    expect(sharedMailDomainOf("mesnotaires.fr")).toBeNull();
    expect(sharedMailDomainOf("contact@example.test")).toBeNull();
  });

  it("un domaine propre n'est ni partagé, ni une messagerie de profession, d'accès ou grand public", () => {
    expect(ownMailDomainOf("contact@example.test")).toBe("example.test");
    expect(ownMailDomainOf(`office@${NOTARY_DOMAIN}`)).toBeNull();
    expect(ownMailDomainOf(`pgp@${STATE_DOMAIN}`)).toBeNull();
    expect(ownMailDomainOf("cabinet.fictif@gmail.test")).toBeNull();
    for (const provider of ["avocat.fr", "avocatline.fr", "nomade.fr", "aliceadsl.fr"]) {
      expect(ownMailDomainOf(`contact@exemple-fictif.${provider}`)).toBeNull();
      expect(
        informationAgentStructureKeys({ email: `contact@exemple-fictif.${provider}` }),
      ).toEqual([]);
    }
  });

  it("le code d'office est fait de 4 à 6 chiffres", () => {
    expect(normalizedOfficeCode("33001")).toBe("33001");
    expect(normalizedOfficeCode(33001)).toBe("33001");
    expect(normalizedOfficeCode(" 75012 ")).toBe("75012");
    expect(normalizedOfficeCode("abc")).toBeNull();
    expect(normalizedOfficeCode("123")).toBeNull();
    expect(normalizedOfficeCode(null)).toBeNull();
  });

  it("règle du code d'office : celui du notaire désigné, sinon celui de la vente hors domaine propre", () => {
    const notary = `autre.notaire@${NOTARY_DOMAIN}`;
    expect(
      informationAgentOfficeCodeFor({
        email: notary,
        officeCode: "33001",
        saleOfficeCode: "75012",
      }),
    ).toBe("33001");
    // Adresse saisie sur un domaine partagé ou une messagerie : seul l'office de la vente l'identifie.
    expect(
      informationAgentOfficeCodeFor({ email: notary, officeCode: null, saleOfficeCode: "33001" }),
    ).toBe("33001");
    expect(
      informationAgentOfficeCodeFor({
        email: "etude.fictive@gmail.test",
        officeCode: null,
        saleOfficeCode: "33001",
      }),
    ).toBe("33001");
    // Adresse saisie sur un domaine propre : identifiée par ce domaine, pas par l'office de la vente.
    expect(
      informationAgentOfficeCodeFor({
        email: "contact@example.test",
        officeCode: null,
        saleOfficeCode: "33001",
      }),
    ).toBeNull();
  });
});

describe("clés d'opposition d'une structure", () => {
  it("domaine propre du cabinet", () => {
    expect(informationAgentStructureKeys({ email: "jean.martin@example.test" })).toEqual([
      "structure|domain|example.test",
    ]);
  });

  it("jamais un domaine partagé ni une messagerie grand public", () => {
    expect(informationAgentStructureKeys({ email: `jean.martin@${NOTARY_DOMAIN}` })).toEqual([]);
    expect(informationAgentStructureKeys({ email: `pgp@${STATE_DOMAIN}` })).toEqual([]);
    expect(informationAgentStructureKeys({ email: "cabinet.fictif@gmail.test" })).toEqual([]);
  });

  it("code d'office, quel que soit le domaine", () => {
    expect(
      informationAgentStructureKeys({ email: `jean.martin@${NOTARY_DOMAIN}`, officeCode: "33001" }),
    ).toEqual(["structure|office|33001"]);
    expect(
      informationAgentStructureKeys({ email: "etude@example.test", officeCode: "33001" }),
    ).toEqual(["structure|office|33001", "structure|domain|example.test"]);
  });

  it("une clé ne contient aucune adresse", () => {
    for (const key of informationAgentStructureCheckKeys({
      email: "etude@bureau.example.test",
      officeCode: "33001",
    })) {
      expect(key).not.toContain("@");
      expect(key).toBe(key.toLowerCase());
    }
  });

  it("l'opposition d'un domaine vaut pour ses sous-domaines, pas l'inverse", () => {
    // Clés contrôlées avant d'écrire à un sous-domaine : le domaine et ses parents.
    expect(
      informationAgentStructureCheckKeys({ email: "contact@paris.cabinet.example.test" }),
    ).toEqual([
      "structure|domain|paris.cabinet.example.test",
      "structure|domain|cabinet.example.test",
      "structure|domain|example.test",
    ]);
    // Clés portées par l'adresse (versées dans la liste si elle s'oppose) : son domaine exact seulement.
    expect(informationAgentStructureKeys({ email: "contact@paris.cabinet.example.test" })).toEqual([
      "structure|domain|paris.cabinet.example.test",
    ]);
    // Un parent partagé, de profession ou grand public n'est jamais une structure.
    expect(informationAgentStructureCheckKeys({ email: `etude@${NOTARY_DOMAIN}` })).toEqual([]);
  });
});

describe("clés d'opposition d'un destinataire (définition unique)", () => {
  const place = { bar: "Bordeaux", city: "Bordeaux" };

  it("adresse nominative : la personne seule est portée, la structure est contrôlée", () => {
    const keys = recipientOppositionKeys({
      role: "lawyer",
      name: "Maître Jean Dupont",
      place,
      email: "jean.dupont@example.test",
    });
    expect(keys.identityKeys).toEqual(["lawyer|bordeaux|dupont jean"]);
    expect(keys.checkKeys).toEqual([
      "lawyer|bordeaux|dupont jean",
      "structure|domain|example.test",
    ]);
  });

  it("adresse générique : la structure est portée avec la personne", () => {
    const keys = recipientOppositionKeys({
      role: "notary",
      name: null,
      place,
      email: `etude@${NOTARY_DOMAIN}`,
      officeCode: "33001",
    });
    expect(keys.identityKeys).toEqual(["structure|office|33001"]);
    expect(keys.checkKeys).toEqual(["structure|office|33001"]);
    expect(personIdentityKeys(keys.identityKeys)).toEqual([]);
  });

  it("boîte de service désignée par l'annonce : générique même si sa forme ne le dit pas", () => {
    const email = "sdnc.gestion-domaniale@service.example.test";
    expect(
      recipientOppositionKeys({ role: "organizer", name: null, place, email }).identityKeys,
    ).toEqual([]);
    expect(
      recipientOppositionKeys({
        role: "organizer",
        name: null,
        place,
        email,
        addressKind: "generic",
      }).identityKeys,
    ).toEqual(["structure|domain|service.example.test"]);
  });
});

describe("unité de plafond", () => {
  it("domaine propre : le domaine ; domaine partagé : l'office, sinon la boîte", () => {
    expect(informationAgentCapStructure({ email: "Jean.Martin@Example.test" })).toEqual({
      key: "domain|example.test",
      sharedDomain: null,
    });
    expect(
      informationAgentCapStructure({ email: `jean.martin@${NOTARY_DOMAIN}`, officeCode: "33001" }),
    ).toEqual({ key: "office|33001", sharedDomain: "notaires.fr" });
    expect(informationAgentCapStructure({ email: `PGP@${STATE_DOMAIN}` })).toEqual({
      key: `mailbox|pgp@${STATE_DOMAIN}`,
      sharedDomain: "gouv.fr",
    });
  });
});

describe("plafonds du pilote par structure et par domaine partagé", () => {
  const NOW = new Date("2026-11-03T09:30:00Z"); // mardi 10 h 30 à Paris
  const caps = { dayCap: 40, hourCap: 12, phase: autopilotPhase(null, [], NOW) };
  const counted = { ...parseAutopilotStats({}), sharedStructureCountsComplete: true };
  const decide = (
    overrides: Partial<AutopilotStats>,
    email: string,
    officeCode: string | null = null,
  ) =>
    autopilotBudgetDecision({
      stats: { ...counted, ...overrides },
      caps,
      domain: email.split("@")[1],
      structure: informationAgentCapStructure({ email, officeCode }),
      court: null,
      now: NOW,
      random: 0.5,
    });

  it("valeurs des plafonds", () => {
    expect(AUTOPILOT_STRUCTURE_DAY_CAP).toBe(1);
    expect(AUTOPILOT_STRUCTURE_WEEK_CAP).toBe(2);
    expect(AUTOPILOT_SHARED_DOMAIN_DAY_CAP).toBe(3);
  });

  it("domaine propre : plafond inchangé, 1 par jour et 2 par semaine pour le domaine", () => {
    expect(decide({}, "contact@example.test")).toEqual({ ok: true });
    expect(decide({ todayByDomain: { "example.test": 1 } }, "contact@example.test")).toEqual({
      ok: false,
      scope: "candidate",
      code: "domain_cap",
    });
    expect(
      decide({ weekByDomain: { "example.test": 2 } }, "jean.martin@example.test"),
    ).toMatchObject({ code: "domain_cap" });
    // Le compte par structure ne concerne pas un domaine propre : incomplet, il ne le bloque pas.
    expect(decide({ sharedStructureCountsComplete: false }, "contact@example.test")).toEqual({
      ok: true,
    });
  });

  it("domaine partagé : un autre office n'est pas bloqué par l'envoi du jour à un premier office", () => {
    const sent = {
      todayByDomain: { [NOTARY_DOMAIN]: 1 },
      weekByDomain: { [NOTARY_DOMAIN]: 2 },
      todayBySharedStructure: { "office|33001": 1 },
      weekBySharedStructure: { "office|33001": 1 },
    };
    expect(decide(sent, `jean.martin@${NOTARY_DOMAIN}`, "75012")).toEqual({ ok: true });
    expect(decide(sent, `anne.leroy@${NOTARY_DOMAIN}`, "33001")).toEqual({
      ok: false,
      scope: "candidate",
      code: "structure_cap",
    });
  });

  it("domaine partagé : 2 envois en 7 jours au même office", () => {
    expect(
      decide({ weekBySharedStructure: { "office|33001": 2 } }, `etude@${NOTARY_DOMAIN}`, "33001"),
    ).toMatchObject({ code: "structure_cap" });
    expect(
      decide({ weekBySharedStructure: { "office|33001": 1 } }, `etude@${NOTARY_DOMAIN}`, "33001"),
    ).toEqual({ ok: true });
  });

  it("domaine partagé sans code d'office : la boîte est la structure", () => {
    const key = `mailbox|pgp@${STATE_DOMAIN}`;
    expect(decide({ todayBySharedStructure: { [key]: 1 } }, `pgp@${STATE_DOMAIN}`)).toMatchObject({
      code: "structure_cap",
    });
    expect(decide({ todayBySharedStructure: { [key]: 1 } }, `prie@${STATE_DOMAIN}`)).toEqual({
      ok: true,
    });
  });

  it("domaine partagé : 3 envois par jour au plus, sous-domaines confondus", () => {
    const today = { "a.notaires.fr": 1, "b.notaires.fr": 1, "notaires.fr": 1, "example.test": 9 };
    expect(decide({ todayByDomain: today }, `etude@${NOTARY_DOMAIN}`, "75012")).toEqual({
      ok: false,
      scope: "candidate",
      code: "shared_domain_cap",
    });
    // Le plafond de `notaires.fr` ne touche ni `gouv.fr` ni les domaines propres.
    expect(decide({ todayByDomain: today }, `pgp@${STATE_DOMAIN}`)).toEqual({ ok: true });
    expect(
      decide(
        { todayByDomain: { "a.notaires.fr": 1, "b.notaires.fr": 1 } },
        `etude@${NOTARY_DOMAIN}`,
      ),
    ).toEqual({ ok: true });
  });

  it("domaine partagé sans unité de plafond : le candidat est écarté", () => {
    expect(
      autopilotBudgetDecision({
        stats: counted,
        caps,
        domain: NOTARY_DOMAIN,
        court: null,
        now: NOW,
        random: 0.5,
      }),
    ).toEqual({ ok: false, scope: "candidate", code: "structure_unknown" });
  });

  it("compte par structure incomplet : rien ne part vers un domaine partagé", () => {
    // Compteurs SQL seuls (`parseAutopilotStats`) : le compte par structure n'a pas été lu.
    expect(parseAutopilotStats({}).sharedStructureCountsComplete).toBe(false);
    expect(
      decide({ sharedStructureCountsComplete: false }, `etude@${NOTARY_DOMAIN}`, "75012"),
    ).toEqual({ ok: false, scope: "candidate", code: "structure_count_incomplete" });
  });

  it("l'écart de 15 minutes par domaine est conservé", () => {
    expect(decide({ recentDomains: [NOTARY_DOMAIN] }, `etude@${NOTARY_DOMAIN}`, "75012")).toEqual({
      ok: false,
      scope: "candidate",
      code: "domain_spacing",
    });
  });

  it("compte les envois par structure sur les domaines partagés seulement", () => {
    const at = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
    expect(
      sharedStructureCounts(
        [
          { recipientEmail: `etude@${NOTARY_DOMAIN}`, officeCode: "33001", approvedAt: at(1) },
          {
            recipientEmail: `jean.martin@${NOTARY_DOMAIN}`,
            officeCode: "33001",
            approvedAt: at(30),
          },
          { recipientEmail: `etude@${NOTARY_DOMAIN}`, officeCode: null, approvedAt: at(2) },
          { recipientEmail: `pgp@${STATE_DOMAIN}`, officeCode: null, approvedAt: at(24 * 8) },
          { recipientEmail: "contact@example.test", officeCode: null, approvedAt: at(1) },
        ],
        NOW,
      ),
    ).toEqual({
      todayBySharedStructure: { "office|33001": 1, [`mailbox|etude@${NOTARY_DOMAIN}`]: 1 },
      weekBySharedStructure: { "office|33001": 2, [`mailbox|etude@${NOTARY_DOMAIN}`]: 1 },
      sharedStructureCountsComplete: true,
    });
  });
});
