// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAUNCH_OFFER_ACCOUNT_TEXT,
  LAUNCH_OFFER_DURATION_TEXT,
  LAUNCH_OFFER_VISITOR_TEXT,
  SIGNUP_TRIAL_DENIED_TEXT,
} from "@/lib/launch-offer";
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
import { HomeHero } from "./home/HomeHero";
import { HOME_TRIAL_NOTE } from "./home/HomePrimaryAction";
import { HomeOffers } from "./home/HomeOffers";
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
  it("garde la ligne du compte gratuit sous l'inscription, quand l'essai est coupé", () => {
    render(<HomeHero />);
    expect(screen.getByText(FREE_ACCESS_LINE)).toBeTruthy();
    expect(screen.queryByText(HOME_TRIAL_NOTE)).toBeNull();
    expect(
      screen.getByRole("link", { name: /Créer mon compte gratuit/ }).getAttribute("href"),
    ).toBe("/login?mode=investor");
  });

  it("annonce l'essai sous l'inscription quand il est ouvert, sans en répéter les règles", () => {
    mocks.launch = { active: true, pending: false };
    render(<HomeHero />);
    expect(screen.getByText(HOME_TRIAL_NOTE)).toBeTruthy();
    expect(screen.queryByText(FREE_ACCESS_LINE)).toBeNull();
    // Les règles complètes ne sont pas répétées dans le premier écran.
    expect(document.body.textContent).not.toContain(LAUNCH_OFFER_DURATION_TEXT);
  });

  it("n'invite pas à s'inscrire un compte déjà connecté : il explore les ventes", () => {
    mocks.launch = { active: true, pending: false };
    mocks.user = { id: "u1" };
    render(<HomeHero />);
    expect(screen.queryByText(HOME_TRIAL_NOTE)).toBeNull();
    expect(screen.queryByRole("link", { name: /Créer mon compte gratuit/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Explorer les ventes/ }).getAttribute("href")).toBe(
      "/sales",
    );
  });

  it("ne cite jamais le tarif de l'offre Analyse", () => {
    for (const checkoutOpen of [true, false, null]) {
      for (const active of [true, false]) {
        mocks.checkoutOpen = checkoutOpen;
        mocks.launch = { active, pending: false };
        render(
          <>
            <HomeHero />
            <HomeOffers />
          </>,
        );
        expect(document.body.textContent).not.toMatch(/59|€ TTC|Tarif prévu/);
        cleanup();
      }
    }
  });
});

