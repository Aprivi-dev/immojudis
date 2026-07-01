import { cn } from "@/lib/utils";

export type PropertySectionItem = {
  id: string;
  label: string;
};

export function SectionNav({
  sections,
  activeSection,
}: {
  sections: PropertySectionItem[];
  activeSection: string;
}) {
  return (
    <nav
      aria-label="Sections de la fiche"
      className="sticky top-[72px] z-30 border-y border-border bg-white/92 backdrop-blur"
    >
      <div className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 sm:px-6 lg:px-8">
        {sections.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            aria-current={activeSection === section.id ? "true" : undefined}
            className={cn(
              "inline-flex min-h-12 shrink-0 cursor-pointer items-center border-b-2 px-3 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-gold",
              activeSection === section.id
                ? "border-gold text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {section.label}
          </a>
        ))}
      </div>
    </nav>
  );
}
