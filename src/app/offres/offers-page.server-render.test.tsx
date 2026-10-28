import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Rendu serveur de /offres (renderToString, sans effets ni navigateur) avec le VRAI fournisseur de
// l'état de l'essai : ce que lit un robot ou une connexion lente, avant tout JavaScript.
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: null, loading: false }) }));
vi.mock("@/lib/client-billing", () => ({
  fetchBillingOffer: vi.fn(),
  fetchLaunchOffer: vi.fn(),
}));
vi.mock("@/components/BillingActions", () => ({ BillingActions: () => <button>Actions</button> }));

import { LaunchOfferProvider } from "@/components/LaunchOfferProvider";
import { OffersPage } from "./offers-page";

/** Texte hors balises, entités courantes décodées. */
function visibleText(markup: string): string {
  let text = "";
  let inTag = false;
  for (const char of markup) {
    if (char === "<") inTag = true;
    else if (char === ">") inTag = false;
    else if (!inTag) text += char;
  }
  return text
    .replaceAll("&#x27;", "’")
    .replaceAll("&#39;", "’")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");
}

function render({
  trialOpen,
  subscriptionOpen,
}: {
  trialOpen?: boolean;
  subscriptionOpen?: boolean;
}) {
  const markup = renderToString(
    <LaunchOfferProvider initialActive={trialOpen}>
      <OffersPage initialSubscriptionOpen={subscriptionOpen} />
    </LaunchOfferProvider>,
  );
  return { markup, text: visibleText(markup) };
}

describe("/offres : rendu serveur", () => {
  it("essai ouvert : la FAQ répond oui et le bandeau de l'essai est dans le HTML", () => {
    const { markup, text } = render({ trialOpen: true, subscriptionOpen: false });
    expect(text).toContain("Oui. Une fois votre adresse email confirmée");
    expect(text).not.toContain("Pas pour le moment");
    expect(markup).toContain('data-testid="launch-offer-banner"');
    expect(markup).not.toContain("launch-offer-banner-placeholder");
  });

  it("essai fermé, lu : la FAQ dit qu'il n'y en a pas pour le moment, sans bandeau", () => {
    const { markup, text } = render({ trialOpen: false, subscriptionOpen: false });
    expect(text).toContain("Pas pour le moment");
    expect(markup).not.toContain("launch-offer-banner");
  });

  it("état de l'essai non lu : jamais « Pas pour le moment », une réponse vraie dans les deux états", () => {
    const { markup, text } = render({ trialOpen: undefined, subscriptionOpen: false });
    expect(text).not.toContain("Pas pour le moment");
    expect(text).toContain(
      "Un essai gratuit de 7 jours, sans carte bancaire, est proposé à l’inscription tant que l’essai est ouvert",
    );
    // L'emplacement réservé remplace le bandeau, sans rien annoncer.
    expect(markup).toContain("launch-offer-banner-placeholder");
    expect(markup).not.toContain('data-testid="launch-offer-banner"');
  });

  it("souscription fermée : « tarif prévu, pas encore souscriptible » est dans le HTML serveur", () => {
    const { markup, text } = render({ trialOpen: true, subscriptionOpen: false });
    expect(markup).toContain('data-testid="price-note"');
    expect(text).toContain("Tarif prévu, pas encore souscriptible");
    expect(text).toContain("Analyse : tarif prévu 59 € TTC / mois, pas encore souscriptible.");
    expect(text).toContain(
      "Quand l’abonnement sera ouvert, les règles prévues sont les suivantes.",
    );
    expect(text).not.toContain("Analyse coûte");
    expect(text).not.toContain(
      "Les conditions de souscription s’affichent une fois l’offre chargée",
    );
  });

  it("souscription ouverte : le prix est dit sans la mention de tarif prévu", () => {
    const { markup, text } = render({ trialOpen: true, subscriptionOpen: true });
    expect(text).toContain("Analyse coûte 59 € TTC / mois, résiliable à tout moment.");
    expect(markup).not.toContain('data-testid="price-note"');
    expect(text).not.toContain("pas encore souscriptible");
  });

  it("souscription non connue du serveur : ne dit ni « coûte » ni « pas encore souscriptible »", () => {
    const { text } = render({ trialOpen: true, subscriptionOpen: undefined });
    expect(text).toContain("Les conditions de souscription s’affichent une fois l’offre chargée.");
    expect(text).not.toContain("Analyse coûte");
    expect(text).not.toContain("pas encore souscriptible");
  });
});
