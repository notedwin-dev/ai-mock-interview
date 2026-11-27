import Link from 'next/link';
import Image from 'next/image';

export function BrandMark({ href }: { href?: string }) {
  const mark = (
    <span className="flex items-center gap-2.5">
      <Image
        src="/logo.png"
        width={100}
        height={100}
        alt="AIMIS"
        className="h-9 w-9 object-contain"
        priority
      />

      <span className="font-display text-lg font-bold tracking-tight text-ink">
        AIMIS
      </span>
    </span>
  );

  if (!href) return mark;

  return (
    <Link
      href={href}
      className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
      {mark}
    </Link>
  );
}
