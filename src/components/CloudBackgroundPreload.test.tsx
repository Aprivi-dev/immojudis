import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CLOUD_BACKGROUND_SRC, CloudBackgroundPreload } from "./CloudBackgroundPreload";

describe("CloudBackgroundPreload", () => {
  it("emits a high-priority image preload for the page background and no visible markup", () => {
    const html = renderToString(
      <main>
        <CloudBackgroundPreload />
        <p>Contenu</p>
      </main>,
    );

    expect(html).toContain('rel="preload"');
    expect(html).toContain('as="image"');
    expect(html).toContain(`href="${CLOUD_BACKGROUND_SRC}"`);
    expect(html).toContain('fetchPriority="high"');
    expect(html).toContain("<main><p>Contenu</p></main>");
  });

  it("preloads the exact file that .liquid-page paints, and the home page keeps its own LCP", () => {
    const css = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8");
    const liquidPage = css.slice(
      css.indexOf(".liquid-page {"),
      css.indexOf(".liquid-page::before"),
    );
    expect(liquidPage).toContain(`url("${CLOUD_BACKGROUND_SRC}")`);

    // Les pages de contenu qui affichent .liquid-page au premier écran le préchargent. Les
    // routes juridiques le font depuis leur fichier de route : `src/routes/*` est ancré par
    // sha256 dans LEGAL_DOCUMENTS et ne doit pas être modifié sans nouvelle version.
    for (const file of [
      "app/ventes-immobilieres-judiciaires/resources-guide.tsx",
      "app/a-propos/page.tsx",
      "app/legal/page.tsx",
      "app/privacy/page.tsx",
      "app/conditions-generales/page.tsx",
    ]) {
      expect(readFileSync(join(process.cwd(), "src", file), "utf8"), file).toContain(
        "<CloudBackgroundPreload />",
      );
    }

    // L'accueil (.ij-page) n'est pas préchargé : son LCP est la photo du dossier d'exemple.
    const layout = readFileSync(join(process.cwd(), "src", "app", "layout.tsx"), "utf8");
    const home = readFileSync(join(process.cwd(), "src", "app", "page.tsx"), "utf8");
    expect(layout).not.toContain("CloudBackgroundPreload");
    expect(home).not.toContain("CloudBackgroundPreload");
  });
});
