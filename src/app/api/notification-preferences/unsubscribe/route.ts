import { NextResponse } from "next/server";
import { errorDetailForLog } from "@/lib/api-errors";
import { EMAIL_BRAND_NAME, EMAIL_COLORS, EMAIL_FONT_STACK } from "@/lib/email-brand";
import {
  deactivateAlertForUser,
  revokeEmailAlertConsent,
  revokeLaunchOfferEndNotice,
  revokeOfferOpeningRequest,
  revokeSaleReminderConsent,
  revokeSaleResultsConsent,
  revokeWeeklyDigestConsent,
  unsubscribeEmailAlertsByNotificationId,
} from "@/lib/email-alerts";
import {
  unsubscribeTokenScopeKind,
  verifyUnsubscribeToken,
  type UnsubscribeScope,
} from "@/lib/email-unsubscribe-token";
import { escapeHtml } from "@/lib/guards";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** La question et le bouton de la page de confirmation, selon ce que le lien désactive. */
function confirmationCopy(kind: UnsubscribeScope["kind"]): { question: string; button: string } {
  switch (kind) {
    case "alert":
      return {
        question: "Voulez-vous désactiver cette alerte ?",
        button: "Désactiver cette alerte",
      };
    case "reminders":
      return {
        question:
          "Voulez-vous ne plus recevoir les rappels d'audience et les avertissements sur vos ventes suivies ?",
        button: "Me désinscrire des rappels",
      };
    case "weekly-digest":
      return {
        question: "Voulez-vous ne plus recevoir le récapitulatif hebdomadaire « Ma semaine » ?",
        button: "Me désinscrire du récapitulatif",
      };
    case "sale-results":
      return {
        question:
          "Voulez-vous ne plus recevoir les alertes de résultat ou de remise en vente de vos ventes suivies ?",
        button: "Me désinscrire des alertes de résultat",
      };
    case "offer-opening":
      return {
        question:
          "Voulez-vous retirer votre demande d'être prévenu de l'ouverture de l'offre Analyse ?",
        button: "Retirer ma demande",
      };
    case "launch-offer-end":
      return {
        question:
          "Voulez-vous ne plus recevoir de message sur la fin de l'essai gratuit ? Votre compte n'est pas modifié.",
        button: "Ne plus recevoir ce message",
      };
    default:
      return {
        question: "Voulez-vous ne plus recevoir d'alertes par email ?",
        button: "Me désinscrire des emails",
      };
  }
}

/**
 * A GET only shows a confirmation page: mail scanners and link previews open
 * links, and must never unsubscribe anyone. The change is made by the POST
 * behind the button, or by the one-click POST of mail clients (RFC 8058).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const legacyNotificationId = url.searchParams.get("notificationId");

  if (token) {
    const claims = verifyUnsubscribeToken(token);
    if (!claims) return expiredLinkResponse(token);
    const { question, button } = confirmationCopy(claims.scope.kind);
    return htmlResponse("Confirmer la désinscription", question, 200, null, {
      field: "token",
      value: token,
      button,
    });
  }

  if (legacyNotificationId && UUID_PATTERN.test(legacyNotificationId)) {
    return htmlResponse(
      "Confirmer la désinscription",
      "Voulez-vous ne plus recevoir d'alertes par email ?",
      200,
      null,
      { field: "notificationId", value: legacyNotificationId, button: "Me désinscrire des emails" },
    );
  }

  return htmlResponse("Lien incomplet", "Le lien de désinscription est incomplet.", 400);
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  let token = url.searchParams.get("token");
  let legacyNotificationId = url.searchParams.get("notificationId");

  // The mail client's one-click request carries "List-Unsubscribe=One-Click"
  // in a form body; the confirmation page posts the token as a form field.
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const body = new URLSearchParams(await request.text());
    token = token ?? body.get("token");
    legacyNotificationId = legacyNotificationId ?? body.get("notificationId");
  }

  try {
    if (token) {
      const claims = verifyUnsubscribeToken(token);
      if (!claims) return expiredLinkResponse(token);
      if (claims.scope.kind === "alert") {
        await deactivateAlertForUser({ userId: claims.userId, alertId: claims.scope.alertId });
        return htmlResponse(
          "Alerte désactivée",
          "Cette alerte est désactivée. Vos autres alertes continuent de fonctionner.",
          200,
          { href: "/alertes", label: "Gérer mes alertes" },
        );
      }
      if (claims.scope.kind === "reminders") {
        await revokeSaleReminderConsent({ userId: claims.userId });
        return htmlResponse(
          "Rappels désactivés",
          "Vous ne recevrez plus de rappels d'audience ni d'avertissements par email. Vos alertes email ne sont pas modifiées.",
          200,
          { href: "/compte", label: "Gérer mes notifications" },
        );
      }
      if (claims.scope.kind === "weekly-digest") {
        await revokeWeeklyDigestConsent({ userId: claims.userId });
        return htmlResponse(
          "Récapitulatif désactivé",
          "Vous ne recevrez plus le récapitulatif hebdomadaire « Ma semaine ». Vos alertes email et vos autres emails ne sont pas modifiés.",
          200,
          { href: "/compte", label: "Gérer mes notifications" },
        );
      }
      if (claims.scope.kind === "sale-results") {
        await revokeSaleResultsConsent({ userId: claims.userId });
        return htmlResponse(
          "Alertes de résultat désactivées",
          "Vous ne recevrez plus d'alerte de résultat ni de remise en vente sur vos ventes suivies. Vos alertes email et vos autres emails ne sont pas modifiés.",
          200,
          { href: "/compte", label: "Gérer mes notifications" },
        );
      }
      if (claims.scope.kind === "offer-opening") {
        await revokeOfferOpeningRequest({ userId: claims.userId });
        return htmlResponse(
          "Demande retirée",
          "Vous ne serez plus prévenu de l'ouverture de l'offre Analyse. Vos alertes email ne sont pas modifiées.",
          200,
          { href: "/offres", label: "Voir les offres" },
        );
      }
      if (claims.scope.kind === "launch-offer-end") {
        await revokeLaunchOfferEndNotice({ userId: claims.userId });
        return htmlResponse(
          "Préavis désactivé",
          "Vous ne recevrez plus ce message. Votre compte et vos alertes email ne sont pas modifiés.",
          200,
          { href: "/compte", label: "Voir mon compte" },
        );
      }
      await revokeEmailAlertConsent({ userId: claims.userId });
    } else if (legacyNotificationId && UUID_PATTERN.test(legacyNotificationId)) {
      await unsubscribeEmailAlertsByNotificationId({ notificationId: legacyNotificationId });
    } else {
      return htmlResponse("Lien incomplet", "Le lien de désinscription est incomplet.", 400);
    }
    return htmlResponse(
      "Désinscription confirmée",
      "Vous ne recevrez plus d'alertes email Immojudis. Les notifications dans l'application restent disponibles.",
      200,
      { href: "/alertes", label: "Gérer mes alertes" },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        scope: "notification-preferences.unsubscribe",
        error: errorDetailForLog(error),
      }),
    );
    return htmlResponse(
      "Désinscription impossible",
      "La désinscription n'a pas pu être confirmée. Réessayez ou gérez vos emails depuis votre compte.",
      500,
      { href: "/alertes", label: "Gérer mes alertes" },
    );
  }
}

/**
 * Lien invalide ou expiré. Un jeton « rappels » (signature valide, même expiré) renvoie vers le
 * compte, où se règlent les rappels d'audience ; les autres vers la page des alertes.
 */
