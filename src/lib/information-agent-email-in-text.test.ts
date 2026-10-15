import { describe, expect, it, vi } from "vitest";
import { discoverInformationAgentContacts } from "@/lib/information-agent/contacts";
import {
  emailInTextPattern,
  findEmailsInText,
  replaceEmailsInText,
} from "@/lib/information-agent/email-in-text";
import type { AuctionSale } from "@/lib/types";

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: vi.fn() },
}));

describe("adresse e-mail collée au texte qui suit", () => {
  it.each([
    ["maitre.dupont@cabinet-dupont.frTél : 01 02 03 04 05", "maitre.dupont@cabinet-dupont.fr"],
    ["maitre.dupont@cabinet-dupont.fr.", "maitre.dupont@cabinet-dupont.fr"],
    ["maitre.dupont@cabinet-dupont.fr/Tel 01 02 03 04 05", "maitre.dupont@cabinet-dupont.fr"],
    ["maitre.dupont@cabinet-dupont.fr0145678901", "maitre.dupont@cabinet-dupont.fr"],
    ["maitre.dupont@cabinet-dupont.fr, Paris", "maitre.dupont@cabinet-dupont.fr"],
    ["Email : maitre.dupont@cabinet-dupont.fr (cabinet)", "maitre.dupont@cabinet-dupont.fr"],
    ["MAITRE.DUPONT@CABINET-DUPONT.FR", "MAITRE.DUPONT@CABINET-DUPONT.FR"],
    ["MAITRE.DUPONT@CABINET-DUPONT.FRTél 0145678901", "MAITRE.DUPONT@CABINET-DUPONT.FR"],
    ["MAITRE.DUPONT@CABINET-DUPONT.FRTel 0145678901", "MAITRE.DUPONT@CABINET-DUPONT.FR"],
    ["Maitre.Dupont@Cabinet-Dupont.Fr", "Maitre.Dupont@Cabinet-Dupont.Fr"],
    ["Maitre.Dupont@Cabinet-Dupont.FrTél", "Maitre.Dupont@Cabinet-Dupont.Fr"],
    ["greffe@mairie.sous.domaine.cabinet.fr", "greffe@mairie.sous.domaine.cabinet.fr"],
    ["contact@avocats.paris", "contact@avocats.paris"],
    ["contact@etude-dupont.immobilier", "contact@etude-dupont.immobilier"],
    ["contact@etude-dupont.immobilierTél", "contact@etude-dupont.immobilier"],
    ["jean+vente@exemple.notaires.fr", "jean+vente@exemple.notaires.fr"],
    ["a_b%c@x.co", "a_b%c@x.co"],
  ])("%s", (text, expected) => {
    expect(findEmailsInText(text)).toEqual([expected]);
  });

  it("trouve plusieurs adresses dans un même bloc", () => {
    expect(
      findEmailsInText(
        "Me Dupont : dupont@cabinet.frTél 01 02 03 04 05 / Me Martin : martin@etude.paris.",
      ),
    ).toEqual(["dupont@cabinet.fr", "martin@etude.paris"]);
  });

  it("ne reconnaît pas ce qui n'est pas une adresse", () => {
    expect(findEmailsInText("pas d'adresse ici, tél. 01 02 03 04 05")).toEqual([]);
    expect(findEmailsInText("x@localhost")).toEqual([]);
    expect(findEmailsInText("x@cabinet.f")).toEqual([]);
    expect(findEmailsInText("@cabinet.fr")).toEqual([]);
  });

  it("ne partage aucun état entre deux appels", () => {
    expect(findEmailsInText("a@b.fr")).toEqual(["a@b.fr"]);
    expect(findEmailsInText("a@b.fr")).toEqual(["a@b.fr"]);
    expect(emailInTextPattern()).not.toBe(emailInTextPattern());
  });

  it("remplace l'adresse sans emporter le mot qui la suit", () => {
    expect(replaceEmailsInText("Me Dupont maitre.dupont@cabinet.frTél 01 02", " ")).toBe(
      "Me Dupont  Tél 01 02",
    );
  });
});

describe("découverte de contact sur une adresse collée au téléphone", () => {
  it("retient l'adresse sans la lettre du mot suivant", () => {
    const sale = {
      id: "sale-1",
      source_name: "licitor",
      source_url: "https://example.test/vente",
      lawyer_name: "Maître Dupont",
      lawyer_contact: "maitre.dupont@cabinet-dupont.frTél : 01 02 03 04 05",
    } as unknown as AuctionSale;

    expect(discoverInformationAgentContacts(sale).map((candidate) => candidate.email)).toEqual([
      "maitre.dupont@cabinet-dupont.fr",
    ]);
  });
});
