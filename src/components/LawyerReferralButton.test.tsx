// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  fetchAccessPlan: vi.fn(),
  fetchLawyerReferrals: vi.fn(),
  requestLawyerReferral: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "user-1" }, loading: false }),
}));
vi.mock("@/lib/client-api", () => ({
  fetchAccessPlan: mocks.fetchAccessPlan,
  fetchLawyerReferrals: mocks.fetchLawyerReferrals,
  requestLawyerReferral: mocks.requestLawyerReferral,
}));

import { LawyerReferralButton } from "./LawyerReferralButton";

afterEach(cleanup);

describe("LawyerReferralButton", () => {
  it("informe, dans le récapitulatif, que l'avocat proposé peut être un partenaire rémunéré", async () => {
    mocks.fetchAccessPlan.mockResolvedValue({ plan: { features: { lawyerReferrals: "enabled" } } });
    mocks.fetchLawyerReferrals.mockResolvedValue({ requests: [] });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LawyerReferralButton saleId="sale-1" />
      </QueryClientProvider>,
    );

    const button = await screen.findByRole("button", { name: "Mise en relation Immojudis" });
    fireEvent.click(button);

    const recap = screen.getByRole("group", { name: "Récapitulatif avant mise en relation" });
    const text = recap.textContent ?? "";
    expect(text).toContain(
      "L'avocat proposé peut être un partenaire qui rémunère Immojudis pour sa visibilité.",
    );
    expect(text).toContain("Vous restez libre de choisir un autre avocat.");
    expect(text).toContain("Ses honoraires sont fixés avec lui.");
    expect(text).not.toMatch(/ne perçoit aucune part/i);
    expect(mocks.requestLawyerReferral).not.toHaveBeenCalled();
  });
});
