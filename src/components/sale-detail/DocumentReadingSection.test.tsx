// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentReadingSection } from "./DocumentReadingSection";
import { SaleUnlockOfferProvider } from "./UnlockCallToAction";

const mocks = vi.hoisted(() => ({ fetchDocumentReading: vi.fn() }));
vi.mock("@/lib/client-api", () => ({ fetchDocumentReading: mocks.fetchDocumentReading }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DocumentReadingSection saleId="sale-1" enabled />
    </QueryClientProvider>,
  );
}

describe("DocumentReadingSection", () => {
  it("shows each point with its quote and a link to the cited page", async () => {
    mocks.fetchDocumentReading.mockResolvedValue({
      access: "full",
      status: "completed",
      generatedAt: "2026-10-12T08:00:00Z",
      partial: false,
      points: [
        {
          theme: "occupation",
          importance: "alerte",
          title: "Bien occupé sans bail",
          explanation: "Une procédure d'expulsion sera nécessaire.",
          quote: "occupé par Monsieur X et sa famille",
          page: 2,
          document: {
            label: "PV de description",
            url: "https://example.test/pv.pdf",
            documentType: "pv_huissier",
          },
        },
      ],
    });
    renderSection();
    const section = await screen.findByRole("region", { name: "Lecture des pièces du dossier" });
    expect(section.textContent).toContain("1 point relevé dans les pièces");
    expect(section.textContent).toContain("À vérifier en priorité");
    expect(section.textContent).toContain("noms de personnes remplacés par leur rôle");
    expect(section.textContent).toContain("« occupé par Monsieur X et sa famille »");
    expect(
      screen.getByRole("link", { name: "PV de description, page 2" }).getAttribute("href"),
    ).toBe("https://example.test/pv.pdf#page=2");
  });

  it("gives a free account the count and themes only", async () => {
    mocks.fetchDocumentReading.mockResolvedValue({
      access: "teaser",
      pointCount: 5,
      alertCount: 2,
      themes: ["occupation", "diagnostics"],
    });
    renderSection();
    const section = await screen.findByRole("region", { name: "Lecture des pièces du dossier" });
    expect(section.textContent).toContain(
      "5 points relevés dans les pièces, dont 2 à vérifier en priorité : occupation, diagnostics.",
    );
    expect(section.textContent).toContain("avec l’offre Analyse ou en débloquant cette vente");
    expect(screen.getByRole("link", { name: "Découvrir l’offre Analyse" })).toBeTruthy();
  });

  it("makes « Débloquer cette vente » the main link of the teaser when the page has the unlock card", async () => {
    mocks.fetchDocumentReading.mockResolvedValue({
      access: "teaser",
      pointCount: 2,
      alertCount: 0,
      themes: ["occupation"],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SaleUnlockOfferProvider
          status={{
            saleId: "sale-1",
            unlocked: false,
            unlockable: true,
            analysisAccess: false,
            limit: 3,
            used: 3,
            remaining: 0,
            periodStart: "2026-09-30T22:00:00.000Z",
            resetsAt: "2026-10-31T23:00:00.000Z",
          }}
        >
          <DocumentReadingSection saleId="sale-1" enabled />
        </SaleUnlockOfferProvider>
      </QueryClientProvider>,
    );
    const section = await screen.findByRole("region", { name: "Lecture des pièces du dossier" });
    expect(section.textContent).toContain("Vos 3 déblocages d’octobre reviennent le 1er novembre.");
    expect(screen.getByRole("link", { name: "Voir l’offre Analyse" }).getAttribute("href")).toBe(
      "/offres",
    );
    expect(screen.queryByRole("link", { name: /Débloquer cette vente/ })).toBeNull();
  });

  it("reads the full reading again once the sale is unlocked, never serving the cached teaser", async () => {
    mocks.fetchDocumentReading.mockResolvedValueOnce({
      access: "teaser",
      pointCount: 1,
      alertCount: 0,
      themes: ["occupation"],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = (access: "discovery" | "unlocked") => (
      <QueryClientProvider client={client}>
        <DocumentReadingSection saleId="sale-1" enabled access={access} />
      </QueryClientProvider>
    );
    const { rerender } = render(view("discovery"));
    expect((await screen.findByRole("region")).textContent).toContain("1 point relevé");
    expect(mocks.fetchDocumentReading).toHaveBeenCalledTimes(1);

    mocks.fetchDocumentReading.mockResolvedValueOnce({
      access: "full",
      status: "completed",
      generatedAt: "2026-10-12T08:00:00Z",
      partial: false,
      points: [
        {
          theme: "occupation",
          importance: "info",
          title: "Bien occupé",
          explanation: null,
          quote: "occupé par un occupant",
          page: 3,
          document: null,
        },
      ],
    });
    rerender(view("unlocked"));

    expect(await screen.findByText("« occupé par un occupant »")).toBeTruthy();
    expect(mocks.fetchDocumentReading).toHaveBeenCalledTimes(2);
  });

  it("announces a reading in preparation and hides a dossier without text", async () => {
    mocks.fetchDocumentReading.mockResolvedValue({
      access: "full",
      status: "pending",
      points: [],
      generatedAt: null,
      partial: false,
    });
    renderSection();
    expect((await screen.findByRole("region")).textContent).toContain("en préparation");
    cleanup();
    mocks.fetchDocumentReading.mockResolvedValue({
      access: "full",
      status: "no_text",
      points: [],
      generatedAt: null,
      partial: false,
    });
    const { container } = renderSection();
    await vi.waitFor(() => expect(mocks.fetchDocumentReading).toHaveBeenCalledTimes(2));
    expect(container.textContent).toBe("");
  });
});
