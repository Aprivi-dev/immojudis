import type { SVGProps } from "react";

/**
 * Icônes de l'accueil : Phosphor Icons, graisse « regular » (licence MIT, Copyright (c) 2023
 * Phosphor Icons), tracés recopiés du paquet `@phosphor-icons/core` 2.1.1 (`assets/regular/`). Pas
 * de dépendance pour une dizaine d'icônes ; le reste du site garde Lucide.
 */
type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number };

function icon(path: string) {
  return function PhosphorIcon({ size = 20, ...props }: IconProps) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 256 256"
        width={size}
        height={size}
        fill="currentColor"
        aria-hidden
        focusable="false"
        {...props}
      >
        <path d={path} />
      </svg>
    );
  };
}

export const ArrowRight = icon(
  "M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z",
);
export const ShieldCheck = icon(
  "M208,40H48A16,16,0,0,0,32,56v56c0,52.72,25.52,84.67,46.93,102.19,23.06,18.86,46,25.26,47,25.53a8,8,0,0,0,4.2,0c1-.27,23.91-6.67,47-25.53C198.48,196.67,224,164.72,224,112V56A16,16,0,0,0,208,40Zm0,72c0,37.07-13.66,67.16-40.6,89.42A129.3,129.3,0,0,1,128,223.62a128.25,128.25,0,0,1-38.92-21.81C61.82,179.51,48,149.3,48,112l0-56,160,0ZM82.34,141.66a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35a8,8,0,0,1,11.32,11.32l-56,56a8,8,0,0,1-11.32,0Z",
);
export const Check = icon(
  "M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z",
);
