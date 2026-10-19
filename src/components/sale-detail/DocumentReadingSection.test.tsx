// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentReadingSection } from "./DocumentReadingSection";
import { SaleUnlockOfferProvider } from "./UnlockCallToAction";

const mocks = vi.hoisted(() => ({ fetchDocumentReading: vi.fn() }));
vi.mock("@/lib/client-api", () => ({ fetchDocumentReading: mocks.fetchDocumentReading }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** La section affiche d'abord son chargement : on attend la lecture elle-même. */
async function loadedSection() {
  await screen.findByRole("region", { name: "Lecture des pièces du dossier" });
  await waitFor(() =>
    expect(screen.getByRole("region").textContent).not.toContain("Lecture des pièces en cours"),
  );
  return screen.getByRole("region");
}

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
    const section = await loadedSection();
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
    const section = await loadedSection();
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
    const section = await loadedSection();
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
    expect((await loadedSection()).textContent).toContain("1 point relevé");
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

  it("announces a reading in preparation", async () => {
    mocks.fetchDocumentReading.mockResolvedValue({
      access: "full",
      status: "pending",
      points: [],
      generatedAt: null,
      partial: false,
    });
    renderSection();
    expect((await loadedSection()).textContent).toContain("en préparation");
  });

  it("reserves the place and says that the reading is under way while it loads", async () => {
    mocks.fetchDocumentReading.mockReturnValue(new Promise(() => {}));
    renderSection();
    const section = screen.getByRole("region", { name: "Lecture des pièces du dossier" });
    expect(section.getAttribute("aria-busy")).toBe("true");
    expect(section.className).toContain("placeholder");
    expect(screen.getByRole("status").textContent).toBe("Lecture des pièces en cours…");
  });

  it("says when the reading could not be loaded and offers to try again", async () => {
    mocks.fetchDocumentReading.mockRejectedValueOnce(new Error("réseau"));
    renderSection();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "La lecture des pièces n’a pas pu être chargée.",
    );
    expect(screen.getByRole("region").className).toContain("placeholder");

    mocks.fetchDocumentReading.mockResolvedValueOnce({
      access: "full",
      status: "completed",
      generatedAt: "2026-10-12T08:00:00Z",
      partial: false,
      points: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    await waitFor(() =>
      expect(screen.getByRole("region").textContent).toContain("Aucun point particulier relevé"),
    );
    expect(mocks.fetchDocumentReading).toHaveBeenCalledTimes(2);
  });

  it("tells that scanned documents could not be read and points to the documents", async () => {
    mocks.fetchDocumentReading.mockResolvedValue({
      access: "full",
      status: "no_text",
      points: [],
      generatedAt: null,
      partial: false,
    });
    renderSection();
    const section = await loadedSection();
    expect(section.textContent).toContain(
      "Les pièces de ce dossier n’ont pas pu être lues automatiquement (documents numérisés). Lisez-les directement :",
    );
    expect(
      screen.getByRole("link", { name: "Voir les pièces disponibles" }).getAttribute("href"),
    ).toBe("#documents");
  });

  it("shows nothing more than before to a free account without points, and nothing without a session", async () => {
    mocks.fetchDocumentReading.mockResolvedValue({
      access: "teaser",
      pointCount: 0,
      alertCount: 0,
      themes: [],
    });
    const { container } = renderSection();
    await waitFor(() => expect(container.textContent).toBe(""));
    cleanup();
    mocks.fetchDocumentReading.mockClear();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const disabled = render(
      <QueryClientProvider client={client}>
        <DocumentReadingSection saleId="sale-1" enabled={false} />
      </QueryClientProvider>,
    );
    expect(disabled.container.textContent).toBe("");
    expect(mocks.fetchDocumentReading).not.toHaveBeenCalled();
  });
});
