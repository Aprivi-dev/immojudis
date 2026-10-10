import { describe, expect, it } from "vitest";
import { jsonLdString } from "./json-ld";

describe("jsonLdString", () => {
  it("neutralise une fermeture de balise script dans une valeur", () => {
    const out = jsonLdString({ name: "</script><script>alert(1)</script>" });
    expect(out).not.toContain("</script>");
    expect(JSON.parse(out).name).toBe("</script><script>alert(1)</script>");
  });
});
