// @vitest-environment jsdom

import { act, cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { hydrateRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { axe } from "vitest-axe";
import {
  LaunchOfferContext,
  type LaunchOfferState,
  type LaunchOfferStore,
} from "@/hooks/use-launch-offer";
import { LAUNCH_OFFER_SHORT_TEXT, LAUNCH_OFFER_VISITOR_TEXT } from "@/lib/launch-offer";
import type { FeeRegimeKey } from "@/lib/fee-regime-open";
import type { AuctionSale, SaleVenueType } from "@/lib/types";
import { FREE_ACCESS_LINE } from "@/lib/sale-unlocks";
import { publicSaleVenueCopy, SalePublicPreview } from "./SalePublicPreview";
import { pepiteCriteriaPayload, pepiteCriteriaViews } from "@/lib/sale-pepite-view";

const pepiteMocks = vi.hoisted(() => ({ pepite: vi.fn(), status: null as string | null }));
const dynamicLoads = vi.hoisted((): Promise<unknown>[] => []);
vi.mock("@/hooks/use-sale-pepite", () => ({
  useSalePepite: (args: unknown) => pepiteMocks.pepite(args),
  // Le contenu (`pepiteMocks.pepite`) et, quand il manque, l'état de la lecture (`pepiteMocks.status`).
  useSalePepiteState: (args: unknown) => {
    const payload = pepiteMocks.pepite(args);
    return { payload, status: payload ? "ready" : (pepiteMocks.status ?? "idle") };
  },
}));
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
    // Le bloc chargé à la demande : le vrai composant, résolu tout de suite.
    let Component: React.ComponentType<Record<string, unknown>> | null = null;
    dynamicLoads.push(
      loader().then((resolved) => {
        Component = resolved;
      }),
    );
    return function Lazy(props: Record<string, unknown>) {
      return Component ? <Component {...props} /> : null;
    };
  },
}));

// Every lazy module (the pépite block, the alert form) finishes loading before the first test,
// never after the environment is torn down.
beforeAll(() => Promise.all(dynamicLoads));
afterEach(cleanup);

