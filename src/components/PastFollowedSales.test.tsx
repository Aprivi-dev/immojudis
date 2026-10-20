// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowedSaleSnapshot } from "@/lib/followed-sale-snapshots-shared";
import { PastFollowedSales, resultText } from "./PastFollowedSales";

const mocks = vi.hoisted(() => ({
  auth: { user: { id: "user-1" } as { id: string } | null, loading: false },
  fetchSnapshots: vi.fn(),
  deleteSnapshot: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/lib/client-api", () => ({
  fetchFollowedSaleSnapshots: mocks.fetchSnapshots,
  deleteFollowedSaleSnapshot: mocks.deleteSnapshot,
}));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

function snapshot(overrides: Partial<FollowedSaleSnapshot> = {}): FollowedSaleSnapshot {
  return {
    id: "snap-1",
    saleId: "sale-1",
    capturedAt: "2026-10-14T12:05:00.000Z",
    expiresAt: "2027-04-14T12:05:00.000Z",
    title: "Maison de ville",
    city: "Bordeaux",
    department: "33",
    propertyType: "house",
    tribunalName: "Tribunal judiciaire de Bordeaux",
    startingPriceEur: 100_000,
    saleDate: "2026-10-14T12:00:00.000Z",
    lawyerName: "Me Dupont",
    sourceName: "vench",
    result: { status: "unknown", priceEur: null, priceSource: null, priceWithheld: false },
    personalStatus: null,
    bidCeilingEur: null,
    surenchere: {
      kind: "window",
      hearingDay: "2026-10-14",
      deadline: "2026-10-24",
      adjudicationConfirmed: false,
      expired: false,
    },
    ...overrides,
  };
}

function renderSection() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PastFollowedSales />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.auth.user = { id: "user-1" };
  mocks.auth.loading = false;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("resultText", () => {
  it("n'affiche un prix que s'il est publié, avec sa source", () => {
    expect(
      resultText({
        status: "adjudicated",
        priceEur: 250_000,
        priceSource: "vench",
        priceWithheld: false,
      }),
    ).toMatch(/^Adjugé à 250\s000\s€ \(source : vench\)\.$/);
  });

  it("dit « non connu » plutôt que de déduire un prix", () => {
    expect(
      resultText({
        status: "adjudicated",
        priceEur: null,
        priceSource: null,
        priceWithheld: false,
      }),
    ).toBe("Adjugé. Prix d’adjudication non connu.");
    expect(
      resultText({ status: "unknown", priceEur: null, priceSource: null, priceWithheld: false }),
    ).toBe("Résultat non connu.");
  });

  it("distingue un prix réservé à l'offre Analyse d'un prix non connu", () => {
    expect(
      resultText({ status: "adjudicated", priceEur: null, priceSource: null, priceWithheld: true }),
    ).toBe("Adjugé. Le prix d’adjudication est réservé à l’offre Analyse.");
  });
});

