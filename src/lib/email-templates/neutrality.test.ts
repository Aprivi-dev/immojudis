import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Les constructeurs sont appelés pour de vrai ; la base et le réseau ne doivent jamais l'être.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: vi.fn(), rpc: vi.fn(), auth: { admin: {} } },
}));

import { EMAIL_TEMPLATES } from "./registry";

/**
 * Neutralité de la migration des émetteurs vers `sendTrackedEmail` (module Emails, lot 3, 01/11/2026) : aucun
 * texte d'email ne change, le rendu reste identique octet pour octet. Les empreintes SHA-256 de l'objet, du HTML
 * et du texte de chaque variante d'aperçu ont été mesurées sur `origin/main` AVANT la migration, avec le code du
 * registre inchangé. Si un texte change volontairement (par exemple au lot 5), mettre ces empreintes à jour
 * dans le commit qui le change, avec sa justification : ce test n'est pas un instantané à régénérer sans
 * lire la différence.
 *
 * Mise à jour explicite du 02/11/2026 (emails « ne pas répondre ») : les empreintes de alert, sale_reminder,
 * weekly_digest, sale_result, trial_end, offer_opening et trial_ending ont changé, et SEULEMENT celles-là.
 * Comparées à `origin/main`, ces sept rendus ne diffèrent que par l'ajout de la phrase du pied (« Message
 * automatique, merci de ne pas y répondre. Pour nous écrire : contact@immojudis.com », HTML et texte) et
 * l'espace de 8 px sous le paragraphe qui la précède ; trial_ending reçoit en plus la cellule de pied qui
 * la porte. Les empreintes des huit autres gabarits (paiement échoué, résiliation, mise en relation, incident,
 * relecture des réponses, agent d'information) sont celles d'avant.
 *
 * Mise à jour explicite du 02/11/2026 (agent d'information, lot 1, ajout autorisé par le propriétaire) : les
 * empreintes de agent_request et agent_court_registry ont changé, et SEULEMENT celles-là. Les deux rendus ne
 * diffèrent de ceux d'avant que par UNE ligne sous la signature : le lien « Ne plus être contacté » (même
 * libellé et même adresse que celui du pied), en HTML (paragraphe discret) et en texte (« Ne plus être
 * contacté : <lien> »). Aucun autre texte ne change (vérifié par emails/information-request.test.tsx, qui garde
 * les textes juridiques mot pour mot).
 *
 * Mise à jour explicite du 06/11/2026 (revue marketing, n° 11, validée par le propriétaire) : l'empreinte de
 * trial_end a changé, et SEULEMENT celle-là. Seule la liste « Ce qui se ferme » diffère
 * (`LAUNCH_OFFER_END_NEEDS_ANALYSIS`, `launch-offer-end-lists.ts`) : le plafond et les alertes en tête, le PDF
 * cité une seule fois, formulations relues par juridique-rgpd. Avec l’ancienne liste, le rendu redonne
 * l’empreinte d’avant (vérifié).
 *
 * Mise à jour explicite du 14/11/2026 (lot C, validé par le propriétaire : C12, C13, C14, J10, J15) : les
 * empreintes de agent_request et agent_court_registry ont changé, et SEULEMENT celles-là. Les deux rendus
 * perdent l'encadré doré et le bouton « Déposer des pièces » au profit d'une ligne de texte (« Vous pouvez
 * aussi répondre dans l’espace privé de ce dossier… Rien n’est publié sans relecture par notre équipe. ») ;
 * agent_request reçoit en plus les nouveaux textes du modèle (introduction avant les questions, consignes sans
 * « documents ou photos » ni procès-verbal descriptif, « Merci par avance. », question des modalités sans
 * rappel de procédure) et la section « Affichage sur la fiche : » du pied de l'avocat poursuivant. Textes
 * gardés mot pour mot par emails/information-request.test.tsx.
 *
 * Mise à jour explicite du même jour (relecture juridique-rgpd du lot C, textes repris mot pour mot, transmise
 * par le chef d'orchestre) : les empreintes de agent_request et agent_court_registry ont changé, et SEULEMENT
 * celles-là. Les deux rendus changent les deux lignes sous la signature (« notre équipe relit chaque réponse
 * avant toute mise à jour de la fiche », « Inutile de nous transmettre des pièces : nous indiquer où les
 * consulter suffit. ») ; agent_request reçoit en plus le second paragraphe des consignes (« informations déjà
 * destinées à tout candidat acquéreur… Inutile de joindre des pièces. ») et le nouveau texte de la section
 * « Affichage sur la fiche : » ; agent_court_registry reçoit la nouvelle question au greffe et la section
 * « Affichage sur la fiche : » de la variante greffe. Textes gardés mot pour mot par
 * emails/information-request.test.tsx.
 *
 * Mise à jour explicite du même jour (ronde 3 de juridique-rgpd, textes repris mot pour mot, transmise par le chef
 * d'orchestre) : l'empreinte de agent_court_registry a changé, et SEULEMENT celle-là. Seuls l'objet (« … : avocat
 * poursuivant et consultation du cahier ») et la phrase « Affichage sur la fiche » du greffe (« … ou à indiquer aux
 * candidats où consulter le cahier. ») diffèrent.
 *
 * Mise à jour explicite du 15/11/2026 (offre gratuite : une seule vente débloquée, validée par
 * le propriétaire) : l'empreinte de trial_end a changé, et SEULEMENT celle-là. Seules deux lignes
 * des listes de `launch-offer-end-lists.ts` diffèrent : « une vente à débloquer » au lieu de
 * « 3 déblocages par mois », et « le plafond chiffré sur toutes les ventes (compte gratuit : une
 * vente débloquée) » au lieu de « … sans limite mensuelle (compte gratuit : 3 ventes par mois) ».
 * Gabarit dormant tant que l'essai est fermé.
 *
 * Mise à jour explicite du 15/11/2026 (le déblocage ouvre toute l'analyse de la vente, validé par
 * le propriétaire) : l'empreinte de trial_end a changé, et SEULEMENT celle-là. Seules deux lignes
 * de `LAUNCH_OFFER_END_NEEDS_ANALYSIS` diffèrent : l'estimation détaillée et les ventes comparables
 * reçoivent « sur toutes les ventes (compte gratuit : une vente débloquée) », et le rapport PDF
 * « (compte gratuit : le rapport de la vente débloquée) ». Gabarit toujours dormant.
 *
 * Mise à jour explicite du 22/11/2026 (Claude Haiku 5.5 pour tous les appels d'IA, décision du propriétaire) : les
 * empreintes de agent_request et agent_court_registry ont changé, et SEULEMENT celles-là. L'aperçu de la galerie
 * nomme désormais le prestataire d'IA configuré (`informationAgentAiProvider`, `LLM_PROVIDER`, Anthropic par
 * défaut) au lieu de « Replicate (États-Unis) » écrit en dur : seule la parenthèse « Anthropic (Anthropic Ireland,
 * Limited, Irlande ; données stockées aux États-Unis) » du pied diffère (libellé de la politique 2026-11-22.1). Avec LLM_PROVIDER=replicate, le rendu redonne les empreintes d'avant
 * (vérifié). Le test fixe LLM_PROVIDER à vide pour ne pas dépendre de l'environnement.
 *
 * Mise à jour explicite du 24/11/2026 (refonte de la marque, demandée par le propriétaire : palette pierre et
 * bordeaux, nouveau logo) : les quatorze empreintes ont changé. Aucun texte ne change : seuls diffèrent les
 * codes couleur de `EMAIL_COLORS` (copies des jetons de `src/styles.css`) et l'adresse du logo (fichiers
 * `immojudis-logo-email-v2.png` et `-dark-v2.png`). Vérifié gabarit par gabarit : en remettant les anciens
 * codes couleur et l'ancien nom de fichier dans le HTML rendu, chaque rendu redonne l'empreinte d'avant.
 *
 * Mise à jour explicite du 25/11/2026 (passage en Réel du pilote, point 5, validé par le propriétaire) :
 * l'empreinte de agent_request a de nouveau changé (après la refonte du 24/11), et SEULEMENT celle-là. Seul l'objet diffère : « Immojudis – question
 * sur la vente … », sans « audience » ni date. Avec l'ancien objet, le rendu redonne l'empreinte de la refonte (ae664543…)
 * (vérifié). agent_court_registry n'est pas concerné.
 */
