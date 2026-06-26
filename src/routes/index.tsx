import { createFileRoute, Link } from "@tanstack/react-router";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import Bell from "lucide-react/dist/esm/icons/bell.js";
import CalendarDays from "lucide-react/dist/esm/icons/calendar-days.js";
import Landmark from "lucide-react/dist/esm/icons/landmark.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import UserRound from "lucide-react/dist/esm/icons/user-round.js";
import type { ComponentType } from "react";

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

const benefits = [
  { icon: Scale, title: "100% des ventes", text: "en France" },
  { icon: Bell, title: "Alertes personnalisées", text: "par email" },
  { icon: UserRound, title: "Accompagnement", text: "expert" },
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

function HomePage() {
  return (
    <main className="ij-page">
      <HeroSection />
      <AuctionCardsSection />
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
          <svg className="ij-candle-arrow" viewBox="0 0 230 128" aria-hidden="true">
            <path className="ij-candle-arrow-line" d="M8 116C42 42 128 8 205 58" />
            <path className="ij-candle-arrow-head" d="M192 40L207 59L184 62" />
          </svg>
          <CandleAnimation />
          <article className="ij-candle-note">
            <h2>Vente à la bougie</h2>
            <p>
              Symbole des ventes judiciaires en France : la lumière de la transparence et de
              l'équité.
            </p>
            <Link to="/ventes-immobilieres-judiciaires">
              Découvrir son histoire <ArrowRight aria-hidden className="h-4 w-4" />
            </Link>
          </article>
        </div>
      </div>
    </section>
  );
}

function SearchBar() {
  return (
    <form className="ij-search ij-reveal ij-reveal-4" action="/sales">
      <label className="sr-only" htmlFor="home-search">
        Rechercher un bien, une ville ou un tribunal
      </label>
      <input
        id="home-search"
        name="q"
        type="search"
        placeholder="Rechercher un bien, une ville, un tribunal..."
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
