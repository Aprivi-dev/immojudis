import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { useMemo, useState } from "react";
import BadgeCheck from "lucide-react/dist/esm/icons/badge-check.js";
import EyeOff from "lucide-react/dist/esm/icons/eye-off.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import ImagePlus from "lucide-react/dist/esm/icons/image-plus.js";
import Megaphone from "lucide-react/dist/esm/icons/megaphone.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import UploadCloud from "lucide-react/dist/esm/icons/upload-cloud.js";
import { toast } from "sonner";

export const Route = createFileRoute("/publish")({
  head: () => ({
    meta: [
      { title: "Publier une vente — Immojudis" },
      {
        name: "description",
        content:
          "Préparez une annonce de vente aux enchères immobilière avec documents, anonymisation et options de promotion.",
      },
    ],
    links: [{ rel: "canonical", href: "/publish" }],
  }),
  component: PublishPage,
});

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
  selectedPromotions: ["featured"],
  fileCount: 0,
};

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
    label: "Mise en avant Immojudis",
    desc: "Annonce priorisée dans les sélections éditoriales et les pages de recherche.",
  },
  {
    id: "seo",
    label: "Référencement renforcé",
    desc: "Titre, description et données structurées préparés pour une meilleure visibilité.",
  },
  {
    id: "partners",
    label: "Diffusion partenaires",
    desc: "Préparation d'un dossier compatible avec des relais médias ou sites spécialisés.",
  },
] as const;

function PublishPage() {
  const [draft, setDraft] = useState<PublishDraft>(INITIAL_DRAFT);

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

  const saveDraft = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (typeof window !== "undefined") {
      window.localStorage.setItem("immojudis_publish_draft", JSON.stringify(draft));
    }

    toast.success("Brouillon de publication enregistré.");
  };

  return (
    <main className="liquid-page min-h-screen px-4 py-8 text-foreground sm:px-6 lg:py-12">
      <div className="mx-auto max-w-7xl">
        <header className="glass-shell mb-8 grid gap-6 rounded-lg p-6 sm:p-8 lg:grid-cols-[1fr_24rem] lg:items-end">
          <div>
            <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
              <Megaphone className="h-4 w-4" />
              Publication premium
            </div>
            <h1 className="mt-4 max-w-4xl font-display text-4xl leading-tight text-foreground sm:text-5xl">
              Préparer une annonce de vente judiciaire lisible, complète et promue.
            </h1>
            <p className="mt-5 max-w-3xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              Centralisez les informations utiles, les photos et les pièces officielles avant revue.
              L'objectif est de publier une annonce exploitable par un investisseur sans exposer de
              données sensibles.
            </p>
          </div>

          <div className="liquid-panel-soft rounded-lg p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                  Préparation
                </div>
                <div className="mt-2 font-display text-3xl text-gold-soft">{completion}%</div>
              </div>
              <BadgeCheck className="h-8 w-8 text-gold" />
            </div>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-gold transition-all"
                style={{ width: `${completion}%` }}
              />
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Le brouillon reste local tant que le workflow de validation Supabase n'est pas
              branché.
            </p>
          </div>
        </header>

        <form onSubmit={saveDraft} className="grid gap-6 lg:grid-cols-[1fr_22rem]">
          <div className="grid gap-6">
            <section className="liquid-panel rounded-lg p-5 sm:p-6">
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
                <Field label="Photos">
                  <label className="form-dropzone">
                    <ImagePlus className="h-5 w-5 text-gold" />
                    <span>{draft.fileCount > 0 ? `${draft.fileCount} fichier(s)` : "Ajouter"}</span>
                    <input
                      type="file"
                      accept="image/*,application/pdf"
                      multiple
                      className="sr-only"
                      onChange={(event) =>
                        updateDraft("fileCount", event.currentTarget.files?.length ?? 0)
                      }
                    />
                  </label>
                </Field>
              </div>

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
            </section>

            <section className="liquid-panel rounded-lg p-5 sm:p-6">
              <SectionTitle
                icon={ShieldCheck}
                title="Documents et confidentialité"
                subtitle="Les pièces sont listées avant publication pour faciliter le contrôle."
              />

              <div className="mt-6 grid gap-3 md:grid-cols-2">
                {DOCUMENT_TYPES.map((name) => (
                  <label key={name} className="choice-card">
                    <input
                      type="checkbox"
                      checked={draft.selectedDocuments.includes(name)}
                      onChange={() => toggleDocument(name)}
                      className="sr-only"
                    />
                    <FileText className="h-4 w-4 text-gold" />
                    <span>{name}</span>
                  </label>
                ))}
              </div>

              <label className="mt-5 flex items-start gap-3 rounded-lg border border-gold/20 bg-gold/10 p-4">
                <input
                  type="checkbox"
                  checked={draft.anonymizeDocuments}
                  onChange={(event) => updateDraft("anonymizeDocuments", event.target.checked)}
                  className="mt-1"
                />
                <span>
                  <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <EyeOff className="h-4 w-4 text-gold" />
                    Anonymiser les documents avant diffusion
                  </span>
                  <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
                    Masquer les informations personnelles et ne garder que les éléments utiles à la
                    décision d'investissement.
                  </span>
                </span>
              </label>
            </section>
          </div>

          <aside className="grid gap-6 lg:sticky lg:top-24 lg:self-start">
            <section className="liquid-panel rounded-lg p-5">
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
                      className="mt-1"
                    />
                    <span>
                      <span className="block text-sm font-semibold text-foreground">
                        {option.label}
                      </span>
                      <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                        {option.desc}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </section>

            <section className="liquid-panel-soft rounded-lg p-5">
              <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-gold">
                <UploadCloud className="h-4 w-4" />
                Prochaine étape
              </div>
              <h2 className="mt-4 font-display text-2xl text-foreground">
                Revue avant mise en ligne
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                Une annonce publiée doit être vérifiée : cohérence juridique, preuves disponibles,
                anonymisation et qualité de présentation.
              </p>
              <button
                type="submit"
                className="liquid-button mt-5 inline-flex w-full items-center justify-center rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.18em] text-background"
              >
                Enregistrer le brouillon
              </button>
            </section>
          </aside>
        </form>
      </div>
    </main>
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
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-gold/20 bg-gold/10 text-gold">
        <Icon className="h-5 w-5" />
      </span>
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-foreground">
          {title}
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
