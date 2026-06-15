import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";

import appCss from "../styles.css?url";
import { Navbar } from "@/components/Navbar";
import { AuthGate } from "@/components/AuthGate";
import { BrandMark } from "@/components/BrandLogo";
import { Toaster } from "sonner";

function NotFoundComponent() {
  return (
    <div className="liquid-page flex min-h-screen items-center justify-center px-4 py-10">
      <div className="glass-shell max-w-xl overflow-hidden rounded-lg p-6 text-center sm:p-8">
        <BrandMark className="mx-auto h-16 w-16 drop-shadow-[0_18px_34px_rgba(0,0,0,0.35)]" />
        <h1 className="mt-5 font-display text-6xl leading-none text-gold-soft">404</h1>
        <h2 className="mt-4 font-display text-2xl text-foreground">Page introuvable</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          La page demandée n'existe pas ou a été déplacée.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="liquid-button inline-flex items-center justify-center rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.18em] text-background transition hover:brightness-105"
          >
            Retour à l'accueil
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="liquid-page flex min-h-screen items-center justify-center px-4 py-10">
      <div className="glass-shell max-w-xl rounded-lg p-6 text-center sm:p-8">
        <BrandMark className="mx-auto h-14 w-14" />
        <h1 className="mt-5 font-display text-2xl tracking-tight text-foreground">
          Cette page n'a pas chargé
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Une erreur est survenue. Vous pouvez réessayer ou revenir à l'accueil.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="liquid-button inline-flex items-center justify-center rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.16em] text-background transition hover:brightness-105"
          >
            Réessayer
          </button>
          <a
            href="/"
            className="liquid-panel-soft inline-flex items-center justify-center rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.16em] text-gold transition hover:border-gold"
          >
            Retour à l'accueil
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Immojudis — Ventes immobilières judiciaires" },
      {
        name: "description",
        content:
          "Explorez les ventes aux enchères immobilières judiciaires avec annonces analysées, carte, alertes et mise plafond.",
      },
      { name: "author", content: "Immojudis" },
      { property: "og:title", content: "Immojudis — Ventes immobilières judiciaires" },
      {
        property: "og:description",
        content:
          "Carte, annonces analysées, alertes et mise plafond pour les enchères immobilières judiciaires.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "icon", type: "image/png", href: "/brand/immojudis-mark-transparent.png" },
      { rel: "apple-touch-icon", href: "/brand/immojudis-mark-transparent.png" },
      { rel: "preload", as: "image", href: "/brand/immojudis-mark-transparent.png" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600&family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=Sora:wght@600;700;800&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen bg-background">
        <Navbar />
        <AuthGate>
          <Outlet />
        </AuthGate>
        <Toaster position="top-right" richColors />
      </div>
    </QueryClientProvider>
  );
}
