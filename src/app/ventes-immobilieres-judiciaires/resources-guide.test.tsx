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

  it("a un plan de titres sans saut de niveau : un h1, puis jamais plus d'un niveau d'écart", () => {
    const { container } = render(<ResourcesPage />);
    const levels = Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6")).map((heading) =>
      Number(heading.tagName.slice(1)),
    );
    expect(levels.filter((level) => level === 1)).toHaveLength(1);
    expect(levels[0]).toBe(1);
    // The first heading after the h1 is an h2 (it used to be an h3 in the intro cards).
    expect(levels[1]).toBe(2);
    levels.forEach((level, index) => {
      if (index > 0) expect(level - levels[index - 1]).toBeLessThanOrEqual(1);
    });
  });
});
