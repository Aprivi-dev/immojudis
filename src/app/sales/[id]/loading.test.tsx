import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import SaleLoading from "./loading";

it("rend « Chargement de l'annonce… » invisible aux moteurs et aux lecteurs d'écran", () => {
  const html = renderToStaticMarkup(<SaleLoading />);
  // data-nosnippet n'est reconnu que sur span, div et section (pas sur un paragraphe).
  expect(html).toMatch(
    /<span[^>]*aria-hidden="true"[^>]*data-nosnippet[^>]*>Chargement de l’annonce…/,
  );
  expect(html).not.toMatch(/<p[\s>]/);
  // Le squelette lui-même est masqué aux technologies d'assistance.
  expect(html).toContain('aria-busy="true"');
  expect(html.match(/aria-hidden="true"/g)?.length).toBeGreaterThanOrEqual(2);
});
