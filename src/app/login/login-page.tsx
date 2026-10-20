"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import BriefcaseBusiness from "lucide-react/dist/esm/icons/briefcase-business.js";
import Building2 from "lucide-react/dist/esm/icons/building-2.js";
import Eye from "lucide-react/dist/esm/icons/eye.js";
import EyeOff from "lucide-react/dist/esm/icons/eye-off.js";
import FileSearch from "lucide-react/dist/esm/icons/file-search.js";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import Mail from "lucide-react/dist/esm/icons/mail.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import UserRound from "lucide-react/dist/esm/icons/user-round.js";
import { toast } from "@/lib/toast";
import { useAuth } from "@/hooks/use-auth";
import { useLaunchOffer } from "@/hooks/use-launch-offer";
import { isSupabaseConfigured, supabase } from "@/integrations/supabase/client";
import {
  getAccountType,
  isAdminAccount,
  PROFESSIONAL_ROLE_OPTIONS,
  type AccountType,
  type ProfessionalRole,
} from "@/lib/account";
import {
  loginPageMode,
  loginReason,
  searchParamsToRecord,
  type LoginPageMode,
  type LoginReason,
} from "@/lib/navigation";
import { LEGAL_DOCUMENTS } from "@/lib/legal-documents";
import { resolveAnalysisOfferLabel } from "@/lib/analysis-offer";
import { LAUNCH_OFFER_VISITOR_TEXT } from "@/lib/launch-offer";
import { postAuthDestination } from "@/lib/onboarding";
import { PLAN_LIMITS } from "@/lib/plans";
import { MONTHLY_SALE_UNLOCKS, UNLOCK_HIGHLIGHTS_INLINE_TEXT } from "@/lib/sale-unlocks";
import { trackProductEvent } from "@/lib/product-events";
import { ACCOUNT_EXISTS_MESSAGE, userMessage } from "@/lib/user-messages";

type LoginSearch = {
  redirect?: string;
  mode?: Exclude<LoginPageMode, "login">;
  reason?: LoginReason;
};

/** Keeps only a same-site `redirect` and a known `mode` from the query string. */
function parseLoginSearch(search: Record<string, unknown>): LoginSearch {
  const redirect = safeRedirect(search.redirect);
  const mode = loginPageMode(search.mode);
  const reason = loginReason(search.reason);
  return {
    ...(redirect ? { redirect } : {}),
    ...(mode !== "login" ? { mode } : {}),
    ...(reason ? { reason } : {}),
  };
}

type LoginMode = LoginPageMode;

const PASSWORD_RULE_ID = "login-password-rule";

/** Délai avant de pouvoir demander un nouvel email de confirmation. */
const RESEND_COOLDOWN_SECONDS = 30;

/**
 * Phrase du bandeau : l'action qui a envoyé la personne ici, et ce que le compte gratuit change.
 * Deux états : avec l'offre de lancement le compte gratuit a les avantages Analyse (export compris) ;
 * sans elle, l'export reste réservé à l'offre Analyse et le texte ne promet pas plus que le produit.
 */
