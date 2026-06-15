import { useEffect, useState, type ComponentType } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right.js";
import BriefcaseBusiness from "lucide-react/dist/esm/icons/briefcase-business.js";
import Calculator from "lucide-react/dist/esm/icons/calculator.js";
import CircleDollarSign from "lucide-react/dist/esm/icons/circle-dollar-sign.js";
import Database from "lucide-react/dist/esm/icons/database.js";
import FileCheck2 from "lucide-react/dist/esm/icons/file-check-2.js";
import FileSearch from "lucide-react/dist/esm/icons/file-search.js";
import Gavel from "lucide-react/dist/esm/icons/gavel.js";
import Landmark from "lucide-react/dist/esm/icons/landmark.js";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import MapPinned from "lucide-react/dist/esm/icons/map-pinned.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.js";
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
          "Immojudis lit les annonces et pièces de ventes judiciaires pour transformer un dossier complexe en mise plafond claire avant audience.",
      },
    ],
  }),
  component: HomePage,
});

type IconComponent = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

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
      { threshold: 0.14 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

function HeroVideo() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const saveData =
      (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData ===
      true;
    if (!reducedMotion && !saveData) setEnabled(true);
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

  const investorCta = user
    ? { to: "/sales", label: "Ouvrir les annonces" }
    : { to: "/login", label: "Accès investisseur" };
  const professionalCta = isProfessionalAccount(user, profile)
    ? { to: "/publish", label: "Publier une vente" }
    : { to: "/login", label: "Référencer une annonce" };

  const totalSales = stats ? stats.totalSales.toLocaleString("fr-FR") : "—";
  const departments = stats ? String(stats.departments) : "—";
  const nextSale = stats?.nextSale ? formatDate(stats.nextSale) : "—";

  return (
    <main className="hx-page min-h-screen text-foreground">
      <section className="hx-hero px-4 sm:px-6">
        <HeroVideo />
        <div aria-hidden className="hx-hero-veil" />
        <div className="mx-auto grid max-w-7xl items-center gap-10 py-12 lg:min-h-[calc(100svh-4rem)] lg:grid-cols-[minmax(0,0.95fr)_minmax(27rem,0.78fr)] lg:gap-16 lg:py-10 xl:gap-20">
          <div className="hx-hero-copy">
            <p className="hx-eyebrow">
              <span aria-hidden className="hx-eyebrow-dot" />
              Assistant d'analyse des ventes judiciaires
            </p>

            <h1 className="hx-title">
              Décider avant
              <span>d'enchérir.</span>
            </h1>

            <p className="hx-lead">
              Immojudis lit les annonces, pièces et diagnostics pour estimer la mise maximale à ne
              pas dépasser, avec les preuves utiles et les points à vérifier avant l'audience.
            </p>

            <div className="hx-actions">
              <a href="#demo-analysis" className="hx-btn-primary">
                Voir une analyse exemple <ArrowRight className="h-4 w-4" />
              </a>
              <Link to={investorCta.to} className="hx-btn-ghost">
                {investorCta.label}
              </Link>
            </div>

            <div className="hx-trust-row" aria-label="Garanties de confiance">
              <TrustPill icon={Database}>Sources publiques suivies</TrustPill>
              <TrustPill icon={FileCheck2}>Documents tracés</TrustPill>
              <TrustPill icon={LockKeyhole}>Accès sécurisé</TrustPill>
            </div>
          </div>

          <ProductPreview />
        </div>
      </section>

      <section className="hx-section hx-proof-strip px-4 py-8 sm:px-6" data-reveal>
        <div className="mx-auto grid max-w-7xl gap-3 md:grid-cols-3">
          <StatCard value={totalSales} label="annonces collectées" />
          <StatCard value={departments} label="départements suivis" />
          <StatCard value={nextSale} label="prochaine audience" />
        </div>
      </section>

      <section className="hx-section px-4 py-16 sm:px-6 lg:py-20">
        <div className="mx-auto max-w-7xl">
          <SectionHeading
            eyebrow="Avant / après"
            title="Le dossier judiciaire devient une décision lisible."
            text="On ne remplace pas la relecture humaine : on met les informations utiles au bon endroit, avec une limite rationnelle avant d'enchérir."
          />

          <div className="hx-before-after mt-9" data-reveal>
            <div className="hx-before-panel">
              <PanelBadge tone="warm">Sans Immojudis</PanelBadge>
              <h3>Des pièces dispersées, difficiles à arbitrer.</h3>
              <ul>
                <li>Annonce, diagnostics et conditions de vente séparés</li>
                <li>Marché local difficile à comparer rapidement</li>
                <li>Risque de fixer une limite au ressenti</li>
              </ul>
            </div>
            <div className="hx-after-panel">
              <PanelBadge tone="green">Avec Immojudis</PanelBadge>
              <h3>Une mise plafond et les preuves qui l'expliquent.</h3>
              <ul>
                <li>Fourchette prudente, équilibrée et offensive</li>
                <li>Prix au m² local et marge de sécurité visibles</li>
                <li>Points à vérifier reliés aux pièces du dossier</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section id="demo-analysis" className="hx-section px-4 py-16 sm:px-6 lg:py-20">
        <div className="mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-[0.82fr_1.18fr]">
          <div data-reveal>
            <SectionHeading
              eyebrow="Démo produit"
              title="Une annonce judiciaire, traduite en prix maximum."
              text="L'exemple montre la logique attendue : partir du marché local, retirer une marge de sécurité, puis intégrer frais et travaux pour obtenir une limite d'enchère."
            />
            <div className="hx-source-list mt-8">
              <SourceItem
                icon={FileSearch}
                title="Annonce source"
                text="Prix, audience, adresse et surface utile."
              />
              <SourceItem
                icon={FileCheck2}
                title="Pièces du dossier"
                text="Conditions de vente, diagnostics, PV descriptif."
              />
              <SourceItem
                icon={MapPinned}
                title="Marché local"
                text="Comparables proches et prix au m² de référence."
              />
            </div>
          </div>

          <DemoCaseCard />
        </div>
      </section>

      <section className="hx-section px-4 py-16 sm:px-6 lg:py-20">
        <div className="mx-auto max-w-7xl">
          <SectionHeading
            eyebrow="Fonctionnalités clés"
            title="Trois gestes pour arriver préparé."
            text="La home reste volontairement courte : lire le dossier, calculer la limite, préparer la décision."
          />
          <div className="mt-9 grid gap-4 md:grid-cols-3">
            <FeatureCard
              icon={FileSearch}
              title="Lire le dossier"
              text="Les annonces et documents utiles sont structurés pour retrouver l'information importante sans fouiller chaque PDF."
              delay="0ms"
            />
            <FeatureCard
              icon={Calculator}
              title="Calculer la mise plafond"
              text="Le plafond combine marché local, frais, travaux estimés et marge de sécurité pour éviter l'enchère émotionnelle."
              delay="90ms"
            />
            <FeatureCard
              icon={Gavel}
              title="Préparer l'audience"
              text="Vous gardez une limite claire, une synthèse courte et les points à confirmer avant la salle de vente."
              delay="180ms"
            />
          </div>
        </div>
      </section>

      <section className="hx-section px-4 py-16 sm:px-6 lg:py-20">
        <div className="mx-auto grid max-w-7xl gap-4 lg:grid-cols-2">
          <AudienceCard
            icon={CircleDollarSign}
            eyebrow="Investisseurs"
            title="Consulter les ventes avec une limite claire."
            text="Accédez aux annonces, favoris, alertes et mises plafonds pour décider plus vite, sans perdre le fil des pièces."
            cta={investorCta.label}
            to={investorCta.to}
          />
          <AudienceCard
            icon={BriefcaseBusiness}
            eyebrow="Professionnels"
            title="Référencer une vente et structurer le dossier."
            text="Les comptes pro pourront déposer les informations, documents et visuels, puis suivre la validation côté Immojudis."
            cta={professionalCta.label}
            to={professionalCta.to}
          />
        </div>
      </section>

      <section className="hx-section px-4 pb-16 sm:px-6">
        <div className="hx-sources mx-auto max-w-7xl" data-reveal>
          <span>Sources suivies</span>
          <strong>Avoventes</strong>
          <strong>Licitor</strong>
          <strong>Vench</strong>
          <strong>Enchères Publiques</strong>
          <strong>Info Enchères</strong>
          <strong>DVF</strong>
          <strong>OpenStreetMap</strong>
        </div>
      </section>

      <footer className="border-t border-white/8 px-4 py-8 sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-col justify-between gap-5 text-xs text-muted-foreground md:flex-row md:items-center">
          <div>
            <strong className="block text-sm uppercase tracking-[0.16em] text-foreground">
              Immojudis
            </strong>
            <p className="mt-2 max-w-xl leading-relaxed">
              Aide à l'analyse des ventes immobilières judiciaires. Immojudis ne remplace pas un
              conseil juridique, financier ou une relecture professionnelle du dossier.
            </p>
          </div>
          <div className="flex flex-wrap gap-5 uppercase tracking-[0.16em]">
            <Link to="/legal">Légal</Link>
            <Link to="/privacy">Confidentialité</Link>
            <Link to="/contact">Contact</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}

function ProductPreview() {
  return (
    <aside className="hx-product-preview" aria-label="Aperçu d'une analyse Immojudis">
      <div className="hx-preview-topbar">
        <span>Analyse Immojudis</span>
        <span className="hx-live-chip">
          <span aria-hidden className="hx-eyebrow-dot" />
          dossier lu
        </span>
      </div>

      <div className="hx-preview-main">
        <div>
          <p className="hx-mini-label">Appartement · Bordeaux</p>
          <h2>À combien s'arrêter ?</h2>
          <p>
            Le plafond est calculé sous le marché local avec frais, travaux estimés et marge de
            sécurité.
          </p>
        </div>
        <div className="hx-price-tile">
          <span>Mise équilibrée</span>
          <strong>129 400 €</strong>
          <small>à ne pas dépasser</small>
        </div>
      </div>

      <div className="hx-bid-grid">
        <BidOption title="Prudent" value="121 800 €" text="-14% sous marché" />
        <BidOption title="Équilibré" value="129 400 €" text="-10% sous marché" active />
        <BidOption title="Offensif" value="136 900 €" text="-6% sous marché" />
      </div>

      <div className="hx-meter-block">
        <div className="hx-meter-head">
          <span>Prix marché local</span>
          <strong>4 060 €/m²</strong>
        </div>
        <div className="hx-meter-track" aria-hidden>
          <span />
        </div>
      </div>

      <div className="hx-preview-notes">
        <PreviewNote icon={FileCheck2} title="Pièce utile" text="Cahier des conditions identifié" />
        <PreviewNote
          icon={ShieldCheck}
          title="À vérifier"
          text="Occupation à confirmer avant audience"
        />
      </div>
    </aside>
  );
}

function DemoCaseCard() {
  return (
    <article className="hx-demo-card" data-reveal>
      <div className="hx-demo-visual" aria-hidden>
        <div className="hx-demo-map">
          <MapPinned className="h-5 w-5" />
          <span>Bordeaux · rayon DVF 500 m</span>
        </div>
        <div className="hx-demo-building">
          <Landmark className="h-8 w-8" />
        </div>
      </div>

      <div className="hx-demo-content">
        <div>
          <p className="hx-mini-label">Appartement T4 · audience à confirmer</p>
          <h3>Fixer une limite avant la salle.</h3>
        </div>
        <div className="hx-demo-ceiling">
          <span>Plafond recommandé</span>
          <strong>129 400 €</strong>
          <small>fourchette 121 800 € → 136 900 €</small>
        </div>
      </div>

      <div className="hx-demo-logic">
        <LogicStep number="1" title="Marché local" value="4 060 €/m²" />
        <LogicStep number="2" title="Marge sécurité" value="-10%" />
        <LogicStep number="3" title="Frais + travaux" value="intégrés" />
      </div>

      <div className="hx-demo-alert">
        <Sparkles className="h-4 w-4" />
        <span>
          Lecture : rester sous ce plafond permet de conserver une marge face au marché local, sous
          réserve de confirmer les pièces avant audience.
        </span>
      </div>
    </article>
  );
}

function TrustPill({ icon: Icon, children }: { icon: IconComponent; children: string }) {
  return (
    <span>
      <Icon aria-hidden className="h-3.5 w-3.5" />
      {children}
    </span>
  );
}

function StatCard({ value, label }: { value: string; label: string }) {
  return (
    <div className="hx-stat-card">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function SectionHeading({
  eyebrow,
  title,
  text,
}: {
  eyebrow: string;
  title: string;
  text: string;
}) {
  return (
    <div className="hx-section-heading" data-reveal>
      <p>{eyebrow}</p>
      <h2>{title}</h2>
      <span>{text}</span>
    </div>
  );
}

function PanelBadge({ children, tone }: { children: string; tone: "warm" | "green" }) {
  return <span className={`hx-panel-badge hx-panel-badge-${tone}`}>{children}</span>;
}

function SourceItem({
  icon: Icon,
  title,
  text,
}: {
  icon: IconComponent;
  title: string;
  text: string;
}) {
  return (
    <div className="hx-source-item">
      <Icon aria-hidden className="h-4 w-4" />
      <div>
        <strong>{title}</strong>
        <span>{text}</span>
      </div>
    </div>
  );
}

function FeatureCard({
  icon: Icon,
  title,
  text,
  delay,
}: {
  icon: IconComponent;
  title: string;
  text: string;
  delay: string;
}) {
  return (
    <article className="hx-feature-card" data-reveal style={{ ["--d" as string]: delay }}>
      <div className="hx-feature-icon">
        <Icon aria-hidden className="h-5 w-5" />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
    </article>
  );
}

function AudienceCard({
  icon: Icon,
  eyebrow,
  title,
  text,
  cta,
  to,
}: {
  icon: IconComponent;
  eyebrow: string;
  title: string;
  text: string;
  cta: string;
  to: string;
}) {
  return (
    <article className="hx-audience-card" data-reveal>
      <div className="hx-feature-icon">
        <Icon aria-hidden className="h-5 w-5" />
      </div>
      <p>{eyebrow}</p>
      <h3>{title}</h3>
      <span>{text}</span>
      <Link to={to} className="hx-audience-link">
        {cta} <ArrowUpRight className="h-4 w-4" />
      </Link>
    </article>
  );
}

function BidOption({
  title,
  value,
  text,
  active = false,
}: {
  title: string;
  value: string;
  text: string;
  active?: boolean;
}) {
  return (
    <div className={active ? "hx-bid-option hx-bid-option-active" : "hx-bid-option"}>
      <span>{title}</span>
      <strong>{value}</strong>
      <small>{text}</small>
    </div>
  );
}

function PreviewNote({
  icon: Icon,
  title,
  text,
}: {
  icon: IconComponent;
  title: string;
  text: string;
}) {
  return (
    <div className="hx-preview-note">
      <Icon aria-hidden className="h-4 w-4" />
      <div>
        <strong>{title}</strong>
        <span>{text}</span>
      </div>
    </div>
  );
}

function LogicStep({ number, title, value }: { number: string; title: string; value: string }) {
  return (
    <div>
      <span>{number}</span>
      <strong>{title}</strong>
      <small>{value}</small>
    </div>
  );
}
