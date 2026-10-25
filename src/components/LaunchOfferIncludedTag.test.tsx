// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  launch: { active: true, pending: false },
  user: null as { id: string } | null,
  plan: vi.fn(),
}));
vi.mock("@/hooks/use-launch-offer", () => ({ useLaunchOffer: () => mocks.launch }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.user, loading: false }) }));
vi.mock("@/lib/client-billing", () => ({ fetchAccessPlan: mocks.plan }));

import { LaunchOfferIncludedTag } from "./LaunchOfferIncludedTag";

function renderTag() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <LaunchOfferIncludedTag />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.launch = { active: true, pending: false };
  mocks.user = { id: "u1" };
  mocks.plan.mockReset();
});
afterEach(cleanup);

describe("étiquette « Inclus pendant votre essai gratuit »", () => {
  it("s'affiche pour un compte dont l'accès Analyse vient de l'offre", async () => {
    mocks.plan.mockResolvedValue({ plan: { hasAnalysisAccess: true, launchOffer: true } });
    renderTag();
    expect((await screen.findByTestId("launch-offer-included")).textContent).toBe(
      "Inclus pendant votre essai gratuit",
    );
  });

  it("n'apparaît pas pour un abonné réel", async () => {
    mocks.plan.mockResolvedValue({ plan: { hasAnalysisAccess: true } });
    renderTag();
    await waitFor(() => expect(mocks.plan).toHaveBeenCalled());
    expect(screen.queryByTestId("launch-offer-included")).toBeNull();
  });

  it("n'apparaît pas hors de l'offre, sans lire le plan", () => {
    mocks.launch = { active: false, pending: false };
    renderTag();
    expect(screen.queryByTestId("launch-offer-included")).toBeNull();
    expect(mocks.plan).not.toHaveBeenCalled();
  });

  it("n'apparaît pas pour un visiteur", () => {
    mocks.user = null;
    renderTag();
    expect(screen.queryByTestId("launch-offer-included")).toBeNull();
    expect(mocks.plan).not.toHaveBeenCalled();
  });
});
