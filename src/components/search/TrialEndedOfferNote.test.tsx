// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: null as { id: string } | null,
  plan: undefined as Record<string, unknown> | undefined,
  offer: { status: "loading" } as Record<string, unknown>,
  readOffer: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.user, loading: false }) }));
vi.mock("@/hooks/use-access-plan", () => ({ useAccessPlan: () => mocks.plan }));
vi.mock("@/hooks/use-sale-unlock-purchase-offer", () => ({
  useSaleUnlockPurchaseOffer: () => {
    mocks.readOffer();
    return mocks.offer;
  },
}));

import { TRIAL_ENDED_NOTE_DAYS, TrialEndedOfferNote } from "./TrialEndedOfferNote";

const DAY = 86_400_000;
const endedDaysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const openOffer = (purchase: { label: string; amountCents: number } | null) => ({
  status: "ready",
  analysisOpen: true,
  analysisLabel: "59 € TTC / mois",
  analysisCents: 5900,
  purchase,
  firstMonthDeductionCents: 0,
});
const text = (element: HTMLElement) => (element.textContent ?? "").replace(/[\u00a0\u202f]/g, " ");

afterEach(() => {
  cleanup();
  mocks.user = null;
  mocks.plan = undefined;
  mocks.offer = { status: "loading" };
  mocks.readOffer.mockReset();
});

describe("offre ouverte, dite à un compte dont l'essai est terminé", () => {
  it("dit la fin de l'essai, les deux prix lus dans l'offre et le chemin vers les offres", async () => {
    mocks.user = { id: "u1" };
    mocks.plan = { hasAnalysisAccess: false, trialEndedAt: "2026-11-15T22:59:00.000Z" };
    vi.useFakeTimers({ now: new Date("2026-11-25T10:00:00.000Z"), toFake: ["Date"] });
    try {
      mocks.offer = openOffer({ label: "19 €", amountCents: 1900 });
      render(<TrialEndedOfferNote />);
      const note = await screen.findByTestId("trial-ended-offer-open");
      expect(text(note)).toBe(
        "Votre essai gratuit de l’offre Analyse s’est terminé le 15 novembre 2026. L’offre est ouverte à la souscription : 59 € TTC / mois, sans engagement. Une fois le déblocage de votre compte gratuit utilisé, chaque vente s’ouvre aussi à l’unité pour 19 €. Voir les offres",
      );
      expect(screen.getByRole("link", { name: "Voir les offres" }).getAttribute("href")).toBe(
        "/offres#tarifs",
      );
      // Ni compte à rebours, ni remise, ni appel pressant.
      expect(text(note)).not.toMatch(/dernier|vite|profitez|plus que|remise|expire/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ne cite pas l'achat à l'unité tant qu'il n'est pas ouvert", async () => {
    mocks.user = { id: "u1" };
    mocks.plan = { hasAnalysisAccess: false, trialEndedAt: endedDaysAgo(3) };
    mocks.offer = openOffer(null);
    render(<TrialEndedOfferNote />);
    const note = await screen.findByTestId("trial-ended-offer-open");
    expect(text(note)).toContain("59 € TTC / mois, sans engagement. Voir les offres");
    expect(text(note)).not.toMatch(/à l’unité/);
  });

  it("ne dit rien tant que l'abonnement ne se souscrit pas, ou que l'offre n'est pas lue", async () => {
    mocks.user = { id: "u1" };
    mocks.plan = { hasAnalysisAccess: false, trialEndedAt: endedDaysAgo(3) };
    for (const offer of [
      { status: "loading" },
      { ...openOffer({ label: "19 €", amountCents: 1900 }), analysisOpen: false },
    ]) {
      mocks.offer = offer;
      const view = render(<TrialEndedOfferNote />);
      await waitFor(() => expect(mocks.readOffer).toHaveBeenCalled());
      expect(screen.queryByTestId("trial-ended-offer-open")).toBeNull();
      view.unmount();
      mocks.readOffer.mockReset();
    }
  });

  it("ne lit même pas l'offre pour les autres comptes", async () => {
    mocks.offer = openOffer({ label: "19 €", amountCents: 1900 });
    const others: Array<[{ id: string } | null, Record<string, unknown> | undefined]> = [
      // Visiteur, droits non lus, compte sans essai, abonné, essai en cours.
      [null, undefined],
      [{ id: "u1" }, undefined],
      [{ id: "u1" }, { hasAnalysisAccess: false }],
      [{ id: "u1" }, { hasAnalysisAccess: true, trialEndedAt: endedDaysAgo(3) }],
      [{ id: "u1" }, { hasAnalysisAccess: true, launchOffer: true, trialEndsAt: endedDaysAgo(-3) }],
      // Fin trop ancienne : le catalogue n'en parle plus.
      [
        { id: "u1" },
        { hasAnalysisAccess: false, trialEndedAt: endedDaysAgo(TRIAL_ENDED_NOTE_DAYS + 1) },
      ],
      [{ id: "u1" }, { hasAnalysisAccess: false, trialEndedAt: "date illisible" }],
    ];
    for (const [user, plan] of others) {
      mocks.user = user;
      mocks.plan = plan;
      const view = render(<TrialEndedOfferNote />);
      // Laisse à un import dynamique le temps d'arriver s'il était demandé à tort.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.queryByTestId("trial-ended-offer-open")).toBeNull();
      view.unmount();
    }
    expect(mocks.readOffer).not.toHaveBeenCalled();
  });
});
