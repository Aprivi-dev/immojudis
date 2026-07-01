import { motion } from "framer-motion";
import type { PropsWithChildren } from "react";
import { cn } from "@/lib/utils";

type AnimatedSectionProps = PropsWithChildren<{
  id: string;
  className?: string;
  "aria-labelledby"?: string;
}>;

export function AnimatedSection({
  id,
  className,
  children,
  "aria-labelledby": ariaLabelledBy,
}: AnimatedSectionProps) {
  return (
    <motion.section
      id={id}
      aria-labelledby={ariaLabelledBy}
      className={cn("scroll-mt-28", className)}
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.18 }}
      transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.section>
  );
}
