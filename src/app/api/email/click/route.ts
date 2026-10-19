import { NextResponse } from "next/server";
import { recordAccountProductEvent } from "@/lib/account-product-events.server";
import { emailClickPath, readEmailClickToken } from "@/lib/email-click-token";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";

/** Où mène un jeton absent, faux ou mal formé : l'accueil, jamais une adresse venue de la requête. */
const FALLBACK_PATH = "/";

/**
 * Redirection de suivi des liens des emails d'alertes et de rappels (point 65). Un clic est mesuré
 * pour le compte nommé par le jeton signé, puis la personne est envoyée vers la vente (ou le fichier
 * .ics) que le jeton désigne. La destination est un chemin du site construit côté serveur à partir de
 * valeurs fermées (`emailClickPath`) : elle n'est jamais lue dans la requête, il n'y a donc pas de
 * redirection ouverte.
 *
 * La personne arrive toujours à destination : jeton périmé, limite de débit ou base indisponible
 * n'empêchent pas la redirection, seulement la mesure. Un jeton faux mène à l'accueil.
 *
 * Les antivirus et prévisualisations de messagerie qui ouvrent le lien comptent comme un clic (ils
 * font un GET) ; les requêtes HEAD sont redirigées sans être mesurées. La page « Pilotage » le dit.
 */
function redirectTo(path: string) {
  return new NextResponse(null, {
    status: 302,
    headers: {
      location: path,
      "cache-control": "private, no-store",
      // La destination ne reçoit pas l'adresse de ce lien (le jeton y figure).
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token");
  const read = readEmailClickToken(token);
  if (!read) return redirectTo(FALLBACK_PATH);

  const { claims, expired } = read;
  if (!expired) {
    try {
      await enforceIpRateLimit({
        request,
        bucketKey: "email.click",
        ...RATE_LIMIT_POLICIES.publicIp,
      });
      await recordAccountProductEvent(claims.userId, {
        type: "email_clicked",
        email: claims.kind,
        saleId: claims.saleId,
      });
    } catch {
      // Limite atteinte ou base indisponible : la redirection reste la même.
    }
  }
  return redirectTo(emailClickPath(claims));
}

/** Les robots qui sondent un lien par HEAD arrivent au même endroit, sans être comptés. */
export async function HEAD(request: Request) {
  const read = readEmailClickToken(new URL(request.url).searchParams.get("token"));
  return redirectTo(read ? emailClickPath(read.claims) : FALLBACK_PATH);
}
