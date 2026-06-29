import { createFileRoute, Link } from "@tanstack/react-router";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import Bell from "lucide-react/dist/esm/icons/bell.js";
import CalendarDays from "lucide-react/dist/esm/icons/calendar-days.js";
import Landmark from "lucide-react/dist/esm/icons/landmark.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import UserRound from "lucide-react/dist/esm/icons/user-round.js";
import { useEffect, useState, type ComponentType } from "react";
import { BrandMark } from "@/components/BrandLogo";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ImmoJudis — L'immobilier judiciaire en toute clarté" },
      {
        name: "description",
        content:
          "ImmoJudis rassemble les ventes judiciaires immobilières en France dans une expérience claire, premium et accessible.",
      },
    ],
  }),
  component: HomePage,
});

type IconComponent = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
type CandleArrowGeometry = {
  width: number;
  height: number;
  linePath: string;
  headPath: string;
};

const benefits = [
  { icon: Scale, title: "100% des ventes", text: "en France" },
  { icon: Bell, title: "Alertes personnalisées", text: "par email" },
  { icon: UserRound, title: "Appui expert", text: "sur demande" },
] satisfies Array<{ icon: IconComponent; title: string; text: string }>;

const auctionCards = [
  {
    image: "/media/landing/auction-bordeaux.jpg",
    badge: "Audience le 9 juillet",
    city: "Bordeaux",
    tribunal: "Tribunal judiciaire de Bordeaux",
    title: "Appartement de caractère, quartier Jardin Public",
    price: "Mise à prix 92 000 €",
  },
  {
    image: "/media/landing/auction-nantes.jpg",
    badge: "Nouveau",
    city: "Nantes",
    tribunal: "Tribunal judiciaire de Nantes",
    title: "Maison de ville en pierre avec dépendance",
    price: "Mise à prix 138 500 €",
  },
  {
    image: "/media/landing/auction-lyon.jpg",
    badge: "Audience le 16 juillet",
    city: "Lyon",
    tribunal: "Tribunal judiciaire de Lyon",
    title: "Appartement familial avec balcon et stationnement",
    price: "Mise à prix 176 000 €",
  },
  {
    image: "/media/landing/auction-toulouse.jpg",
    badge: "Baisse de prix",
    city: "Toulouse",
    tribunal: "Tribunal judiciaire de Toulouse",
    title: "Maison ancienne avec jardin arboré",
    price: "Mise à prix 121 000 €",
  },
] as const;

const workflowSteps = [
  {
    icon: Search,
    title: "1. Repérez",
    text: "Filtrez les ventes par ville, budget et type de bien.",
  },
  {
    icon: Scale,
    title: "2. Comprenez",
    text: "Lisez les points clés du dossier avant l'audience.",
  },
  {
    icon: Bell,
    title: "3. Suivez",
    text: "Créez une alerte et préparez votre mise plafond.",
  },
] satisfies Array<{ icon: IconComponent; title: string; text: string }>;

const searchGhostCities = ["Bordeaux", "Paris", "Lyon", "Nantes", "Toulouse", "Lille"] as const;

function HomePage() {
  return (
    <main className="ij-page">
      <HeroSection />
      <AuctionCardsSection />
      <HomeProcessSection />
      <HomeFooter />
    </main>
  );
}

function HeroSection() {
  return (
    <section className="ij-hero" aria-labelledby="home-title">
      <div className="ij-sky" aria-hidden />
      <div className="ij-hero-inner">
        <div className="ij-hero-copy">
          <p className="ij-badge ij-reveal">Plateforme n°1 des ventes judiciaires en France</p>

          <h1 id="home-title" className="ij-title ij-reveal ij-reveal-2">
            L'immobilier judiciaire,
            <br /> en toute <em>clarté.</em>
          </h1>

          <p className="ij-lead ij-reveal ij-reveal-3">
            Accédez à toutes les ventes aux enchères immobilières, comprenez chaque étape et
            saisissez les meilleures opportunités.
          </p>

          <SearchBar />

          <div className="ij-benefits ij-reveal ij-reveal-5" aria-label="Bénéfices ImmoJudis">
            {benefits.map(({ icon: Icon, title, text }) => (
              <div key={title} className="ij-benefit">
                <Icon aria-hidden className="h-6 w-6" />
                <span>
                  <strong>{title}</strong>
                  <small>{text}</small>
                </span>
              </div>
            ))}
          </div>
        </div>

        <JusticeGoddessVisual />

        <div className="ij-candle-scene ij-reveal ij-reveal-6">
          <CandleAnimation />
          <article className="ij-candle-note">
            <h2>Vente à la bougie</h2>
            <p>
              Symbole des ventes judiciaires en France : la lumière de la transparence et de
              l'équité.
            </p>
            <Link to="/ressources">
              Découvrir son histoire <ArrowRight aria-hidden className="h-4 w-4" />
            </Link>
          </article>
        </div>

        <CandleArrow />
      </div>
    </section>
  );
}

