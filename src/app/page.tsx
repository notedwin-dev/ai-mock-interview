import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import illustration from "../../public/illustration.png";

export const metadata: Metadata = {
  title: "AIMIS — practise job interviews with AI",
};

/**
 * Public landing page: one spacious banner card on the room grid — headline,
 * one supporting line, two actions, the practice illustration. No decoration
 * beyond that (the reference kit keeps marketing surfaces restrained).
 */

const PRIMARY_PILL =
  "inline-flex h-11 cursor-pointer items-center justify-center rounded-full bg-emerald-400 px-6 text-sm font-semibold text-emerald-950 outline-none transition-all hover:bg-emerald-300 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-emerald-400";
const GHOST_PILL =
  "inline-flex h-11 cursor-pointer items-center justify-center rounded-full border border-line bg-surface px-6 text-sm font-semibold text-ink outline-none transition-colors hover:border-ink-muted active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-emerald-400";

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16 lg:py-24">
      <BrandMark />
      <section className="mt-8 w-full max-w-3xl rounded-3xl border border-line bg-raised p-8 sm:p-12">
        <div className="flex flex-col gap-8 lg:grid lg:grid-cols-[minmax(0,1fr)_16rem] lg:items-center">
          <div>
            <h1 className="font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
              The green room for your next interview.
            </h1>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-ink-muted sm:text-base">
              Set up a mock interview, step into the room, and answer the AI
              interviewer&apos;s questions. Your transcript stays with you for
              review.
            </p>
            <nav className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Link href="/signin" className={PRIMARY_PILL}>
                Sign in
              </Link>
              <Link href="/signup" className={GHOST_PILL}>
                Create account
              </Link>
            </nav>
          </div>
          <Image
            src={illustration}
            alt=""
            aria-hidden
            className="hidden h-44 object-contain lg:block"
          />
        </div>
      </section>
    </main>
  );
}
