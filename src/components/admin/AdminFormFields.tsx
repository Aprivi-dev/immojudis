/** Champs de formulaire des écrans admin. */
export function TextField({
  label,
  value,
  onChange,
  type = "text",
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
      {label}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        type={type}
        required={required}
        className="rounded-lg border border-brand-navy/10 bg-white px-3 py-2.5 text-sm normal-case tracking-normal text-foreground outline-none transition focus:border-gold"
      />
    </label>
  );
}
