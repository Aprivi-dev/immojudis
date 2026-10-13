// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  offer: vi.fn(),
  legalReady: vi.fn(),
  billingActionsProps: vi.fn(),
  track: vi.fn(),
}));
vi.mock("@/lib/product-events", () => ({ trackProductEvent: mocks.track }));

vi.mock("@/lib/client-billing", () => ({ fetchBillingOffer: mocks.offer }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: null, loading: false }) }));
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
  mocks.legalReady.mockReturnValue({ ready: true, missing: [] });
  mocks.offer.mockResolvedValue({
    configured: true,
    trialAvailable: true,
    label: "29 € TTC / mois",
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

    expect(screen.getAllByText(/29 € TTC \/ mois/).length).toBeGreaterThan(0);
    await waitFor(() => expect(mocks.offer).toHaveBeenCalled());
  });

  it("indique le chemin de résiliation : Mon compte, bouton « Résilier mon abonnement »", () => {
    const { container } = render(<OffersPage />);
    const answer = container.querySelector("details")?.textContent ?? "";
    expect(answer).toContain("« Mon compte », le bouton « Résilier mon abonnement »");
    expect(answer).toContain("date de fin d’accès est affichée avant confirmation");
  });

  it("répond aux cinq questions attendues", () => {
    const { container } = render(<OffersPage />);
    const questions = Array.from(container.querySelectorAll("details > summary")).map((node) =>
      node.textContent?.trim(),
    );
    expect(questions).toEqual([
      "Comment résilier ?",
      "Y a-t-il un essai gratuit ?",
      "Puis-je être remboursé ?",
      "Quelle est la couverture géographique ?",
      "En quoi est-ce différent d’un avocat ?",
    ]);
  });

  it("ne cite ni fournisseur ni « Premium » ni l'historique météo", () => {
    const { container } = render(<OffersPage />);
    expect(container.textContent).not.toMatch(/Stripe|Meteostat|ClimaScore|Premium|météo/i);
  });

  it("ne promet plus les statistiques des tribunaux, fonction gelée", () => {
    const { container } = render(<OffersPage />);
    expect(container.textContent).not.toMatch(/statistiques/i);
    expect(screen.getByText("Rapport PDF et export des résultats")).toBeTruthy();
  });

  it("promet l'essai seulement quand la souscription est ouverte", async () => {
    render(<OffersPage />);
    expect(await screen.findByText(/Essai gratuit de 7 jours avec carte bancaire/)).toBeTruthy();
    cleanup();

    mocks.offer.mockResolvedValue({
      configured: false,
      trialAvailable: false,
      label: "29 € TTC / mois",
    });
    render(<OffersPage />);
    expect(await screen.findByText(/Ouverture prochaine des souscriptions/)).toBeTruthy();
    expect(screen.queryByText(/Essai gratuit de 7 jours avec carte bancaire/)).toBeNull();
  });

  it("n'annonce aucun essai tant que l'offre est en chargement ou en erreur", async () => {
    mocks.offer.mockReturnValue(new Promise(() => undefined));
    const { container, unmount } = render(<OffersPage />);
    expect(container.textContent).not.toMatch(/essai de 7 jours|Essai gratuit de 7 jours/);
    expect(container.textContent).not.toMatch(/Ouverture prochaine|ne sont pas ouvertes/);
    expect(
      screen.getByText("Les conditions de l’essai s’affichent dès que l’offre est chargée."),
    ).toBeTruthy();
    unmount();

    mocks.offer.mockRejectedValue(new Error("réseau"));
    const failed = render(<OffersPage />);
    expect(await screen.findByText(/n’ont pas pu être chargées/)).toBeTruthy();
    expect(failed.container.textContent).not.toMatch(/essai de 7 jours|Essai gratuit de 7 jours/);
    expect(failed.container.textContent).not.toMatch(/Ouverture prochaine/);
  });

  it("affiche « Recommandée » seulement quand l'offre est ouverte", async () => {
    render(<OffersPage />);
    expect(screen.queryByText("Recommandée")).toBeNull();
    expect(await screen.findByText("Recommandée")).toBeTruthy();
    cleanup();

    mocks.offer.mockResolvedValue({ configured: false, trialAvailable: true, label: "29 €" });
    render(<OffersPage />);
    await screen.findByText(/Ouverture prochaine des souscriptions/);
    expect(screen.queryByText("Recommandée")).toBeNull();
    cleanup();

    mocks.offer.mockResolvedValue({ configured: true, trialAvailable: true, label: "29 €" });
    mocks.legalReady.mockReturnValue({ ready: false, missing: ["NEXT_PUBLIC_LEGAL_ENTITY_NAME"] });
    render(<OffersPage />);
    await screen.findByText(/Ouverture prochaine des souscriptions/);
    expect(screen.queryByText("Recommandée")).toBeNull();
  });

  it("lit l'offre une seule fois et la partage avec le bouton de paiement", async () => {
    render(<OffersPage />);
    await screen.findByText(/Essai gratuit de 7 jours/);
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
    await screen.findByText(/n’ont pas pu être chargées/);
    const props = mocks.billingActionsProps.mock.calls.at(-1)?.[0] as {
      offerSource: { reload: () => void };
    };
    act(() => props.offerSource.reload());
    expect(await screen.findByText(/Essai gratuit de 7 jours/)).toBeTruthy();
    expect(mocks.offer).toHaveBeenCalledTimes(2);
  });

  it("explique la formule de l'enchère plafond aux lecteurs d'écran", () => {
    render(<OffersPage />);
    expect(
      screen.getByText(
        "Enchère plafond = valeur estimée moins marge de sécurité moins frais et travaux.",
      ),
    ).toBeTruthy();
  });
});
