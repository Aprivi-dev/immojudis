// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ResourcesPage } from "./resources-guide";

afterEach(cleanup);

describe("guide des ventes immobilières judiciaires", () => {
  it("renvoie la section frais vers le simulateur de frais", () => {
    const { container } = render(<ResourcesPage />);
    const section = container.querySelector("#frais");
    expect(section).not.toBeNull();
    const link = Array.from(section!.querySelectorAll("a")).find(
      (anchor) => anchor.getAttribute("href") === "/simulateur-frais-encheres",
    );
    expect(link?.textContent).toBe("simulateur de frais d’enchères");
    expect(screen.getAllByRole("link", { name: "simulateur de frais d’enchères" })).toHaveLength(1);
  });
});
