import { describe, expect, it, vi } from "vitest";
import {
  informationAgentExcludedAddressReason,
  isCourtRegistryEmail,
  isInformationAgentExcludedSourceUrl,
  isInformationAgentExcludedAddress,
} from "@/lib/information-agent/excluded-addresses";
import { discoverInformationAgentContacts } from "@/lib/information-agent";
import type { AuctionSale } from "@/lib/types";

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: vi.fn() },
}));

describe("adresses jamais sollicitées par l'agent", () => {
  it.each([
    ["greffe@tj-paris.justice.fr", "court"],
    ["accueil@justice.fr", "court"],
    ["ca-lyon@ca-lyon.justice.gouv.fr", "court"],
    ["me.dupont@avocat-conseil.fr", "rpva"],
    ["MAITRE@Avocat-Conseil.FR", "rpva"],
    ["secretariat@ordre-avocats-lyon.test", "bar_or_carpa"],
    ["contact@www.barreau-lyon.test", "bar_or_carpa"],
    ["contact@ordredesavocats.test", "bar_or_carpa"],
    ["contact@barreau-bordeaux.test", "bar_or_carpa"],
    ["batonnier@cabinet.test", "bar_or_carpa"],
    ["compta@carpa-paris.test", "bar_or_carpa"],
    ["carpa@cabinet.test", "bar_or_carpa"],
    ["ordre@cabinet.test", "bar_or_carpa"],
    ["noreply@cabinet.test", "technical"],
    ["no-reply@cabinet.test", "technical"],
    ["no_reply@cabinet.test", "technical"],
    ["donotreply@cabinet.test", "technical"],
    ["dpo@cabinet.test", "technical"],
    ["dpo.cabinet@cabinet.test", "technical"],
    ["rgpd@cabinet.test", "technical"],
  ])("%s est exclue (%s)", (email, reason) => {
    expect(informationAgentExcludedAddressReason(email)).toBe(reason);
    expect(isInformationAgentExcludedAddress(email)).toBe(true);
  });

  it.each([
    "me.dupont@cabinet-dupont.test",
    "greffe.exemple@cabinet.test",
    "contact@avocat-dupont.test",
    "ordrefacile@cabinet.test",
    "sandpoint@cabinet.test",
    "reply.exemple@cabinet.test",
    "dpontier@cabinet.test",
    "contact@justicefr.test",
    "contact@cabinet-barreau.fr",
    "contact@carpaccio-avocats.fr",
    "contact@avocats-ordre-du-jour.test",
    "contact@mail.cabinet-carpa.test",
    "delivered@resend.dev",
  ])("%s reste un contact possible", (email) => {
    expect(informationAgentExcludedAddressReason(email)).toBeNull();
    expect(isInformationAgentExcludedAddress(email)).toBe(false);
  });

  it("refuse comme source d'une adresse saisie un réseau social, un moteur ou un annuaire exclu", () => {
    for (const url of [
      "https://www.linkedin.com/in/jean-dupont",
      "https://fr.linkedin.com/in/jean-dupont",
      "https://www.facebook.com/cabinet",
      "https://x.com/cabinet",
      "https://twitter.com/cabinet",
      "https://www.instagram.com/cabinet",
      "https://www.google.com/search?q=jean+dupont",
      "https://www.notaires.fr/fr/office/etude-x",
      "https://paris.notaires.fr/fr/annuaire/x",
      "https://www.avocatparis.org/annuaire/avocat/1",
      "https://www.barreau-marseille.avocat.fr/annuaire/",
      "https://www.pagesjaunes.fr/pros/1",
    ]) {
      expect(isInformationAgentExcludedSourceUrl(url), url).toBe(true);
    }
    for (const url of [
      "https://www.licitor.com/annonce/1",
      "https://cabinet-dupont.example.test/contact",
      "https://www.barreaulyon.com/annuaire/avocat/jean-dupont/",
      "https://annuaire.commissaire-justice.fr/etude-1",
      "https://notairesfr.example.test/",
      "pas une url",
    ]) {
      expect(isInformationAgentExcludedSourceUrl(url), url).toBe(false);
    }
  });

  it("garde isCourtRegistryEmail limité aux juridictions", () => {
    expect(isCourtRegistryEmail("greffe@tj-paris.justice.fr")).toBe(true);
    expect(isCourtRegistryEmail("me@avocat-conseil.fr")).toBe(false);
    expect(isCourtRegistryEmail("noreply@cabinet.test")).toBe(false);
  });

  it("la découverte ne propose aucune adresse exclue", () => {
    const sale = {
      id: "sale",
      source_name: "licitor",
      primary_source: "licitor",
      source_url: "https://www.licitor.com/annonce/1",
      lawyer_contact:
        "me.dupont@cabinet-dupont.test, me.dupont@avocat-conseil.fr, noreply@cabinet-dupont.test",
      description:
        "Greffe greffe@tj-paris.justice.fr ; Ordre secretariat@ordre-avocats-lyon.test ; CARPA compta@carpa-paris.test ; dpo@cabinet-dupont.test ; rgpd@cabinet-dupont.test",
      source_description: null,
      source_blocks: null,
      source_blocks_by_source: {},
    } as unknown as AuctionSale;
    expect(discoverInformationAgentContacts(sale).map((candidate) => candidate.email)).toEqual([
      "me.dupont@cabinet-dupont.test",
    ]);
  });
});
