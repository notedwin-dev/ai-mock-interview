import { NextResponse, type NextRequest } from "next/server";

// Auth.js v5 default session cookies (plain HTTP and the __Secure- variant
// used over HTTPS). The cookie's presence is only a cheap UX redirect signal
// — real authorization always re-validates the account against the database
// inside src/lib/auth/guard.ts.
const SESSION_COOKIE_NAMES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
];
const PROTECTED_PREFIXES = ["/dashboard"];
const AUTH_PAGES = ["/signin", "/signup"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSessionCookie = SESSION_COOKIE_NAMES.some((name) =>
    request.cookies.has(name),
  );

  // Bounce signed-in visitors away from the auth pages on plain navigation
  // only (GET). Server-action POSTs must pass through untouched so an
  // authenticated user can still sign in as a different account or register.
  if (
    hasSessionCookie &&
    request.method === "GET" &&
    AUTH_PAGES.some((prefix) => pathname.startsWith(prefix))
  ) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  if (
    !hasSessionCookie &&
    PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  ) {
    return NextResponse.redirect(new URL("/signin", request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Never intercept the Auth.js API routes or framework assets.
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico).*)"],
};
