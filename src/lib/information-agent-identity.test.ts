import { describe, expect, it } from "vitest";
import {
  informationAgentIdentityKeys,
  informationAgentIdentityKeySet,
  normalizeInformationAgentIdentityName,
} from "@/lib/information-agent/identity";

describe("clé d'identité d'un professionnel (opposition par identité)", () => {
  it("ignore titres, formes sociales, accents, casse et ordre des mots", () => {
    expect(normalizeInformationAgentIdentityName("Maître Jean DUPONT")).toBe("dupont jean");
    expect(normalizeInformationAgentIdentityName("Me Dupont Jean")).toBe("dupont jean");
    expect(normalizeInformationAgentIdentityName("Éloïse   Müller-Martin")).toBe(
      "eloise martin muller",
    );
    expect(normalizeInformationAgentIdentityName("SCP Dupont & Associés")).toBe("dupont");
    expect(normalizeInformationAgentIdentityName(null)).toBe("");
  });

  it("combine rôle, barreau et nom ; la même personne a la même clé sous toute adresse", () => {
    const first = informationAgentIdentityKeys({
      role: "lawyer",
      name: "Maître Jean Dupont",
      bar: "Bordeaux",
    });
    const second = informationAgentIdentityKeys({
      role: "source_lawyer",
      name: "DUPONT jean",
      bar: "barreau de Bordeaux",
    });
    expect(first).toEqual(["lawyer|bordeaux|dupont jean"]);
    expect(second).toEqual(first);
  });

  it("distingue deux barreaux et deux rôles", () => {
    const base = { name: "Jean Dupont" };
    expect(informationAgentIdentityKeys({ ...base, role: "lawyer", bar: "Lyon" })).not.toEqual(
      informationAgentIdentityKeys({ ...base, role: "lawyer", bar: "Bordeaux" }),
    );
    expect(informationAgentIdentityKeys({ ...base, role: "lawyer", city: "Lyon" })).not.toEqual(
      informationAgentIdentityKeys({ ...base, role: "notary", city: "Lyon" }),
    );
  });

  it("utilise la ville à défaut de barreau", () => {
    expect(
      informationAgentIdentityKeys({ role: "notary", name: "Étude Martin", city: "Bordeaux" }),
    ).toEqual(["notary|bordeaux|etude martin"]);
  });

  it("étend un rôle inconnu à tous les rôles plutôt que de manquer une personne opposée", () => {
    const keys = informationAgentIdentityKeys({
      role: "source_contact",
      name: "Jean Dupont",
      bar: "Lyon",
    });
    expect(keys).toEqual([
      "commissaire_de_justice|lyon|dupont jean",
      "lawyer|lyon|dupont jean",
      "manager|lyon|dupont jean",
      "notary|lyon|dupont jean",
    ]);
    // Le rôle précis d'une opposition précédente reste reconnu par un rôle inconnu.
    expect(
      informationAgentIdentityKeys({ role: "lawyer", name: "Jean Dupont", bar: "Lyon" }).every(
        (key) => keys.includes(key),
      ),
    ).toBe(true);
  });

  it("reconnaît un avocat qui postule dans les barreaux d'Île-de-France sous l'un ou l'autre", () => {
    const atBobigny = informationAgentIdentityKeys({
      role: "lawyer",
      name: "Jean Dupont",
      bar: "Bobigny",
    });
    const atParis = informationAgentIdentityKeys({
      role: "lawyer",
      name: "Jean Dupont",
      bar: "Paris",
    });
    expect(atBobigny).toEqual(atParis);
    expect(atParis).toContain("lawyer|paris|dupont jean");
    expect(atParis).toContain("lawyer|hauts de seine|dupont jean");
  });

  it("ajoute la clé SIREN quand elle est connue (SIRET réduit à son SIREN)", () => {
    expect(informationAgentIdentityKeys({ siren: "123 456 789" })).toEqual(["siren|123456789"]);
    expect(informationAgentIdentityKeys({ siren: "12345678900012" })).toEqual(["siren|123456789"]);
    expect(informationAgentIdentityKeys({ siren: "12345" })).toEqual([]);
    expect(
      informationAgentIdentityKeys({
        role: "lawyer",
        name: "Jean Dupont",
        bar: "Lyon",
        siren: "123456789",
      }),
    ).toEqual(["lawyer|lyon|dupont jean", "siren|123456789"]);
  });

  it("ne produit aucune clé sans nom exploitable ni lieu : seule l'adresse compte", () => {
    expect(informationAgentIdentityKeys({ role: "lawyer", name: null, bar: "Lyon" })).toEqual([]);
    expect(informationAgentIdentityKeys({ role: "lawyer", name: "Me", bar: "Lyon" })).toEqual([]);
    expect(informationAgentIdentityKeys({ role: "lawyer", name: "Jean Dupont" })).toEqual([]);
  });

  it("ne contient jamais d'adresse email", () => {
    const keys = informationAgentIdentityKeys({
      role: "lawyer",
      name: "Jean Dupont jean.dupont@cabinet.test",
      bar: "Lyon",
    });
    expect(keys.join(" ")).not.toContain("@");
  });

  it("fusionne les clés de plusieurs identités sans doublon", () => {
    const identity = { role: "lawyer", name: "Jean Dupont", bar: "Lyon" };
    expect(informationAgentIdentityKeySet([identity, identity])).toEqual([
      "lawyer|lyon|dupont jean",
    ]);
  });
});
