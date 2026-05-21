import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { ImageOff } from "lucide-react";
import { getSourceImage } from "@/lib/source-image.functions";
import { Skeleton } from "@/components/ui/skeleton";

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
        className={`flex items-center justify-center bg-muted text-muted-foreground ${className ?? "h-64 w-full"}`}
      >
        <div className="flex flex-col items-center gap-1 text-xs">
          <ImageOff className="h-5 w-5" />
          <span>Pas d'illustration disponible</span>
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