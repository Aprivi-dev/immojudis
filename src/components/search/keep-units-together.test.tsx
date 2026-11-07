// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { formatPricePerM2 } from "@/lib/format";
import { keepUnitsTogether } from "./keep-units-together";

afterEach(cleanup);

function nowrapParts(text: string) {
  const { container } = render(<p>{keepUnitsTogether(text)}</p>);
  return {
    text: container.textContent,
    nowrap: [...container.querySelectorAll("span.whitespace-nowrap")].map(
      (span) => span.textContent,
    ),
  };
}

describe("keepUnitsTogether", () => {
  it("met le nombre et son unité dans un même bloc, sans changer le texte", () => {
    expect(nowrapParts("Appartement de 114 m² à Aix-en-Provence")).toEqual({
      text: "Appartement de 114 m² à Aix-en-Provence",
      nowrap: ["114 m²"],
    });
    const perM2 = formatPricePerM2(2500);
    expect(nowrapParts(`· ${perM2}`)).toEqual({ text: `· ${perM2}`, nowrap: [perM2] });
  });

  it("rend le texte tel quel quand il n'y a aucune unité", () => {
    expect(keepUnitsTogether("Maison à Lille")).toBe("Maison à Lille");
  });
});
