// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentReadingHighlights } from "./DocumentReadingSection";

const mocks = vi.hoisted(() => ({ fetchDocumentReading: vi.fn() }));
vi.mock("@/lib/client-api", () => ({ fetchDocumentReading: mocks.fetchDocumentReading }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderHighlights(enabled = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DocumentReadingHighlights saleId="sale-1" enabled={enabled} />
    </QueryClientProvider>,
  );
}

const point = (title: string, importance: "alerte" | "attention" | "info", page = 1) => ({
  theme: "occupation",
  importance,
  title,
  explanation: null,
  quote: "citation exacte",
  page,
  document: { label: "Cahier des conditions", url: null, documentType: "cahier" },
});

describe("DocumentReadingHighlights", () => {
  it("montre les trois points les plus importants et renvoie aux citations", async () => {
    mocks.fetchDocumentReading.mockResolvedValue({
      access: "full",
      status: "completed",
      generatedAt: null,
      partial: false,
      points: [
        point("Bon à savoir", "info"),
        point("Servitude de passage", "attention", 4),
        point("Bien occupé sans bail", "alerte", 2),
        point("Travaux de toiture", "attention", 7),
      ],
    });
    renderHighlights();
    const aside = await screen.findByRole("complementary", { name: "Ce que disent les pièces" });
    const items = [...aside.querySelectorAll("li")].map((item) => item.textContent);
    expect(items).toHaveLength(3);
    expect(items[0]).toContain("Bien occupé sans bail");
    expect(items[0]).toContain("Cahier des conditions, page 2");
    expect(aside.textContent).not.toContain("Bon à savoir");
    expect(
      screen.getByRole("link", { name: "Voir les 4 points et leurs citations" }),
    ).toHaveProperty("hash", "#pieces");
  });

  it("compte gratuit : seulement le nombre de points, comme dans la section", async () => {
    mocks.fetchDocumentReading.mockResolvedValue({
      access: "teaser",
      pointCount: 5,
      alertCount: 2,
      themes: ["occupation"],
    });
    renderHighlights();
    const aside = await screen.findByRole("complementary", { name: "Ce que disent les pièces" });
    expect(aside.textContent).toContain(
      "5 points relevés dans les pièces, dont 2 à vérifier en priorité.",
    );
    expect(aside.querySelectorAll("li")).toHaveLength(0);
  });

  it("n'affiche rien sans point, sans lecture terminée, ou sans compte", async () => {
    mocks.fetchDocumentReading.mockResolvedValue({
      access: "full",
      status: "completed",
      generatedAt: null,
      partial: false,
      points: [],
    });
    const { container } = renderHighlights();
    await vi.waitFor(() => expect(mocks.fetchDocumentReading).toHaveBeenCalled());
    // La réponse est rendue (aucun encart pour une lecture sans point).
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.textContent).toBe("");
    cleanup();
    vi.clearAllMocks();
    renderHighlights(false);
    expect(mocks.fetchDocumentReading).not.toHaveBeenCalled();
  });
});
