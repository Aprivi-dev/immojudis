// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminInformationAgentReviewPanel } from "./AdminInformationAgentReviewPanel";

const mocks = vi.hoisted(() => ({
  fetchReview: vi.fn(),
  reviewFact: vi.fn(),
}));

vi.mock("@/lib/client-api", () => ({
  fetchAdminInformationAgentReview: mocks.fetchReview,
  reviewAdminInformationAgentFactClient: mocks.reviewFact,
}));

vi.mock("@/lib/router-compat", () => ({
  Link: ({
    to,
    params,
    children,
    ...props
  }: {
    to: string;
    params: Record<string, string>;
    children: React.ReactNode;
  }) => (
    <a href={to.replace("$id", params.id)} {...props}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("AdminInformationAgentReviewPanel", () => {
  it("identifies the sale and contact before an admin reviews a fact", async () => {
    mocks.fetchReview.mockResolvedValue({
      facts: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          case_id: "33333333-3333-4333-8333-333333333333",
          sale_id: "11111111-1111-4111-8111-111111111111",
          fact_key: "surface_m2",
          display_value: "70 m²",
          confidence: 0.95,
          evidence_asset_id: null,
          evidence_excerpt: "La surface habitable est de 70 m².",
        },
      ],
      cases: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          recipient_name: "Maître Dupont",
          recipient_email: "cabinet@example.test",
          subject: "Informations complémentaires — vente de Bordeaux",
        },
      ],
      assets: [],
      extractions: [],
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AdminInformationAgentReviewPanel />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/Maître Dupont/)).toBeTruthy();
    expect(screen.getByText(/cabinet@example\.test/)).toBeTruthy();
    expect(screen.getByText(/Dossier 33333333/)).toBeTruthy();
    expect(screen.getByText(/Informations complémentaires/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Voir l’annonce 11111111/ }).getAttribute("href"),
    ).toBe("/sales/11111111-1111-4111-8111-111111111111");
  });
});
