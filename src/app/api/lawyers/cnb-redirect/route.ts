import { NextResponse } from "next/server";
import {
  CNB_DIRECTORY_URL,
  CNB_REAL_ESTATE_SPECIALIZATION_CODE,
  CNB_SEARCH_URL,
  findCnbBarAssociation,
} from "@/lib/cnb-directory";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const bar = new URL(request.url).searchParams.get("bar")?.slice(0, 120);
  const cnbBar = findCnbBarAssociation(bar);
  if (!cnbBar) return NextResponse.redirect(CNB_DIRECTORY_URL, 307);

  const html = `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Ouverture de l'annuaire du CNB</title>
    <style>
      body { display: grid; min-height: 100vh; margin: 0; place-items: center; background: #eef7ff; color: #132c48; font: 16px/1.5 system-ui, sans-serif; }
      main { max-width: 34rem; padding: 2rem; text-align: center; }
      button { min-height: 44px; border: 0; border-radius: 6px; padding: 0 18px; background: #132c48; color: white; cursor: pointer; font: inherit; font-weight: 700; }
    </style>
  </head>
  <body>
    <main>
      <p>Ouverture des avocats en droit immobilier du barreau sélectionné…</p>
      <form id="cnb-search" method="post" action="${CNB_SEARCH_URL}">
        <input type="hidden" name="form" value="formulaireRecherche">
        <input type="hidden" name="nomAvocat" value="">
        <input type="hidden" name="prenomAvocat" value="">
        <input type="hidden" name="barreau" value="${cnbBar.code}">
        <input type="hidden" name="ville" value="">
        <input type="hidden" name="codePostal" value="">
        <input type="hidden" name="mentions" value="${CNB_REAL_ESTATE_SPECIALIZATION_CODE}">
        <input type="hidden" name="langues" value="nonRenseigne">
        <noscript><button type="submit">Continuer vers l'annuaire du CNB</button></noscript>
      </form>
    </main>
    <script>document.getElementById("cnb-search").submit();</script>
  </body>
</html>`;

  return new Response(html, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; base-uri 'none'; form-action https://annuaire.avocat.fr; frame-ancestors 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
