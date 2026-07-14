import Camera from "lucide-react/dist/esm/icons/camera.js";
import RotateCw from "lucide-react/dist/esm/icons/rotate-cw.js";
import { cn } from "@/lib/utils";

export function RotatingCamera360({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none grid h-9 w-9 select-none place-items-center text-white drop-shadow-[0_2px_5px_rgba(7,17,31,0.95)]",
        className,
      )}
    >
      <span className="relative grid h-8 w-8 place-items-center">
        <span className="absolute inset-0 motion-safe:animate-[spin_4s_linear_infinite] motion-reduce:animate-none">
          <RotateCw className="h-full w-full" />
        </span>
        <Camera className="h-4 w-4" />
      </span>
    </div>
  );
}
