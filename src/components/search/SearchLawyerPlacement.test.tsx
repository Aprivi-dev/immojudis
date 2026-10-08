// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchLawyerPlacement } from "./SearchLawyerPlacement";

const mocks = vi.hoisted(() => ({
  fetchLawyerDirectory: vi.fn(),
}));

vi.mock("@/lib/client-api", () => ({
  fetchLawyerDirectory: mocks.fetchLawyerDirectory,
}));

afterEach(() => {
  cleanup();
  mocks.fetchLawyerDirectory.mockReset();
});

function renderPlacement(props: ComponentProps<typeof SearchLawyerPlacement> = {}) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false } },
        })
      }
    >
      <SearchLawyerPlacement {...props} />
    </QueryClientProvider>,
  );
}

function directoryResponse(overrides: Record<string, unknown> = {}) {
  return {
    lawyers: [],
    sectorLabel: "Bordeaux",
    barAssociation: "Bordeaux",
    isDemo: false,
    officialSource: null,
    ...overrides,
  };
}

describe("SearchLawyerPlacement", () => {
  beforeEach(() => {
    mocks.fetchLawyerDirectory.mockResolvedValue(directoryResponse());
  });

  it("uses the public city and department scope and renders only a real active sponsor", async () => {
    mocks.fetchLawyerDirectory.mockResolvedValue(
      directoryResponse({
        lawyers: [
          {
            id: "lawyer-1",
            displayName: "Maître Élodie Martin",
            firmName: "Cabinet Martin",
            barAssociation: "Bordeaux",
            city: "Bordeaux",
            department: "33",
            matchingLabel: "Bordeaux",
            isSponsored: true,
            source: "immojudis",
          },
        ],
      }),
    );

    renderPlacement({ geographicLabel: "Bordeaux · 33", city: "Bordeaux", department: "33" });

    await waitFor(() => expect(screen.getByText("Cabinet Martin")).toBeTruthy());
    expect(screen.getByText("Sponsorisé")).toBeTruthy();
    expect(screen.queryByText("Espace partenaire")).toBeNull();
    expect(mocks.fetchLawyerDirectory).toHaveBeenCalledWith({
      city: "Bordeaux",
      department: "33",
    });
    expect(
      screen.getByRole("link", { name: "Voir l’annuaire du secteur" }).getAttribute("href"),
    ).toBe("/avocats?city=Bordeaux&department=33");
  });

  it("keeps a transparent contact slot when there is no configured campaign", async () => {
    mocks.fetchLawyerDirectory.mockResolvedValue(
      directoryResponse({
        lawyers: [
          {
            id: "directory-1",
            displayName: "Maître Claire Bernard",
            isSponsored: false,
            source: "immojudis",
          },
        ],
      }),
    );

    renderPlacement({ geographicLabel: "Bordeaux", city: "Bordeaux" });

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Présentez votre cabinet" })).toBeTruthy(),
    );
    expect(screen.getByText("Espace partenaire")).toBeTruthy();
    expect(screen.queryByText("Maître Claire Bernard")).toBeNull();
    expect(screen.queryByText("Sponsorisé")).toBeNull();
    expect(
      screen.getByText(
        "Présentez votre cabinet aux acquéreurs qui recherchent un bien dans ce secteur.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Présenter mon cabinet" }).getAttribute("href")).toBe(
      "/contact",
    );
  });

  it("does not present development demo lawyers as paid partners", async () => {
    mocks.fetchLawyerDirectory.mockResolvedValue(
      directoryResponse({
        isDemo: true,
        lawyers: [
          {
            id: "demo-1",
            displayName: "Maître Cabinet Démo",
            isSponsored: true,
            source: "immojudis",
          },
        ],
      }),
    );

    renderPlacement({ city: "Bordeaux" });

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Présentez votre cabinet" })).toBeTruthy(),
    );
    expect(screen.queryByText("Maître Cabinet Démo")).toBeNull();
  });

  it("derives one department code from a department-only geographic label", async () => {
    renderPlacement({ geographicLabel: "33" });

    await waitFor(() => expect(mocks.fetchLawyerDirectory).toHaveBeenCalled());
    expect(mocks.fetchLawyerDirectory).toHaveBeenCalledWith({
      city: undefined,
      department: "33",
    });
  });

  it("does not query the directory without a commune or a single department", () => {
    renderPlacement({ geographicLabel: "Recherche libre" });

    expect(screen.getByRole("heading", { name: "Présentez votre cabinet" })).toBeTruthy();
    expect(mocks.fetchLawyerDirectory).not.toHaveBeenCalled();

    cleanup();
    renderPlacement({ geographicLabel: "Nouvelle-Aquitaine" });
    expect(mocks.fetchLawyerDirectory).not.toHaveBeenCalled();
  });
});
