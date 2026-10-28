"use client";

import { EMAIL_COLORS, EMAIL_FONT_STACK } from "@/lib/email-brand";

/**
 * Dernier filet de sécurité : cette page remplace le gabarit racine, donc sans
 * feuille de style du site. Les couleurs reprennent la charte (papier #fbf9f5,
 * marine #132238, or #c98d45 avec texte marine à 5,6:1).
 */
export default function GlobalError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="fr">
      <body style={{ margin: 0 }}>
        <title>Incident temporaire</title>
        <main
          style={{
            alignItems: "center",
            background: "#fbf9f5",
            color: EMAIL_COLORS.navy,
            display: "flex",
            fontFamily: EMAIL_FONT_STACK,
            justifyContent: "center",
            minHeight: "100vh",
            padding: "2rem",
          }}
        >
          <section
            role="alert"
            style={{
              background: EMAIL_COLORS.white,
              border: `1px solid ${EMAIL_COLORS.lineWarm}`,
              borderRadius: ".75rem",
              maxWidth: "36rem",
              padding: "2rem",
              textAlign: "center",
            }}
          >
            <p
              style={{
                color: EMAIL_COLORS.goldText,
                fontSize: ".75rem",
                fontWeight: 600,
                letterSpacing: ".14em",
                margin: 0,
                textTransform: "uppercase",
              }}
            >
              Incident temporaire
            </p>
            <h1 style={{ fontSize: "2rem", margin: "1rem 0" }}>
              Immojudis ne peut pas afficher cette page.
            </h1>
            <p style={{ color: EMAIL_COLORS.inkSoft, lineHeight: 1.6 }}>
              Vos données n’ont pas été modifiées. Vous pouvez relancer l’affichage immédiatement.
            </p>
            <button
              type="button"
              onClick={retry}
              style={{
                background: EMAIL_COLORS.gold,
                border: 0,
                borderRadius: ".375rem",
                color: EMAIL_COLORS.navy,
                cursor: "pointer",
                fontSize: "1rem",
                fontWeight: 600,
                marginTop: "1.5rem",
                minHeight: "2.75rem",
                padding: ".6rem 1.5rem",
              }}
            >
              Réessayer
            </button>
          </section>
        </main>
      </body>
    </html>
  );
}
