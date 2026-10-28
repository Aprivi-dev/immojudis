import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { normalizedEmail as normalizedEmailFromContacts } from "@/lib/information-agent/contacts";
import {
  INFORMATION_AGENT_EMAIL_PATTERN,
  INFORMATION_AGENT_NO_EMAIL_MESSAGE,
  isValidInformationAgentEmail,
  normalizedEmail,
} from "@/lib/information-agent/email-address";

vi.mock("server-only", () => ({}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

describe("validateur d'adresse email de l'agent", () => {
  it.each([
    ["  Cabinet.Dupont@Example.TEST ", "cabinet.dupont@example.test"],
    ["me+ventes@etude-martin.fr", "me+ventes@etude-martin.fr"],
    ["o'brien@cabinet.test", "o'brien@cabinet.test"],
  ])("accepte %j", (value, expected) => {
    expect(normalizedEmail(value)).toBe(expected);
    expect(isValidInformationAgentEmail(value)).toBe(true);
  });

  it.each([
    ["un téléphone", "05 56 00 00 01"],
    ["un téléphone avec indicatif", "+33 5 56 00 00 01"],
    ["un nom", "Maître Jean Dupont"],
    ["un nom avec fonction", "Me Dupont, avocat"],
    ["un champ vide", ""],
    ["des espaces", "   "],
    ["une adresse sans domaine", "dupont@"],
    ["une adresse sans extension", "dupont@cabinet"],
    ["une extension d'une lettre", "dupont@cabinet.f"],
    ["deux adresses", "a@cabinet.test b@cabinet.test"],
    ["une adresse entre chevrons", "Dupont <dupont@cabinet.test>"],
    ["null", null],
    ["undefined", undefined],
    ["un nombre", 33556000001],
  ])("refuse %s", (_label, value) => {
    expect(normalizedEmail(value)).toBeNull();
    expect(isValidInformationAgentEmail(value)).toBe(false);
  });

  it("accepte et refuse exactement ce que z.email() accepte et refuse", () => {
    const zodEmail = z.string().email();
    for (const value of [
      "cabinet.dupont@example.test",
      "me+ventes@etude-martin.fr",
      "o'brien@cabinet.test",
      "a.b.c@sous.domaine.example.fr",
      ".dupont@cabinet.test",
      "dupont.@cabinet.test",
      "du..pont@cabinet.test",
      "dupont@-cabinet.test",
      "dupont@cabinet.f",
      "dupont@cabinet",
      "dupont@",
      "05 56 00 00 01",
      "Me Dupont, avocat",
      "a@cabinet.test b@cabinet.test",
    ]) {
      expect(INFORMATION_AGENT_EMAIL_PATTERN.test(value), value).toBe(
        zodEmail.safeParse(value).success,
      );
    }
  });

  it("est le même validateur que celui du résolveur de contacts", () => {
    expect(normalizedEmailFromContacts).toBe(normalizedEmail);
  });

  it("donne un motif court et factuel", () => {
    expect(INFORMATION_AGENT_NO_EMAIL_MESSAGE).toBe(
      "Aucune adresse email de contact : l'agent ne peut pas écrire.",
    );
  });
});
