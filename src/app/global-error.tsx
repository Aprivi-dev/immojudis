"use client";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="fr">
      <body>
        <main
          style={{
            alignItems: "center",
            background: "#07111f",
            color: "#f7f3e8",
            display: "flex",
            fontFamily: "system-ui, sans-serif",
            justifyContent: "center",
            minHeight: "100vh",
            padding: "2rem",
          }}
        >
          <section style={{ maxWidth: "36rem", textAlign: "center" }}>
            <p style={{ color: "#d6af55", fontSize: ".75rem", letterSpacing: ".18em" }}>
              INCIDENT TEMPORAIRE
            </p>
            <h1 style={{ fontFamily: "Georgia, serif", fontSize: "2.5rem", margin: "1rem 0" }}>
              Immojudis ne peut pas afficher cette page.
            </h1>
            <p style={{ color: "#c6ced8", lineHeight: 1.6 }}>
              Vos données n’ont pas été modifiées. Vous pouvez relancer l’affichage immédiatement.
            </p>
            <button
              type="button"
              onClick={reset}
              style={{
                background: "#d6af55",
                border: 0,
                borderRadius: ".5rem",
                color: "#07111f",
                cursor: "pointer",
                fontWeight: 700,
                marginTop: "1.5rem",
                padding: ".8rem 1.25rem",
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
