import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import { getSourceImage } from "@/lib/source-image.functions";
import { Skeleton } from "@/components/ui/skeleton";
import { BrandMark } from "@/components/BrandLogo";

export function SourceImage({
  sourceUrl,
  alt,
  className,
}: {
  sourceUrl: string;
  alt?: string;
  className?: string;
}) {
  const fetchImage = useServerFn(getSourceImage);
  const [errored, setErrored] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["source-image", sourceUrl],
    queryFn: () => fetchImage({ data: { url: sourceUrl } }),
    staleTime: 7 * 24 * 60 * 60_000,
    gcTime: 7 * 24 * 60 * 60_000,
    retry: 1,
  });

  if (isLoading) {
    return <Skeleton className={className ?? "h-64 w-full"} />;
  }

  if (!data?.imageUrl || errored) {
    return (
      <div
        className={`relative flex items-center justify-center overflow-hidden bg-[var(--surface)] text-muted-foreground ${className ?? "h-64 w-full"}`}
      >
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(242,196,135,0.18),transparent_34%),linear-gradient(135deg,rgba(21,19,17,0.95),rgba(8,8,10,0.98))]" />
        <BrandMark className="absolute right-4 top-4 h-20 w-20 opacity-20" />
        <div className="relative flex flex-col items-center gap-2 px-6 text-center text-xs">
          <FileText className="h-5 w-5 text-[var(--gold)]" />
          <span>Document source sans visuel</span>
        </div>
      </div>
    );
  }

  return (
    <img
      src={data.imageUrl}
      alt={alt ?? "Illustration de l'annonce"}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setErrored(true)}
      className={`object-cover ${className ?? "h-64 w-full"}`}
    />
  );
}
