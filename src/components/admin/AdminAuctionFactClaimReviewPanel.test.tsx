// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminAuctionFactClaimReviewPanel } from "./AdminAuctionFactClaimReviewPanel";

const mocks = vi.hoisted(() => ({
  fetchReview: vi.fn(),
  review: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/client-api", () => ({
  fetchAdminAuctionFactClaimReview: mocks.fetchReview,
  reviewAdminAuctionFactClaimClient: mocks.review,
}));

vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));

const saleId = "11111111-1111-4111-8111-111111111111";
const claimId = "22222222-2222-4222-8222-222222222222";

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AdminAuctionFactClaimReviewPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchReview.mockResolvedValue({
    ok: true,
    items: [
      {
        claimId,
        saleId,
        lotId: null,
        fieldKey: "sale.starting_price_eur",
        value: 92000,
        currentCanonicalValue: 92000,
        status: "candidate",
        conflictGroup: null,
        evidence: {
          kind: "source_listing",
          sourceId: null,
          rawArtifactId: null,
          sourceRecordId: null,
          extractionId: null,
          sourceUrl: "https://source.example/sale",
          locator: { quote: "Mise à prix : 92 000 €" },
          confidence: 0.91,
          capturedAt: "2026-09-28T10:00:00Z",
        },
        sale: {
          title: "Appartement T3",
          city: "Bordeaux",
          saleDate: "2026-10-10T10:00:00Z",
          startingPriceEur: 92000,
        },
        createdAt: "2026-09-28T10:01:00Z",
        updatedAt: "2026-09-28T10:01:00Z",
        resolutionNote: null,
      },
    ],
    hasMore: false,
    nextCursor: null,
  });
  mocks.review.mockResolvedValue({ ok: true, result: { claim_id: claimId } });
});

afterEach(cleanup);

describe("AdminAuctionFactClaimReviewPanel", () => {
  it("shows the extracted value, canonical value and source evidence", async () => {
    renderPanel();

    expect(await screen.findByRole("heading", { name: "Faits à vérifier" })).toBeTruthy();
    expect(await screen.findByText("Appartement T3")).toBeTruthy();
    expect(screen.getByText("Valeur extraite")).toBeTruthy();
    expect(screen.getByText("Valeur canonique actuelle")).toBeTruthy();
    expect(screen.getByText(/Mise à prix : 92 000/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Ouvrir la source/ }).getAttribute("href")).toBe(
      "https://source.example/sale",
    );
  });

  it("sends an accepted decision without a justification", async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Accepter" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmer" }));

    await waitFor(() => expect(mocks.review).toHaveBeenCalled());
    expect(mocks.review.mock.calls[0][0]).toEqual({
      claimId,
      decision: "accepted",
      resolutionNote: null,
    });
    expect(mocks.success).toHaveBeenCalled();
  });

  it("requires a reason before rejecting or marking a conflict", async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Rejeter" }));
    const confirm = screen.getByRole("button", { name: "Confirmer" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Justification obligatoire"), {
      target: { value: "La source est contradictoire." },
    });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(mocks.review).toHaveBeenCalled());
    expect(mocks.review.mock.calls[0][0]).toEqual({
      claimId,
      decision: "rejected",
      resolutionNote: "La source est contradictoire.",
    });
  });

  it("surfaces a decision error to the administrator", async () => {
    mocks.review.mockRejectedValue(new Error("La valeur canonique a changé."));
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Marquer conflit" }));
    fireEvent.change(screen.getByLabelText("Justification obligatoire"), {
      target: { value: "Écart à contrôler." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirmer" }));

    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("La valeur canonique a changé."));
  });

  it("shows the reason and next step for an existing conflict without decision actions", async () => {
    mocks.fetchReview.mockResolvedValueOnce({
      ok: true,
      items: [
        {
          claimId,
          saleId,
          lotId: null,
          fieldKey: "sale.starting_price_eur",
          value: 95000,
          currentCanonicalValue: 92000,
          status: "conflicted",
          conflictGroup: "starting-price-conflict",
          evidence: {
            kind: "source_listing",
            sourceId: null,
            rawArtifactId: null,
            sourceRecordId: null,
            extractionId: null,
            sourceUrl: "https://source.example/sale",
            locator: { quote: "Mise à prix : 95 000 €" },
            confidence: 0.91,
            capturedAt: "2026-09-28T10:00:00Z",
          },
          sale: {
            title: "Appartement T3",
            city: "Bordeaux",
            saleDate: "2026-10-10T10:00:00Z",
            startingPriceEur: 92000,
          },
          createdAt: "2026-09-28T10:01:00Z",
          updatedAt: "2026-09-28T10:02:00Z",
          resolutionNote: "Valeur source contredite.",
        },
      ],
      hasMore: false,
      nextCursor: null,
    });

    renderPanel();

    expect(await screen.findByText("Conflit déjà enregistré")).toBeTruthy();
    expect(screen.getByText("Motif : Valeur source contredite.")).toBeTruthy();
    expect(
      screen.getByText(/lancer une nouvelle collecte ou attendre une nouvelle observation/i),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accepter" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rejeter" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Marquer conflit" })).toBeNull();
    expect(mocks.review).not.toHaveBeenCalled();
  });
});