function reasonCopy(reason: LoginReason, launchOffer: boolean): { signup: string; login: string } {
  switch (reason) {
    case "alerte":
      return {
        signup: "Créez votre compte gratuit pour enregistrer cette alerte, sans carte bancaire.",
        login: "Connectez-vous pour enregistrer cette alerte.",
      };
    case "favori":
      return {
        signup: `Créez votre compte gratuit pour garder cette vente en favori (${PLAN_LIMITS.decouverte.favoriteSales} favoris offerts).`,
        login: "Connectez-vous pour garder cette vente en favori.",
      };
    case "export":
      return launchOffer
        ? {
            signup:
              "Créez votre compte gratuit pour exporter ces résultats : l’export fait partie des avantages de l’offre Analyse accordés pendant l’offre de lancement, sans carte bancaire.",
            login: "Connectez-vous pour exporter ces résultats.",
          }
        : {
            signup:
              "Créez votre compte gratuit, sans carte bancaire. L’export des résultats est réservé à l’offre Analyse.",
            login: "Connectez-vous. L’export des résultats est réservé à l’offre Analyse.",
          };
    case "offre":
      return launchOffer
        ? {
            signup:
              "Créez votre compte gratuit : pendant l’offre de lancement, il bénéficie des avantages de l’offre Analyse.",
            login: "Connectez-vous pour retrouver les avantages de l’offre Analyse.",
          }
        : {
            signup:
              "Créez votre compte gratuit. L’offre Analyse n’est pas encore ouverte à la souscription : vous pourrez demander à être prévenu de son ouverture.",
            login: "Connectez-vous pour découvrir l'offre Analyse.",
          };
    case "ouverture":
      return {
        signup: "Créez votre compte gratuit pour être prévenu de l’ouverture de l’offre Analyse.",
        login: "Connectez-vous pour être prévenu de l’ouverture de l’offre Analyse.",
      };
    case "mes-favoris":
      return {
        signup: "Créez votre compte gratuit pour garder vos ventes en favori et les retrouver ici.",
        login: "Connectez-vous pour retrouver vos favoris.",
      };
    case "mes-alertes":
      return {
        signup: "Créez votre compte gratuit pour enregistrer vos alertes et les retrouver ici.",
        login: "Connectez-vous pour retrouver vos alertes.",
      };
    case "fiche":
      return {
        signup: launchOffer
          ? "Créez votre compte gratuit pour voir l'adresse, les photos et la fourchette de valeur de cette vente : pendant l’offre de lancement, il ouvre aussi les analyses de l’offre Analyse."
          : `Créez votre compte gratuit pour voir l'adresse, les photos et la fourchette de valeur de cette vente, et en débloquer ${MONTHLY_SALE_UNLOCKS} en détail chaque mois (contenu selon la vente).`,
        login: "Connectez-vous pour consulter cette vente.",
      };
  }
}

const modeCopy: Record<
  LoginMode,
  {
    eyebrow: string;
    title: string;
    description: string;
    submit: string;
  }
> = {
  login: {
    eyebrow: "Connexion",
    title: "Reprendre votre analyse",
    description: "Retrouvez vos annonces, favoris, alertes et calculs d'enchère plafond.",
    submit: "Se connecter",
  },
  investor: {
    eyebrow: "Compte Découverte",
    title: "Explorer gratuitement",
    description:
      "Créez votre compte pour consulter les fiches et préparer votre première recherche, sans carte bancaire.",
    submit: "Créer mon compte gratuit",
  },
  professional: {
    eyebrow: "Compte professionnel",
    title: "Référencer une vente",
    description: "Un espace B2B pour les avocats, notaires, commissaires de justice et tribunaux.",
    submit: "Demander mon accès pro",
  },
};

