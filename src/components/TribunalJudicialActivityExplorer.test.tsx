// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTribunalJudicialActivityDirectory,
  type TribunalJudicialActivityDirectorySale,
} from "@/lib/tribunal-judicial-activity-directory";

const mocks = vi.hoisted(() => ({ useQuery: vi.fn(), useAuth: vi.fn() }));

vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.useQuery }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: mocks.useAuth }));
vi.mock("@/lib/client-api", () => ({ fetchAccessPlan: vi.fn() }));
vi.mock("@/components/PremiumAdjudicationExplorer", () => ({
  PremiumAdjudicationExplorer: () => <section aria-label="Résultats premium Licitor" />,
}));

import { TribunalJudicialActivityExplorer } from "./TribunalJudicialActivityExplorer";

const AS_OF = new Date("2026-08-20T12:00:00.000Z");

describe("TribunalJudicialActivityExplorer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useAuth.mockReturnValue({ session: { user: { id: "premium-user" } }, loading: false });
    mocks.useQuery.mockImplementation((options: { queryKey?: unknown[] }) => {
      if (options.queryKey?.[0] === "tribunal-judicial-activity-plan") {
        return {
          data: { plan: { hasAnalysisAccess: true } },
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        };
      }
      return {
        data: fixture(),
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      };
    });
  });
  afterEach(cleanup);

  it("présente la France puis les ressorts avant le détail tribunal", () => {
    render(<TribunalJudicialActivityExplorer />);

    const nationalHeading = screen.getByRole("heading", {
      name: "Repères du périmètre suivi",
    });
    const regionHeading = screen.getByRole("heading", {
      name: "Où les données sont-elles assez denses ?",
    });
    const tribunalHeading = screen.getByRole("heading", { name: "TJ Marseille" });

    expect(
      nationalHeading.compareDocumentPosition(regionHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      regionHeading.compareDocumentPosition(tribunalHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("0 / 2")).toBeTruthy();
    expect(screen.getByText(/Profils historiques publiables \/ tribunaux suivis/i)).toBeTruthy();
    expect(screen.getByText(/ne mesure pas la couverture nationale/i)).toBeTruthy();
    expect(screen.getAllByText("Historique observé").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Pipeline à venir").length).toBeGreaterThan(0);
    expect(screen.getByText(/présentés séparément aux membres Analyse/i)).toBeTruthy();
  });

  it("filtre les tribunaux depuis un ressort sans perdre la vue nationale", () => {
    render(<TribunalJudicialActivityExplorer />);

    fireEvent.click(screen.getByRole("button", { name: /^Paris/ }));

    expect(screen.getByRole("heading", { name: "Repères du périmètre suivi" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "TJ Paris" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Marseille/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Revenir à toute la France" })).toBeTruthy();
  });

  it("ne charge pas l’annuaire pour un visiteur", () => {
    mocks.useAuth.mockReturnValue({ session: null, loading: false });
    mocks.useQuery.mockImplementation((options: { queryKey?: unknown[] }) => {
      if (options.queryKey?.[0] === "tribunal-judicial-activity-plan") {
        return { data: undefined, isLoading: false, isError: false, refetch: vi.fn() };
      }
      return { data: fixture(), isLoading: false, isError: false, refetch: vi.fn() };
    });

    render(<TribunalJudicialActivityExplorer />);

    expect(
      screen.getByRole("region", { name: "Activité des annonces et prochaines audiences" }),
    ).toBeTruthy();
    const directoryQuery = mocks.useQuery.mock.calls.find(
      ([options]) => options.queryKey?.[0] === "tribunal-judicial-activity-directory",
    );
    expect(directoryQuery?.[0].enabled).toBe(false);
  });
});

function fixture() {
  return buildTribunalJudicialActivityDirectory({
    courts: [
      { code: "marseille", name: "TJ Marseille", judicialRegion: "Aix" },
      { code: "paris", name: "TJ Paris", judicialRegion: "Paris" },
    ],
    sales: [
      ...Array.from({ length: 5 }, (_, index) =>
        sale("marseille", `marseille-${index}`, 10 + index, 40_000 + index * 10_000),
      ),
      ...Array.from({ length: 5 }, (_, index) =>
        sale("paris", `paris-${index}`, 20 + index, 200_000 + index * 10_000),
      ),
    ],
    asOf: AS_OF,
    historyMonths: 36,
  });
}

function sale(
  tribunalCode: string,
  id: string,
  daysFromNow: number,
  startingPriceEur: number,
): TribunalJudicialActivityDirectorySale {
  const saleDate = new Date(AS_OF.getTime() + daysFromNow * 24 * 60 * 60 * 1_000);
  return {
    tribunalCode,
    id,
    saleDate: saleDate.toISOString(),
    status: "upcoming",
    startingPriceEur,
    propertyType: "apartment",
    visitDates: [],
    firstSeenAt: new Date(saleDate.getTime() - 30 * 24 * 60 * 60 * 1_000).toISOString(),
  };
}
