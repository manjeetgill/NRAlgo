import { ButtonHTMLAttributes } from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// A small owned component following shadcn's composition approach.
// No component registry or external runtime is required.
export function Button({
  className,
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
}) {
  return (
    <button
      className={twMerge(clsx("button", `button-${variant}`, className))}
      {...props}
    />
  );
}