function CandleArrow() {
  const [geometry, setGeometry] = useState<CandleArrowGeometry | null>(null);

  useEffect(() => {
    let frame = 0;

    const px = (value: number) => Math.round(value * 10) / 10;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const root = document.querySelector<HTMLElement>(".ij-hero-inner");
        const start = document.querySelector<HTMLElement>("[data-arrow-start]");
        const end = document.querySelector<HTMLElement>("[data-arrow-end]");
        const candleScene = document.querySelector<HTMLElement>(".ij-candle-scene");

        if (
          !root ||
          !start ||
          !end ||
          !candleScene ||
          getComputedStyle(candleScene).display === "none"
        ) {
          setGeometry(null);
          return;
        }

        const rootRect = root.getBoundingClientRect();
        const startRect = start.getBoundingClientRect();
        const endRect = end.getBoundingClientRect();
        const startX = px(startRect.left + startRect.width / 2 - rootRect.left);
        const startY = px(startRect.top + startRect.height / 2 - rootRect.top);
        const endX = px(endRect.left + endRect.width / 2 - rootRect.left);
        const endY = px(endRect.top + endRect.height / 2 - rootRect.top);
        const dx = endX - startX;
        const dy = endY - startY;
        const lift = Math.min(132, Math.max(44, Math.abs(dx) * 0.75 + Math.abs(dy) * 0.55));
        const c1X = px(startX + dx * 0.12);
        const c1Y = px(startY - lift);
        const c2X = px(startX + dx * 0.82);
        const c2Y = px(endY - lift * 0.65);
        const angle = Math.atan2(endY - c2Y, endX - c2X);
        const headLength = 18;
        const wing = 0.58;
        const leftX = px(endX - Math.cos(angle - wing) * headLength);
        const leftY = px(endY - Math.sin(angle - wing) * headLength);
        const rightX = px(endX - Math.cos(angle + wing) * headLength);
        const rightY = px(endY - Math.sin(angle + wing) * headLength);
        const width = px(Math.max(rootRect.width, startX, endX, c1X, c2X, leftX, rightX) + 24);
        const height = px(Math.max(rootRect.height, startY, endY, c1Y, c2Y, leftY, rightY) + 24);

        setGeometry({
          width,
          height,
          linePath: `M ${startX} ${startY} C ${c1X} ${c1Y} ${c2X} ${c2Y} ${endX} ${endY}`,
          headPath: `M ${leftX} ${leftY} L ${endX} ${endY} L ${rightX} ${rightY}`,
        });
      });
    };

    const observer = "ResizeObserver" in window ? new ResizeObserver(update) : null;
    const hero = document.querySelector<HTMLElement>(".ij-hero-inner");
    const settleTimers = [120, 420, 820, 1220].map((delay) => window.setTimeout(update, delay));
    document
      .querySelectorAll<HTMLElement>(
        ".ij-hero-inner, [data-arrow-start], [data-arrow-end], .ij-candle-scene",
      )
      .forEach((element) => observer?.observe(element));

    update();
    hero?.addEventListener("animationend", update, true);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    window.addEventListener("load", update);
    void document.fonts?.ready.then(update);

    return () => {
      cancelAnimationFrame(frame);
      settleTimers.forEach((timer) => window.clearTimeout(timer));
      observer?.disconnect();
      hero?.removeEventListener("animationend", update, true);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      window.removeEventListener("load", update);
    };
  }, []);

  if (!geometry) return null;

  return (
    <svg
      className="ij-candle-arrow"
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      style={{ width: geometry.width, height: geometry.height }}
      aria-hidden="true"
    >
      <defs>
        <mask
          id="ij-candle-arrow-mask"
          maskUnits="userSpaceOnUse"
          x={0}
          y={0}
          width={geometry.width}
          height={geometry.height}
        >
          <path className="ij-candle-arrow-mask-line" d={geometry.linePath} pathLength={1} />
        </mask>
      </defs>
      <g mask="url(#ij-candle-arrow-mask)">
        <path className="ij-candle-arrow-line" d={geometry.linePath} />
      </g>
      <path className="ij-candle-arrow-head" d={geometry.headPath} pathLength={1} />
    </svg>
  );
}

function SearchBar() {
  const [query, setQuery] = useState("");
  const [cityIndex, setCityIndex] = useState(0);
  const [letterCount, setLetterCount] = useState(0);
  const ghostCity = searchGhostCities[cityIndex];

  useEffect(() => {
    if (query) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      if (letterCount !== ghostCity.length) setLetterCount(ghostCity.length);
      return;
    }

    const isComplete = letterCount >= ghostCity.length;
    const timer = window.setTimeout(
      () => {
        if (isComplete) {
          setCityIndex((current) => (current + 1) % searchGhostCities.length);
          setLetterCount(0);
          return;
        }

        setLetterCount((current) => current + 1);
      },
      isComplete ? 950 : 92,
    );

    return () => window.clearTimeout(timer);
  }, [cityIndex, ghostCity.length, letterCount, query]);

  return (
    <form className="ij-search ij-reveal ij-reveal-4" action="/sales">
      <span className="ij-search-arrow-start" data-arrow-start aria-hidden="true" />
      <span className={`ij-search-ghost${query ? " ij-search-ghost-hidden" : ""}`} aria-hidden>
        {ghostCity.slice(0, letterCount)}
        <span className="ij-search-ghost-caret" />
      </span>
      <label className="sr-only" htmlFor="home-search">
        Rechercher un bien, une ville ou un tribunal
      </label>
      <input
        id="home-search"
        name="q"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        autoComplete="off"
      />
      <button type="submit" aria-label="Rechercher">
        <Search aria-hidden className="h-6 w-6" />
      </button>
    </form>
  );
}

