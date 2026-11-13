"use client";

import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type * as React from "react";
import { useMemo, useState } from "react";
import BadgeCheck from "lucide-react/dist/esm/icons/badge-check.js";
import Clock from "lucide-react/dist/esm/icons/clock.js";
import EyeOff from "lucide-react/dist/esm/icons/eye-off.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import ImagePlus from "lucide-react/dist/esm/icons/image-plus.js";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import Megaphone from "lucide-react/dist/esm/icons/megaphone.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import UploadCloud from "lucide-react/dist/esm/icons/upload-cloud.js";
import { formatShortDate } from "@/lib/format/dates";
import { toast } from "@/lib/toast";
import { buttonClasses, Card, Eyebrow, Notice, PageTitle } from "@/components/ui/primitives";
import { useAuth } from "@/hooks/use-auth";
import { getProfessionalStatus, isProfessionalAccount } from "@/lib/account";
import {
  PROFESSIONAL_ACCESS_REQUEST_HREF,
  PROFESSIONAL_WORKSPACE_HREF,
} from "@/lib/professional-access";
import {
  fetchPublicationRequestsClient,
  submitPublicationRequestClient,
  type PublicationRequestSummary,
} from "@/lib/publication-requests-client";
import { userMessage } from "@/lib/user-messages";
import * as queryKeys from "@/lib/query-keys";
import { formatFileSize } from "@/lib/format-file-size";
import { PublicationStatusPill as StatusPill } from "@/components/PublicationStatusPill";

type PublishDraft = {
  title: string;
  location: string;
  startingPrice: string;
  hearingDate: string;
  court: string;
  description: string;
  strengths: string;
  cautions: string;
  anonymizeDocuments: boolean;
  selectedDocuments: string[];
  selectedPromotions: string[];
  fileCount: number;
};

const INITIAL_DRAFT: PublishDraft = {
  title: "",
  location: "",
  startingPrice: "",
  hearingDate: "",
  court: "",
  description: "",
  strengths: "",
  cautions: "",
  anonymizeDocuments: true,
  selectedDocuments: [],
  // Aucune option n'est cochée d'office: chacune est une demande adressée à l'équipe.
  selectedPromotions: [],
  fileCount: 0,
};

/** Libellés en capitales des petits blocs : 12 px, encre douce (plus de 11 px). */
const LABEL_CLASS = "text-xs font-semibold uppercase tracking-[0.14em] text-ink-soft";

const DOCUMENT_TYPES = [
  "Cahier des conditions de vente",
  "Procès-verbal descriptif",
  "Diagnostics techniques",
  "Photos du bien",
  "Plans ou annexes",
] as const;

const PROMOTION_OPTIONS = [
  {
    id: "featured",
    label: "Demander une mise en avant éditoriale (sélections et contenus Immojudis)",
    desc: "L'équipe étudie une présentation dans les sélections et contenus éditoriaux d'Immojudis. Cette option n'a aucun effet sur l'ordre des résultats de recherche : le classement ne dépend d'aucune rémunération ni demande. Si une contrepartie est convenue, le contenu concerné est signalé comme publicité.",
  },
  {
    id: "seo",
    label: "Demander une préparation SEO",
    desc: "L'équipe peut préparer les éléments de visibilité après validation du dossier.",
  },
  {
    id: "partners",
    label: "Demander un relais partenaire",
    desc: "Une diffusion externe éventuelle reste soumise à une validation séparée.",
  },
] as const;

