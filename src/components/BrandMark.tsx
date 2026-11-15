import Link from "next/link";
import { Mic } from "lucide-react";

/**
 * AIMIS wordmark: a jade mic chip beside the name — the product is a voice
 * practice room, and the chip echoes the reference kit's logo-lockup pattern
 * without copying its brand. Optionally wrapped in a link.
 */
export function BrandMark({ href }: { href?: string }) {
  const mark = (
    <span className="flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-400 text-emerald-950">
        <Mic className="h-4 w-4" aria-hidden />
      </span>
      <span className="font-display text-lg font-bold tracking-tight text-ink">
        AIMIS
      </span>
    </span>
  );

  if (!href) {
    return mark;
  }

  return (
    <Link
      href={href}
      className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
    >
      {mark}
    </Link>
  );
}
