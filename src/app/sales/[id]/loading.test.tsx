// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import SaleLoading from "./loading";

afterEach(cleanup);

describe("chargement de la fiche d'une vente", () => {
  it("annonce le chargement (role=status) sans le laisser reprendre comme extrait (data-nosnippet)", () => {
    render(<SaleLoading />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Chargement de l’annonce…");
    expect(status.hasAttribute("data-nosnippet")).toBe(true);
    expect(status.hasAttribute("aria-hidden")).toBe(false);
    expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("true");
  });
});