const BASELINE: Record<string, string> = {
  alert: "e5edf96964d49e74667515e78a52b1853863b288b42023e733b41bc5090c1b0f",
  sale_reminder: "31b3ff3fbdcd57b166e9a8db80843e7f34e98a54f7cfc8aa5891d7581935f2b6",
  weekly_digest: "730825c8af442b9fd51d93fd6bbd0800289ba21a917f4f679baf9d7fd63a3eaa",
  sale_result: "25d1c25ad625792e26567276b9fa9ff004aae736edf6061cc401d69bc2679a56",
  trial_end: "f2e540570c97bdfb8abf403c5eaf5eaa583a12c0f99be36ffc4f092556387eab",
  offer_opening: "cd130735e7b8cc848a6788046f77d40f8a2e9893da17bd6be2654291cf935bee",
  payment_failed: "7f9dd590191bf1347f4370fb659008857810cdad6629d628ba54e3daef6e5e53",
  trial_ending: "29a7398e1ee2ff6e92918ed84a727d676148dc75065a5460797a7ba93046fcd3",
  cancellation: "608cf3a4489cb9fa036b4c416a50559a6d321e5ecdec65ba6846d445dd63136c",
  lawyer_referral: "13e2a2e884e8138a6afb70af09f463d85401002d5e4028961adbff98c21a6e89",
  operations_incident: "1e060cf4fa5ff9c44ea4d501b95f3962eea981cd5aadb410f39d6e446f3dd5cc",
  replies_review_digest: "f7297b7ee825ceccae19102bbff8a98ffd01ae4c55e07ae4a1f8b0eb268a0852",
  agent_request: "ab04a4ffa91349ba24009ed3b05bd2051244c7ee476c7594a5a1c37e04370fc9",
  agent_court_registry: "d404b8cd9c0b7c7cc77d94b02110b1d2d47ef9b77d9f68a207d64414af648c24",
};

async function fingerprints(key: string): Promise<string[]> {
  const definition = EMAIL_TEMPLATES.find((template) => template.key === key);
  const variants = (await definition?.sample?.()) ?? [];
  return variants.map((variant) =>
    createHash("sha256")
      .update(JSON.stringify([variant.key, variant.subject, variant.html, variant.text]))
      .digest("hex"),
  );
}

describe("neutralité du rendu des emails", () => {
  beforeEach(() => {
    vi.stubEnv("LLM_PROVIDER", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(Object.keys(BASELINE))("le gabarit %s rend les mêmes octets qu'avant", async (key) => {
    const actual = await fingerprints(key);
    expect(actual.length).toBeGreaterThan(0);
    expect(createHash("sha256").update(actual.join("|")).digest("hex")).toBe(BASELINE[key]);
  });
});
