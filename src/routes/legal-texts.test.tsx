// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ANALYSIS_OFFER_LABEL, ANALYSIS_TRIAL_DAYS } from "@/lib/analysis-offer";
import { LEGAL_DOCUMENTS } from "@/lib/legal-documents";
import { PAST_DUE_GRACE_DAYS } from "@/lib/plans";
import { TermsPage } from "./conditions-generales";
import { PrivacyPage } from "./privacy";

function pageText(node: React.ReactElement): string {
  const { container } = render(node);
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_LEGAL_CONTACT_EMAIL", "contact@immojudis.example");
  vi.stubEnv("NEXT_PUBLIC_ANALYSIS_OFFER_LABEL", "");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("conditions générales", () => {
  it("annoncent leur version et un abonnement mensuel sans engagement de durée", () => {
    const text = pageText(<TermsPage />);
    expect(text).toContain(`Version ${LEGAL_DOCUMENTS.terms.version}`);
    expect(text).toContain("mensuel, sans engagement de durée, et reconduit chaque mois");
    expect(text).toContain("jusqu’à résiliation");
  });

  it("affichent le prix configurable et l'essai gratuit s'il est proposé", () => {
    expect(pageText(<TermsPage />)).toContain(
      `Prix de l’abonnement Analyse : ${DEFAULT_ANALYSIS_OFFER_LABEL}, précédé d’un essai gratuit de ${ANALYSIS_TRIAL_DAYS} jours lorsque celui-ci est proposé`,
    );
    cleanup();
    vi.stubEnv("NEXT_PUBLIC_ANALYSIS_OFFER_LABEL", "39 € TTC / mois");
    expect(pageText(<TermsPage />)).toContain("Prix de l’abonnement Analyse : 39 € TTC / mois");
  });

  it("décrivent un seul chemin de résiliation, aligné sur le bouton réel du compte", () => {
    const text = pageText(<TermsPage />);
    expect(text).toContain(
      "Vous pouvez résilier à tout moment, gratuitement, depuis la page Mon compte, bouton « Gérer mon abonnement Analyse »",
    );
    expect(text).toContain("Le portail indique la date de fin d’accès et confirme la résiliation");
    expect(text).not.toContain("page Offres");
  });

  it("énoncent le délai de grâce réel en cas d'impayé", () => {
    expect(PAST_DUE_GRACE_DAYS).toBe(7);
    expect(pageText(<TermsPage />)).toContain(
      `En cas d’échec de paiement, l’accès Analyse reste ouvert pendant ${PAST_DUE_GRACE_DAYS} jours à compter de la fin de la période payée, le temps de mettre à jour votre moyen de paiement ; il est ensuite suspendu.`,
    );
  });

  it("rappellent la garantie légale de conformité", () => {
    expect(pageText(<TermsPage />)).toContain(
      "Vous bénéficiez de la garantie légale de conformité des contenus et services numériques (articles L. 224-25-12 et suivants du code de la consommation).",
    );
  });

  it("emploient « Analyse » et « enchère plafond »", () => {
    const text = pageText(<TermsPage />);
    expect(text).not.toMatch(/Premium|mise plafond/i);
    expect(text).toContain("enchère plafond");
  });
});

describe("politique de confidentialité", () => {
  it("annonce sa version et écrit Immojudis", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain(`Version ${LEGAL_DOCUMENTS.privacy.version}`);
    expect(text).not.toContain("ImmoJudis");
    expect(text).not.toMatch(/Premium/);
  });

  it("décrit le traitement des annonces publiques et la cartographie", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain("Annonces de ventes et pièces publiques");
    expect(text).toContain("noms remplacés par leur rôle");
    expect(text).toContain("Intérêt légitime à informer le public");
    expect(text).toContain("opposition et demande de retrait par email, sans compte");
    expect(text).toContain("Cartographie et géocodage (Mapbox)");
  });

  it("permet à une personne citée de demander retrait ou rectification sans compte", () => {
    expect(pageText(<PrivacyPage />)).toContain(
      "Si vous êtes cité dans une annonce, vous pouvez demander la rectification ou le retrait à contact@immojudis.example, sans créer de compte.",
    );
  });

  it("liste Mapbox, le prestataire d'IA et le rapport d'erreurs parmi les destinataires", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain("Mapbox (cartes, vignettes et géocodage)");
    expect(text).toContain("le prestataire d’IA utilisé pour lire les annonces et les pièces");
    expect(text).toContain("Replicate");
    expect(text).toContain("le service de rapport d’erreurs lorsqu’il est configuré");
  });

  it("décrit la mesure d'audience, son opposition et une conservation de 25 mois au plus", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain(
      "Nous mesurons la fréquentation avec Vercel Analytics et Speed Insights, sans cookie et sans suivi entre sites, et des événements de parcours anonymes.",
    );
    expect(text).toContain("Les données ne servent qu’à des statistiques de notre service.");
    expect(text).toContain(
      "Vous pouvez vous y opposer en nous écrivant à contact@immojudis.example.",
    );
    const months = [...text.matchAll(/(\d+) mois au plus/g)].map((match) => Number(match[1]));
    expect(months.length).toBeGreaterThan(0);
    for (const value of months) expect(value).toBeLessThanOrEqual(25);
  });

  it("aligne la base légale de l'enquête dossier sur le registre et ne parle plus de prospection", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain(
      "Intérêt légitime à fiabiliser le catalogue pour les contacts professionnels",
    );
    expect(text).toContain("consentement pour la communication de l’email de réponse");
    expect(text).not.toContain("service professionnel");
    expect(text).toContain("aucune sollicitation commerciale");
  });
});