function expiredLinkResponse(token: string) {
  const kind = unsubscribeTokenScopeKind(token);
  if (kind === "reminders") {
    return htmlResponse(
      "Lien expiré",
      "Ce lien de désinscription n'est plus valide. Ouvrez votre compte pour gérer vos rappels d'audience.",
      400,
      { href: "/compte", label: "Gérer mes notifications" },
    );
  }
  if (kind === "weekly-digest" || kind === "sale-results" || kind === "launch-offer-end") {
    return htmlResponse(
      "Lien expiré",
      "Ce lien de désinscription n'est plus valide. Ouvrez votre compte pour gérer vos notifications.",
      400,
      { href: "/compte", label: "Gérer mes notifications" },
    );
  }
  return htmlResponse(
    "Lien expiré",
    "Ce lien de désinscription n'est plus valide. Ouvrez la page Mes alertes pour gérer vos emails.",
    400,
    { href: "/alertes", label: "Gérer mes alertes" },
  );
}

function htmlResponse(
  title: string,
  message: string,
  status: number,
  link: { href: string; label: string } | null = null,
  form: { field: "token" | "notificationId"; value: string; button: string } | null = null,
) {
  return new NextResponse(
    `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(title)} - Immojudis</title>
  </head>
  <body style="margin:0;background:${EMAIL_COLORS.surface};color:${EMAIL_COLORS.navy};font-family:${EMAIL_FONT_STACK};">
    <main style="min-height:100vh;display:grid;place-items:center;padding:24px;">
      <section style="max-width:520px;background:${EMAIL_COLORS.white};border:1px solid ${EMAIL_COLORS.lineWarm};border-radius:10px;padding:28px;">
        <p style="margin:0 0 10px;color:${EMAIL_COLORS.goldText};font-size:16px;font-weight:800;">${EMAIL_BRAND_NAME}</p>
        <h1 style="margin:0 0 10px;font-size:24px;line-height:1.25;">${escapeHtml(title)}</h1>
        <p style="margin:0 0 18px;color:${EMAIL_COLORS.inkSoft};line-height:1.55;">${escapeHtml(message)}</p>
        ${
          form
            ? `<form method="post" action="/api/notification-preferences/unsubscribe">
          <input type="hidden" name="${form.field}" value="${escapeHtml(form.value)}" />
          <button type="submit" style="background:${EMAIL_COLORS.navy};color:${EMAIL_COLORS.white};border:0;border-radius:8px;padding:12px 16px;font-weight:700;font-size:15px;cursor:pointer;">${escapeHtml(form.button)}</button>
        </form>`
            : ""
        }
        ${link ? `<p style="margin:0;"><a href="${escapeHtml(link.href)}" style="color:${EMAIL_COLORS.navy};font-weight:700;">${escapeHtml(link.label)}</a></p>` : ""}
      </section>
    </main>
  </body>
</html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}
