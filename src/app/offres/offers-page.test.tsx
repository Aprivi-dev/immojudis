// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ offer: vi.fn() }));

vi.mock("@/lib/client-billing", () => ({ fetchBillingOffer: mocks.offer }));
vi.mock("@/components/BillingActions", () => ({
  BillingActions: () => <button>Démarrer l’essai Analyse</button>,
}));
import { OffersPage } from "./offers-page";

beforeEach(() => {
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
    expect(await screen.findByText(/Les souscriptions ne sont pas ouvertes/)).toBeTruthy();
    expect(screen.queryByText(/Essai gratuit de 7 jours avec carte bancaire/)).toBeNull();
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
