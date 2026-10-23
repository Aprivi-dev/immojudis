"use server";

import { headers } from "next/headers";
import { Resend } from "resend";
import { RateLimitError } from "@/lib/api-errors";
import { deliverContact, type ContactState } from "@/lib/contact-message";
import { publicLegalPublisher } from "@/lib/legal-documents";
import { enforceGlobalRateLimit, enforceIpRateLimit } from "@/lib/rate-limit";
import { CONTACT_RATE_LIMITS } from "@/lib/rate-limit-policies";

/**
 * Limiteur partagé du dépôt (tenu en base, donc valable d'une instance Vercel à l'autre) : par adresse,
 * puis pour tout le site. Une base indisponible lève : le message n'est pas envoyé et l'échec est
 * journalisé (voir `deliverContact`).
 */
function sharedLimiter(list: Headers) {
  return {
    async consume(): Promise<boolean> {
      try {
        // Seuls les en-têtes comptent pour l'adresse du visiteur.
        const request = new Request("https://immojudis.local/contact", { headers: list });
        await enforceIpRateLimit({ request, bucketKey: "contact", ...CONTACT_RATE_LIMITS.perIp });
        await enforceGlobalRateLimit({ bucketKey: "contact", ...CONTACT_RATE_LIMITS.global });
        return true;
      } catch (error) {
        if (error instanceof RateLimitError) return false;
        throw error;
      }
    },
  };
}

/**
 * Envoie le message du formulaire de contact à l'équipe via Resend.
 * Destinataire : CONTACT_EMAIL_TO, à défaut l'adresse de contact légale publiée.
 * Expéditeur : CONTACT_EMAIL_FROM, à défaut ALERT_EMAIL_FROM (domaine déjà vérifié chez Resend).
 */
export async function sendContactMessage(
  _previous: ContactState,
  formData: FormData,
): Promise<ContactState> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const to = process.env.CONTACT_EMAIL_TO?.trim() || publicLegalPublisher().contactEmail;
  const from = process.env.CONTACT_EMAIL_FROM?.trim() || process.env.ALERT_EMAIL_FROM?.trim();
  const resend = apiKey ? new Resend(apiKey) : null;

  return deliverContact(
    {
      name: formData.get("name"),
      email: formData.get("email"),
      subject: formData.get("subject"),
      message: formData.get("message"),
      website: formData.get("website"),
    },
    "contact",
    {
      limiter: sharedLimiter(await headers()),
      to,
      from,
      send: resend
        ? async (email) => {
            const { error } = await resend.emails.send({
              from: email.from,
              to: [email.to],
              replyTo: email.replyTo,
              subject: email.subject,
              text: email.text,
            });
            return { error };
          }
        : undefined,
    },
  );
}
