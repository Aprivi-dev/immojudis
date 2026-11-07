"use client";

import { EMAIL_COLORS, EMAIL_FONT_STACK } from "@/lib/email-brand";

/**
 * Dernier filet de sécurité : cette page remplace le gabarit racine, donc sans feuille de style du
 * site. Elle reprend en styles en ligne le gabarit des pages d'état (`StatusPage`, repasse design
 * n° 37) : fond papier, carte blanche à filet, surtitre or texte, titre de page, bouton principal
 * marine (n° 19) et retour à l'accueil. Les couleurs viennent des jetons copiés dans `EMAIL_COLORS`.
 */
export default function GlobalError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const action = {
    alignItems: "center",
    borderRadius: ".375rem",
    boxSizing: "border-box",
    cursor: "pointer",
    display: "inline-flex",
    fontFamily: "inherit",
    fontSize: ".875rem",
    fontWeight: 600,
    justifyContent: "center",
    minHeight: "2.75rem",
    padding: "0 1rem",
    textDecoration: "none",
  } as const;
  return (
    <html lang="fr">
      <body style={{ margin: 0 }}>
        <title>Incident temporaire</title>
        <main
          id="contenu"
          style={{
            alignItems: "center",
            background: EMAIL_COLORS.paper,
            color: EMAIL_COLORS.navy,
            display: "flex",
            fontFamily: EMAIL_FONT_STACK,
            justifyContent: "center",
            minHeight: "100vh",
            padding: "4rem 1rem",
            boxSizing: "border-box",
          }}
        >
          <section
            role="alert"
            style={{
              background: EMAIL_COLORS.white,
              border: `1px solid ${EMAIL_COLORS.line}`,
              borderRadius: ".625rem",
              maxWidth: "42rem",
              padding: "2.5rem",
              textAlign: "center",
              width: "100%",
              boxSizing: "border-box",
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
            <h1 style={{ fontSize: "2rem", fontWeight: 600, lineHeight: 1.25, margin: ".75rem 0" }}>
              Immojudis ne peut pas afficher cette page.
            </h1>
            <p style={{ color: EMAIL_COLORS.inkSoft, lineHeight: 1.6, margin: 0 }}>
              Vos données n’ont pas été modifiées. Vous pouvez relancer l’affichage immédiatement.
            </p>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: ".75rem",
                justifyContent: "center",
                marginTop: "1.5rem",
              }}
            >
              <button
                type="button"
                onClick={retry}
                style={{
                  ...action,
                  background: EMAIL_COLORS.navy,
                  border: 0,
                  color: EMAIL_COLORS.white,
                }}
              >
                Réessayer
              </button>
              {/* Lien simple : le routeur du site n'est peut-être plus utilisable ici. */}
              <a
                href="/"
                style={{
                  ...action,
                  background: EMAIL_COLORS.white,
                  border: `1px solid ${EMAIL_COLORS.line}`,
                  color: EMAIL_COLORS.navy,
                }}
              >
                Retour à l’accueil
              </a>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
