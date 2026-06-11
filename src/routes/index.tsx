import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right.js";
import Bell from "lucide-react/dist/esm/icons/bell.js";
import Calculator from "lucide-react/dist/esm/icons/calculator.js";
import Check from "lucide-react/dist/esm/icons/check.js";
import FileSearch from "lucide-react/dist/esm/icons/file-search.js";
import Gavel from "lucide-react/dist/esm/icons/gavel.js";
import Heart from "lucide-react/dist/esm/icons/heart.js";
import MapIcon from "lucide-react/dist/esm/icons/map.js";
import ScanSearch from "lucide-react/dist/esm/icons/scan-search.js";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert.js";
import { getStats } from "@/lib/queries";
import { formatDate } from "@/lib/format";
import { useAuth } from "@/hooks/use-auth";
import { isProfessionalAccount } from "@/lib/account";
import { ScoreBadge } from "@/components/ScoreBadge";

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
  const { user } = useAuth();
  const { data: stats } = useQuery({
    queryKey: ["stats"],
    queryFn: getStats,
    staleTime: 5 * 60_000,
  });
  useScrollReveal();

  const professionalCta = isProfessionalAccount(user)
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

      {/* ─────────── Méthode : 3 temps reliés ─────────── */}
      <section className="px-4 py-20 sm:px-6 lg:py-28" aria-labelledby="methode-title">
        <div className="mx-auto max-w-7xl">
          <header className="hx-section-head" data-reveal>
            <span>La méthode</span>
            <h2 id="methode-title">Trois temps, une décision</h2>
          </header>

          <ol className="hx-method" data-reveal>
            <li className="hx-method-step" style={{ ["--d" as string]: "0ms" }}>
              <span className="hx-method-index">01</span>
              <FileSearch aria-hidden className="h-5 w-5" />
              <h3>Analyser</h3>
              <p>
                Annonces, cahiers des conditions de vente, PV descriptifs et diagnostics sont
                collectés puis lus page par page. Chaque fait retenu garde sa source.
              </p>
            </li>
            <li className="hx-method-step" style={{ ["--d" as string]: "140ms" }}>
              <span className="hx-method-index">02</span>
              <ScanSearch aria-hidden className="h-5 w-5" />
              <h3>Décider</h3>
              <p>
                Le Score Immojudis croise risques, occupation, état et marché local. Le prix plafond
                fixe la limite rationnelle au-delà de laquelle on passe.
              </p>
            </li>
            <li className="hx-method-step" style={{ ["--d" as string]: "280ms" }}>
              <span className="hx-method-index">03</span>
              <Gavel aria-hidden className="h-5 w-5" />
              <h3>Enchérir</h3>
              <p>
                Vous entrez en salle avec une position tenue : les points à vérifier sont levés, le
                plafond est connu, la décision est déjà prise.
              </p>
            </li>
          </ol>
        </div>
      </section>

      {/* ─────────── Capacités ─────────── */}
      <section className="px-4 pb-20 sm:px-6 lg:pb-28" aria-labelledby="capacites-title">
        <div className="mx-auto max-w-7xl">
          <header className="hx-section-head" data-reveal>
            <span>Le poste d'analyse</span>
            <h2 id="capacites-title">Tout le dossier, au même endroit</h2>
          </header>

          <div className="hx-caps" data-reveal>
            <Capability
              to="/sales"
              icon={FileSearch}
              title="Annonces scorées"
              desc="Chaque vente arrive lue, scorée et datée — comparables entre elles."
              delay={0}
            />
            <Capability
              to="/map"
              icon={MapIcon}
              title="Carte du territoire"
              desc="Score, prix et occupation projetés sur la zone que vous prospectez."
              delay={70}
            />
            <Capability
              to="/sales"
              icon={ShieldAlert}
              title="Risques sourcés"
              desc="Occupation, servitudes, travaux : chaque alerte renvoie à l'extrait exact."
              delay={140}
            />
            <Capability
              to="/sales"
              icon={Calculator}
              title="Prix plafond"
              desc="Frais, travaux et marge de sécurité intégrés à votre limite d'enchère."
              delay={210}
            />
            <Capability
              to="/favorites"
              icon={Heart}
              title="Favoris"
              desc="Votre liste courte, prête pour la relecture de veille d'audience."
              delay={280}
            />
            <Capability
              to="/alerts"
              icon={Bell}
              title="Alertes"
              desc="Vos critères surveillent les nouvelles ventes à votre place."
              delay={350}
            />
          </div>
        </div>
      </section>

      {/* ─────────── CTA final ─────────── */}
      <section className="px-4 pb-24 sm:px-6">
        <div className="hx-cta mx-auto max-w-7xl" data-reveal>
          <div>
            <h2>Entrez dans le poste d'analyse</h2>
            <p>Un compte investisseur donne accès aux annonces, scores, carte et alertes.</p>
          </div>
          <div className="hx-actions !mt-0">
            <Link to={user ? "/sales" : "/login"} className="hx-btn-primary">
              {user ? "Voir les annonces" : "Créer un accès"} <ArrowUpRight className="h-4 w-4" />
            </Link>
          </div>
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
        <li className="hx-row hx-row-score" style={{ ["--d" as string]: "1850ms" }}>
          <ScoreBadge score={82} confidence={0.8} size="md" showLabel />
        </li>
        <li className="hx-row" style={{ ["--d" as string]: "2300ms" }}>
          <div className="w-full">
            <div className="hx-ceiling-label">
              <strong>Prix plafond</strong>
              <span className="hx-ceiling-value">129 400 €</span>
            </div>
            <div className="hx-ceiling-track" aria-hidden>
              <span className="hx-ceiling-bar" style={{ ["--d" as string]: "2500ms" }} />
            </div>
            <span className="hx-ceiling-note">frais, travaux et marge de sécurité inclus</span>
          </div>
        </li>
      </ol>

      <footer className="hx-stamp" style={{ ["--d" as string]: "3100ms" }}>
        <Gavel aria-hidden className="h-4 w-4" />
        <span>
          Décision — <strong>enchérir jusqu'au plafond</strong>
        </span>
      </footer>
    </aside>
  );
}

function Capability({
  to,
  icon: Icon,
  title,
  desc,
  delay,
}: {
  to: string;
  icon: typeof FileSearch;
  title: string;
  desc: string;
  delay: number;
}) {
  return (
    <Link to={to} className="hx-cap" style={{ ["--d" as string]: `${delay}ms` }}>
      <Icon aria-hidden className="h-5 w-5" />
      <h3>{title}</h3>
      <p>{desc}</p>
      <span className="hx-cap-go" aria-hidden>
        <ArrowUpRight className="h-3.5 w-3.5" />
      </span>
    </Link>
  );
}