export function LoginPage() {
  const { user, profile, loading } = useAuth();
  const launchOffer = useLaunchOffer().active;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const {
    redirect,
    mode: requestedMode,
    reason,
  } = useMemo(
    () => parseLoginSearch(searchParamsToRecord(new URLSearchParams(queryString))),
    [queryString],
  );
  const mode: LoginMode = requestedMode ?? "login";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [professionalRole, setProfessionalRole] = useState<ProfessionalRole>("lawyer");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /** Adresse à laquelle l'email de confirmation vient d'être envoyé (compte sans session). */
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [resendNotice, setResendNotice] = useState<string | null>(null);
  /**
   * Supabase répond sans erreur à une inscription avec une adresse déjà confirmée : il renvoie
   * un utilisateur sans identité (`identities` vide) et n'envoie rien. On le dit à la personne.
   */
  const [accountExists, setAccountExists] = useState(false);
  /**
   * Instant (ms) à partir duquel l'email peut être renvoyé. Le décompte se recalcule depuis
   * l'horloge à chaque seconde : un onglet en veille ou une horloge avancée ne le figent pas.
   */
  const [resendAvailableAt, setResendAvailableAt] = useState<number | null>(null);
  const [clockNow, setClockNow] = useState(0);
  /** Secondes restantes avant de pouvoir renvoyer l'email (0 = disponible). */
  const resendCountdown =
    resendAvailableAt === null ? 0 : Math.max(0, Math.ceil((resendAvailableAt - clockNow) / 1000));
  function startResendCooldown() {
    const now = Date.now();
    setClockNow(now);
    setResendAvailableAt(now + RESEND_COOLDOWN_SECONDS * 1000);
  }

  const copy = modeCopy[mode];
  const isSignup = mode !== "login";
  const accountType: AccountType = mode === "professional" ? "b2b" : "b2c";
  const postAuthTarget = useMemo(
    () =>
      postAuthDestination({
        mode,
        redirect,
        professional: isAdminAccount(user, profile) || getAccountType(user, profile) === "b2b",
      }),
    [mode, profile, redirect, user],
  );

  useEffect(() => {
    if (user && !loading) router.push(postAuthTarget);
  }, [loading, postAuthTarget, router, user]);

  // Compte à rebours du bouton « Renvoyer l'email » : relu sur l'horloge chaque seconde, jusqu'à 0.
  const countingDown = resendCountdown > 0;
  useEffect(() => {
    if (!countingDown) return;
    const timer = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [countingDown]);

  /** Switches the form mode and keeps the rest of the query string (the `redirect`). */
  function switchMode(next: LoginMode) {
    const params = new URLSearchParams(queryString);
    if (next === "login") params.delete("mode");
    else params.set("mode", next);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  }

  /** Where the confirmation link brings the person back to. */
  function signupRedirectTo(): string | undefined {
    const origin = typeof window !== "undefined" ? window.location.origin : undefined;
    const redirectPath = postAuthDestination({
      mode,
      redirect,
      professional: accountType === "b2b",
    });
    return origin ? `${origin}${redirectPath}` : undefined;
  }

  async function resendConfirmation() {
    if (!pendingEmail || resending || resendCountdown > 0) return;
    setResending(true);
    setResendNotice(null);
    setFormError(null);
    try {
      const { error } = await supabase.auth.resend({
        type: "signup",
        email: pendingEmail,
        options: { emailRedirectTo: signupRedirectTo() },
      });
      if (error) throw error;
      setResendNotice(
        `Email renvoyé à ${pendingEmail}. Pensez à vérifier vos courriers indésirables.`,
      );
    } catch (err: unknown) {
      setFormError(userMessage(err, "Impossible de renvoyer l'email pour le moment. Réessayez."));
    } finally {
      setResending(false);
      startResendCooldown();
    }
  }

  function changeAddress() {
    setPendingEmail(null);
    setAccountExists(false);
    setResendAvailableAt(null);
    setResendNotice(null);
    setFormError(null);
    setPassword("");
  }

  /** Depuis le panneau « compte existant » : retour au formulaire en mode connexion. */
  function goToLogin() {
    changeAddress();
    switchMode("login");
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!isSupabaseConfigured) {
      toast.error("Connexion indisponible : Supabase n'est pas configuré sur ce déploiement.");
      return;
    }

    if (mode === "professional" && organizationName.trim().length < 2) {
      toast.error("Renseignez votre cabinet, étude, office ou tribunal.");
      return;
    }

    setFormError(null);
    setBusy(true);
    try {
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        toast.success("Connecté");
        return;
      }

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: signupRedirectTo(),
          data: {
            account_type: accountType,
            full_name: fullName.trim() || null,
            organization_name: accountType === "b2b" ? organizationName.trim() : null,
            professional_role: accountType === "b2b" ? professionalRole : null,
            onboarding_version:
              accountType === "b2b" ? "2026-06-split-investor-pro" : "2026-08-first-search",
            terms_version: LEGAL_DOCUMENTS.terms.version,
            privacy_version: LEGAL_DOCUMENTS.privacy.version,
            terms_accepted_at: new Date().toISOString(),
          },
        },
      });
      if (error) throw error;
      trackProductEvent("signup_completed");
      // Sans session, le compte attend la confirmation de l'adresse : un toast qui disparaît
      // laisserait la personne devant le même formulaire, on le remplace donc par un panneau.
      if (data?.session === null) {
        setResendNotice(null);
        setAccountExists(isExistingAccountResponse(data));
        startResendCooldown();
        setPendingEmail(email.trim());
        return;
      }
      toast.success(
        accountType === "b2b"
          ? "Demande pro créée. Vous pouvez poursuivre."
          : "Compte Découverte créé. Vous pouvez poursuivre.",
      );
    } catch (err: unknown) {
      const message = userMessage(
        err,
        "Impossible de continuer. Vérifiez vos informations puis réessayez.",
      );
      setFormError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="contenu" className="liquid-page min-h-screen px-4 py-10 text-foreground sm:px-6">
      <div className="mx-auto grid min-h-[calc(100svh-8rem)] max-w-6xl items-center gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(24rem,29rem)]">
        <section className="glass-shell relative hidden min-h-[38rem] overflow-hidden rounded-lg p-8 lg:block">
          <div className="cinematic-grid absolute inset-0 opacity-35" />
          <div className="absolute inset-x-10 top-16 h-px bg-gradient-to-r from-transparent via-gold/50 to-transparent" />
          <div className="relative z-10 max-w-xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-gold/25 bg-gold/10 px-3 py-1 text-xs font-semibold text-gold-text">
              <ShieldCheck className="h-3.5 w-3.5" />
              Accès Immojudis
            </div>
            <p className="mt-6 font-display text-5xl leading-tight text-foreground">
              Préparez votre achat aux enchères.
            </p>
            <p className="mt-5 max-w-md text-sm leading-relaxed text-muted-foreground">
              {launchOffer ? (
                <>
                  Découverte ouvre gratuitement le catalogue. Pendant l’offre de lancement, le
                  compte gratuit bénéficie des avantages de l’offre Analyse : comparables, alertes
                  quotidiennes et exports (contenu selon la vente). Tarif prévu de l’offre Analyse :{" "}
                  {resolveAnalysisOfferLabel()}, pas encore souscriptible.
                </>
              ) : (
                <>
                  Découverte ouvre gratuitement le catalogue et, chaque mois, {MONTHLY_SALE_UNLOCKS}{" "}
                  ventes en détail ({UNLOCK_HIGHLIGHTS_INLINE_TEXT}). Analyse ouvre toutes les
                  ventes, avec les comparables, les alertes quotidiennes et les exports (tarif prévu
                  : {resolveAnalysisOfferLabel()}, pas encore souscriptible).
                </>
              )}{" "}
              Les professionnels déposent et suivent leurs annonces dans leur espace.
            </p>
            {launchOffer ? (
              <p
                data-testid="login-launch-offer-column"
                className="mt-5 max-w-md rounded-lg border border-gold/25 bg-gold/10 px-4 py-3 text-sm font-medium leading-relaxed text-foreground"
              >
                {LAUNCH_OFFER_VISITOR_TEXT}
              </p>
            ) : null}

            <div className="mt-10 grid gap-3">
              <FeatureLine
                icon={FileSearch}
                title="Découverte"
                text="Explorer les annonces et les aperçus gratuitement."
              />
              <FeatureLine
                icon={BriefcaseBusiness}
                title="Professionnel"
                text="Référencer une vente et structurer le dossier."
              />
            </div>
          </div>
        </section>

        <section className="glass-shell rounded-lg p-6 sm:p-8">
          {pendingEmail ? (
            <div>
              <div className="flex items-center gap-3 text-xs font-semibold text-gold-text">
                <Mail className="h-4 w-4" />
                {accountExists ? "Adresse déjà inscrite" : "Compte créé"}
              </div>
              <h1 className="mt-4 font-display text-3xl text-foreground">
                {accountExists ? "Un compte existe déjà" : "Confirmez votre adresse email"}
              </h1>
              <div
                role="status"
                className="mt-4 rounded-lg border border-gold/25 bg-gold/10 px-4 py-3 text-sm leading-relaxed text-foreground"
              >
                {accountExists ? (
                  <p>
                    {ACCOUNT_EXISTS_MESSAGE} Aucun email de confirmation n'a été envoyé à{" "}
                    <strong>{pendingEmail}</strong>.
                  </p>
                ) : (
                  <p>
                    Un email de confirmation a été envoyé à <strong>{pendingEmail}</strong>, cliquez
                    sur le lien pour continuer.
                  </p>
                )}
                {resendNotice ? <p className="mt-2 text-muted-foreground">{resendNotice}</p> : null}
              </div>
              <p
                data-testid="signup-help"
                className="mt-3 text-sm leading-relaxed text-muted-foreground"
              >
                Vous ne recevez rien ? Vérifiez vos courriers indésirables. Si vous avez déjà un
                compte avec cette adresse,{" "}
                <button type="button" onClick={goToLogin} className="text-foreground underline">
                  connectez-vous
                </button>{" "}
                ou{" "}
                <Link href="/mot-de-passe-oublie" className="text-foreground underline">
                  réinitialisez votre mot de passe
                </Link>
                .
              </p>
              {formError ? (
                <p
                  role="alert"
                  className="mt-3 rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm leading-relaxed text-red-700"
                >
                  {formError}
                </p>
              ) : null}
              <div className="mt-5 flex flex-wrap gap-3">
                {accountExists ? null : (
                  <button
                    type="button"
                    onClick={() => void resendConfirmation()}
                    disabled={resending || resendCountdown > 0}
                    className="liquid-button inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {resending
                      ? "Envoi..."
                      : resendCountdown > 0
                        ? `Renvoyer l'email (${resendCountdown} s)`
                        : "Renvoyer l'email"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={changeAddress}
                  className="inline-flex min-h-11 items-center justify-center rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-white/5"
                >
                  Changer d'adresse
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-1">
                <ModeButton active={mode === "login"} onClick={() => switchMode("login")}>
                  Se connecter
                </ModeButton>
                <ModeButton active={mode === "investor"} onClick={() => switchMode("investor")}>
                  Créer un compte
                </ModeButton>
                <ModeButton
                  active={mode === "professional"}
                  onClick={() => switchMode("professional")}
                >
                  Professionnel
                </ModeButton>
              </div>

              {reason ? (
                <p
                  data-testid="login-reason"
                  className="mt-5 rounded-lg border border-gold/25 bg-gold/10 px-4 py-3 text-sm leading-relaxed text-foreground"
                >
                  {isSignup
                    ? reasonCopy(reason, launchOffer).signup
                    : reasonCopy(reason, launchOffer).login}
                </p>
              ) : null}

              <div className="mt-6 flex items-center gap-3 text-xs font-semibold text-gold-text">
                {mode === "professional" ? (
                  <BriefcaseBusiness className="h-4 w-4" />
                ) : mode === "investor" ? (
                  <UserRound className="h-4 w-4" />
                ) : (
                  <LockKeyhole className="h-4 w-4" />
                )}
                {copy.eyebrow}
              </div>
              <h1 className="mt-4 font-display text-3xl text-foreground">{copy.title}</h1>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {copy.description}
              </p>
              {mode === "investor" ? (
                // The explanation column is hidden below the lg breakpoint: say the promise here.
                <p
                  data-testid="login-free-promise"
                  className="mt-2 text-sm font-medium leading-relaxed text-foreground lg:hidden"
                >
                  {launchOffer
                    ? LAUNCH_OFFER_VISITOR_TEXT
                    : `Gratuit : ${MONTHLY_SALE_UNLOCKS} ventes en détail par mois (${UNLOCK_HIGHLIGHTS_INLINE_TEXT}), sans carte bancaire`}
                </p>
              ) : null}
              {mode === "investor" && launchOffer ? (
                <p
                  data-testid="login-launch-offer"
                  className="mt-3 hidden rounded-lg border border-gold/25 bg-gold/10 px-4 py-3 text-sm font-medium leading-relaxed text-foreground lg:block"
                >
                  {LAUNCH_OFFER_VISITOR_TEXT}
                </p>
              ) : null}

              {!isSupabaseConfigured ? (
                <div className="mt-5 rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm leading-relaxed text-red-100">
                  Connexion temporairement indisponible : les variables Supabase publiques ne sont
                  pas présentes dans ce build.
                </div>
              ) : null}

              <form onSubmit={submit} className="mt-6 space-y-3">
                {isSignup ? (
                  <label className="grid gap-2">
                    <span className="text-[13px] font-semibold text-muted-foreground">
                      Nom complet
                    </span>
                    <input
                      type="text"
                      placeholder="Prénom Nom"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      className="form-input"
                    />
                  </label>
                ) : null}

                {mode === "professional" ? (
                  <div className="grid gap-3">
                    <label className="grid gap-2">
                      <span className="text-[13px] font-semibold text-muted-foreground">
                        Profil professionnel
                      </span>
                      <select
                        value={professionalRole}
                        onChange={(event) =>
                          setProfessionalRole(event.target.value as ProfessionalRole)
                        }
                        className="form-input"
                      >
                        {PROFESSIONAL_ROLE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-2">
                      <span className="text-[13px] font-semibold text-muted-foreground">
                        Organisation
                      </span>
                      <div className="relative">
                        <Building2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gold/80" />
                        <input
                          type="text"
                          required
                          placeholder="Cabinet, étude, office, tribunal..."
                          value={organizationName}
                          onChange={(e) => setOrganizationName(e.target.value)}
                          className="form-input pl-10"
                        />
                      </div>
                    </label>
                    <div className="rounded-lg border border-gold/20 bg-gold/10 px-4 py-3 text-xs leading-relaxed text-gold-text">
                      L'accès pro permet de préparer une annonce. La publication et les options de
                      référencement pourront être validées séparément.
                    </div>
                  </div>
                ) : null}

                <label className="grid gap-2">
                  <span className="text-[13px] font-semibold text-muted-foreground">Email</span>
                  <div className="relative">
                    <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gold/80" />
                    <input
                      type="email"
                      autoComplete="email"
                      required
                      placeholder="vous@exemple.fr"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="form-input pl-10"
                    />
                  </div>
                </label>
                <div className="grid gap-1.5">
                  <label className="grid gap-2">
                    <span className="text-[13px] font-semibold text-muted-foreground">
                      Mot de passe
                    </span>
                    <div className="relative">
                      <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gold/80" />
                      <input
                        type={showPassword ? "text" : "password"}
                        autoComplete={isSignup ? "new-password" : "current-password"}
                        required
                        minLength={isSignup ? 12 : 6}
                        placeholder={isSignup ? "12 caractères minimum" : "Votre mot de passe"}
                        aria-describedby={isSignup ? PASSWORD_RULE_ID : undefined}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="form-input pl-10 pr-12"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((visible) => !visible)}
                        aria-label={
                          showPassword ? "Masquer le mot de passe" : "Afficher le mot de passe"
                        }
                        aria-pressed={showPassword}
                        className="absolute right-0 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
                      >
                        {showPassword ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </label>
                  {isSignup ? (
                    <p
                      id={PASSWORD_RULE_ID}
                      className="text-xs leading-relaxed text-muted-foreground"
                    >
                      Au moins 12 caractères. Une phrase facile à retenir fonctionne très bien.
                    </p>
                  ) : null}
                </div>

                {!isSignup ? (
                  <div className="pb-2 text-right">
                    <Link
                      href="/mot-de-passe-oublie"
                      className="inline-flex min-h-11 items-center text-sm underline"
                    >
                      Mot de passe oublié ?
                    </Link>
                  </div>
                ) : null}
                {formError ? (
                  <p
                    role="alert"
                    className="rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm leading-relaxed text-red-700"
                  >
                    {formError}
                  </p>
                ) : null}
                <button
                  type="submit"
                  disabled={busy}
                  className="liquid-button inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-semibold transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? "Chargement..." : copy.submit}
                  {!busy ? <ArrowRight className="h-4 w-4" /> : null}
                </button>
                {isSignup ? (
                  <p className="text-center text-xs leading-relaxed text-muted-foreground">
                    En cliquant sur « {copy.submit} », vous acceptez les{" "}
                    <Link href="/conditions-generales" className="underline">
                      conditions générales
                    </Link>{" "}
                    et vous reconnaissez avoir pris connaissance de la{" "}
                    <Link href="/privacy" className="underline">
                      politique de confidentialité
                    </Link>
                    .
                  </p>
                ) : null}
              </form>
            </>
          )}

          <div className="mt-6 border-t border-white/10 pt-4 text-center text-xs text-muted-foreground">
            <Link href="/" className="hover:text-foreground">
              Retour à la présentation
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}

/** Une inscription « réussie » sans identité créée correspond à une adresse déjà inscrite. */
function isExistingAccountResponse(
  data: { user?: { identities?: unknown[] | null } | null } | null | undefined,
): boolean {
  const identities = data?.user?.identities;
  return Array.isArray(identities) && identities.length === 0;
}

function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (
    !value.startsWith("/") ||
    value.includes("\\") ||
    [...value].some((character) => character.charCodeAt(0) <= 32)
  )
    return undefined;
  const base = "http://immojudis.local";
  try {
    const url = new URL(value, base);
    if (url.origin !== base || url.pathname === "/login") return undefined;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}

function ModeButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-11 rounded-md px-3 py-2 text-sm font-semibold transition ${
        active
          ? "bg-gold text-brand-navy shadow-[0_12px_28px_rgb(242_196_135_/_18%)]"
          : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function FeatureLine({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof FileSearch;
  title: string;
  text: string;
}) {
  return (
    <div className="liquid-panel-soft flex items-start gap-3 rounded-lg p-4">
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-gold-text" />
      <div>
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{text}</p>
      </div>
    </div>
  );
}
