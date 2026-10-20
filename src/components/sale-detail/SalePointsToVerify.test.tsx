// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import { pointsToVerify } from "@/lib/search/points-to-verify";
import type { AuctionSale } from "@/lib/types";
import { SalePointsToVerify } from "./SalePointsToVerify";

afterEach(cleanup);

const sale = (fields: Record<string, unknown> = {}) =>
  ({
    id: "sale-1",
    status: "upcoming",
    sale_date: "2099-01-20T09:00:00Z",
    app_surface_m2: null,
    occupancy_status: null,
    ...fields,
  }) as unknown as AuctionSale;

describe("SalePointsToVerify", () => {
  it("reprend, sous l'ancre #points-a-verifier, les points de la pastille de la liste", () => {
    const points = pointsToVerify(sale(), { occupancyVisible: true });
    const { container } = render(<SalePointsToVerify points={points} />);

    const section = screen.getByRole("region", { name: "2 points à vérifier" });
    expect(section.id).toBe("points-a-verifier");
    expect(container.querySelector("#points-a-verifier")).toBe(section);
    expect(Array.from(section.querySelectorAll("li")).map((item) => item.textContent)).toEqual([
      "Surface non communiquée dans l’annonce",
      "Occupation du bien à vérifier",
    ]);
    expect(section.textContent).toContain(
      "La liste n’est pas exhaustive : l’absence de pastille ne signifie pas qu’il n’y a rien à vérifier.",
    );
  });

  it("n'affiche rien sans point", () => {
    const { container } = render(
      <SalePointsToVerify
        points={pointsToVerify(sale({ app_surface_m2: 60, occupancy_status: "libre" }), {
          occupancyVisible: true,
        })}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("n'a pas de défaut d'accessibilité", async () => {
    const { container } = render(
      <SalePointsToVerify points={pointsToVerify(sale(), { occupancyVisible: true })} />,
    );
    const result = await axe(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map(({ id, help }) => ({ id, help }))).toEqual([]);
  });
});
