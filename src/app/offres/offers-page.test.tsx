// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LAUNCH_OFFER_VISITOR_TEXT } from "@/lib/launch-offer";
import { PLAN_LIMITS } from "@/lib/plans";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  launch: vi.fn(() => ({ active: false, pending: false })),
  user: vi.fn((): { id: string } | null => null),
  offer: vi.fn(),
  legalReady: vi.fn(),
  billingActionsProps: vi.fn(),
  track: vi.fn(),
}));
vi.mock("@/lib/product-events", () => ({ trackProductEvent: mocks.track }));

vi.mock("@/lib/client-billing", () => ({ fetchBillingOffer: mocks.offer }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.user(), loading: false }) }));
vi.mock("@/hooks/use-launch-offer", () => ({ useLaunchOffer: () => mocks.launch() }));
vi.mock("@/lib/legal-documents", () => ({
  legalPublisherConfigurationStatus: mocks.legalReady,
}));
vi.mock("@/components/BillingActions", () => ({
  BillingActions: (props: unknown) => {
    mocks.billingActionsProps(props);
    return <button>Démarrer l’essai Analyse</button>;
  },
}));
import { OffersPage } from "./offers-page";

beforeEach(() => {
  mocks.launch.mockReturnValue({ active: false, pending: false });
  mocks.user.mockReturnValue(null);
  mocks.legalReady.mockReturnValue({ ready: true, missing: [] });
  mocks.offer.mockResolvedValue({
    configured: true,
    trialAvailable: true,
    label: "59 € TTC / mois",
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("page Offres", () => {
  it("mesure la consultation des offres une fois, sans donnée personnelle", () => {
    render(<OffersPage />);
    expect(mocks.track).toHaveBeenCalledTimes(1);
    expect(mocks.track).toHaveBeenCalledWith("offers_viewed");
  });

  it("présente trois bénéfices concrets, le comparatif, la FAQ et le prix TTC", async () => {
    render(<OffersPage />);
    expect(screen.getByRole("heading", { name: "Une enchère plafond chiffrée" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Des alertes sur les nouvelles ventes" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Des comparables de ventes réelles" })).toBeTruthy();

    const table = screen.getByRole("table", { name: /Comparaison des offres/ });
    expect(within(table).getByRole("columnheader", { name: "Découverte" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Analyse" })).toBeTruthy();
    expect(within(table).getByRole("rowheader", { name: /Enchère plafond chiffrée/ })).toBeTruthy();

    expect(screen.getAllByText(/59 € TTC \/ mois/).length).toBeGreaterThan(0);
    await waitFor(() => expect(mocks.offer).toHaveBeenCalled());
  });

  it("indique le chemin de résiliation : Mon compte, bouton « Résilier mon abonnement »", () => {
    const { container } = render(<OffersPage />);
    const answer = container.querySelector("details")?.textContent ?? "";
    expect(answer).toContain("« Mon compte », le bouton « Résilier mon abonnement »");
    expect(answer).toContain("date de fin d’accès est affichée avant confirmation");
  });

  it("répond aux six questions attendues", () => {
    const { container } = render(<OffersPage />);
    const questions = Array.from(container.querySelectorAll("details > summary")).map((node) =>
      node.textContent?.trim(),
    );
    expect(questions).toEqual([
      "Comment résilier ?",
      "Y a-t-il un essai gratuit ?",
      "Comment fonctionnent les 3 déblocages par mois ?",
      "Puis-je être remboursé ?",
      "Quelle est la couverture géographique ?",
      "En quoi est-ce différent d’un avocat ?",
    ]);
  });

  it("ne cite ni fournisseur ni « Premium » ni l'historique météo", () => {
    const { container } = render(<OffersPage />);
    expect(container.textContent).not.toMatch(/Stripe|Meteostat|ClimaScore|Premium|météo/i);
  });

  it("promet les statistiques des tribunaux, le rapport PDF et l'export", () => {
    render(<OffersPage />);
    expect(
      screen.getByText(
        "Statistiques des tribunaux : prix d’adjudication, quand l’historique du tribunal est suffisant ; rapport PDF et export des résultats",
      ),
    ).toBeTruthy();
    // Réserve de couverture sous le comparatif : source tierce, période, passé, seuil de ventes.
    const note = screen.getByText(/Les scénarios d’enchères s’appuient sur les adjudications/);
    expect(note.textContent).toMatch(
      /trois dernières années publiées par Licitor \(source tierce, non officielle\)/,
    );
    expect(note.textContent).toMatch(/assez de ventes comparables/);
    expect(note.textContent).toMatch(/ne prédisent pas le prix final/);
    expect(note.textContent).toMatch(/informations et des pièces disponibles/);
  });

  it("annonce le suivi des changements des favoris dans les fonctionnalités d'Analyse", () => {
    render(<OffersPage />);
    expect(
      screen.getByText(
        "Suivi des changements de vos favoris (date, mise à prix, statut, documents), consultable dans Mes favoris",
      ),
    ).toBeTruthy();
  });

  it("n'ajoute jamais d'essai avec carte au paiement : abonnement mensuel, ou tarif prévu", async () => {
    const open = render(<OffersPage />);
    expect(await screen.findByText(/Abonnement mensuel, résiliable à tout moment\./)).toBeTruthy();
    expect(open.container.textContent).not.toMatch(/avec carte bancaire/);
    cleanup();

    mocks.offer.mockResolvedValue({
      configured: false,
      trialAvailable: false,
      label: "59 € TTC / mois",
    });
    render(<OffersPage />);
    expect(
      await screen.findByText(/Tarif prévu : 59 € TTC \/ mois\. Pas encore souscriptible\./),
    ).toBeTruthy();
    expect(screen.queryByText(/Abonnement mensuel, résiliable/)).toBeNull();
  });

  it("n'annonce aucun essai tant que l'offre est en chargement ou en erreur", async () => {
    mocks.offer.mockReturnValue(new Promise(() => undefined));
    const { container, unmount } = render(<OffersPage />);
    expect(container.textContent).not.toMatch(/essai de 7 jours|Essai gratuit de 7 jours/);
    expect(container.textContent).not.toMatch(/Ouverture prochaine|ne sont pas ouvertes/);
    expect(container.textContent).not.toMatch(/Tarif prévu|Pas encore souscriptible/);
    expect(container.textContent).toContain(
      "Les conditions de souscription s’affichent une fois l’offre chargée.",
    );
    unmount();

    mocks.offer.mockRejectedValue(new Error("réseau"));
    const failed = render(<OffersPage />);
    await waitFor(() => expect(mocks.offer).toHaveBeenCalled());
    expect(failed.container.textContent).toContain(
      "Les conditions de souscription s’affichent une fois l’offre chargée.",
    );
    expect(failed.container.textContent).not.toMatch(/essai de 7 jours|Essai gratuit de 7 jours/);
    expect(failed.container.textContent).not.toMatch(/Ouverture prochaine|Tarif prévu/);
  });

  it("affiche « Recommandée » seulement quand l'offre est ouverte", async () => {
    render(<OffersPage />);
    expect(screen.queryByText("Recommandée")).toBeNull();
    expect(await screen.findByText("Recommandée")).toBeTruthy();
    cleanup();

    mocks.offer.mockResolvedValue({ configured: false, trialAvailable: true, label: "59 €" });
    render(<OffersPage />);
    await screen.findByText(/Tarif prévu : 59 € TTC \/ mois\. Pas encore souscriptible\./);
    expect(screen.queryByText("Recommandée")).toBeNull();
    cleanup();

    mocks.offer.mockResolvedValue({ configured: true, trialAvailable: true, label: "59 €" });
    mocks.legalReady.mockReturnValue({ ready: false, missing: ["NEXT_PUBLIC_LEGAL_ENTITY_NAME"] });
    render(<OffersPage />);
    await screen.findByText(/Tarif prévu : 59 € TTC \/ mois\. Pas encore souscriptible\./);
    expect(screen.queryByText("Recommandée")).toBeNull();
  });

  it("lit l'offre une seule fois et la partage avec le bouton de paiement", async () => {
    render(<OffersPage />);
    await screen.findByText(/Abonnement mensuel, résiliable à tout moment\./);
    expect(mocks.offer).toHaveBeenCalledTimes(1);
    const props = mocks.billingActionsProps.mock.calls.at(-1)?.[0] as {
      offerSource: { offer: { status: string }; reload: () => void };
      handleCheckoutReturn: boolean;
    };
    expect(props.offerSource.offer.status).toBe("ready");
    expect(props.handleCheckoutReturn).toBe(true);
  });

  it("relit l'offre quand le bouton « Réessayer » du paiement appelle reload", async () => {
    mocks.offer.mockRejectedValueOnce(new Error("réseau"));
    render(<OffersPage />);
    await waitFor(() => expect(mocks.billingActionsProps).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        (
          mocks.billingActionsProps.mock.calls.at(-1)?.[0] as {
            offerSource: { offer: { status: string } };
          }
        ).offerSource.offer.status,
      ).toBe("error"),
    );
    const props = mocks.billingActionsProps.mock.calls.at(-1)?.[0] as {
      offerSource: { reload: () => void };
    };
    act(() => props.offerSource.reload());
    expect(await screen.findByText(/Abonnement mensuel, résiliable à tout moment\./)).toBeTruthy();
    expect(mocks.offer).toHaveBeenCalledTimes(2);
  });

  it("annonce les déblocages mensuels avec le chiffre de plans.ts et leur limite", () => {
    const n = PLAN_LIMITS.decouverte.monthlyUnlocks;
    const { container } = render(<OffersPage />);
    const text = container.textContent ?? "";

    expect(
      screen.getByText(
        new RegExp(`^${n} déblocages par mois : l’enchère plafond, la lecture des pièces`),
      ),
    ).toBeTruthy();
    expect(text).toContain(
      `elle comprend ${n} déblocages par mois, chacun ouvrant, pour une vente, l’enchère plafond`,
    );
    // Never the names the owner excluded.
    expect(text).not.toMatch(
      /analyses? (complètes? )?gratuites?|essai gratuit des? (déblocages|ventes)/i,
    );
  });

  it("répond à la question sur les déblocages : périmètre, remise à zéro à Paris, ce qui reste à Analyse", () => {
    const { container } = render(<OffersPage />);
    const answer = Array.from(container.querySelectorAll("details")).find((node) =>
      node.querySelector("summary")?.textContent?.includes("déblocages par mois"),
    )?.textContent;

    expect(answer).toContain("l’enchère plafond, la lecture des pièces, l’historique de la vente");
    expect(answer).toContain(
      "les statistiques du tribunal de cette vente et les pièces du dossier",
    );
    expect(answer).toContain("le 1er du mois à 00 h 00, heure de Paris");
    expect(answer).toContain("ne sont pas reportés");
    expect(answer).toContain("tant qu’elle est en ligne");
    expect(answer).toContain("Aucune carte bancaire n’est demandée");
    expect(answer).toContain("L’export PDF ou CSV, les rapports enregistrés");
    expect(answer).toContain("lorsque la vente les comporte");
    expect(answer).toContain("dans la limite de 24 mois après le déblocage");
    expect(answer).toContain("l’estimation détaillée et les ventes comparables restent réservés");
  });

  it("montre dans le comparatif « Pour 3 ventes par mois » plutôt que « Non inclus »", () => {
    render(<OffersPage />);
    const table = screen.getByRole("table", { name: /Comparaison des offres/ });
    const ceiling = within(table).getByRole("rowheader", {
      name: /Enchère plafond chiffrée/,
    }).parentElement!;
    expect(ceiling.textContent).toContain("Pour 3 ventes par mois");
    expect(ceiling.textContent).not.toContain("Non inclus");
    const pdf = within(table).getByRole("rowheader", {
      name: /Rapport PDF du scénario/,
    }).parentElement!;
    expect(pdf.textContent).toContain("Non inclus");
  });

  it("ne promet l'enchère plafond « pour toutes les ventes » que pour celles du tribunal", () => {
    const { container } = render(<OffersPage />);
    const text = container.textContent ?? "";
    expect(text).toContain(
      "Enchère plafond chiffrée pour toutes les ventes au tribunal : travaux, libération, portage et tous les frais",
    );
    expect(text).not.toContain("Enchère plafond chiffrée pour toutes les ventes :");
    expect(text).toContain(`${PLAN_LIMITS.decouverte.favoriteSales} favoris`);
    expect(text).not.toContain("trois favoris");
  });

  it("offre fermée : le tarif prévu est annoncé sans promettre un prix à payer", async () => {
    mocks.offer.mockResolvedValue({ configured: false, trialAvailable: true, label: "59 €" });
    const { container } = render(<OffersPage />);
    await screen.findByText(/Tarif prévu : 59 € TTC \/ mois\. Pas encore souscriptible\./);
    expect(container.textContent).toContain("Analyse : tarif prévu 59 € TTC / mois, pas encore");
    expect(container.textContent).not.toContain("Analyse coûte");
    expect(screen.queryByTestId("launch-offer-banner")).toBeNull();
  });

  it("ne promet les pièces et l'historique que « quand ils existent »", () => {
    const { container } = render(<OffersPage />);
    const text = container.textContent ?? "";
    expect(text).toContain("Pièces du dossier et leur lecture, pour les ventes qui en comportent");
    expect(text).toContain("Historique de la vente, quand il existe");
    expect(text).not.toContain("Pièces du dossier et leur lecture pour toutes les ventes");
    expect(text).not.toContain("Historique de la vente pour toutes les ventes");
  });

  it("souscription fermée : « Tarif prévu » sous le prix, résilier et rembourser au futur", async () => {
    mocks.offer.mockResolvedValue({ configured: false, trialAvailable: true, label: "59 €" });
    const { container } = render(<OffersPage />);
    expect((await screen.findByTestId("price-note")).textContent).toBe(
      "Tarif prévu, pas encore souscriptible",
    );
    const answers = Array.from(container.querySelectorAll("details")).map(
      (node) => node.textContent ?? "",
    );
    const resiliation = answers.find((text) => text.startsWith("Comment résilier ?"))!;
    const refund = answers.find((text) => text.startsWith("Puis-je être remboursé ?"))!;
    expect(resiliation).toContain("Quand l’abonnement sera ouvert, ");
    expect(refund).toContain("Quand l’abonnement sera ouvert, ");
  });

  it("souscription ouverte : ni note de tarif prévu ni préfixe dans la FAQ", async () => {
    const { container } = render(<OffersPage />);
    await screen.findByText(/Abonnement mensuel, résiliable à tout moment\./);
    expect(screen.queryByTestId("price-note")).toBeNull();
    expect(container.textContent).not.toContain("Quand l’abonnement sera ouvert");
  });

  it("essai gratuit : le tarif prévu reste sous le prix, la FAQ explique l'essai et ses règles", async () => {
    mocks.launch.mockReturnValue({ active: true, pending: false });
    mocks.offer.mockResolvedValue({ configured: false, trialAvailable: false, label: "59 €" });
    const { container } = render(<OffersPage />);
    expect((await screen.findByTestId("price-note")).textContent).toBe(
      "Tarif prévu, pas encore souscriptible",
    );
    const answer = (question: string) =>
      Array.from(container.querySelectorAll("details")).find((node) =>
        node.querySelector("summary")?.textContent?.includes(question),
      )!.textContent;
    const unlocks = answer("déblocages par mois");
    expect(unlocks).toContain("qui suivent la confirmation de l’adresse email");
    expect(unlocks).toContain("sont aussi ouverts au compte gratuit");
    expect(unlocks).toContain("redeviennent réservés à Analyse ensuite");
    const trial = answer("Y a-t-il un essai gratuit ?");
    expect(trial).toContain("Oui. Une fois votre adresse email confirmée");
    expect(trial).toContain("n’est proposé qu’une fois par personne");
    expect(trial).toContain("en cas d’abus ou d’impératif technique ou juridique");
    expect(trial).toContain("restent conservées tant que votre compte existe");
    expect(trial).toContain("l’abonnement n’est pas encore ouvert (tarif prévu : 59 € TTC / mois)");
    expect(container.textContent).not.toContain("prendront fin au plus tard au lancement officiel");
    expect(container.textContent).not.toContain("Qu’est-ce que l’offre de lancement ?");
  });

  it("réserve la hauteur du bandeau tant que l'état est inconnu, sans le rendre", () => {
    mocks.launch.mockReturnValue({ active: false, pending: true });
    render(<OffersPage />);
    const placeholder = screen.getByTestId("launch-offer-banner-placeholder");
    expect(placeholder.className).toContain("min-h-");
    expect(placeholder.getAttribute("aria-hidden")).toBe("true");
    expect(placeholder.textContent).toBe("");
    expect(screen.queryByTestId("launch-offer-banner")).toBeNull();
    cleanup();

    mocks.launch.mockReturnValue({ active: false, pending: false });
    render(<OffersPage />);
    expect(screen.queryByTestId("launch-offer-banner-placeholder")).toBeNull();
  });

  it("comparatif : une liste d'une ligne par fonctionnalité sous 640 px, le tableau au-dessus", () => {
    render(<OffersPage />);
    const list = screen.getByRole("list", { name: /en liste/ });
    expect(list.className).toContain("sm:hidden");
    const item = within(list)
      .getAllByRole("listitem")
      .find((node) => node.textContent?.includes("Rapport PDF du scénario"))!;
    expect(item.textContent).toContain("Découverte : Non inclus");
    expect(item.textContent).toContain("Analyse : Inclus");
    const table = screen.getByRole("table", { name: /Comparaison des offres/ });
    expect(table.parentElement?.className).toContain("hidden");
    expect(table.parentElement?.className).toContain("sm:block");
  });

  it("essai gratuit : l'invitation passe avant les offres pour un visiteur, sans bouton de paiement", async () => {
    mocks.launch.mockReturnValue({ active: true, pending: false });
    render(<OffersPage />);

    const banner = screen.getByTestId("launch-offer-banner");
    expect(banner.textContent).toContain(LAUNCH_OFFER_VISITOR_TEXT);
    // Le bandeau précède le titre de la page.
    expect(
      banner.compareDocumentPosition(screen.getByRole("heading", { level: 1 })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getAllByRole("link", { name: /Créer mon compte gratuit/ }).length,
    ).toBeGreaterThan(0);

    // Aucun parcours d'achat sans compte : la carte Analyse ne monte pas le bouton de paiement.
    expect(mocks.billingActionsProps).not.toHaveBeenCalled();
    const panel = screen.getByTestId("launch-offer-panel");
    expect(panel.textContent).toContain(
      "Offerte pendant 7 jours à l’inscription, sans carte bancaire.",
    );
    expect(await within(panel).findByText(/Abonnement mensuel, résiliable/)).toBeTruthy();
    expect(within(panel).getByRole("link", { name: "Commencer l’essai gratuit" })).toBeTruthy();
  });

  it("essai gratuit : un compte connecté n'a pas l'invitation, mais son parcours d'abonnement", () => {
    mocks.launch.mockReturnValue({ active: true, pending: false });
    mocks.user.mockReturnValue({ id: "user-1" });
    render(<OffersPage />);
    expect(screen.queryByTestId("launch-offer-banner")).toBeNull();
    expect(screen.queryByTestId("launch-offer-panel")).toBeNull();
    expect(mocks.billingActionsProps).toHaveBeenCalled();
  });

  it("n'affiche ni l'offre de lancement ni le bouton de paiement tant que l'état est inconnu", () => {
    mocks.launch.mockReturnValue({ active: false, pending: true });
    render(<OffersPage />);
    expect(screen.queryByTestId("launch-offer-banner")).toBeNull();
    expect(mocks.billingActionsProps).not.toHaveBeenCalled();
    expect(screen.getByRole("status", { name: "Chargement de l’offre" })).toBeTruthy();
  });

  it("définit l'enchère plafond là où elle est présentée, vers le lexique du guide", () => {
    render(<OffersPage />);

    // Une bulle près du titre du bénéfice, une dans le comparatif.
    const hints = screen.getAllByRole("button", { name: "Définition : enchère plafond" });
    expect(hints).toHaveLength(2);
    // Le titre garde son nom accessible : la bulle est à côté, pas dedans.
    expect(screen.getByRole("heading", { name: "Une enchère plafond chiffrée" })).toBeTruthy();

    fireEvent.click(hints[0]);
    expect(screen.getByRole("link", { name: "En savoir plus" }).getAttribute("href")).toBe(
      "/ventes-immobilieres-judiciaires#lexique-enchere-plafond",
    );
  });

  it("explique la formule de l'enchère plafond aux lecteurs d'écran", () => {
    render(<OffersPage />);
    expect(
      screen.getByText(
        "Enchère plafond = valeur estimée moins marge de sécurité moins frais et travaux.",
      ),
    ).toBeTruthy();
  });
  it("rendu serveur : ne dit pas « Analyse coûte » tant que l'état de l'offre n'est pas lu", () => {
    // Pas d'effet côté serveur : l'état de l'offre de lancement et de la souscription est inconnu.
    mocks.launch.mockReturnValue({ active: false, pending: true });
    const html = renderToStaticMarkup(<OffersPage />);
    expect(html).not.toMatch(/Analyse coûte/);
    expect(html).not.toMatch(/résiliable à tout moment/);
    expect(html).toContain("Les conditions de souscription s’affichent une fois l’offre chargée.");
    expect(html).not.toContain("launch-offer-free-note");
  });

  it("annonce « Analyse coûte » seulement quand la souscription est lue ouverte", async () => {
    render(<OffersPage />);
    expect(screen.queryByText(/Analyse coûte/)).toBeNull();
    expect(
      await screen.findByText(/Analyse coûte 59 € TTC \/ mois, résiliable à tout moment/),
    ).toBeTruthy();
  });

  it("essai gratuit : le prix reste dit, et la carte Découverte et le comparatif disent quand ses limites s'appliquent", async () => {
    mocks.launch.mockReturnValue({ active: true, pending: false });
    mocks.offer.mockResolvedValue({ configured: false, trialAvailable: false, label: "59 €" });
    const { container } = render(<OffersPage />);
    await screen.findByTestId("price-note");
    expect(container.textContent).not.toMatch(/Analyse coûte/);
    expect(container.textContent).toContain(
      "Analyse : tarif prévu 59 € TTC / mois, pas encore souscriptible. Elle est offerte pendant 7 jours à l’inscription, sans carte bancaire.",
    );
    const discovery = screen.getByTestId("launch-offer-free-note");
    const comparison = screen.getByTestId("launch-offer-comparison-note");
    for (const note of [discovery, comparison]) {
      expect(note.textContent).toContain("qui suivent la confirmation de son adresse email");
      expect(note.textContent).toContain("bénéficie de l’offre Analyse (un essai par personne)");
      expect(note.textContent).toContain("s’appliquent ensuite");
    }
    // La carte Découverte contient sa mention, le comparatif la sienne.
    expect(discovery.closest("article")?.textContent).toContain("Découverte");
    expect(comparison.nextElementSibling?.tagName).toBe("UL");
  });

  it("hors offre de lancement, aucune mention de l'offre de lancement dans la carte ni le comparatif", async () => {
    render(<OffersPage />);
    await screen.findByText(/Abonnement mensuel, résiliable à tout moment\./);
    expect(screen.queryByTestId("launch-offer-free-note")).toBeNull();
    expect(screen.queryByTestId("launch-offer-comparison-note")).toBeNull();
  });

  it("ne liste plus les « scénarios » parmi les bénéfices de l'offre Analyse", () => {
    render(<OffersPage />);
    const analysis = screen.getByRole("article", { name: "Analyse" });
    expect(analysis.textContent).not.toMatch(/scénarios/i);
    expect(analysis.textContent).toContain("Statistiques des tribunaux : prix d’adjudication");
  });
});
