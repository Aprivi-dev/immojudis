// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EXAMPLE_COMMUNE_RISKS } from "@/lib/example-commune-risks";
import { ListingEnvironmentalRisks } from "./ListingEnvironmentalRisks";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderRisks(props: Parameters<typeof ListingEnvironmentalRisks>[0]) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ListingEnvironmentalRisks {...props} />
    </QueryClientProvider>,
  );
}

describe("commune risks block", () => {
  it("loads the commune profile from the public risks route", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ risks: EXAMPLE_COMMUNE_RISKS })),
    );
    vi.stubGlobal("fetch", fetcher);
    renderRisks({ saleId: "sale-1" });

    expect(await screen.findByText("Bordeaux")).toBeTruthy();
    expect(fetcher).toHaveBeenCalledWith("/api/sales/sale-1/risks", expect.any(Object));
  });

  it("groups sub-risks under their family and shows zoning, plans and decrees", () => {
    vi.stubGlobal("fetch", vi.fn());
    renderRisks({ saleId: "example", demoProfile: EXAMPLE_COMMUNE_RISKS });

    expect(screen.getByText("Risques naturels")).toBeTruthy();
    expect(screen.getByText("Risques technologiques")).toBeTruthy();
    expect(
      screen.getByText(
        (_, node) =>
          node?.textContent === "Inondation · Par une crue à débordement lent de cours d'eau",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Zone 2 · faible")).toBeTruthy();
    expect(screen.getByText(/Catégorie 2/)).toBeTruthy();
    expect(screen.getByText("PPR Bordeaux (revision)")).toBeTruthy();
    expect(screen.getByText(/approuvé le 05\/12\/2023/)).toBeTruthy();
    expect(screen.getByText("50")).toBeTruthy();
    expect(screen.getByText(/JO du 02\/08\/2024/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Géorisques, base GASPAR/ })).toBeTruthy();
  });

  it("never calls the network for the example listing", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    renderRisks({ saleId: "example", demoProfile: EXAMPLE_COMMUNE_RISKS });

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("falls back to Géorisques when the profile is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ risks: { status: "unavailable", reason: "profile_missing" } }),
          ),
      ),
    );
    renderRisks({ saleId: "sale-1" });

    expect(await screen.findByText(/pas encore disponible/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Vérifier l’adresse exacte sur Géorisques/ }),
    ).toBeTruthy();
  });

  it("renders nothing when the listing cannot be located", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { container } = renderRisks({ saleId: "sale-1", enabled: false });

    expect(container.textContent).toBe("");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