export function PublishPage() {
  const { user, profile, loading } = useAuth();
  const [draft, setDraft] = useState<PublishDraft>(INITIAL_DRAFT);
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const queryClient = useQueryClient();

  const isProfessional = isProfessionalAccount(user, profile);
  const professionalStatus = getProfessionalStatus(profile);

  const { data: recentRequestsData, isFetching: requestsLoading } = useQuery({
    queryKey: queryKeys.publicationRequests(user?.id),
    enabled: Boolean(user?.id && isProfessional),
    queryFn: () => fetchPublicationRequestsClient(1),
  });
  const recentRequests = recentRequestsData?.requests ?? [];

  const completion = useMemo(() => {
    const checks = [
      draft.title.trim(),
      draft.location.trim(),
      draft.startingPrice.trim(),
      draft.hearingDate.trim(),
      draft.court.trim(),
      draft.description.trim(),
      draft.selectedDocuments.length > 0 ? "documents" : "",
      draft.fileCount > 0 ? "files" : "",
    ];

    return Math.round((checks.filter(Boolean).length / checks.length) * 100);
  }, [draft]);

  const updateDraft = <K extends keyof PublishDraft>(key: K, value: PublishDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const toggleDocument = (name: string) => {
    setDraft((current) => ({
      ...current,
      selectedDocuments: current.selectedDocuments.includes(name)
        ? current.selectedDocuments.filter((item) => item !== name)
        : [...current.selectedDocuments, name],
    }));
  };

  const togglePromotion = (id: string) => {
    setDraft((current) => ({
      ...current,
      selectedPromotions: current.selectedPromotions.includes(id)
        ? current.selectedPromotions.filter((item) => item !== id)
        : [...current.selectedPromotions, id],
    }));
  };

  const handleFilesChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextFiles = Array.from(event.currentTarget.files ?? []);
    setFiles(nextFiles);
    updateDraft("fileCount", nextFiles.length);
  };

  const submitRequest = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!user || !isProfessional) {
      toast.error("Seuls les comptes professionnels peuvent demander une publication.");
      return;
    }

    if (!user.email?.trim()) {
      toast.error("Une adresse email est obligatoire avant tout dépôt.");
      return;
    }

    if (!draft.title.trim() || !draft.location.trim() || !draft.description.trim()) {
      toast.error("Ajoutez au minimum un titre, une localisation et une description.");
      return;
    }

    if (!draft.selectedDocuments.length && !files.length) {
      toast.error("Ajoutez au moins un type de document ou une pièce transmise.");
      return;
    }

    setSubmitting(true);

    try {
      await submitPublicationRequestClient({
        title: draft.title.trim(),
        location: draft.location.trim(),
        startingPrice: draft.startingPrice,
        hearingDate: draft.hearingDate,
        court: draft.court.trim(),
        description: draft.description.trim(),
        strengths: draft.strengths.trim(),
        cautions: draft.cautions.trim(),
        anonymizeDocuments: draft.anonymizeDocuments,
        documentTypes: draft.selectedDocuments,
        promotionOptions: draft.selectedPromotions,
        files,
      });

      await queryClient.invalidateQueries({ queryKey: queryKeys.publicationRequestsAll() });
      toast.success("Demande envoyée. Elle attend maintenant la validation de l'équipe Immojudis.");
      setDraft(INITIAL_DRAFT);
      setFiles([]);
    } catch (error) {
      toast.error(userMessage(error, "Impossible d'enregistrer la demande de publication."));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <main id="contenu" className="min-h-screen px-4 py-8 text-foreground sm:px-6 lg:py-12">
        <Card role="status" className="mx-auto max-w-3xl p-6">
          <RefreshCw className="h-5 w-5 animate-spin text-gold-text" aria-hidden />
          <p className="mt-4 text-sm text-ink-soft">Vérification de l'accès pro...</p>
        </Card>
      </main>
    );
  }

  if (!isProfessional) {
    // La page est derrière `AuthGate` : la personne est connectée. `/login?mode=professional`
    // l'aurait renvoyée ici aussitôt (boucle) : la demande d'accès passe par le contact.
    return (
      <main id="contenu" className="min-h-screen px-4 py-8 text-foreground sm:px-6 lg:py-12">
        <Card className="mx-auto max-w-3xl p-6 sm:p-8">
          <Eyebrow className="flex items-center gap-2">
            <LockKeyhole className="h-4 w-4" aria-hidden />
            Accès professionnel
          </Eyebrow>
          <PageTitle className="mt-4 text-brand-navy">
            La publication d'annonce est réservée aux comptes pro.
          </PageTitle>
          <p className="mt-4 text-base leading-relaxed text-ink-soft">
            Les comptes Découverte conservent l'accès au catalogue et les comptes Analyse aux outils
            de suivi. Pour référencer une vente, créez un compte professionnel avocat, notaire,
            commissaire de justice ou tribunal.
          </p>
          <Link
            href={PROFESSIONAL_ACCESS_REQUEST_HREF}
            className={buttonClasses({ variant: "primary", className: "mt-6" })}
          >
            Demander un accès pro
          </Link>
        </Card>
      </main>
    );
  }

  return (
    <main id="contenu" className="min-h-screen px-4 py-8 text-foreground sm:px-6 lg:py-12">
      <div className="mx-auto max-w-7xl">
        <header className="mb-8 grid gap-6 lg:grid-cols-[1fr_24rem] lg:items-start">
          <div>
            <Eyebrow className="flex items-center gap-2">
              <Megaphone className="h-4 w-4" aria-hidden />
              Demande de publication pro
            </Eyebrow>
            <PageTitle className="mt-4 max-w-4xl text-brand-navy">
              Transmettre une annonce complète pour validation Immojudis.
            </PageTitle>
            <p className="mt-4 max-w-3xl text-base leading-relaxed text-ink-soft">
              Votre demande et ses pièces sont enregistrées en attente de validation. L'équipe
              Immojudis les vérifie, peut les compléter, puis valide la mise en ligne.
            </p>
          </div>

          <Card>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className={LABEL_CLASS}>Préparation</p>
                <p className="mt-2 font-display text-3xl font-semibold tabular-nums text-brand-navy">
                  {completion}%
                </p>
              </div>
              <BadgeCheck className="h-8 w-8 text-gold-text" aria-hidden />
            </div>
            <div
              role="progressbar"
              aria-label="Préparation de la demande"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={completion}
              className="mt-4 h-2 overflow-hidden rounded-full bg-line-soft"
            >
              <div
                className="h-full rounded-full bg-gold transition-all"
                style={{ width: `${completion}%` }}
              />
            </div>
            <p className="mt-3 text-sm leading-relaxed text-ink-soft">
              Statut pro : {professionalStatusLabel(professionalStatus)}. La publication reste
              soumise à validation interne avant diffusion.
            </p>
          </Card>
        </header>

        <form onSubmit={submitRequest} className="grid gap-6 lg:grid-cols-[1fr_22rem]">
          {!user?.email?.trim() ? (
            <Notice tone="warning" role="alert" className="lg:col-span-2">
              Une adresse email confirmée est obligatoire avant tout dépôt. Ajoutez-la à votre
              compte puis revenez ici pour envoyer la demande.
            </Notice>
          ) : null}
          <div className="grid gap-6">
            <Card as="section" className="sm:p-6">
              <SectionTitle
                icon={FileText}
                title="Informations de l'annonce"
                subtitle="Les éléments qui structurent la lecture investisseur."
              />

              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <Field label="Titre de l'annonce">
                  <input
                    value={draft.title}
                    onChange={(event) => updateDraft("title", event.target.value)}
                    className="form-input"
                    placeholder="Appartement T3 avec terrasse..."
                  />
                </Field>
                <Field label="Adresse ou secteur">
                  <input
                    value={draft.location}
                    onChange={(event) => updateDraft("location", event.target.value)}
                    className="form-input"
                    placeholder="Bordeaux, département 33"
                  />
                </Field>
                <Field label="Mise à prix">
                  <input
                    value={draft.startingPrice}
                    onChange={(event) => updateDraft("startingPrice", event.target.value)}
                    className="form-input"
                    inputMode="numeric"
                    placeholder="340000"
                  />
                </Field>
                <Field label="Date de vente">
                  <input
                    value={draft.hearingDate}
                    onChange={(event) => updateDraft("hearingDate", event.target.value)}
                    className="form-input"
                    type="date"
                  />
                </Field>
                <Field label="Tribunal">
                  <input
                    value={draft.court}
                    onChange={(event) => updateDraft("court", event.target.value)}
                    className="form-input"
                    placeholder="TJ Bordeaux"
                  />
                </Field>
                <Field label="Pièces transmises">
                  {/* Bordure de champ (3:1 au moins), comme `.form-input`. */}
                  <label className="form-dropzone border-brand-navy/55 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-gold-soft">
                    <ImagePlus className="h-5 w-5 text-gold-text" aria-hidden />
                    <span>{files.length > 0 ? `${files.length} fichier(s)` : "Ajouter"}</span>
                    <input
                      type="file"
                      accept="image/*,application/pdf"
                      multiple
                      className="sr-only"
                      onChange={handleFilesChange}
                    />
                  </label>
                </Field>
              </div>

              {files.length ? (
                <div className="mt-4 rounded-lg border border-line bg-surface-muted p-3">
                  <p className={LABEL_CLASS}>Fichiers prêts à envoyer</p>
                  <div className="mt-3 grid gap-2">
                    {files.map((file) => (
                      <div
                        key={`${file.name}-${file.size}`}
                        className="flex items-center justify-between gap-3 rounded-md bg-white px-3 py-2 text-xs"
                      >
                        <span className="truncate text-foreground">{file.name}</span>
                        <span className="shrink-0 text-ink-soft">{formatFileSize(file.size)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="mt-4 grid gap-4">
                <Field label="Description détaillée">
                  <textarea
                    value={draft.description}
                    onChange={(event) => updateDraft("description", event.target.value)}
                    className="form-textarea min-h-32"
                    placeholder="Décrire le bien, son contexte, les surfaces, annexes et conditions de visite."
                  />
                </Field>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Atouts à mettre en avant">
                    <textarea
                      value={draft.strengths}
                      onChange={(event) => updateDraft("strengths", event.target.value)}
                      className="form-textarea"
                      placeholder="Terrasse, cave, stationnement, emplacement..."
                    />
                  </Field>
                  <Field label="Points à contextualiser">
                    <textarea
                      value={draft.cautions}
                      onChange={(event) => updateDraft("cautions", event.target.value)}
                      className="form-textarea"
                      placeholder="Occupation, travaux, servitude, diagnostics..."
                    />
                  </Field>
                </div>
              </div>
            </Card>

            <Card as="section" className="sm:p-6">
              <SectionTitle
                icon={ShieldCheck}
                title="Documents et confidentialité"
                subtitle="Les pièces sont conservées dans un espace privé avant validation."
              />

              <div className="mt-6 grid gap-3 md:grid-cols-2">
                {DOCUMENT_TYPES.map((name) => (
                  <label key={name} className="choice-card">
                    {/* Case visible : l'état coché ne repose plus sur une teinte d'or à peine
                        perceptible. */}
                    <input
                      type="checkbox"
                      checked={draft.selectedDocuments.includes(name)}
                      onChange={() => toggleDocument(name)}
                      className="h-4 w-4 shrink-0 accent-brand-navy"
                    />
                    <FileText className="h-4 w-4 text-gold-text" aria-hidden />
                    <span>{name}</span>
                  </label>
                ))}
              </div>

              <label className="mt-5 flex items-start gap-3 rounded-lg border border-line bg-surface-muted p-4">
                <input
                  type="checkbox"
                  checked={draft.anonymizeDocuments}
                  onChange={(event) => updateDraft("anonymizeDocuments", event.target.checked)}
                  className="mt-1 h-4 w-4 shrink-0 accent-brand-navy"
                />
                <span>
                  <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <EyeOff className="h-4 w-4 text-gold-text" aria-hidden />
                    Demander l'anonymisation avant diffusion
                  </span>
                  <span className="mt-1 block text-sm leading-relaxed text-ink-soft">
                    Les pièces restent privées. Cette demande sera traitée lors de la validation ;
                    la diffusion publique ne doit conserver que les éléments utiles à
                    l'investisseur.
                  </span>
                </span>
              </label>
            </Card>
          </div>

          <aside className="grid gap-6 lg:sticky lg:top-24 lg:self-start">
            <Card as="section">
              <SectionTitle
                icon={Megaphone}
                title="Promotion"
                subtitle="Choisir comment donner de la visibilité au dossier."
              />

              <div className="mt-5 grid gap-3">
                {PROMOTION_OPTIONS.map((option) => (
                  <label key={option.id} className="choice-card items-start">
                    <input
                      type="checkbox"
                      checked={draft.selectedPromotions.includes(option.id)}
                      onChange={() => togglePromotion(option.id)}
                      className="mt-1 h-4 w-4 shrink-0 accent-brand-navy"
                    />
                    <span>
                      <span className="block text-sm font-semibold text-foreground">
                        {option.label}
                      </span>
                      <span className="mt-1 block text-xs leading-relaxed text-ink-soft">
                        {option.desc}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </Card>

            <Card as="section" className="bg-surface-muted">
              <Eyebrow className="flex items-center gap-2">
                <UploadCloud className="h-4 w-4" aria-hidden />
                Prochaine étape
              </Eyebrow>
              <h2 className="mt-4 font-display text-2xl font-semibold text-brand-navy">
                Envoyer à la validation
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-ink-soft">
                L'équipe Immojudis reçoit la demande et les fichiers associés, et les contrôle avant
                toute publication.
              </p>
              <button
                type="submit"
                disabled={submitting || !user?.email?.trim()}
                className={buttonClasses({ variant: "primary", className: "mt-5 w-full" })}
              >
                {submitting ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin" aria-hidden />
                    Envoi en cours
                  </>
                ) : (
                  "Envoyer pour validation"
                )}
              </button>
              <Link
                href={PROFESSIONAL_WORKSPACE_HREF}
                className={buttonClasses({ variant: "secondary", className: "mt-3 w-full" })}
              >
                Ouvrir mon espace pro
              </Link>
            </Card>

            <Card as="section" aria-labelledby="publish-recent-title">
              <div className="flex items-center justify-between gap-3">
                <Eyebrow id="publish-recent-title" className="flex items-center gap-2">
                  <Clock className="h-4 w-4" aria-hidden />
                  Mes demandes
                </Eyebrow>
                {requestsLoading ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin text-ink-soft" aria-hidden />
                ) : null}
              </div>
              <div className="mt-4 grid gap-3">
                {recentRequests.length ? (
                  recentRequests.map((request) => (
                    <PublicationRequestLine key={request.id} request={request} />
                  ))
                ) : (
                  <p className="text-sm text-ink-soft">
                    Aucune demande encore transmise depuis ce compte.
                  </p>
                )}
              </div>
            </Card>
          </aside>
        </form>
      </div>
    </main>
  );
}

function PublicationRequestLine({ request }: { request: PublicationRequestSummary }) {
  return (
    <div className="rounded-lg border border-line bg-white p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">{request.title}</div>
          <div className="mt-1 text-xs text-ink-soft">
            {request.location ?? "Localisation à préciser"}
          </div>
        </div>
        <StatusPill status={request.status} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-ink-soft">
        <span>{request.documentCount} fichier(s)</span>
        <span aria-hidden>•</span>
        <span>{formatShortDate(request.createdAt)}</span>
      </div>
      {request.publishedUrl ? (
        <Link
          href={request.publishedUrl}
          className="mt-1 inline-flex min-h-11 items-center text-sm text-gold-text underline"
        >
          Voir la vente publiée
        </Link>
      ) : null}
    </div>
  );
}

function SectionTitle({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line bg-surface-tint text-gold-text">
        <Icon className="h-5 w-5" />
      </span>
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-brand-navy">
          {title}
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-ink-soft">{subtitle}</p>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-2">
      <span className="text-sm font-semibold text-brand-navy">{label}</span>
      {children}
    </label>
  );
}

function professionalStatusLabel(status: ReturnType<typeof getProfessionalStatus>) {
  if (status === "approved") return "validé";
  if (status === "rejected") return "refusé";
  if (status === "pending") return "en cours de revue";
  return "professionnel";
}
