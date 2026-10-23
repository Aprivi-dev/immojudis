"use client";

import { useSearchParams } from "next/navigation";
import { ContactForm } from "@/components/ContactForm";
import { contactPrefill } from "@/lib/contact-message";

/**
 * Formulaire de contact prérempli d'après l'adresse (`?sujet=erreur&vente=<id>&rubrique=<rubrique>`),
 * pour « Signaler une erreur sur cette fiche ». Lu dans le navigateur : la page `/contact` reste
 * statique. Sans paramètre valide, c'est le formulaire habituel.
 */
export function ContactPrefilledForm() {
  const params = useSearchParams();
  return <ContactForm prefill={contactPrefill(params)} />;
}
