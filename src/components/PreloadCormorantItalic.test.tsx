import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import italicUrl from "@/fonts/cormorant-garamond-latin-italic.woff2";
import { PreloadCormorantItalic } from "./PreloadCormorantItalic";

describe("PreloadCormorantItalic", () => {
  it("écrit un seul <link rel=preload as=font> vers le fichier de l'italique, dans le <head>", () => {
    const html = renderToString(
      <html>
        <head />
        <body>
          <PreloadCormorantItalic />
          <PreloadCormorantItalic />
        </body>
      </html>,
    );
    const links = html.match(/<link[^>]*rel="preload"[^>]*>/g) ?? [];
    expect(links).toHaveLength(1);
    expect(links[0]).toContain(`href="${italicUrl}"`);
    expect(links[0]).toContain('as="font"');
    expect(links[0]).toContain('type="font/woff2"');
    // Une police chargée en `anonymous` : sans cet attribut le préchargement ne servirait pas la
    // requête de la police, qui est toujours anonyme.
    expect(links[0]).toContain('crossorigin=""');
    expect(html.indexOf("<link")).toBeLessThan(html.indexOf("<body"));
  });

  it("est un composant client : un préfetch RSC ne l'exécute pas, donc n'écrit aucun indice", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(__dirname, "PreloadCormorantItalic.tsx"), "utf8");
    expect(source.trimStart().startsWith('"use client";')).toBe(true);
  });
});
