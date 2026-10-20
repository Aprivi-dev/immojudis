// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LawyerStatement } from "@/lib/lawyer-statement";
import { AdminLawyerStatementPanel } from "./AdminLawyerStatementPanel";

const mocks = vi.hoisted(() => ({ fetchStatement: vi.fn() }));
vi.mock("@/lib/client-api/admin", () => ({ fetchAdminLawyerStatement: mocks.fetchStatement }));

const statement: LawyerStatement = {
  month: "2026-10",
  rows: [
    {
      lawyerId: "c6400000-1000-4000-8000-000000000001",
      displayName: "Maître Claire Durand",
      firmName: "Cabinet Durand",
      impressions: 1200,
      ctaClicks: 7,
      referralRequestsSent: 2,
    },
    {
      lawyerId: "c6400000-1000-4000-8000-000000000002",
      displayName: "Maître Marc Lefèvre",
      firmName: null,
      impressions: 30,
      ctaClicks: 0,
      referralRequestsSent: 0,
    },
  ],
  totals: { impressions: 1230, ctaClicks: 7, referralRequestsSent: 2 },
};

function renderPanel() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <AdminLawyerStatementPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-20T10:00:00Z") });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("AdminLawyerStatementPanel", () => {
  it("opens on the previous month and shows the figures per lawyer with a total", async () => {
    mocks.fetchStatement.mockResolvedValue(statement);

    renderPanel();

    expect(await screen.findByRole("table")).toBeTruthy();
    expect(mocks.fetchStatement).toHaveBeenCalledWith("2026-10");
    expect((screen.getByLabelText("Mois") as HTMLInputElement).value).toBe("2026-10");
    expect(screen.getAllByText(/octobre 2026/).length).toBeGreaterThan(0);

    const claire = screen.getByRole("row", { name: /Maître Claire Durand/ });
    expect(
      within(claire)
        .getAllByRole("cell")
        .map((cell) => cell.textContent?.replace(/\s/g, " ")),
    ).toEqual(["1 200", "7", "2"]);
    const total = screen.getByRole("row", { name: /^Total/ });
    expect(within(total).getAllByRole("cell")).toHaveLength(3);
  });

  it("states that nothing is sent and that no buyer data is included", async () => {
    mocks.fetchStatement.mockResolvedValue(statement);

    renderPanel();
    await screen.findByRole("table");

    expect(screen.getByText(/rien n’est envoyé automatiquement/)).toBeTruthy();
    expect(screen.getByText(/sans aucune donnée d’acquéreur ni de compte/)).toBeTruthy();
  });

  it("exports the shown month as a CSV file", async () => {
    mocks.fetchStatement.mockResolvedValue(statement);
    const createObjectURL = vi.fn(() => "blob:statement");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    renderPanel();
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: /Exporter en CSV/ }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
    // The UTF-8 byte order mark lets a spreadsheet open the accents correctly.
    expect([...new Uint8Array(await blob.arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = await blob.text();
    expect(text.startsWith("mois;avocat;cabinet;affichages;clics;demandes_transmises")).toBe(true);
    expect(text).toContain("2026-10;Maître Claire Durand;Cabinet Durand;1200;7;2");
    expect(text).toContain("2026-10;Total;;1230;7;2");
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:statement");
  });

  it("reads another month when it is changed", async () => {
    mocks.fetchStatement.mockResolvedValue(statement);

    renderPanel();
    await screen.findByRole("table");
    fireEvent.change(screen.getByLabelText("Mois"), { target: { value: "2026-09" } });

    await waitFor(() => expect(mocks.fetchStatement).toHaveBeenLastCalledWith("2026-09"));
  });

  it("disables the export for an empty month", async () => {
    mocks.fetchStatement.mockResolvedValue({
      month: "2026-10",
      rows: [],
      totals: { impressions: 0, ctaClicks: 0, referralRequestsSent: 0 },
    });

    renderPanel();

    expect(await screen.findByText(/Aucun avocat actif ni activité/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Exporter en CSV/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shows the server message when the statement cannot be read", async () => {
    mocks.fetchStatement.mockRejectedValue(
      new Error("Le relevé mensuel n'est pas encore disponible : migration à appliquer."),
    );

    renderPanel();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("migration à appliquer");
  });
});
