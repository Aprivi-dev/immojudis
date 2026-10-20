import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("PublicTribunalActivity : contraste du texte atténué", () => {
  it("n'utilise plus text-brand-navy/60 (4,33:1) : text-ink-soft tient 4,5:1", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/PublicTribunalActivity.tsx"),
      "utf8",
    );
    expect(source).not.toContain("text-brand-navy/60");
    expect(source).toContain("text-ink-soft");
  });
});
