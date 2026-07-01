import Image from "next/image";
import { cn } from "@/lib/utils";

type PropertyImageProps = {
  src: string;
  alt: string;
  className?: string;
  priority?: boolean;
};

export function PropertyImage({ src, alt, className, priority = false }: PropertyImageProps) {
  return (
    <span className="relative block h-full w-full">
      <Image
        src={src}
        alt={alt}
        fill
        sizes="(max-width: 768px) 100vw, (max-width: 1280px) 50vw, 760px"
        priority={priority}
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : "auto"}
        className={cn("object-cover", className)}
      />
    </span>
  );
}
