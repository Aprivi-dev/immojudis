import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import type { SaleDocument } from "@/lib/types";

function parseDocs(raw: unknown): SaleDocument[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((d): SaleDocument | null => {
        if (typeof d === "string") return { url: d };
        if (
          d &&
          typeof d === "object" &&
          "url" in d &&
          typeof (d as { url: unknown }).url === "string"
        ) {
          return d as SaleDocument;
        }
        return null;
      })
      .filter((d): d is SaleDocument => d !== null);
  }
  if (typeof raw === "object" && raw !== null) {
    return Object.values(raw as Record<string, unknown>)
      .filter((v): v is string => typeof v === "string")
      .map((url) => ({ url }));
  }
  return [];
}

export function DocumentsList({ documents }: { documents: unknown }) {
  const docs = parseDocs(documents);
  if (docs.length === 0) {
    return <p className="text-sm text-muted-foreground">Aucun document attaché.</p>;
  }
  return (
    <ul className="space-y-2">
      {docs.map((d, i) => (
        <li key={i}>
          <a
            href={d.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm hover:bg-accent"
          >
            <FileText className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1 truncate">
              {d.name ?? d.url.split("/").pop() ?? `Document ${i + 1}`}
            </span>
            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
          </a>
        </li>
      ))}
    </ul>
  );
}
