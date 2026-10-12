"use client";

import { useActionState } from "react";
import { sendContactMessage } from "@/app/contact/actions";
import {
  CONTACT_LIMITS,
  CONTACT_SUBJECTS,
  type ContactFieldErrors,
  type ContactState,
} from "@/lib/contact-message";
import { Button } from "@/components/ui/primitives";

const INITIAL: ContactState = { status: "idle" };

export function ContactForm({
  action = sendContactMessage,
}: {
  action?: (previous: ContactState, formData: FormData) => Promise<ContactState>;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL);
  const errors: ContactFieldErrors = state.fieldErrors ?? {};
  const values = state.values ?? {};

  if (state.status === "sent") {
    return (
      <div role="status" className="rounded-lg border border-success/30 bg-success-tint p-5">
        <p className="font-display text-2xl font-semibold text-brand-navy">Message envoyé</p>
        <p className="mt-2 text-sm text-ink-strong">{state.message}</p>
      </div>
    );
  }

  return (
    <form action={formAction} noValidate className="grid gap-4" aria-label="Formulaire de contact">
      {state.status === "error" && state.message ? (
        <p
          role="alert"
          className="rounded-md border border-danger/30 bg-danger-tint p-3 text-sm text-danger"
        >
          {state.message}
        </p>
      ) : null}

      <Field label="Nom" name="name" error={errors.name}>
        <input
          id="contact-name"
          name="name"
          autoComplete="name"
          required
          maxLength={CONTACT_LIMITS.name}
          defaultValue={values.name}
          aria-invalid={Boolean(errors.name)}
          aria-describedby={errors.name ? "contact-name-error" : undefined}
          className="form-input h-11"
        />
      </Field>

      <Field label="Adresse email" name="email" error={errors.email}>
        <input
          id="contact-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          maxLength={CONTACT_LIMITS.email}
          defaultValue={values.email}
          aria-invalid={Boolean(errors.email)}
          aria-describedby={errors.email ? "contact-email-error" : undefined}
          className="form-input h-11"
        />
      </Field>

      <Field label="Sujet" name="subject" error={errors.subject}>
        <select
          id="contact-subject"
          name="subject"
          required
          defaultValue={values.subject ?? ""}
          aria-invalid={Boolean(errors.subject)}
          aria-describedby={errors.subject ? "contact-subject-error" : undefined}
          className="form-input h-11 cursor-pointer"
        >
          <option value="" disabled>
            Choisissez un sujet
          </option>
          {CONTACT_SUBJECTS.map((subject) => (
            <option key={subject.value} value={subject.value}>
              {subject.label}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Message"
        name="message"
        error={errors.message}
        hint="Indiquez l’identifiant ou l’adresse de la vente concernée, si vous en avez une."
      >
        <textarea
          id="contact-message"
          name="message"
          required
          rows={6}
          maxLength={CONTACT_LIMITS.message}
          defaultValue={values.message}
          aria-invalid={Boolean(errors.message)}
          aria-describedby={[
            errors.message ? "contact-message-error" : null,
            "contact-message-hint",
          ]
            .filter(Boolean)
            .join(" ")}
          className="form-textarea"
        />
      </Field>

      {/* Piège à robots : invisible et hors parcours clavier. */}
      <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>
          Ne pas remplir
          <input name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      <Button
        type="submit"
        variant="dark"
        size="lg"
        disabled={pending}
        className="w-full sm:w-auto"
      >
        {pending ? "Envoi en cours…" : "Envoyer le message"}
      </Button>
    </form>
  );
}

function Field({
  label,
  name,
  error,
  hint,
  children,
}: {
  label: string;
  name: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={`contact-${name}`} className="text-sm font-semibold text-brand-navy">
        {label}
      </label>
      {children}
      {hint ? (
        <p id={`contact-${name}-hint`} className="text-xs text-ink-soft">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`contact-${name}-error`} className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