describe("PastFollowedSales (ventes passées)", () => {
  it("n'affiche rien sans compte ou sans instantané", async () => {
    mocks.fetchSnapshots.mockResolvedValue({ snapshots: [] });
    const { container } = renderSection();
    await waitFor(() => expect(mocks.fetchSnapshots).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");

    cleanup();
    mocks.auth.user = null;
    const anonymous = renderSection();
    expect(anonymous.container.innerHTML).toBe("");
  });

  it("montre les données clés, le résultat inconnu et la fenêtre de surenchère avec le renvoi à l'avocat", async () => {
    mocks.fetchSnapshots.mockResolvedValue({ snapshots: [snapshot()] });
    renderSection();

    expect(await screen.findByRole("heading", { name: "Maison de ville" })).toBeTruthy();
    expect(screen.getByText("Bordeaux (33) · Maison")).toBeTruthy();
    expect(screen.getByText("Tribunal judiciaire de Bordeaux")).toBeTruthy();
    expect(screen.getByTestId("snapshot-result").textContent).toBe("Résultat non connu.");

    const surenchere = screen.getByTestId("snapshot-surenchere").textContent ?? "";
    expect(surenchere).toContain("Le résultat n’est pas connu");
    expect(surenchere).toContain(
      "Date indicative : le 24 octobre 2026, ou le premier jour ouvrable suivant si ce jour tombe un samedi, un dimanche ou un jour férié. Elle est calculée à partir de la date d’audience connue d’Immojudis, qui peut avoir changé.",
    );
    expect(surenchere).toContain("par acte d’avocat");
    expect(surenchere).toContain("un avocat de votre choix");
    expect(surenchere).not.toContain("l’avocat de la vente");
    expect(surenchere).not.toContain("Me Dupont");
    // Formulation prudente : ni compte à rebours, ni « dernier jour », ni « échue ».
    expect(surenchere).not.toMatch(/Il reste|dernier jour|échue/);
    expect(screen.getByRole("link", { name: "l’annuaire" }).getAttribute("href")).toBe("/avocats");
    expect(screen.getByText(/Gardé jusqu’au 14 avril 2027/)).toBeTruthy();
  });

  it("affiche le prix publié et sa source, et la date limite d'une vente adjugée", async () => {
    mocks.fetchSnapshots.mockResolvedValue({
      snapshots: [
        snapshot({
          result: {
            status: "adjudicated",
            priceEur: 250_000,
            priceSource: "vench",
            priceWithheld: false,
          },
          personalStatus: "bidding",
          bidCeilingEur: 180_000,
          surenchere: {
            kind: "window",
            hearingDay: "2026-10-14",
            deadline: "2026-10-24",
            adjudicationConfirmed: true,
            expired: false,
          },
        }),
      ],
    });
    renderSection();

    await screen.findByRole("heading", { name: "Maison de ville" });
    expect(screen.getByTestId("snapshot-result").textContent).toMatch(/Adjugé à 250\s000\s€/);
    expect(screen.getByText("Je prépare mon enchère")).toBeTruthy();
    expect(screen.getByText(/180\s000\s€/)).toBeTruthy();
    const surenchere = screen.getByTestId("snapshot-surenchere").textContent ?? "";
    expect(surenchere).toContain(
      "Date indicative : le 24 octobre 2026, ou le premier jour ouvrable",
    );
    expect(surenchere).not.toMatch(/Il reste|dernier jour|échue/);
    expect(surenchere).not.toContain("passée");
  });

  it("affiche les valeurs absentes comme absentes", async () => {
    mocks.fetchSnapshots.mockResolvedValue({
      snapshots: [
        snapshot({
          title: null,
          city: null,
          department: null,
          propertyType: null,
          tribunalName: null,
          startingPriceEur: null,
          lawyerName: null,
          saleDate: null,
          surenchere: { kind: "no_date" },
        }),
      ],
    });
    renderSection();

    expect(await screen.findByRole("heading", { name: "Vente sans titre" })).toBeTruthy();
    expect(screen.getByText("Date non connue")).toBeTruthy();
    expect(screen.getAllByText("Non renseigné")).toHaveLength(2);
    expect(screen.getByText("Prix non communiqué")).toBeTruthy();
    expect(screen.getByText("Aucun enregistré")).toBeTruthy();
    expect(screen.getByTestId("snapshot-surenchere").textContent).toContain(
      "La date d’audience n’est pas connue",
    );
  });

  it("n'annonce pas de fenêtre pour une vente qui n'est pas judiciaire, ni après l'échéance", async () => {
    mocks.fetchSnapshots.mockResolvedValue({
      snapshots: [
        snapshot({ id: "a", surenchere: { kind: "not_applicable" } }),
        snapshot({
          id: "b",
          title: "Vente échue",
          surenchere: {
            kind: "window",
            hearingDay: "2026-09-01",
            deadline: "2026-09-11",
            adjudicationConfirmed: true,
            expired: true,
          },
        }),
      ],
    });
    renderSection();

    await screen.findByRole("heading", { name: "Vente échue" });
    const blocks = screen.getAllByTestId("snapshot-surenchere").map((node) => node.textContent);
    expect(blocks[0]).toContain("Non déterminée pour ce type de vente");
    expect(blocks[1]).toContain(
      "Cette date indicative est passée : si vous êtes concerné, consultez sans attendre un avocat.",
    );
    expect(blocks[1]).toContain("Date indicative : le 11 septembre 2026");
    expect(blocks[1]).not.toMatch(/Il reste|dernier jour|échue/);
  });

  it("retire un instantané à la demande de la personne", async () => {
    mocks.fetchSnapshots
      .mockResolvedValueOnce({ snapshots: [snapshot()] })
      .mockResolvedValueOnce({ snapshots: [] });
    mocks.deleteSnapshot.mockResolvedValue({ ok: true, removed: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { container } = renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Retirer de mon espace" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("ne pourra pas être rétabli"));

    await waitFor(() => expect(mocks.deleteSnapshot).toHaveBeenCalledWith({ id: "snap-1" }));
    await waitFor(() => expect(container.innerHTML).toBe(""));
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  it("ne retire rien quand la personne refuse la confirmation", async () => {
    mocks.fetchSnapshots.mockResolvedValue({ snapshots: [snapshot()] });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Retirer de mon espace" }));

    expect(mocks.deleteSnapshot).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Maison de ville" })).toBeTruthy();
  });

  it("définit la surenchère et l'adjudication avec le composant Terme", async () => {
    mocks.fetchSnapshots.mockResolvedValue({ snapshots: [snapshot()] });
    renderSection();

    await screen.findByRole("heading", { name: "Maison de ville" });
    expect(screen.getByRole("button", { name: "Définition : surenchère" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Définition : adjudication" })).toBeTruthy();
  });

  it("annonce une indisponibilité sans afficher d'erreur technique", async () => {
    mocks.fetchSnapshots.mockRejectedValue(
      new Error("Ventes passées indisponibles pour le moment."),
    );
    renderSection();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("indisponibles");
  });
});
