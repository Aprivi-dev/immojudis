import { describe, expect, it } from "vitest";
import {
  bidVerdict,
  bidVerdictSentence,
  BID_VERDICT_LABEL,
  TIGHT_MARGIN_LABEL,
} from "./bid-verdict";

describe("verdict d'une enchère plafond face à la mise à prix", () => {
  it("enchérit à partir de 10 % au-dessus de la mise à prix, serré en dessous, passe sous la mise à prix", () => {
    expect(bidVerdict(104_500, 95_000)).toBe("go");
    expect(bidVerdict(135_000, 95_000)).toBe("go");
    expect(bidVerdict(104_499, 95_000)).toBe("tight");
    expect(bidVerdict(95_000, 95_000)).toBe("tight");
    expect(bidVerdict(94_999, 95_000)).toBe("pass");
    expect(BID_VERDICT_LABEL).toEqual({
      go: "On enchérit",
      tight: "Serré",
      pass: "On passe son tour",
    });
    expect(TIGHT_MARGIN_LABEL).toBe("10 %");
  });

  it("chiffre l'écart dans chaque cas", () => {
    const normalize = (text: string) => text.replace(/\s/g, " ");
    expect(normalize(bidVerdictSentence(135_000, 95_000))).toBe(
      "40 000 € de marge au-dessus de la mise à prix.",
    );
    expect(normalize(bidVerdictSentence(102_500, 95_000))).toBe(
      "Seulement 7 500 € au-dessus de la mise à prix : peu de marge.",
    );
    expect(normalize(bidVerdictSentence(44_000, 95_000))).toBe(
      "La mise à prix dépasse déjà votre plafond de 51 000 €.",
    );
  });
});
