// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTribunalJudicialActivityDirectory,
  type TribunalJudicialActivityDirectorySale,
} from "@/lib/tribunal-judicial-activity-directory";
import { TribunalsPage } from "@/routes/tribunaux";

const mocks = vi.hoisted(() => ({
  fetchDirectory: vi.fn(),
}));

vi.mock("@/lib/tribunal-judicial-activity-directory-client", () => ({
  fetchTribunalJudicialActivityDirectory: mocks.fetchDirectory,
}));

vi.mock("@/lib/router-compat", () => ({
  createFileRoute: () => (options: unknown) => options,
}));

const AS_OF = new Date("2026-08-20T12:00:00.000Z");
const DIRECTORY = buildTribunalJudicialActivityDirectory({
  courts: [
    { code: "marseille", name: "TJ Marseille", judicialRegion: "Aix-en-Provence" },
    { code: "paris", name: "TJ Paris", judicialRegion: "Paris" },
  ],
  sales: [...courtSales("marseille", 6, 20_000), ...courtSales("paris", 5, 80_000)],
  asOf: AS_OF,
  historyMonths: 36,
});

describe("TribunalsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchDirectory.mockResolvedValue(DIRECTORY);
  });

  afterEach(cleanup);

  it("affiche publiquement les fourchettes de mise et de délai du tribunal", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "TJ Marseille" })).toBeTruthy();
    expect(screen.getByText(/Fourchette centrale 21 250 € – 23 750 €/i)).toBeTruthy();
    expect(screen.getByText(/Fourchette centrale 23 – 28 jours/i)).toBeTruthy();
    expect(screen.getByText(/Écart prix final \/ mise à prix non publié/i)).toBeTruthy();
    expect(mocks.fetchDirectory).toHaveBeenCalledWith(36);
  });

  it("permet de rechercher un autre tribunal sans authentification", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "TJ Marseille" });

    fireEvent.change(screen.getByPlaceholderText("Marseille, Paris, Lyon…"), {
      target: { value: "Paris" },
    });

    expect(await screen.findByRole("heading", { name: "TJ Paris" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "TJ Marseille" })).toBeNull();
  });

  it("remplace une erreur interne par un message public stable", async () => {
    mocks.fetchDirectory.mockRejectedValue(
      new Error("relation billing_secrets does not exist for tenant 8842"),
    );

    renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Statistiques temporairement indisponibles");
    expect(alert.textContent).not.toContain("billing_secrets");
  });

  it("recalcule la période lorsque le visiteur choisit 12 mois", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "TJ Marseille" });

    fireEvent.click(screen.getByRole("button", { name: "12 mois" }));

    await waitFor(() => expect(mocks.fetchDirectory).toHaveBeenCalledWith(12));
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

function courtSales(
  tribunalCode: string,
  count: number,
  basePrice: number,
): TribunalJudicialActivityDirectorySale[] {
  return Array.from({ length: count }, (_, index) => {
    const saleDate = new Date(AS_OF.getTime() + (20 + index * 5) * 24 * 60 * 60 * 1_000);
    return {
      tribunalCode,
      id: `${tribunalCode}-${index}`,
      saleDate: saleDate.toISOString(),
      status: "upcoming",
      startingPriceEur: basePrice + index * 1_000,
      propertyType: "apartment",
      visitDates: ["visite annoncée"],
      firstSeenAt: new Date(
        saleDate.getTime() - (20 + index * 2) * 24 * 60 * 60 * 1_000,
      ).toISOString(),
    };
  });
}
