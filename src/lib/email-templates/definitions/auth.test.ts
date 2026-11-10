import { describe, expect, it } from "vitest";
import { fillGoVariables, goQueryEscape } from "./auth";

describe("goQueryEscape (urlquery de Go dans l'aperçu)", () => {
  // Valeurs attendues : sortie de `url.QueryEscape` de Go 1.24 pour les mêmes entrées.
  it.each([
    ["a b&c=d", "a+b%26c%3Dd"],
    ["!'()*", "%21%27%28%29%2A"],
    ["é à ç", "%C3%A9+%C3%A0+%C3%A7"],
    [
      "https://immojudis.com/sales?q=a+b c&type=maison",
      "https%3A%2F%2Fimmojudis.com%2Fsales%3Fq%3Da%2Bb+c%26type%3Dmaison",
    ],
    ["~-_.%/", "~-_.%25%2F"],
  ])("encode %j comme Go", (value, expected) => {
    expect(goQueryEscape(value)).toBe(expected);
  });

  it("remplace {{ .RedirectTo | urlquery }} par l'exemple encodé comme Go", () => {
    expect(fillGoVariables("x={{ .RedirectTo | urlquery }}")).toBe(
      `x=${goQueryEscape(fillGoVariables("{{ .RedirectTo }}"))}`,
    );
  });
});
