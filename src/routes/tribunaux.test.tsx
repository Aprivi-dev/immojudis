// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TribunalsPage } from "@/routes/tribunaux";

const mocks = vi.hoisted(() => ({
  fetchEntitlements: vi.fn(),
  fetchStatistics: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "user-1" }, loading: false }),
}));

vi.mock("@/lib/client-api", () => ({
  fetchFeatureEntitlements: mocks.fetchEntitlements,
}));

vi.mock("@/lib/tribunal-statistics-client", () => ({
  fetchTribunalStatistics: mocks.fetchStatistics,
}));

vi.mock("@/lib/router-compat", () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

describe("TribunalsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(cleanup);

  it("n’appelle jamais les statistiques pour un compte Découverte et montre un aperçu fictif", async () => {
    mocks.fetchEntitlements.mockResolvedValue(entitlements("locked"));

    const { container } = renderPage();

    await screen.findByText(/aperçu flouté ci-dessous est une démonstration entièrement fictive/i);
    expect(screen.getByText(/démonstration fictive — aucune donnée réelle/i)).toBeTruthy();
    expect(container.querySelector('[data-preview-kind="strictly-fictional"]')).toBeTruthy();
    expect(mocks.fetchEntitlements).toHaveBeenCalledOnce();
    expect(mocks.fetchStatistics).not.toHaveBeenCalled();
  });

  it("remplace une erreur d’accès interne par un message public stable", async () => {
    mocks.fetchEntitlements.mockRejectedValue(
      new Error("relation billing_secrets does not exist for tenant 8842"),
    );

    renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Impossible de vérifier votre accès Analyse");
    expect(alert.textContent).not.toContain("billing_secrets");
    expect(mocks.fetchStatistics).not.toHaveBeenCalled();
  });

  it("remplace une erreur de statistiques interne par un message public stable", async () => {
    mocks.fetchEntitlements.mockResolvedValue(entitlements("included"));
    mocks.fetchStatistics.mockRejectedValue(
      new Error("snapshot 185c0dc9-a681-40ad-a2bf-935fdf40b710 failed validation"),
    );

    renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "statistiques par tribunal sont temporairement indisponibles",
    );
    expect(alert.textContent).not.toContain("185c0dc9");
    await waitFor(() => expect(mocks.fetchStatistics).toHaveBeenCalledOnce());
  });
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TribunalsPage />
    </QueryClientProvider>,
  );
}

function entitlements(salesStatistics: "included" | "locked") {
  return {
    plan: { features: { salesStatistics } },
    usage: {},
  };
}