describe("SalePublicPreview", () => {
  it("keeps the requested section and search return in the login destination", () => {
    render(
      <SalePublicPreview
        saleId="sale-1"
        preview={{ id: "sale-1" } as AuctionSale}
        returnTo="/sales?city=Toulouse"
        requestedHash="#proofs"
      />,
    );
    // Un seul bouton de compte sur la page, dans la synthèse (maquette validée du 24/10/2026).
    const links = screen.getAllByRole("link", { name: /Créer mon compte gratuit/ });
    expect(links).toHaveLength(1);
    for (const link of links) {
      const params = new URL(link.getAttribute("href")!, "https://example.test").searchParams;
      expect(params.get("redirect")).toBe("/sales/sale-1?from=%2Fsales%3Fcity%3DToulouse#proofs");
      // Le bandeau de la page de connexion explique ce que le compte gratuit ouvre sur cette fiche.
      expect(params.get("mode")).toBe("investor");
      expect(params.get("reason")).toBe("fiche");
    }
  });

  it("announces the statistics of the tribunal in the unlock only while their flag is open", () => {
    const tribunal = { id: "sale-1", sale_venue_type: "tribunal" } as AuctionSale;
    const closed = render(
      <SalePublicPreview saleId="sale-1" preview={tribunal} returnTo="/sales" />,
    );
    const intro = (view: typeof closed) =>
      view.container.querySelector("[class*=tierFree]")?.textContent ?? "";
    expect(intro(closed)).toContain("3 déblocages par mois");
    expect(intro(closed)).not.toContain("déblocages de ventes");
    expect(intro(closed)).toContain("l’enchère plafond, la lecture des pièces");
    expect(intro(closed)).not.toContain("statistiques du tribunal");
    closed.unmount();

    const open = render(
      <SalePublicPreview
        saleId="sale-1"
        preview={tribunal}
        returnTo="/sales"
        adjudicationStatisticsEnabled
      />,
    );
    expect(intro(open)).toContain("les statistiques du tribunal");
  });

  it.each([
    ["tribunal", "Bien immobilier vendu au tribunal"],
    ["notary", "Bien immobilier vendu chez le notaire"],
    ["state", "Bien immobilier vendu par l’État"],
    ["online", "Bien immobilier vendu aux enchères"],
    ["unknown", "Bien immobilier vendu aux enchères"],
  ] satisfies Array<[SaleVenueType, string]>)(
    "explains the %s venue with a dedicated public title",
    (venueType, title) => {
      expect(publicSaleVenueCopy(venueType).title).toBe(title);
      expect(publicSaleVenueCopy(venueType).explanation.length).toBeGreaterThan(70);
    },
  );

  it("makes a notarial sale explicit without leaking protected listing data", () => {
    const { container } = renderPreview({
      sale_venue_type: "notary",
      sale_verification_status: "cross_checked",
      lawyer_contact: "confidential@example.test",
    });

    // Le type de vente reste écrit en toutes lettres près du titre, dans le sous-titre.
    expect(screen.getByText(/^Vente chez le notaire/)).toBeTruthy();
    expect(screen.getAllByText("Vente notariale").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Modalités à consulter dans le dossier")).toBeTruthy();
    expect(screen.getByText("Un seul catalogue, plusieurs procédures")).toBeTruthy();
    expect(container.textContent).toContain(
      "ventes immobilières au tribunal, chez le notaire et les ventes domaniales",
    );
    expect(container.textContent).not.toContain("confidential@example.test");
    // The notarial regimes are open: the ceiling is promised, with both terms while the mode of the
    // sale (candle or interactive) is not readable by a visitor.
    expect(container.textContent).toContain("enchère plafond ou offre plafond");
    expect(screen.queryByText(/Activité publique du tribunal/)).toBeNull();

    const cta = screen.getAllByRole("link", { name: /Créer mon compte gratuit/ })[0];
    expect(cta.getAttribute("href")).toContain("mode=investor");
    // The unfiltered catalogue is the default way back: no `?from=/sales` in the destination.
    const redirect = new URL(cta.getAttribute("href")!, "https://example.test").searchParams.get(
      "redirect",
    );
    expect(redirect).toBe("/sales/sale-1");
  });

  describe("photo principale", () => {
    const ORIGINAL = "https://www.licitor.com/photos/maison.jpg";
    const BASE = "https://ci.supabase.co/storage/v1/object/public/sale-photos/";

    beforeEach(() => vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ci.supabase.co"));
    afterEach(() => vi.unstubAllEnvs());

    it("affiche la copie hébergée et crédite la source de l'URL d'origine, sans lien", () => {
      renderPreview({
        media: [
          {
            type: "image",
            url: ORIGINAL,
            mirror: {
              path640: "s/a-640.webp",
              path1600: "s/a-1600.webp",
              width: 1600,
              height: 1200,
            },
          },
        ],
      });

      const image = screen.getByRole("img", { name: /Photo du bien/ });
      expect(image.getAttribute("src")).toBe(`${BASE}s/a-1600.webp`);
      expect(image.getAttribute("srcset")).toContain("640w");
      // La page publique ne reçoit pas l'annonce d'origine : le nom de la source, sans lien.
      expect(screen.getByTestId("photo-credit").textContent).toBe("Photo : via Licitor");
      expect(screen.queryByRole("link", { name: "Licitor" })).toBeNull();
    });

    it("sans copie, la photo de la source reste affichée telle quelle", () => {
      renderPreview({ media: [{ type: "image", url: ORIGINAL }] });

      expect(screen.getByRole("img", { name: /Photo du bien/ }).getAttribute("src")).toBe(ORIGINAL);
      expect(screen.getByTestId("photo-credit").textContent).toBe("Photo : via Licitor");
    });

    it("hôte inconnu : « source de l'annonce », sans hôte brut ni lien", () => {
      renderPreview({ media: [{ type: "image", url: "https://d1x9.cloudfront.net/p/a.jpg" }] });

      const credit = screen.getByTestId("photo-credit");
      expect(credit.textContent).toBe("Photo : source de l'annonce");
      expect(credit.textContent).not.toContain("cloudfront");
      expect(credit.querySelector("a")).toBeNull();
    });

    it("sans photo, aucun crédit", () => {
      renderPreview({ media: [] });
      expect(screen.queryByTestId("photo-credit")).toBeNull();
    });
  });

  it("links to the guide, the costs article, the courts and the fees simulator", () => {
    render(
      <SalePublicPreview
        saleId="sale-1"
        preview={{ id: "sale-1" } as AuctionSale}
        returnTo="/sales"
      />,
    );
    const section = screen.getByRole("region", { name: "Pour aller plus loin" });
    expect(section.querySelector("h2")?.textContent).toBe("Pour aller plus loin");
    const hrefs = Array.from(section.querySelectorAll("a")).map((link) =>
      link.getAttribute("href"),
    );
    expect(hrefs).toEqual([
      "/ventes-immobilieres-judiciaires",
      "/ressources/frais-vente-encheres-judiciaire",
      "/tribunaux",
      "/simulateur-frais-encheres",
    ]);
  });

  it("keeps court-specific guidance without exposing court statistics in the public teaser", () => {
    renderPreview({
      sale_venue_type: "tribunal",
      sale_verification_status: "verified",
      tribunal_code: "tj-bordeaux",
      tribunal_name: "Tribunal judiciaire de Bordeaux",
    });

    expect(screen.getByText("Avocat obligatoire pour enchérir")).toBeTruthy();
    expect(screen.getByText(/lors d’une audience d’/)).toBeTruthy();
    expect(screen.queryByText(/Activité publique du tribunal/)).toBeNull();
  });

  it("links the name of the tribunal to its page, and keeps plain text without a code", () => {
    renderPreview({
      sale_venue_type: "tribunal",
      sale_verification_status: "verified",
      tribunal_code: "justice_tj_1_93",
      tribunal_name: "TJ Bobigny",
    });
    expect(
      screen.getByRole("link", { name: "Tribunal judiciaire de Bobigny" }).getAttribute("href"),
    ).toBe("/tribunaux/justice-tj-1-93");
    cleanup();

    // Base pas encore migrée, ou tribunal inconnu du référentiel : le nom reste un texte simple.
    renderPreview({
      sale_venue_type: "tribunal",
      sale_verification_status: "verified",
      tribunal_code: null,
      tribunal_name: "TJ Bobigny",
    });
    expect(screen.getByText("Tribunal judiciaire de Bobigny")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Tribunal judiciaire de Bobigny" })).toBeNull();
  });

  it("shows the domanial method before price and avoids promising auctions", () => {
    const { container } = renderPreview({
      sale_venue_type: "state",
      sale_verification_status: "cross_checked",
      starting_price_eur: null,
    });
    expect(screen.getByText("Mode de cession")).toBeTruthy();
    expect(screen.getByText(/Prix non publié/)).toBeTruthy();
    expect(container.textContent).not.toContain("estimation de votre enchère plafond");
    expect(container.textContent).not.toContain("L'inscription et les enchères");
  });

  it("gives each sale its own heading, built from the facts of the sale", () => {
    renderPreview({
      sale_venue_type: "tribunal",
      sale_verification_status: "verified",
      property_type: "apartment",
      app_surface_m2: 50,
      city: "Romainville",
      department: "93",
      sale_date: "2026-10-20T09:00:00+02:00",
      tribunal: "TJ Bobigny",
    });
    // Titre court ; le type de vente, le département et la date passent dans le sous-titre.
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.firstChild?.textContent).toBe("Appartement de 50 m² à Romainville");
    expect(
      screen.getByText(
        "Vente au tribunal · Seine-Saint-Denis (93) · audience le 20 octobre 2026 à 9 h 00",
      ),
    ).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("never gives two different sales the same heading", () => {
    const facts = {
      sale_venue_type: "tribunal",
      property_type: "apartment",
      app_surface_m2: 50,
      city: "Romainville",
      department: "93",
      sale_date: "2026-10-20T09:00:00+02:00",
    } as const;
    const first = renderPreview({ ...facts, id: "005a914d-563c-427b-88a4-740cbf851afb" });
    const firstHeading = screen.getByRole("heading", { level: 1 }).textContent;
    first.unmount();
    renderPreview(
      { ...facts, id: "7c1e22ab-563c-427b-88a4-740cbf851afb" },
      "7c1e22ab-563c-427b-88a4-740cbf851afb",
    );
    const secondHeading = screen.getByRole("heading", { level: 1 }).textContent;
    expect(firstHeading).not.toBe(secondHeading);
  });

  it("shows what the catalogue card shows, without an account", () => {
    renderPreview({
      sale_venue_type: "tribunal",
      sale_verification_status: "verified",
      property_type: "house",
      app_surface_m2: 92,
      rooms_count: 4,
      city: "Pau",
      department: "64",
      sale_date: "2026-10-20T07:30:00Z",
      tribunal: "TJ Pau",
      media: [{ type: "image", url: "https://example.test/property-photo.jpg" }],
    });
    const facts = screen.getByText("Type de bien").closest("dl")!;
    expect(facts.textContent).toContain("Maison");
    expect(facts.textContent).toContain("92 m²");
    expect(facts.textContent).toContain("4");
    expect(facts.textContent).toContain("Pau · 64");
    // La date et le tribunal sont dans la synthèse, sous la mise à prix.
    const summary = screen.getByRole("complementary", { name: "Synthèse de la vente" });
    expect(summary.textContent).toContain("20 octobre 2026 à 9 h 30");
    expect(summary.textContent).toContain("Tribunal judiciaire de Pau");
    expect(screen.getByRole("img", { name: /Photo du bien/ })).toBeTruthy();
  });

  it("leaves out what is unknown and never prints a midnight time", () => {
    renderPreview({
      property_type: "land",
      app_surface_m2: null,
      rooms_count: null,
      sale_date: "2026-10-23T00:00:00+00:00",
    });
    const facts = screen.getByText("Type de bien").closest("dl")!;
    expect(facts.textContent).not.toContain("Surface");
    expect(facts.textContent).not.toContain("Pièces");
    const summary = screen.getByRole("complementary", { name: "Synthèse de la vente" });
    expect(summary.textContent).toContain("23 octobre 2026");
    expect(summary.textContent).not.toMatch(/\d h \d{2}/);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("says what the free account opens in two places only, not three or four", () => {
    const { container } = renderPreview({
      sale_venue_type: "tribunal",
      sale_verification_status: "verified",
      photo_count: 5,
      has_visit_dates: true,
      document_count: 3,
    });
    expect(screen.queryByText(/protège les informations/)).toBeNull();
    // Le bloc sous le prix, puis la comparaison des offres : plus la liste ni l'introduction.
    expect(screen.queryByText("Avec le compte gratuit, vous voyez aussi")).toBeNull();
    expect(container.textContent).not.toContain("Le compte Découverte est gratuit");
    expect(
      container.textContent?.match(/voir l’adresse, les photos et la fourchette/g),
    ).toHaveLength(1);
    expect(container.textContent?.match(/Découverte · gratuit/g)).toHaveLength(1);
    // Rien de ce que le compte révèle n'est annoncé en chiffres.
    expect(container.textContent).not.toContain("5 photos");
  });

  describe("bloc d'inscription sous le prix", () => {
    /** L'inscription suit le prix dans la synthèse, après la date, le lieu et les conditions. */
    const followsPrice = (block: HTMLElement) => {
      const price = screen.getByText(/^Mise à prix$|^Prix publié$/).closest("[class*=priceBlock]")!;
      expect(price.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(price.parentElement).toBe(block.parentElement);
    };

    it("vient juste après le prix, avec la phrase, le bouton et la ligne d'accès commune", () => {
      renderPreview({ sale_venue_type: "tribunal", starting_price_eur: 59_000 });
      const block = screen.getByTestId("public-signup");
      expect(block.textContent).toContain(
        "Créez votre compte gratuit pour voir l’adresse, les photos et la fourchette de valeur de cette vente.",
      );
      expect(block.textContent).toContain(FREE_ACCESS_LINE);
      expect(within(block).getByRole("link", { name: /Créer mon compte gratuit/ })).toBeTruthy();
      followsPrice(block);
    });

    it("suit le prix aussi pour une vente notariale", () => {
      renderPreview({ sale_venue_type: "notary", starting_price_eur: 59_000 });
      followsPrice(screen.getByTestId("public-signup"));
    });

    it("dit « les autres photos » quand une photo est déjà visible, « les photos » sinon", () => {
      const withPhoto = renderPreview({
        sale_venue_type: "tribunal",
        media: [{ type: "image", url: "https://www.licitor.com/photo.jpg" }],
      } as Partial<AuctionSale>);
      const text = screen.getByTestId("public-signup").textContent ?? "";
      expect(text).toContain("voir l’adresse, les autres photos et la fourchette");
      expect(text).not.toContain("voir l’adresse, les photos");
      withPhoto.unmount();
      renderPreview({ sale_venue_type: "tribunal" });
      expect(screen.getByTestId("public-signup").textContent).toContain(
        "voir l’adresse, les photos et la fourchette",
      );
    });

    it("dit « Vérification de votre compte… » à la place du bouton quand une session est détectée", () => {
      const { container } = renderPreview({ sale_venue_type: "tribunal" }, "sale-1", true);
      const block = screen.getByTestId("public-signup");
      expect(within(block).getByRole("status").textContent).toBe("Vérification de votre compte…");
      expect(screen.queryByRole("link", { name: /Créer mon compte gratuit/ })).toBeNull();
      expect(container.textContent).not.toContain(FREE_ACCESS_LINE);
      // La suite de la recherche reste proposée.
      expect(screen.getByRole("link", { name: "Continuer ma recherche" })).toBeTruthy();
    });
  });

  describe("avocat, frais, source et signalement", () => {
    const SALE = "4655881c-249d-4eab-beba-f2624d8a1af0";

    it("« Avocat obligatoire » renvoie vers /avocats de la vente et vers le simulateur de frais", () => {
      renderPreview({ sale_venue_type: "tribunal" }, SALE);
      const links = screen.getByTestId("public-lawyer-links");
      expect(links.parentElement?.textContent).toContain("Avocat obligatoire pour enchérir");
      expect(
        within(links).getByRole("link", { name: "Trouver un avocat" }).getAttribute("href"),
      ).toBe(`/avocats?saleId=${SALE}`);
      expect(
        within(links)
          .getByRole("link", { name: /Estimer les frais/ })
          .getAttribute("href"),
      ).toBe("/simulateur-frais-encheres");
    });

    it("n'ajoute aucun lien d'avocat pour une vente chez le notaire", () => {
      renderPreview({ sale_venue_type: "notary" });
      expect(screen.queryByTestId("public-lawyer-links")).toBeNull();
    });

    it("« Signaler une erreur sur cette fiche » ouvre /contact prérempli avec la vente et la rubrique", () => {
      renderPreview({ sale_venue_type: "tribunal" }, SALE);
      const link = screen.getByRole("link", { name: "Signaler une erreur sur cette fiche" });
      expect(link.getAttribute("href")).toBe(`/contact?sujet=erreur&vente=${SALE}&rubrique=fiche`);
    });

    it("nomme la source de l'annonce près des faits, et seulement quand elle est connue", () => {
      const { unmount } = renderPreview({
        sale_venue_type: "tribunal",
        source_label: "Licitor",
      });
      const note = screen.getByTestId("public-source-note");
      expect(note.textContent).toContain("Source de l’annonce : Licitor.");
      expect(note.previousElementSibling?.tagName).toBe("DL");
      unmount();
      renderPreview({ sale_venue_type: "tribunal" });
      expect(screen.getByTestId("public-source-note").textContent).not.toContain("Source de");
      expect(
        screen.getByRole("link", { name: "Signaler une erreur sur cette fiche" }),
      ).toBeTruthy();
    });
  });

  describe("alerte du secteur", () => {
    it("propose l'alerte du département de la vente, avec retour à la page de confirmation", () => {
      renderPreview({ sale_venue_type: "tribunal", department: "64" });
      const block = screen.getByTestId("public-sector-alert");
      const link = within(block).getByRole("link", {
        name: "Recevoir les nouvelles ventes de ce secteur",
      });
      expect(link.getAttribute("href")).toBe(
        "/login?redirect=%2Falertes%2Fcreer%3Fdepartment%3D64&mode=investor&reason=alerte",
      );
    });

    it("n'en propose pas sans département, ni pendant la vérification du compte", () => {
      renderPreview({ sale_venue_type: "tribunal", department: null });
      expect(screen.queryByTestId("public-sector-alert")).toBeNull();
      cleanup();
      renderPreview({ sale_venue_type: "tribunal", department: "64" }, "sale-1", true);
      expect(screen.queryByTestId("public-sector-alert")).toBeNull();
    });
  });

  describe("écart au marché en trois bandes", () => {
    it.each([
      ["under", "Mise à prix inférieure à la fourchette des ventes comparables"],
      ["near", "Mise à prix dans la fourchette des ventes comparables"],
      ["above", "Mise à prix au-dessus de la fourchette des ventes comparables"],
    ] as const)("annonce la bande %s sous la mise à prix, sans chiffre", (band, label) => {
      renderPreview({
        sale_venue_type: "tribunal",
        starting_price_eur: 59_000,
        market_gap_band: band,
      });
      const note = screen.getByTestId("market-gap-band");
      expect(note.textContent).toContain(label);
      expect(note.getAttribute("data-band")).toBe(band);
      // Rien de chiffré : ni pourcentage, ni valeur estimée, ni fourchette.
      expect(note.textContent).not.toMatch(/\d/);
      expect(note.textContent).toContain("indicatif");
      expect(note.textContent).toContain("Ne remplace ni une visite ni l’avis d’un professionnel");
      expect(note.textContent).toContain("prix d’adjudication peut être très différent");
      expect(note.textContent).toContain(
        "Aux enchères, la mise à prix est volontairement basse : le prix final est souvent bien supérieur.",
      );
      expect(note.textContent).toContain(
        "DVF (base des ventes immobilières déclarées aux notaires)",
      );
      // Le libellé est exclu des extraits de recherche.
      expect(note.querySelector("[data-nosnippet]")?.textContent).toBe(label);
      // Sous le prix, dans le même bloc : l'inscription le suit toujours, dans la synthèse.
      const priceBlock = screen.getByText("Prix de départ, hors frais").parentElement!;
      expect(priceBlock.contains(note)).toBe(true);
      const signup = screen.getByTestId("public-signup");
      expect(priceBlock.parentElement).toBe(signup.parentElement);
      expect(
        priceBlock.compareDocumentPosition(signup) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("renvoie à la page de méthode", () => {
      renderPreview({ sale_venue_type: "tribunal", market_gap_band: "near" });
      const link = within(screen.getByTestId("market-gap-band")).getByRole("link", {
        name: "Comment est calculé ce repère ?",
      });
      expect(link.getAttribute("href")).toBe("/methode-ecart-marche");
    });

    it("dit que l'estimation n'est pas assez fiable plutôt que de deviner", () => {
      renderPreview({ sale_venue_type: "tribunal", market_gap_band: "insufficient" });
      const note = screen.getByTestId("market-gap-band");
      expect(note.textContent).toContain(
        "Pas assez de ventes comparables fiables pour situer cette mise à prix",
      );
      expect(note.textContent).not.toMatch(/nettement|proche|au-dessus/);
      expect(note.textContent).not.toContain("volontairement basse");
    });

    it.each([
      [
        "insufficient_surface",
        "Surface du bien inconnue : pas de comparaison possible avec les ventes du secteur",
      ],
      [
        "insufficient_type",
        "Type de bien non pris en charge par la comparaison avec les ventes du secteur",
      ],
    ] as const)("sépare la raison d'insuffisance %s", (band, label) => {
      renderPreview({ sale_venue_type: "tribunal", market_gap_band: band });
      const note = screen.getByTestId("market-gap-band");
      expect(note.textContent).toContain(label);
      expect(note.textContent).not.toContain("Pas assez de ventes comparables fiables");
      expect(note.textContent).not.toContain("volontairement basse");
    });

    it("dit « bien occupé » à la place de « inférieure à la fourchette »", () => {
      renderPreview({ sale_venue_type: "tribunal", market_gap_band: "occupied" });
      const note = screen.getByTestId("market-gap-band");
      expect(note.textContent).toContain(
        "Bien occupé : la comparaison avec les ventes de biens libres n'est pas pertinente",
      );
      expect(note.textContent).not.toMatch(/inférieure|fourchette|volontairement basse/);
      expect(
        within(note).getByRole("link", { name: "Comment est calculé ce repère ?" }),
      ).toBeTruthy();
    });

    it("dit « occupation non précisée » sans bande ni phrase sur la mise à prix basse", () => {
      renderPreview({ sale_venue_type: "tribunal", market_gap_band: "occupancy_unknown" });
      const note = screen.getByTestId("market-gap-band");
      expect(note.textContent).toContain(
        "Occupation du bien non précisée : la comparaison avec les ventes de biens libres ne peut pas être située",
      );
      expect(note.textContent).not.toMatch(/inférieure|dans la fourchette|volontairement basse/);
      expect(
        within(note).getByRole("link", { name: "Comment est calculé ce repère ?" }),
      ).toBeTruthy();
    });

    it("n'affiche rien sans bande, ni sans mise à prix", () => {
      const absent = renderPreview({ sale_venue_type: "tribunal" });
      expect(screen.queryByTestId("market-gap-band")).toBeNull();
      absent.unmount();
      const noPrice = renderPreview({
        sale_venue_type: "tribunal",
        starting_price_eur: null,
        market_gap_band: "near",
      });
      expect(screen.queryByTestId("market-gap-band")).toBeNull();
      noPrice.unmount();
      renderPreview({ sale_venue_type: "tribunal", market_gap_band: null });
      expect(screen.queryByTestId("market-gap-band")).toBeNull();
    });

    it("garde le chiffre pour le compte : la ligne d'aperçu parle d'écart chiffré", () => {
      renderPreview({ sale_venue_type: "tribunal", market_gap_band: "near" });
      const teaser = screen.getByRole("region", { name: "L’analyse de cette vente" });
      expect(teaser.textContent).toContain("Écart chiffré avec la mise à prix");
    });

    it("n'a pas de défaut d'accessibilité", async () => {
      const { container } = renderPreview({
        sale_venue_type: "tribunal",
        market_gap_band: "under",
      });
      const result = await axe(container, { rules: { "color-contrast": { enabled: false } } });
      expect(result.violations.map(({ id, help }) => ({ id, help }))).toEqual([]);
    });
  });

  it("garde le h1 et expose un fil d'Ariane cohérent avec le JSON-LD (Accueil, Ventes, la vente)", () => {
    renderPreview({
      sale_venue_type: "tribunal",
      property_type: "apartment",
      app_surface_m2: 50,
      city: "Romainville",
      department: "93",
      sale_date: "2026-10-20T09:00:00+02:00",
    });
    const nav = screen.getByRole("navigation", { name: "Fil d’Ariane" });
    const items = Array.from(nav.querySelectorAll("li"));
    expect(items.map((item) => item.textContent)).toEqual([
      "Accueil",
      "Ventes",
      screen.getByRole("heading", { level: 1 }).firstChild?.textContent,
    ]);
    expect(nav.querySelector('a[href="/"]')?.textContent).toBe("Accueil");
    expect(nav.querySelector('a[href="/sales"]')?.textContent).toBe("Ventes");
    expect(nav.querySelector('[aria-current="page"]')).toBe(items[2].firstElementChild);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("« Retour aux ventes » revient à la recherche d'origine, sur la carte de cette vente", () => {
    renderPreview(
      { id: "7c1e22ab-563c-427b-88a4-740cbf851afb" },
      "7c1e22ab",
      false,
      "/sales?city=Lyon&page=2",
    );
    expect(screen.getByRole("link", { name: /Retour aux ventes/ }).getAttribute("href")).toBe(
      "/sales?city=Lyon&page=2#sale-card-7c1e22ab-563c-427b-88a4-740cbf851afb",
    );
  });

  it("nomme la page d'origine dans le lien de retour (tribunal, audiences, carte)", () => {
    const cases = [
      ["/tribunaux/justice-tj-1-93", "Retour au tribunal", "/tribunaux/justice-tj-1-93"],
      ["/audiences-a-venir", "Retour aux audiences", "/audiences-a-venir"],
      ["/sales?city=Lyon&map=true", "Retour à la carte", null],
    ] as const;
    for (const [from, label, href] of cases) {
      const { unmount } = renderPreview({ id: "sale-1" }, "sale-1", false, from);
      const link = screen.getByRole("link", { name: new RegExp(label) });
      if (href) expect(link.getAttribute("href")).toBe(href);
      else expect(link.getAttribute("href")).toContain("/sales?city=Lyon&map=true#sale-card-");
      unmount();
    }
  });

  it("annonce aux lecteurs d'écran que les valeurs floutées sont masquées, et ce qui les ouvre", () => {
    renderPreview({ sale_venue_type: "tribunal", starting_price_eur: 80_000 });
    const teaser = screen.getByRole("region", { name: "L’analyse de cette vente" });
    const rows = Array.from(teaser.querySelectorAll("dd"));
    expect(rows).toHaveLength(4);
    const spoken = rows.map((row) => row.querySelector(".sr-only")?.textContent);
    expect(spoken[0]).toBe("Valeur masquée, visible avec un compte gratuit");
    expect(spoken[1]).toBe("Valeur masquée, visible avec un compte gratuit");
    expect(spoken[2]).toBe("Valeur masquée, visible avec l’offre Analyse, ou avec un déblocage");
    expect(spoken[3]).toBe("Valeur masquée, visible avec l’offre Analyse");
    // La barre de remplacement reste un décor : jamais lue, et sans aucun chiffre.
    for (const row of rows) {
      const bar = row.querySelector("[aria-hidden='true'][data-nosnippet]");
      expect(bar).not.toBeNull();
      expect(bar?.textContent).toBe("");
    }
  });

  it("reprend les points à vérifier sous l'ancre #points-a-verifier, sans l'occupation", () => {
    renderPreview({
      sale_venue_type: "tribunal",
      sale_date: "2099-01-20T08:30:00+00:00",
      app_surface_m2: null,
      occupancy_status: null,
    });
    const section = screen.getByRole("region", { name: "1 point à vérifier" });
    expect(section.id).toBe("points-a-verifier");
    expect(section.textContent).toContain("Surface non communiquée dans l’annonce");
    expect(section.textContent).not.toContain("Occupation");
  });

  it("n'ajoute aucun bloc de points quand l'aperçu n'en laisse aucun ouvert", () => {
    renderPreview({ sale_venue_type: "tribunal", app_surface_m2: 60 });
    expect(document.getElementById("points-a-verifier")).toBeNull();
  });

  it("signale une vente à date passée : pas de bouton d'agenda, pas de bande d'écart", () => {
    renderPreview({
      sale_venue_type: "tribunal",
      sale_date: "2020-03-12T09:00:00+00:00",
      market_gap_band: "under",
    });
    expect(screen.getByTestId("past-sale-date").textContent).toBe("Date de vente passée");
    expect(screen.queryByRole("button", { name: "Ajouter à mon agenda" })).toBeNull();
    expect(screen.queryByTestId("market-gap-band")).toBeNull();
  });

  it("calcule la mention « date passée » après montage : le rendu serveur ne la porte jamais", () => {
    const html = renderToString(
      <SalePublicPreview
        saleId="sale-1"
        returnTo="/sales"
        preview={
          {
            id: "sale-1",
            sale_venue_type: "tribunal",
            sale_date: "2020-03-12T09:00:00+00:00",
            starting_price_eur: 59_000,
            market_gap_band: "under",
          } as AuctionSale
        }
      />,
    );
    expect(html).not.toContain("Date de vente passée");
    expect(html).not.toContain("past-sale-date");
  });

  it("s'hydrate sans différence quand le jour de la vente passe entre le serveur et le navigateur", async () => {
    vi.useFakeTimers();
    const recoverable: unknown[] = [];
    try {
      const sale = {
        id: "sale-1",
        sale_venue_type: "tribunal",
        // 12 mars 2026, 12 h à Paris.
        sale_date: "2026-03-12T11:00:00+00:00",
        starting_price_eur: 59_000,
      } as AuctionSale;
      const element = <SalePublicPreview saleId="sale-1" returnTo="/sales" preview={sale} />;
      // Le serveur rend le soir du 12 mars (23 h 59 à Paris) : la vente n'est pas passée.
      vi.setSystemTime(new Date("2026-03-12T22:59:00Z"));
      const container = document.createElement("div");
      document.body.appendChild(container);
      container.innerHTML = renderToString(element);
      expect(container.querySelector("[data-testid=past-sale-date]")).toBeNull();
      // Le navigateur hydrate le lendemain (minuit passé) : la mention apparaît, sans erreur d'hydratation.
      vi.setSystemTime(new Date("2026-03-12T23:01:00Z"));
      await act(async () => {
        hydrateRoot(container, element, { onRecoverableError: (error) => recoverable.push(error) });
      });
      expect(container.querySelector("[data-testid=past-sale-date]")?.textContent).toBe(
        "Date de vente passée",
      );
      // Aucune différence entre le HTML du serveur et le premier rendu du navigateur.
      expect(recoverable).toEqual([]);
      container.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("garde l'agenda et la bande d'écart d'une vente à venir, sans signal de date passée", () => {
    renderPreview({
      sale_venue_type: "tribunal",
      sale_date: "2099-01-20T08:30:00+00:00",
      market_gap_band: "under",
    });
    expect(screen.queryByTestId("past-sale-date")).toBeNull();
    expect(screen.getByRole("button", { name: "Ajouter à mon agenda" })).toBeTruthy();
    expect(screen.getByTestId("market-gap-band")).toBeTruthy();
  });

  it("donne leur définition à « mise à prix » et à « adjudication »", () => {
    renderPreview({ sale_venue_type: "tribunal" });
    expect(screen.getByRole("button", { name: "Définition : mise à prix" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Définition : adjudication" })).toBeTruthy();
  });

  it("n'annonce pas « Mise à prix » comme terme à définir pour une cession de l'État", () => {
    renderPreview({ sale_venue_type: "state", starting_price_eur: 10_000 });
    expect(screen.queryByRole("button", { name: "Définition : mise à prix" })).toBeNull();
  });

  it("ne met aucun chiffre factice dans le HTML : des barres, pas « 000 000 € » ni « 00 ventes »", () => {
    const { container } = renderPreview({
      sale_venue_type: "tribunal",
      starting_price_eur: 59_000,
    });
    const placeholders = Array.from(container.querySelectorAll("[data-nosnippet]"));
    expect(placeholders).toHaveLength(4);
    expect(placeholders.map((node) => node.textContent)).toEqual(["", "", "", ""]);
    for (const node of placeholders) expect(node.getAttribute("aria-hidden")).toBe("true");
    const teaser = screen.getByRole("region", { name: "L’analyse de cette vente" });
    expect(teaser.innerHTML).not.toMatch(/000 000|00 ventes|00 %/);
    expect(teaser.textContent).not.toMatch(/€|%|ventes? comparables? : \d/);
  });

  it("describes the property from its facts and teases the analysis without figures", () => {
    renderPreview({
      sale_venue_type: "tribunal",
      property_type: "house",
      app_surface_m2: 92,
      land_surface_m2: 640,
      city: "Pau",
      department: "64",
      has_garden: true,
    });
    const description = screen.getByRole("region", { name: "Le bien" });
    expect(description.textContent).toContain(
      "Maison de 92 m², sur un terrain de 640 m², à Pau (64).",
    );
    expect(description.textContent).toContain("Jardin");
    const teaser = screen.getByRole("region", { name: "L’analyse de cette vente" });
    expect(teaser.textContent).toContain("Enchère plafond (simulation)");
    expect(teaser.textContent).not.toMatch(/000 000/);
    expect(teaser.textContent).not.toMatch(/[1-9]\d* ?\d* €/);
  });

  it("annonce « Mon dossier » au visiteur d'une vente au tribunal, hors du bloc d'analyse", () => {
    renderPreview({ sale_venue_type: "tribunal" });
    const note = screen.getByTestId("public-dossier-teaser");
    expect(note.textContent).toBe(
      "Compte gratuit : notez votre statut et votre enchère plafond sur chaque vente suivie.",
    );
    const teaser = screen.getByRole("region", { name: "L’analyse de cette vente" });
    expect(teaser.contains(note)).toBe(false);
  });

  it("ne cite pas le plafond sur une vente domaniale : le statut seul", () => {
    renderPreview({ sale_venue_type: "state" });
    expect(screen.getByTestId("public-dossier-teaser").textContent).toBe(
      "Compte gratuit : notez votre statut sur chaque vente suivie.",
    );
  });

  it("names both terms of the ceiling on a notarial sale, whose mode is not readable before the unlock", () => {
    renderPreview({ sale_venue_type: "notary" });
    expect(screen.getByTestId("public-dossier-teaser").textContent).toBe(
      "Compte gratuit : notez votre statut et votre enchère plafond ou offre plafond sur chaque vente suivie.",
    );
    const teaser = screen.getByRole("region", { name: "L’analyse de cette vente" });
    expect(teaser.textContent).toContain("Enchère plafond ou offre plafond (simulation)");
    expect(teaser.textContent).toContain("Ventes comparables");
  });

  it("does not promise a bid ceiling for a domanial sale", () => {
    renderPreview({ sale_venue_type: "state" });
    const teaser = screen.getByRole("region", { name: "L’analyse de cette vente" });
    expect(teaser.textContent).not.toContain("plafond");
    expect(teaser.textContent).toContain("Ventes comparables");
  });

  it("offers « Ajouter à mon agenda » on a tribunal hearing, never on another venue or without date", () => {
    const tribunal = renderPreview({
      sale_venue_type: "tribunal",
      sale_date: "2099-01-20T08:30:00+00:00",
    });
    expect(screen.getByRole("button", { name: "Ajouter à mon agenda" })).toBeTruthy();
    expect(screen.getByText(/à vérifier auprès de l’avocat poursuivant/)).toBeTruthy();
    tribunal.unmount();

    const notary = renderPreview({
      sale_venue_type: "notary",
      sale_date: "2099-01-20T08:30:00+00:00",
    });
    expect(screen.queryByRole("button", { name: "Ajouter à mon agenda" })).toBeNull();
    notary.unmount();

    renderPreview({ sale_venue_type: "tribunal", sale_date: null });
    expect(screen.queryByRole("button", { name: "Ajouter à mon agenda" })).toBeNull();
  });

  it("écrit « Date de la vente : à confirmer » pour une vente notariale sans date, et pas ailleurs", () => {
    const notary = renderPreview({ sale_venue_type: "notary", sale_date: null });
    const fact = screen.getByTestId("sale-date-to-confirm");
    expect(fact.parentElement?.textContent).toBe("Date de la venteÀ confirmer");
    notary.unmount();

    const dated = renderPreview({
      sale_venue_type: "notary",
      sale_date: "2099-01-20T08:30:00+00:00",
    });
    expect(screen.queryByTestId("sale-date-to-confirm")).toBeNull();
    dated.unmount();

    renderPreview({ sale_venue_type: "tribunal", sale_date: null });
    expect(screen.queryByTestId("sale-date-to-confirm")).toBeNull();
  });

  it("has no structural accessibility violations", async () => {
    const { container } = renderPreview({
      sale_venue_type: "state",
      sale_verification_status: "verified",
    });
    const result = await axe(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map(({ id, help }) => ({ id, help }))).toEqual([]);
  });
});

function renderPreview(
  overrides: Partial<AuctionSale> = {},
  saleId = "sale-1",
  verifyingAccount = false,
  returnTo = "/sales",
) {
  return render(
    <SalePublicPreview
      saleId={saleId}
      returnTo={returnTo}
      verifyingAccount={verifyingAccount}
      preview={
        {
          id: "sale-1",
          starting_price_eur: 59_000,
          sale_venue_type: "notary",
          sale_verification_status: "cross_checked",
          ...overrides,
        } as AuctionSale
      }
    />,
  );
}

describe("plafond annoncé selon le régime de frais de la vente", () => {
  it("annonce l'enchère plafond d'une vente au tribunal, avec le texte actuel", () => {
    const { container } = renderPreview({ sale_venue_type: "tribunal" });
    const text = container.textContent ?? "";
    expect(text).toContain(
      "Compte gratuit : notez votre statut et votre enchère plafond sur chaque vente suivie.",
    );
    expect(text).toContain("calcul de votre enchère plafond");
    expect(text).toContain("l’enchère plafond");
  });

  function renderNotarial(openFeeRegimes?: readonly FeeRegimeKey[], venue = "notary") {
    return render(
      <SalePublicPreview
        saleId="sale-1"
        returnTo="/sales"
        openFeeRegimes={openFeeRegimes}
        preview={
          {
            id: "sale-1",
            starting_price_eur: 59_000,
            sale_venue_type: venue,
            sale_verification_status: "cross_checked",
          } as AuctionSale
        }
      />,
    );
  }

  it("annonce l'enchère plafond ou l'offre plafond d'une vente notariale : les deux régimes sont ouverts par défaut", () => {
    const { container } = renderNotarial();
    const text = container.textContent ?? "";
    expect(text).toContain(
      "Compte gratuit : notez votre statut et votre enchère plafond ou offre plafond sur chaque vente suivie.",
    );
    expect(text).toContain("l’enchère plafond ou l’offre plafond, la lecture des pièces");
    expect(text).toContain("calcul de votre enchère plafond ou offre plafond");
  });

  it("n'annonce que l'enchère plafond quand seul le régime de la bougie est ouvert", () => {
    const { container } = renderNotarial(["tribunal", "notary_auction"]);
    const text = container.textContent ?? "";
    expect(text).toContain("votre enchère plafond sur chaque vente suivie.");
    expect(text).not.toContain("offre plafond");
  });

  it("n'annonce que l'offre plafond quand seul le régime interactif est ouvert", () => {
    const { container } = renderNotarial(["tribunal", "notary_online"]);
    const text = container.textContent ?? "";
    expect(text).toContain("votre offre plafond sur chaque vente suivie.");
    expect(text).toContain("l’offre plafond, la lecture des pièces");
    expect(text).not.toContain("enchère plafond");
  });

  it("n'annonce aucun plafond pour une vente notariale quand le serveur ne liste que le tribunal", () => {
    const { container } = renderNotarial(["tribunal"]);
    const text = container.textContent ?? "";
    expect(text).toContain("Compte gratuit : notez votre statut sur chaque vente suivie.");
    expect(text).not.toContain("plafond");
  });

  it("n'annonce aucun plafond pour une vente domaniale, même quand tous les régimes sont listés ouverts", () => {
    const { container } = renderNotarial(
      ["tribunal", "notary_auction", "notary_online", "state_auction"],
      "state",
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Compte gratuit : notez votre statut sur chaque vente suivie.");
    expect(text).not.toContain("plafond");
  });
});

describe("essai gratuit à l'inscription sur la fiche publique", () => {
  const sale = {
    id: "sale-1",
    starting_price_eur: 59_000,
    sale_venue_type: "tribunal",
    sale_verification_status: "cross_checked",
  } as AuctionSale;

  function storeWith(state: LaunchOfferState): LaunchOfferStore {
    return {
      getSnapshot: () => state,
      // Le serveur ne lit pas l'état dans ces tests : « pas encore lu », comme un fournisseur sans valeur initiale.
      getServerSnapshot: () => ({ active: false, pending: true }),
      subscribe: () => () => {},
      ensure: () => {},
    };
  }
  function withOffer(state: LaunchOfferState) {
    return (
      <LaunchOfferContext.Provider value={storeWith(state)}>
        <SalePublicPreview saleId="sale-1" returnTo="/sales" preview={sale} />
      </LaunchOfferContext.Provider>
    );
  }

  it("offre active : la mention du visiteur sous le bouton, et les étiquettes de l'offre", () => {
    render(withOffer({ active: true, pending: false }));
    const block = screen.getByTestId("public-signup");
    // Trois lignes factuelles au lieu du texte de l'offre en entier (durée, retrait « sans préavis »…) :
    // l'essentiel, puis un renvoi vers /offres où le texte complet reste lisible.
    const line = screen.getByTestId("public-signup-line");
    expect(line.textContent).toContain(LAUNCH_OFFER_SHORT_TEXT);
    expect(line.textContent).not.toContain("sans préavis");
    expect(line.textContent).not.toContain(LAUNCH_OFFER_VISITOR_TEXT);
    expect(line.textContent?.length).toBeLessThan(200);
    expect(
      within(line).getByRole("link", { name: "Voir les conditions" }).getAttribute("href"),
    ).toBe("/offres");
    expect(block.textContent).not.toContain(FREE_ACCESS_LINE);
    const teaser = screen.getByRole("region", { name: "L’analyse de cette vente" });
    expect(teaser.textContent).toContain("Essai gratuit de 7 jours");
    expect(teaser.textContent).not.toContain("3 déblocages par mois");
    expect(teaser.textContent).not.toContain("Offre Analyse");
  });

  it("offre coupée : la ligne et les étiquettes habituelles", () => {
    render(withOffer({ active: false, pending: false }));
    expect(screen.getByTestId("public-signup-line").textContent).toBe(FREE_ACCESS_LINE);
    const teaser = screen.getByRole("region", { name: "L’analyse de cette vente" });
    expect(teaser.textContent).toContain("Offre Analyse, ou 3 déblocages par mois");
  });

  it("rendu serveur : l'état est inconnu, le HTML ne promet ni quota ni offre", () => {
    // Le magasin annonce « offre active », mais le serveur ne lit pas l'état : il rend « inconnu ».
    const html = renderToString(withOffer({ active: true, pending: false }));
    // Le quota de l'étiquette d'accès (« Offre Analyse, ou 3 déblocages par mois ») dépend de l'état ;
    // la description fixe de l'offre Découverte (« Et 3 déblocages par mois, chacun ouvrant… ») n'en dépend pas.
    expect(html).not.toContain("ou 3 déblocages par mois");
    expect(html).not.toContain("offre de lancement");
    expect(html).toContain("Gratuit, sans carte bancaire");
    expect(html).toContain("Selon votre compte");
  });
});

describe("SalePublicPreview : repère « Pépite »", () => {
  const LOCKED = pepiteCriteriaPayload(
    pepiteCriteriaViews(
      ["pass:regime_open", "pass:sale_upcoming", "pass:test_c_cost"],
      [],
      "notary_auction",
    ),
  );

  async function renderPreview(preview: Partial<AuctionSale>) {
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <SalePublicPreview
          saleId="sale-1"
          preview={{ id: "sale-1", sale_venue_type: "tribunal", ...preview } as AuctionSale}
          returnTo="/sales"
        />
      </QueryClientProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <SalePublicPreview
          saleId="sale-1"
          preview={{ id: "sale-1", sale_venue_type: "tribunal", ...preview } as AuctionSale}
          returnTo="/sales"
        />
      </QueryClientProvider>,
    );
    return view;
  }

  it("ne change rien pour une vente qui n'est pas une pépite", async () => {
    pepiteMocks.pepite.mockReturnValue(null);
    await renderPreview({});
    expect(screen.queryByTestId("pepite-badge")).toBeNull();
    expect(document.body.textContent).not.toMatch(/pépite/i);
    expect(pepiteMocks.pepite).not.toHaveBeenCalled();
  });

  it("réserve la place du bloc tant que les critères d'une pépite arrivent", async () => {
    pepiteMocks.pepite.mockReturnValue(null);
    pepiteMocks.status = "loading";
    try {
      await renderPreview({ pepite: true });
      expect(screen.getByTestId("pepite-block-loading").className).toContain("min-h-44");
    } finally {
      pepiteMocks.status = null;
    }
    cleanup();
    // Plus une pépite (404) : aucune place réservée, la page ne garde aucun trou.
    pepiteMocks.pepite.mockReturnValue(null);
    pepiteMocks.status = "absent";
    try {
      await renderPreview({ pepite: true });
      expect(screen.queryByTestId("pepite-block-loading")).toBeNull();
    } finally {
      pepiteMocks.status = null;
    }
  });

  it("pose la pastille et « Pourquoi ? » en tête, puis le bloc verrouillé avec « Créez un compte gratuit »", async () => {
    pepiteMocks.pepite.mockReturnValue(LOCKED);
    await renderPreview({ pepite: true });
    expect(screen.getByTestId("pepite-badge").textContent).toBe("Pépite");
    expect(screen.getByRole("link", { name: "Pourquoi ?" }).getAttribute("href")).toBe("#pepite");
    // Niveau « criteria » seulement : la vente est déjà connue comme pépite, aucun montant.
    expect(pepiteMocks.pepite).toHaveBeenCalledWith(
      expect.objectContaining({ view: "criteria", known: true }),
    );
    const block = screen.getByRole("region", {
      name: "Pépite : critère rempli",
    });
    expect(block.textContent).toContain("Montant et détail : débloquez cette vente");
    // Le visiteur sans compte lit ce que le compte gratuit lui ouvre, pas un déblocage qu'il n'a pas.
    expect(
      within(block)
        .getByRole("link", { name: "Créez un compte gratuit pour voir le détail du calcul" })
        .getAttribute("href"),
    ).toMatch(/^\/login\?/);
    expect(block.textContent).not.toMatch(/€|Prix de référence|fourchette/);
    expect(block.innerHTML).not.toMatch(/blur/);
  });

  describe("quand le détail ne s'affiche pas", () => {
    afterEach(() => {
      pepiteMocks.status = null;
    });

    it("pendant la lecture : un emplacement de hauteur fixe, et « Pourquoi ? » mène à la méthode", async () => {
      pepiteMocks.pepite.mockReturnValue(null);
      pepiteMocks.status = "loading";
      await renderPreview({ pepite: true });
      expect(screen.getByTestId("pepite-block-loading").className).toMatch(/min-h-/);
      expect(screen.queryByRole("link", { name: "Pourquoi ?" })).toBeNull();
      expect(document.querySelector("#pepite")).toBeNull();
      const head = screen.getByTestId("pepite-badge").parentElement!;
      expect(
        within(head)
          .getByRole("link", { name: "Comment repérons-nous les pépites ?" })
          .getAttribute("href"),
      ).toBe("/methode-pepites");
    });

    it("en cas de panne (503, 429, réseau) : une ligne d'erreur, jamais une ancre morte", async () => {
      pepiteMocks.pepite.mockReturnValue(null);
      pepiteMocks.status = "error";
      await renderPreview({ pepite: true });
      expect(screen.getByTestId("pepite-block-error").textContent).toContain(
        "n’a pas pu être chargé",
      );
      expect(screen.queryByRole("link", { name: "Pourquoi ?" })).toBeNull();
      expect(document.querySelector("a[href='#pepite']")).toBeNull();
    });

    it("quand le bloc est chargé : « Pourquoi ? » mène à l'ancre qui existe", async () => {
      pepiteMocks.pepite.mockReturnValue(LOCKED);
      await renderPreview({ pepite: true });
      expect(screen.getByRole("link", { name: "Pourquoi ?" }).getAttribute("href")).toBe("#pepite");
      expect(document.querySelector("#pepite")).not.toBeNull();
    });
  });

  it("n'emploie qu'une formulation pour le déblocage : « N déblocages par mois »", async () => {
    pepiteMocks.pepite.mockReturnValue(null);
    render(
      <SalePublicPreview
        saleId="sale-1"
        preview={{ id: "sale-1", sale_venue_type: "tribunal" } as AuctionSale}
        returnTo="/sales"
      />,
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("3 déblocages par mois");
    expect(text).not.toContain("en débloquant la vente");
    expect(text).not.toContain("déblocages de ventes");
    expect(screen.getByRole("region", { name: "L’analyse de cette vente" }).textContent).toContain(
      "Valeur masquée, visible avec l’offre Analyse, ou avec un déblocage",
    );
  });
});
