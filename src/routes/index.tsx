import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right.js";
import Check from "lucide-react/dist/esm/icons/check.js";
import Gavel from "lucide-react/dist/esm/icons/gavel.js";
import { getStats } from "@/lib/queries";
import { formatDate } from "@/lib/format";
import { useAuth } from "@/hooks/use-auth";
import { isProfessionalAccount } from "@/lib/account";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Immojudis — Décider avant d'enchérir" },
      {
        name: "description",
        content:
          "Immojudis transforme les annonces, documents et données de marché des ventes judiciaires en décision claire avant enchère.",
      },
    ],
  }),
  component: HomePage,
});

/**
 * Scroll reveal: elements tagged [data-reveal] get hidden client-side only,
 * then released when they enter the viewport. SSR / no-JS users see everything.
 */
function useScrollReveal() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    if (els.length === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    els.forEach((el) => el.classList.add("hx-reveal"));
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("hx-in");
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.16 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

/**
 * Ambient hero video. Mounted client-side only, and only when the user allows
 * motion — reduced-motion users never download the file. Heavily filtered and
 * sitting under the hero gradients so copy stays fully readable.
 */
function HeroVideo() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const saveData =
      (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData ===
      true;
    if (!reducedMotion && !saveData) {
      setEnabled(true);
    }
  }, []);

  if (!enabled) return null;

  return (
    <video
      className="hx-hero-video"
      src="/media/hero-ambient.mp4"
      autoPlay
      muted
      loop
      playsInline
      preload="auto"
      disablePictureInPicture
      tabIndex={-1}
      aria-hidden
      onCanPlay={(event) => {
        const video = event.currentTarget;
        video.classList.add("hx-video-ready");
        // Some browsers drop the autoplay attribute after hydration — retry
        // explicitly; if the platform still refuses, the veil keeps the hero clean.
        void video.play().catch(() => {});
      }}
    />
  );
}

