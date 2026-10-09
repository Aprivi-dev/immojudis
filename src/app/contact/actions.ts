"use server";

import { headers } from "next/headers";
import { Resend } from "resend";
import { createContactLimiter, deliverContact, type ContactState } from "@/lib/contact-message";
import { publicLegalPublisher } from "@/lib/legal-documents";

const limiter = createContactLimiter();

function clientKey(list: Headers): string {
  const forwarded = list.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || list.get("x-real-ip") || "inconnu";
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
    clientKey(await headers()),
    {
      limiter,
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
