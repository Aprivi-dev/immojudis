"use client";

/**
 * Dernier filet de sécurité : cette page remplace le gabarit racine, donc sans
 * feuille de style du site. Les couleurs reprennent la charte (ciel #eef7ff,
 * marine #132238, or #c98d45 avec texte marine à 5,6:1).
 */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="fr">
      <body style={{ margin: 0 }}>
        <title>Incident temporaire</title>
        <main
          style={{
            alignItems: "center",
            background: "#eef7ff",
            color: "#132238",
            display: "flex",
            fontFamily: "system-ui, sans-serif",
            justifyContent: "center",
            minHeight: "100vh",
            padding: "2rem",
          }}
        >
          <section
            role="alert"
            style={{
              background: "#ffffff",
              border: "1px solid #cbd5df",
              borderRadius: ".75rem",
              maxWidth: "36rem",
              padding: "2rem",
              textAlign: "center",
            }}
          >
            <p
              style={{
                color: "#84602e",
                fontSize: ".75rem",
                fontWeight: 600,
                letterSpacing: ".14em",
                margin: 0,
                textTransform: "uppercase",
              }}
            >
              Incident temporaire
            </p>
            <h1 style={{ fontFamily: "Georgia, serif", fontSize: "2rem", margin: "1rem 0" }}>
              Immojudis ne peut pas afficher cette page.
            </h1>
            <p style={{ color: "#526170", lineHeight: 1.6 }}>
              Vos données n’ont pas été modifiées. Vous pouvez relancer l’affichage immédiatement.
            </p>
            <button
              type="button"
              onClick={reset}
              style={{
                background: "#c98d45",
                border: 0,
                borderRadius: ".375rem",
                color: "#132238",
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
