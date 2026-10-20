// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/SectorAlertCta", () => ({
  SectorAlertCta: ({ criteria }: { criteria: Record<string, string> }) => (
    <div data-testid="cta">{criteria.department}</div>
  ),
}));

import { TribunalSectorAlert } from "./TribunalSectorAlert";

afterEach(cleanup);

describe("TribunalSectorAlert", () => {
  it("demande un département (une alerte suit un département, pas un tribunal) avant de proposer le bouton", () => {
    render(<TribunalSectorAlert />);
    expect(screen.getByText(/pas un tribunal/)).toBeTruthy();
    expect(screen.queryByTestId("cta")).toBeNull();

    fireEvent.change(screen.getByLabelText("Département"), { target: { value: "33" } });
    expect(screen.getByTestId("cta").textContent).toBe("33");
  });

  it("a un h2, une section nommée par ce h2 et un champ « Département »", () => {
    render(<TribunalSectorAlert />);
    const heading = screen.getByRole("heading", {
      level: 2,
      name: "Être prévenu des nouvelles ventes d’un département",
    });
    const section = screen.getByRole("region", {
      name: "Être prévenu des nouvelles ventes d’un département",
    });
    expect(section.getAttribute("aria-labelledby")).toBe(heading.id);
    const select = screen.getByLabelText("Département");
    expect(select.tagName).toBe("SELECT");
    expect(section.contains(select)).toBe(true);
  });
});
