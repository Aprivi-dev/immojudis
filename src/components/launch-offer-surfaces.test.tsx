// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LAUNCH_OFFER_ACCOUNT_TEXT, LAUNCH_OFFER_VISITOR_TEXT } from "@/lib/launch-offer";
import { PLAN_LIMITS } from "@/lib/plans";
import { FREE_ACCESS_LINE } from "@/lib/sale-unlocks";

/**
 * Les surfaces qui présentent le surclassement (accueil, onboarding, /compte, mention des pages
 * rendues côté serveur) : mention de l'offre quand elle est active, texte habituel sinon.
 */
const mocks = vi.hoisted(() => ({
  launch: { active: false, pending: false },
  user: null as { id: string; email?: string } | null,
  plan: vi.fn(),
  overview: vi.fn(),
  checkoutOpen: true as boolean | null,
}));
vi.mock("@/hooks/use-launch-offer", () => ({ useLaunchOffer: () => mocks.launch }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.user, loading: false }) }));
vi.mock("@/hooks/use-analysis-checkout-open", () => ({
  useAnalysisCheckoutOpen: () => mocks.checkoutOpen,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock("next/form", () => ({
  default: ({ children, ...props }: { children: React.ReactNode }) => (
    <form {...props}>{children}</form>
  ),
}));
vi.mock("@/lib/client-billing", () => ({
  fetchAccessPlan: mocks.plan,
  fetchOfferOpeningNotification: vi.fn().mockResolvedValue({
    notification: { requested: false, consentedAt: null },
  }),
  updateOfferOpeningNotification: vi.fn(),
  updateOfferOpeningSurvey: vi.fn(),
}));
vi.mock("@/lib/client-api", () => ({
  fetchSaleUnlocksOverview: mocks.overview,
  fetchAccessPlan: mocks.plan,
  fetchNotificationPreferences: vi.fn().mockResolvedValue({ preferences: {} }),
  updateNotificationPreferences: vi.fn(),
}));
// /bienvenue crée l'alerte par ce crochet (chantier W5) : simulé, il est testé à part.
vi.mock("@/hooks/use-has-analysis-access", () => ({ useHasAnalysisAccess: () => false }));
vi.mock("@/hooks/use-create-alert", () => ({
  useCreateAlert: () => ({ createAlertFromSearch: vi.fn(), saving: false }),
}));
vi.mock("@/components/BillingActions", () => ({ BillingActions: () => <div>Actions</div> }));

import { AccountPage } from "./AccountPage";
import { CinematicHero } from "./CinematicHome";
import { HomeDiscovery } from "./HomeDiscovery";
import { InvestorOnboarding } from "./InvestorOnboarding";
import { HideForLaunchOfferAccount, LaunchOfferNote } from "./LaunchOfferNote";

beforeEach(() => {
  mocks.launch = { active: false, pending: false };
  mocks.user = null;
  mocks.checkoutOpen = true;
  mocks.plan.mockReset();
  mocks.overview.mockReset();
});
afterEach(cleanup);

describe("accueil", () => {
  it("garde la ligne du compte gratuit quand l'offre de lancement est coupée", () => {
    render(<CinematicHero />);
    expect(screen.getByRole("link", { name: FREE_ACCESS_LINE }).getAttribute("href")).toBe(
      "/offres",
    );
  });

  it("remplace cette ligne par la mention de l'offre quand elle est active", () => {
    mocks.launch = { active: true, pending: false };
    render(<CinematicHero />);
    expect(screen.getByRole("link", { name: LAUNCH_OFFER_VISITOR_TEXT })).toBeTruthy();
    expect(screen.queryByText(FREE_ACCESS_LINE)).toBeNull();
  });

  it("parle au compte connecté avec le texte du compte", () => {
    mocks.launch = { active: true, pending: false };
    mocks.user = { id: "u1" };
    render(<CinematicHero />);
    expect(screen.getByRole("link", { name: LAUNCH_OFFER_ACCOUNT_TEXT })).toBeTruthy();
  });
});

describe("carte Analyse de l'accueil", () => {
  function analysisCard() {
    return screen.getByRole("heading", { name: "Analyse" }).closest("article")!;
  }

  it("souscription fermée : « Me prévenir de l’ouverture » en bouton principal et tarif prévu", () => {
    mocks.checkoutOpen = false;
    render(<HomeDiscovery />);
    const card = analysisCard();
    expect(card.querySelector("button")?.textContent).toContain("Me prévenir de l’ouverture");
    expect(card.textContent).toContain("Tarif prévu : 59 € TTC / mois. Pas encore souscriptible.");
    expect(card.textContent).not.toContain("Offre bientôt disponible");
    expect(card.textContent).not.toContain("Découvrir Analyse");
  });

  it("souscription ouverte : le lien « Découvrir Analyse » et l'essai", () => {
    render(<HomeDiscovery />);
    expect(analysisCard().textContent).toContain("Découvrir Analyse");
    expect(analysisCard().textContent).toContain("Essai de 7 jours");
  });

  it("offre de lancement : la mention sur la carte gratuite, aucun achat sur la carte Analyse", () => {
    mocks.launch = { active: true, pending: false };
    mocks.checkoutOpen = false;
    render(<HomeDiscovery />);
    const free = screen.getByRole("heading", { name: "Découverte" }).closest("article")!;
    expect(free.textContent).toContain(LAUNCH_OFFER_VISITOR_TEXT);
    const card = analysisCard();
    expect(card.querySelector("button")).toBeNull();
    expect(card.textContent).toContain(
      "Inclus avec un compte gratuit pendant l’offre de lancement",
    );
    expect(card.textContent).toContain("Pas encore souscriptible.");
  });

  it("annonce 10 favoris pour le compte gratuit", () => {
    render(<HomeDiscovery />);
    const free = screen.getByRole("heading", { name: "Découverte" }).closest("article")!;
    expect(free.textContent).toContain("Jusqu’à 10 favoris");
    expect(free.textContent).not.toContain("trois favoris");
  });
});

describe("onboarding /bienvenue", () => {
  it("n'affiche la mention de l'offre que tant qu'elle est active", () => {
    const { unmount } = render(<InvestorOnboarding />);
    expect(screen.queryByTestId("onboarding-launch-offer")).toBeNull();
    unmount();

    mocks.launch = { active: true, pending: false };
    render(<InvestorOnboarding />);
    expect(screen.getByTestId("onboarding-launch-offer").textContent).toBe(
      LAUNCH_OFFER_ACCOUNT_TEXT,
    );
  });

  it("ne promet plus « 3 ventes par mois » au dernier pas pendant l'offre", () => {
    mocks.launch = { active: true, pending: false };
    render(<InvestorOnboarding />);
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    const text = document.body.textContent ?? "";
    expect(text).toContain(
      "Pendant l’offre de lancement, votre compte gratuit ouvre les outils de l’offre Analyse sur toutes les ventes (contenu selon la vente).",
    );
    expect(text).not.toContain("Chaque mois, vous pouvez débloquer");
  });
});

describe("page Mon compte", () => {
  function renderPage() {
    return render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AccountPage />
      </QueryClientProvider>,
    );
  }

  beforeEach(() => {
    mocks.user = { id: "u1", email: "a@b.test" };
  });

  it("offre de lancement : plan Analyse marqué, mention retirable, ni date de fin ni portail", async () => {
    mocks.plan.mockResolvedValue({
      plan: {
        plan: "analyse",
        label: "Analyse",
        hasAnalysisAccess: true,
        launchOffer: true,
        currentPeriodEnd: null,
      },
    });
    renderPage();

    expect(await screen.findByText("Analyse · offre de lancement")).toBeTruthy();
    expect(screen.getByTestId("account-launch-offer").textContent).toBe(LAUNCH_OFFER_ACCOUNT_TEXT);
    // Aucun compteur de déblocages (accès complet) et aucune explication du portail Stripe.
    expect(screen.queryByTestId("account-unlocks")).toBeNull();
    expect(mocks.overview).not.toHaveBeenCalled();
    expect(screen.queryByText(/portail sécurisé Stripe/)).toBeNull();
    expect(screen.queryByText(/accès jusqu’au/)).toBeNull();
  });

  it("offre de lancement : dit ce qui reste gratuit et ce qui demandera Analyse, sans date ni pression", async () => {
    mocks.plan.mockResolvedValue({
      plan: {
        plan: "analyse",
        label: "Analyse",
        hasAnalysisAccess: true,
        launchOffer: true,
        currentPeriodEnd: null,
      },
    });
    renderPage();

    const block = await screen.findByTestId("account-offer-end");
    const text = block.textContent ?? "";
    expect(text).toContain("Ce qui reste gratuit");
    expect(text).toContain(`${PLAN_LIMITS.decouverte.favoriteSales} favoris`);
    expect(text).toContain("1 alerte avec un email récapitulatif par semaine");
    expect(text).toContain(
      `${PLAN_LIMITS.decouverte.monthlyUnlocks} déblocages de ventes par mois`,
    );
    expect(text).toContain("« Mon dossier »");
    expect(text).toContain("Ce qui demandera l’offre Analyse");
    expect(text).toContain("le rapport PDF");
    expect(text).toContain("ventes comparables");
    expect(text).toContain("les exports");
    expect(text).toContain("vos données ne sont pas supprimées");
    // Ni compte à rebours, ni date, ni incitation à s'abonner.
    expect(text).not.toMatch(/\d{4}|jours?|dernier|vite|profitez|abonnez/i);
    expect(block.querySelector("a, button")).toBeNull();
  });

  it("n'affiche pas ce bloc à un abonné réel ni hors de l'offre de lancement", async () => {
    mocks.plan.mockResolvedValue({
      plan: {
        plan: "analyse",
        label: "Analyse",
        hasAnalysisAccess: true,
        currentPeriodEnd: "2026-12-01T00:00:00.000Z",
        billing: { status: "active", hasStripeCustomer: true, graceEndsAt: null },
      },
    });
    renderPage();
    await screen.findByText(/accès jusqu’au 1 décembre 2026/);
    expect(screen.queryByTestId("account-offer-end")).toBeNull();
  });

  it("un abonné réel garde son libellé, sa date de fin et l'explication du portail", async () => {
    mocks.plan.mockResolvedValue({
      plan: {
        plan: "analyse",
        label: "Analyse",
        hasAnalysisAccess: true,
        currentPeriodEnd: "2026-12-01T00:00:00.000Z",
        billing: { status: "active", hasStripeCustomer: true, graceEndsAt: null },
      },
    });
    renderPage();
    expect(await screen.findByText(/accès jusqu’au 1 décembre 2026/)).toBeTruthy();
    expect(screen.getByText(/portail sécurisé Stripe/)).toBeTruthy();
    expect(screen.queryByTestId("account-launch-offer")).toBeNull();
  });
});

describe("mention des pages rendues côté serveur", () => {
  it("n'affiche rien tant que l'offre n'est pas active ni connue", () => {
    const { container, unmount } = render(<LaunchOfferNote />);
    expect(container.textContent).toBe("");
    unmount();

    mocks.launch = { active: false, pending: true };
    const pending = render(<LaunchOfferNote />);
    expect(pending.container.textContent).toBe("");
    expect(screen.queryByTestId("launch-offer-note")).toBeNull();
  });

  it("réserve la hauteur du bloc tant que l'état est inconnu, sans le rendre ni le lire", () => {
    mocks.launch = { active: false, pending: true };
    render(<LaunchOfferNote className="mt-3" />);
    const placeholder = screen.getByTestId("launch-offer-note-placeholder");
    expect(placeholder.getAttribute("aria-hidden")).toBe("true");
    expect(placeholder.className).toContain("mt-3");
    expect(placeholder.className).toMatch(/min-h-\d+/);
  });

  it("ne réserve rien une fois l'état connu", () => {
    mocks.launch = { active: false, pending: false };
    render(<LaunchOfferNote />);
    expect(screen.queryByTestId("launch-offer-note-placeholder")).toBeNull();
  });

  it("affiche la mention du visiteur, ou celle du compte connecté", () => {
    mocks.launch = { active: true, pending: false };
    const { unmount } = render(<LaunchOfferNote />);
    expect(screen.getByTestId("launch-offer-note").textContent).toBe(LAUNCH_OFFER_VISITOR_TEXT);
    unmount();

    mocks.user = { id: "u1" };
    render(<LaunchOfferNote />);
    expect(screen.getByTestId("launch-offer-note").textContent).toBe(LAUNCH_OFFER_ACCOUNT_TEXT);
  });
});

describe("incitation à découvrir l'offre Analyse", () => {
  const cta = () => <a href="/offres">Découvrir l’offre Analyse</a>;

  it("reste montrée à un visiteur, avec ou sans offre de lancement", () => {
    const { unmount } = render(<HideForLaunchOfferAccount>{cta()}</HideForLaunchOfferAccount>);
    expect(screen.getByRole("link", { name: "Découvrir l’offre Analyse" })).toBeTruthy();
    unmount();

    mocks.launch = { active: true, pending: false };
    render(<HideForLaunchOfferAccount>{cta()}</HideForLaunchOfferAccount>);
    expect(screen.getByRole("link", { name: "Découvrir l’offre Analyse" })).toBeTruthy();
  });

  it("est masquée à un compte qui bénéficie déjà des avantages Analyse", () => {
    mocks.launch = { active: true, pending: false };
    mocks.user = { id: "u1" };
    render(<HideForLaunchOfferAccount>{cta()}</HideForLaunchOfferAccount>);
    expect(screen.queryByRole("link", { name: "Découvrir l’offre Analyse" })).toBeNull();
  });

  it("revient pour un compte connecté quand l'offre est coupée", () => {
    mocks.user = { id: "u1" };
    render(<HideForLaunchOfferAccount>{cta()}</HideForLaunchOfferAccount>);
    expect(screen.getByRole("link", { name: "Découvrir l’offre Analyse" })).toBeTruthy();
  });
});
