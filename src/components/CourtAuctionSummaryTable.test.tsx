// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchCourtAuctionSummaries = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-api", () => ({ fetchCourtAuctionSummaries }));

import { CourtAuctionSummaryTable } from "./CourtAuctionSummaryTable";

const COURTS = {
  courts: [
    {
      courtCode: "bobigny",
      courtName: "TJ Bobigny",
      licitor: {
        sample: 442,
        meanStartingPrice: 61_000,
        meanHammerPrice: 140_000,
        medianStartingPrice: 50_000,
        medianHammerPrice: 121_000,
        medianRatio: 2.28,
        atLeastDoubleRate: 0.57,
      },
      dvf: { sample: 350, medianPrice: 122_000 },
    },
    {
      courtCode: "lyon",
      courtName: "TJ Lyon",
      licitor: null,
      dvf: null,
    },
  ],
};

function renderTable() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CourtAuctionSummaryTable />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CourtAuctionSummaryTable", () => {
  it("présente un tableau accessible : légende, en-têtes de colonne et de ligne, zone défilante", async () => {
    fetchCourtAuctionSummaries.mockResolvedValue(COURTS);
    const { container } = renderTable();

    const region = await screen.findByRole("region", {
      name: "Médianes par tribunal, défilement horizontal",
    });
    expect(region.getAttribute("tabindex")).toBe("0");
    const table = screen.getByRole("table");
    expect(table.querySelector("caption")?.textContent).toContain("Médianes par tribunal");
    const headers = [...container.querySelectorAll("thead th")];
    expect(headers).toHaveLength(7);
    for (const header of headers) expect(header.getAttribute("scope")).toBe("col");
    expect(headers[0].className).toContain("sticky");
    expect(headers[0].className).toContain("left-0");
    const rowHeader = screen.getByRole("rowheader", { name: "TJ Bobigny" });
    expect(rowHeader.getAttribute("scope")).toBe("row");
    expect(rowHeader.className).toContain("sticky");
    expect(rowHeader.className).toContain("left-0");
  });

  it("nomme exactement le calcul : adjugées à au moins 2 fois la mise à prix", async () => {
    fetchCourtAuctionSummaries.mockResolvedValue(COURTS);
    renderTable();
    expect(
      await screen.findByRole("columnheader", {
        name: "Adjugées à au moins 2 fois la mise à prix",
      }),
    ).toBeTruthy();
    expect(screen.queryByText("Au moins le double")).toBeNull();
  });

  it("montre des médianes, pas des moyennes, pour la mise à prix et le prix d'adjudication", async () => {
    fetchCourtAuctionSummaries.mockResolvedValue(COURTS);
    renderTable();
    expect(await screen.findByRole("columnheader", { name: "Mise à prix médiane" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Prix d’adjudication médian" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: /moyen/i })).toBeNull();
    const row = screen.getByRole("rowheader", { name: "TJ Bobigny" }).closest("tr");
    expect(row?.textContent).toMatch(/50\s000\s€/);
    expect(row?.textContent).toMatch(/121\s000\s€/);
    expect(row?.textContent).not.toMatch(/61\s000/);
  });

  it("précise sous le tableau le champ des statistiques, leur origine et leurs sources", async () => {
    fetchCourtAuctionSummaries.mockResolvedValue(COURTS);
    renderTable();
    await screen.findByRole("table");

    const caveat = document.getElementById("moyennes-caveat")?.textContent ?? "";
    expect(caveat).toContain(
      "ventes adjugées uniquement (ni reports, ni ventes sans enchérisseur)",
    );
    expect(caveat).toContain("données tierces non vérifiées auprès du greffe");
    expect(caveat).toContain("ne constituent pas une probabilité pour une vente donnée");
    expect(caveat).toContain("Licitor");
    expect(caveat).toContain("DVF");
  });

  it("annonce qu'aucun tribunal ne correspond au filtre", async () => {
    fetchCourtAuctionSummaries.mockResolvedValue(COURTS);
    renderTable();
    fireEvent.change(await screen.findByLabelText("Rechercher un tribunal"), {
      target: { value: "Zzz" },
    });
    expect(screen.getByRole("status").textContent).toBe("Aucun tribunal ne correspond à « Zzz ».");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("dit que les statistiques n'ont pas pu être chargées et permet de réessayer", async () => {
    fetchCourtAuctionSummaries.mockRejectedValueOnce(new Error("HTTP 500"));
    renderTable();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Les statistiques du tribunal n’ont pas pu être chargées.");

    fetchCourtAuctionSummaries.mockResolvedValue(COURTS);
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(await screen.findByRole("table")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("n'affiche rien quand il n'y a simplement pas de données", async () => {
    fetchCourtAuctionSummaries.mockResolvedValue({ courts: [] });
    const { container } = renderTable();
    await vi.waitFor(() => expect(fetchCourtAuctionSummaries).toHaveBeenCalled());
    await vi.waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(container.textContent).toBe("");
  });
});