function JusticeGoddessVisual() {
  return (
    <div className="ij-goddess" aria-hidden="true">
      <div className="ij-cloud ij-cloud-a" />
      <div className="ij-cloud ij-cloud-b" />
      <img
        src="/media/landing/justice-goddess.png"
        alt=""
        width={1600}
        height={2400}
        decoding="async"
        fetchPriority="high"
      />
      <span className="ij-balance-glint" />
    </div>
  );
}

function CandleAnimation() {
  return (
    <div className="ij-candle" aria-hidden="true">
      <img
        src="/media/landing/judicial-candle.png"
        alt=""
        width={1188}
        height={1324}
        decoding="async"
      />
      <span className="ij-candle-glow" />
      <span className="ij-candle-flame-glow" />
      <span className="ij-candle-arrow-end" data-arrow-end aria-hidden="true" />
    </div>
  );
}

function AuctionCardsSection() {
  return (
    <section className="ij-auctions" aria-labelledby="auctions-title">
      <div className="ij-auctions-head">
        <h2 id="auctions-title">Découvrez les ventes en cours</h2>
        <Link to="/sales" className="ij-all-sales">
          Voir toutes les ventes <ArrowRight aria-hidden className="h-4 w-4" />
        </Link>
      </div>

      <div className="ij-card-grid">
        {auctionCards.map((card) => (
          <Link key={card.title} to="/sales" className="ij-auction-card">
            <span className="ij-card-image">
              <img src={card.image} alt="" width={896} height={512} loading="lazy" />
              <span>{card.badge}</span>
            </span>
            <span className="ij-card-body">
              <span className="ij-card-city">
                <MapPin aria-hidden className="h-4 w-4" />
                {card.city}
              </span>
              <strong>{card.title}</strong>
              <span className="ij-card-meta">
                <Landmark aria-hidden className="h-4 w-4" />
                {card.tribunal}
              </span>
              <span className="ij-card-price">
                <CalendarDays aria-hidden className="h-4 w-4" />
                {card.price}
              </span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function HomeProcessSection() {
  return (
    <section className="ij-process" aria-labelledby="process-title">
      <div className="ij-process-head">
        <div>
          <p className="ij-proof-kicker">Parcours acheteur</p>
          <h2 id="process-title">Comment ça marche</h2>
        </div>
        <p>
          Une lecture rapide des opportunités, avec juste assez de repères pour passer de la
          découverte à la décision.
        </p>
      </div>

      <div className="ij-process-body">
        <div className="ij-process-steps">
          <div className="ij-step-grid">
            {workflowSteps.map(({ icon: Icon, title, text }) => (
              <div key={title} className="ij-step">
                <span className="ij-step-icon">
                  <Icon aria-hidden className="h-4 w-4" />
                </span>
                <span>
                  <strong>{title}</strong>
                  <small>{text}</small>
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="ij-freshness">
          <CalendarDays aria-hidden className="h-5 w-5" />
          <span>
            <strong>Collecte planifiée toutes les 10 min</strong>
            <small>
              Le pipeline ImmoJudis surveille les ventes publiques et met à jour les dossiers dès
              qu'une collecte aboutit.
            </small>
          </span>
        </div>
      </div>
    </section>
  );
}

function HomeFooter() {
  return (
    <footer className="ij-footer" aria-label="Pied de page">
      <div className="ij-footer-inner">
        <Link to="/" className="ij-footer-brand" aria-label="ImmoJudis — accueil">
          <span className="ij-footer-mark" aria-hidden="true">
            <BrandMark variant="transparent" className="h-7 w-7" />
          </span>
          <span>
            <strong>
              Immo<span>Judis</span>
            </strong>
            <small>Ventes judiciaires immobilières</small>
          </span>
        </Link>

        <nav className="ij-footer-nav" aria-label="Navigation pied de page">
          <Link to="/sales">Ventes</Link>
          <Link to="/annonce-exemple">Annonce exemple</Link>
          <Link to="/ressources">Ressources</Link>
          <Link to="/contact">Contact</Link>
        </nav>

        <div className="ij-footer-legal">
          <span>© 2026 ImmoJudis</span>
          <Link to="/legal">Mentions légales</Link>
          <Link to="/privacy">Confidentialité</Link>
        </div>
      </div>
    </footer>
  );
}
