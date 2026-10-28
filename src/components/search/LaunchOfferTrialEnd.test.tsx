// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: null as { id: string } | null,
  plan: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.user, loading: false }) }));
vi.mock("@/lib/client-billing", () => ({ fetchAccessPlan: mocks.plan }));

import { LaunchOfferTrialEnd } from "./LaunchOfferTrialEnd";

function renderNote() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <LaunchOfferTrialEnd />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  mocks.user = null;
  mocks.plan.mockReset();
});

describe("date de fin de l'essai au-dessus de la liste", () => {
  it("dit la date de fin à un compte en essai, sans compte à rebours ni incitation", async () => {
    mocks.user = { id: "u1" };
    mocks.plan.mockResolvedValue({
      plan: { plan: "analyse", launchOffer: true, trialEndsAt: "2026-11-01T13:05:00.000Z" },
    });
    renderNote();

    const note = await screen.findByTestId("launch-offer-trial-end");
    expect(note.textContent).toBe(
      "Essai gratuit de l’offre Analyse jusqu’au 1er novembre 2026 à 14:05. Détails dans Mon compte",
    );
    expect(note.textContent).not.toMatch(/reste|dernier|vite|profitez|abonn/i);
    expect(screen.getByRole("link", { name: "Détails dans Mon compte" }).getAttribute("href")).toBe(
      "/compte",
    );
  });

  it("donne la fin de la prolongation, pas celle de l'essai d'origine", async () => {
    mocks.user = { id: "u1" };
    mocks.plan.mockResolvedValue({
      plan: {
        plan: "analyse",
        launchOffer: true,
        trialExtension: true,
        trialEndsAt: "2026-12-01T13:05:00.000Z",
      },
    });
    renderNote();
    expect((await screen.findByTestId("launch-offer-trial-end")).textContent).toContain(
      "Essai gratuit prolongé jusqu’au 1er décembre 2026 à 14:05.",
    );
  });

  it("ne dit rien à un visiteur, à un abonné ni à un compte dont l'essai est fini", async () => {
    const visitor = renderNote();
    expect(visitor.container.innerHTML).toBe("");
    expect(mocks.plan).not.toHaveBeenCalled();
    cleanup();

    mocks.user = { id: "u1" };
    mocks.plan.mockResolvedValue({ plan: { plan: "analyse", currentPeriodEnd: "2026-12-01" } });
    const subscriber = renderNote();
    await waitFor(() => expect(mocks.plan).toHaveBeenCalled());
    expect(subscriber.container.innerHTML).toBe("");
    cleanup();

    mocks.plan.mockResolvedValue({
      plan: { plan: "decouverte", trialEndedAt: "2026-10-30T09:00:00.000Z" },
    });
    const ended = renderNote();
    await waitFor(() => expect(mocks.plan).toHaveBeenCalledTimes(2));
    expect(ended.container.innerHTML).toBe("");
  });
});
