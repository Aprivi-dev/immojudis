// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Link } from "./router-compat";

afterEach(cleanup);

describe("vestige router-compat (documents juridiques)", () => {
  it("rend un lien natif vers l'adresse donnée, avec sa classe", () => {
    render(
      <Link to="/mes-droits" className="text-gold underline">
        Mes droits
      </Link>,
    );
    const link = screen.getByRole("link", { name: "Mes droits" });
    expect(link.getAttribute("href")).toBe("/mes-droits");
    expect(link.className).toBe("text-gold underline");
  });
});
