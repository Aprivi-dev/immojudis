import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("textes de 9 et 10 px portés à 12 px", () => {
  it.each(["src/components/SaleVisual.tsx", "src/components/search/SearchHeader.tsx"])(
    "%s n'a plus de text-[9px] ni de text-[10px]",
    (file) => {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source).not.toMatch(/text-\[(9|10)px\]/);
    },
  );
});