describe("carte Analyse de l'accueil", () => {
  function analysisCard() {
    return screen.getByRole("heading", { name: "Analyse" }).closest("article")!;
  }

  it("ni essai ni souscription : « Me prévenir de l’ouverture » en bouton principal", async () => {
    mocks.checkoutOpen = false;
    render(<HomeOffers />);
    const card = analysisCard();
    // La demande est chargée à la demande (un seul import dynamique partagé).
    expect(
      await within(card).findByRole("button", { name: "Me prévenir de l’ouverture" }),
    ).toBeTruthy();
    expect(card.textContent).toContain("Sur abonnement");
    expect(card.textContent).toContain("Abonnement bientôt disponible.");
    expect(card.textContent).not.toContain("Découvrir Analyse");
  });

  it("souscription ouverte : le lien « Découvrir Analyse », sans essai avec carte", () => {
    render(<HomeOffers />);
    expect(analysisCard().textContent).toContain("Découvrir Analyse");
    expect(analysisCard().textContent).toContain(
      "Abonnement mensuel, résiliable depuis votre compte.",
    );
    expect(analysisCard().textContent).not.toMatch(/carte bancaire/);
  });

  it("essai ouvert : 7 jours offerts et ses règles sur la carte Analyse, une seule inscription dessous", () => {
    mocks.launch = { active: true, pending: false };
    mocks.checkoutOpen = false;
    render(<HomeOffers />);
    const card = analysisCard();
    expect(card.textContent).toContain("7 jours offerts");
    expect(screen.getByTestId("home-launch-offer").textContent).toBe(LAUNCH_OFFER_VISITOR_TEXT);
    expect(card.querySelector("button, a")).toBeNull();
    const signups = screen.getAllByRole("link", { name: /Créer mon compte gratuit/ });
    expect(signups).toHaveLength(1);
    expect(signups[0].closest("article")).toBeNull();
    expect(signups[0].getAttribute("href")).toBe("/login?mode=investor");
    expect(document.body.textContent).toContain("Rien n’est prélevé à la fin de l’essai.");
  });

  it("essai ouvert : un compte connecté lit la règle, sans invitation à s'inscrire", () => {
    mocks.launch = { active: true, pending: false };
    mocks.user = { id: "u1" };
    render(<HomeOffers />);
    expect(screen.getByTestId("home-launch-offer").textContent).toBe(LAUNCH_OFFER_ACCOUNT_TEXT);
    expect(screen.queryByRole("link", { name: /Créer mon compte gratuit/ })).toBeNull();
    expect(within(analysisCard()).getByRole("link", { name: /Découvrir Analyse/ })).toBeTruthy();
  });

  it("annonce 10 favoris pour le compte gratuit", () => {
    render(<HomeOffers />);
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
      "Pendant votre essai gratuit de 7 jours, votre compte ouvre les outils de l’offre Analyse sur toutes les ventes (contenu selon la vente). Ensuite, vous pourrez débloquer 3 ventes en détail chaque mois.",
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

  it("essai gratuit : plan Analyse marqué, fin de l'essai datée, ni période payée ni portail", async () => {
    mocks.plan.mockResolvedValue({
      plan: {
        plan: "analyse",
        label: "Analyse",
        hasAnalysisAccess: true,
        launchOffer: true,
        trialEndsAt: "2026-11-01T13:05:00.000Z",
        currentPeriodEnd: null,
      },
    });
    renderPage();

    expect(await screen.findByText("Analyse · essai gratuit")).toBeTruthy();
    expect(screen.getByTestId("account-launch-offer").textContent).toBe(
      "Essai gratuit de l’offre Analyse jusqu’au 1er novembre 2026 à 14:05. À son terme, votre compte revient à l’offre Découverte, gratuite : rien ne devient payant automatiquement.",
    );
    // Aucun compteur de déblocages (accès complet) et aucune explication du portail Stripe.
    expect(screen.queryByTestId("account-unlocks")).toBeNull();
    expect(mocks.overview).not.toHaveBeenCalled();
    expect(screen.queryByText(/portail sécurisé Stripe/)).toBeNull();
    expect(screen.queryByText(/accès jusqu’au/)).toBeNull();
  });

  it("essai gratuit : dit ce qui reste gratuit et ce qui demandera Analyse, sans compte à rebours", async () => {
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
    expect(text).toContain(LAUNCH_OFFER_DURATION_TEXT);
    expect(text).toContain(
      "Vos données (favoris, alertes, rapports enregistrés) restent conservées tant que votre compte existe et dans les durées de la politique de confidentialité. Elles redeviennent accessibles avec l’offre Analyse.",
    );
    // Ni compte à rebours, ni date, ni incitation à s'abonner (la date est dans « Abonnement »).
    expect(text).not.toMatch(/\d{4}|restants?|dernier|vite|profitez|abonnez/i);
    expect(block.querySelector("a, button")).toBeNull();
  });

  it("après l'essai : le compte Découverte lit la date de fin de son essai", async () => {
    mocks.plan.mockResolvedValue({
      plan: {
        plan: "decouverte",
        label: "Découverte",
        hasAnalysisAccess: false,
        trialEndedAt: "2026-10-30T09:00:00.000Z",
        currentPeriodEnd: null,
      },
    });
    mocks.overview.mockResolvedValue({ status: null });
    renderPage();
    expect((await screen.findByTestId("account-trial-ended")).textContent).toContain(
      "Votre essai gratuit de l’offre Analyse s’est terminé le 30 octobre 2026",
    );
    expect(screen.queryByTestId("account-offer-end")).toBeNull();
  });

  it("essai refusé : le compte lit pourquoi, et où écrire", async () => {
    mocks.plan.mockResolvedValue({
      plan: {
        plan: "decouverte",
        label: "Découverte",
        hasAnalysisAccess: false,
        trialDenied: true,
        currentPeriodEnd: null,
      },
    });
    mocks.overview.mockResolvedValue({ status: null });
    renderPage();
    expect((await screen.findByTestId("account-trial-ended")).textContent).toBe(
      SIGNUP_TRIAL_DENIED_TEXT,
    );
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
  function renderHidden() {
    return render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <HideForLaunchOfferAccount>{cta()}</HideForLaunchOfferAccount>
      </QueryClientProvider>,
    );
  }

  it("reste montrée à un visiteur, avec ou sans essai ouvert", () => {
    const { unmount } = renderHidden();
    expect(screen.getByRole("link", { name: "Découvrir l’offre Analyse" })).toBeTruthy();
    unmount();

    mocks.launch = { active: true, pending: false };
    renderHidden();
    expect(screen.getByRole("link", { name: "Découvrir l’offre Analyse" })).toBeTruthy();
    expect(mocks.plan).not.toHaveBeenCalled();
  });

  it("est masquée à un compte en essai, qui a déjà l'offre Analyse", async () => {
    mocks.launch = { active: true, pending: false };
    mocks.user = { id: "u1" };
    mocks.plan.mockResolvedValue({ plan: { plan: "analyse", launchOffer: true } });
    renderHidden();
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Découvrir l’offre Analyse" })).toBeNull(),
    );
  });

  it("revient pour un compte dont l'essai est fini, et quand l'essai est coupé", async () => {
    mocks.launch = { active: true, pending: false };
    mocks.user = { id: "u1" };
    mocks.plan.mockResolvedValue({ plan: { plan: "decouverte", trialEndedAt: "2026-10-01" } });
    const { unmount } = renderHidden();
    await waitFor(() => expect(mocks.plan).toHaveBeenCalled());
    expect(screen.getByRole("link", { name: "Découvrir l’offre Analyse" })).toBeTruthy();
    unmount();

    mocks.launch = { active: false, pending: false };
    renderHidden();
    expect(screen.getByRole("link", { name: "Découvrir l’offre Analyse" })).toBeTruthy();
  });
});
