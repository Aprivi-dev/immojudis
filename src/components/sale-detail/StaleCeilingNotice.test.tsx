// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaleChangeEventSummary } from "@/lib/sale-change-monitor";
import { StaleCeilingNotice } from "./StaleCeilingNotice";

const mocks = vi.hoisted(() => ({ fetchChanges: vi.fn() }));
vi.mock("@/lib/client-api", () => ({ fetchSaleChangeEvents: mocks.fetchChanges }));

const SALE_ID = "11111111-1111-4111-8111-111111111111";
const SAVED_AT = "2026-10-10T08:00:00Z";

function change(overrides: Partial<SaleChangeEventSummary> = {}): SaleChangeEventSummary {
  return {
    id: "event-1",
    saleId: SALE_ID,
    watchKind: "favorite",
    watchId: "watch-1",
    eventKind: "price_changed",
    severity: "important",
    fingerprint: "price",
    summaryLabel: "Mise à prix abaissée",
    changeSummary: { previousValue: 120_000, currentValue: 100_000 },
    detectedAt: "2026-10-14T06:45:00Z",
    readAt: null,
    dismissedAt: null,
    ...overrides,
  };
}

function renderNotice(props: Partial<Parameters<typeof StaleCeilingNotice>[0]> = {}) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <StaleCeilingNotice
        saleId={SALE_ID}
        userId="user-1"
        savedAt={SAVED_AT}
        ceiling={185_000}
        canRecalculate
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("StaleCeilingNotice (plafond à vérifier)", () => {
  it("dit ce qui a changé depuis l'enregistrement et renvoie au calcul", async () => {
    mocks.fetchChanges.mockResolvedValue({
      events: [
        change(),
        change({
          id: "event-2",
          eventKind: "audience_changed",
          fingerprint: "date",
          changeSummary: {
            previousValue: "2026-11-02T10:00:00Z",
            currentValue: "2026-11-20T10:00:00Z",
          },
          detectedAt: "2026-10-15T06:45:00Z",
        }),
      ],
    });
    renderNotice();

    const notice = await screen.findByTestId("stale-ceiling");
    expect(notice.textContent).toMatch(/185\s000\s€/);
    expect(notice.textContent).toContain("le 10 octobre 2026");
    expect(notice.textContent).toContain("la mise à prix et la date de la vente");
    expect(notice.textContent).toContain("le 15 octobre 2026");
    expect(screen.getByRole("link", { name: "Recalculer mon plafond" }).getAttribute("href")).toBe(
      "#calculation",
    );
    // Une seule vente, y compris les changements écartés par la personne.
    expect(mocks.fetchChanges).toHaveBeenCalledWith({
      saleId: SALE_ID,
      includeDismissed: true,
      limit: 50,
    });
  });

  it("n'affiche rien quand rien n'a changé depuis, ou pour un changement antérieur", async () => {
    mocks.fetchChanges.mockResolvedValue({
      events: [change({ detectedAt: "2026-10-09T06:45:00Z" })],
    });
    renderNotice();
    await waitFor(() => expect(mocks.fetchChanges).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByTestId("stale-ceiling")).toBeNull();
  });

  it("n'affiche rien et ne demande rien sans date d'enregistrement", async () => {
    mocks.fetchChanges.mockResolvedValue({ events: [change()] });
    renderNotice({ savedAt: null });
    await Promise.resolve();
    expect(mocks.fetchChanges).not.toHaveBeenCalled();
    expect(screen.queryByTestId("stale-ceiling")).toBeNull();
  });

  it("n'affiche rien, sans erreur, quand le suivi des changements est refusé (offre Découverte)", async () => {
    mocks.fetchChanges.mockRejectedValue(Object.assign(new Error("Réservé"), { status: 403 }));
    renderNotice();
    await waitFor(() => expect(mocks.fetchChanges).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByTestId("stale-ceiling")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sans calcul disponible, ne propose pas de lien vers un calcul absent", async () => {
    mocks.fetchChanges.mockResolvedValue({ events: [change()] });
    renderNotice({ canRecalculate: false });
    await screen.findByTestId("stale-ceiling");
    expect(screen.queryByRole("link", { name: "Recalculer mon plafond" })).toBeNull();
  });

  it("« J'ai vérifié » ferme le message jusqu'au changement suivant, dans ce navigateur", async () => {
    mocks.fetchChanges.mockResolvedValue({ events: [change()] });
    const first = renderNotice();
    fireEvent.click(await screen.findByRole("button", { name: "J’ai vérifié, je le garde" }));
    expect(screen.queryByTestId("stale-ceiling")).toBeNull();
    first.unmount();

    // Même changement, autre visite : le message reste fermé.
    renderNotice();
    await waitFor(() => expect(mocks.fetchChanges).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(screen.queryByTestId("stale-ceiling")).toBeNull();
    cleanup();

    // Un nouveau changement le rouvre.
    mocks.fetchChanges.mockResolvedValue({
      events: [
        change(),
        change({ id: "event-3", fingerprint: "price-2", detectedAt: "2026-10-20T06:00:00Z" }),
      ],
    });
    renderNotice();
    expect(await screen.findByTestId("stale-ceiling")).toBeTruthy();
  });
});