function HomePage() {
  const { user, profile } = useAuth();
  const { data: stats } = useQuery({
    queryKey: ["stats"],
    queryFn: getStats,
    staleTime: 5 * 60_000,
  });
  useScrollReveal();

  const professionalCta = isProfessionalAccount(user, profile)
    ? { to: "/publish", label: "Publier une vente" }
    : { to: user ? "/contact" : "/login", label: "Accès pro" };

  return (
    <main className="hx-page min-h-screen text-foreground">
      {/* ─────────── Hero : promesse + dossier vivant ─────────── */}
      <section className="hx-hero px-4 sm:px-6">
        <HeroVideo />
        <div aria-hidden className="hx-hero-veil" />
        <div className="mx-auto grid max-w-7xl items-center gap-12 py-14 lg:min-h-[calc(100svh-4rem)] lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:gap-16 lg:py-10">
          <div>
            <p className="hx-eyebrow">
              <span aria-hidden className="hx-eyebrow-dot" />
              Intelligence des ventes judiciaires
            </p>

            <h1 className="hx-title" aria-label="Analyser. Décider. Enchérir.">
              <span className="hx-word-mask">
                <span className="hx-word" style={{ animationDelay: "80ms" }}>
                  Analyser.
                </span>
              </span>
              <span className="hx-word-mask">
                <span className="hx-word hx-word-gold" style={{ animationDelay: "240ms" }}>
                  Décider.
                </span>
              </span>
              <span className="hx-word-mask">
                <span className="hx-word" style={{ animationDelay: "400ms" }}>
                  Enchérir.
                  <span aria-hidden className="hx-underline" />
                </span>
              </span>
            </h1>

            <p className="hx-lead">
              Immojudis lit les annonces, les pièces du dossier et les données de marché, puis les
              transforme en une lecture claire : score, risques, prix plafond — avant la salle de
              vente.
            </p>

            <div className="hx-actions">
              <Link to="/sales" className="hx-btn-primary">
                Commencer l'analyse <ArrowUpRight className="h-4 w-4" />
              </Link>
              <Link to={professionalCta.to} className="hx-btn-ghost">
                {professionalCta.label}
              </Link>
            </div>

            <dl className="hx-stats" aria-label="Indicateurs Immojudis">
              <div data-reveal style={{ ["--d" as string]: "0ms" }}>
                <dd>{stats ? `${stats.totalSales.toLocaleString("fr-FR")}` : "—"}</dd>
                <dt>Annonces analysées</dt>
              </div>
              <div data-reveal style={{ ["--d" as string]: "90ms" }}>
                <dd>{stats ? String(stats.departments) : "—"}</dd>
                <dt>Départements suivis</dt>
              </div>
              <div data-reveal style={{ ["--d" as string]: "180ms" }}>
                <dd>{stats?.nextSale ? formatDate(stats.nextSale) : "—"}</dd>
                <dt>Prochaine vente</dt>
              </div>
            </dl>
          </div>

          <AnalysisTerminal />
        </div>
      </section>

      <footer className="border-t border-white/8 px-4 py-8 sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 text-xs uppercase tracking-[0.18em] text-muted-foreground sm:flex-row">
          <span>© {new Date().getFullYear()} Immojudis</span>
          <div className="flex gap-5">
            <Link to="/legal">Légal</Link>
            <Link to="/privacy">Confidentialité</Link>
            <Link to="/contact">Contact</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}

/**
 * Live case file — the product, shown as motion: a dossier assembles line by
 * line (source verified → extraction → risk → score fills → ceiling builds),
 * then the decision lands. Values mirror the long-standing demo dossier.
 */
function AnalysisTerminal() {
  return (
    <aside className="hx-terminal" aria-label="Exemple de dossier analysé par Immojudis">
      <header className="hx-terminal-head">
        <span className="hx-terminal-id">Dossier · TJ Bordeaux</span>
        <span className="hx-terminal-live">
          <span aria-hidden className="hx-eyebrow-dot" />
          Analyse
        </span>
      </header>

      <ol className="hx-terminal-body">
        <li className="hx-row" style={{ ["--d" as string]: "500ms" }}>
          <span className="hx-check" aria-hidden>
            <Check className="h-3 w-3" />
          </span>
          <div>
            <strong>Source vérifiée</strong>
            <span>Cahier des conditions de vente</span>
          </div>
        </li>
        <li className="hx-row" style={{ ["--d" as string]: "950ms" }}>
          <span className="hx-check" aria-hidden>
            <Check className="h-3 w-3" />
          </span>
          <div>
            <strong>Pièces extraites</strong>
            <span>PV descriptif · diagnostics recoupés</span>
          </div>
        </li>
        <li className="hx-row" style={{ ["--d" as string]: "1400ms" }}>
          <span className="hx-check hx-check-watch" aria-hidden>
            !
          </span>
          <div>
            <strong>Risque détecté</strong>
            <span>Occupation : bail en cours, à vérifier</span>
          </div>
        </li>
        <li className="hx-row" style={{ ["--d" as string]: "1850ms" }}>
          <span className="hx-check" aria-hidden>
            <Check className="h-3 w-3" />
          </span>
          <div>
            <strong>Marché local mesuré</strong>
            <span>ventes comparables · marge de sécurité appliquée</span>
          </div>
        </li>
        <li className="hx-row hx-row-score" style={{ ["--d" as string]: "2300ms" }}>
          <div className="w-full">
            <div className="hx-ceiling-label">
              <strong>Mise plafond</strong>
              <span className="hx-ceiling-value">129 400 €</span>
            </div>
            <div className="hx-ceiling-track" aria-hidden>
              <span className="hx-ceiling-bar" style={{ ["--d" as string]: "2500ms" }} />
            </div>
            <span className="hx-ceiling-note">enchère + frais + travaux, sous le marché local</span>
          </div>
        </li>
      </ol>

      <footer className="hx-stamp" style={{ ["--d" as string]: "3100ms" }}>
        <Gavel aria-hidden className="h-4 w-4" />
        <span>
          La limite à ne pas dépasser — <strong>pour rester gagnant</strong>
        </span>
      </footer>
    </aside>
  );
}
