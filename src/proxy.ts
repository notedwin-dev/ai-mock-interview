import { NextResponse, type NextRequest } from "next/server";

// Auth.js v5 default session cookies (plain HTTP and the __Secure- variant
// used over HTTPS). The cookie's presence is only a cheap UX redirect signal —
// real authorization always re-validates the account against the database
// inside src/lib/auth/guard.ts.
const SESSION_COOKIE_NAMES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
];
const PROTECTED_PREFIXES = ["/dashboard"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSessionCookie = SESSION_COOKIE_NAMES.some((name) =>
    request.cookies.has(name),
  );

  // Only gate protected pages. Do NOT bounce visitors with a session cookie
  // away from /signin or /signup: a stale/invalid cookie would make the guard
  // redirect /dashboard -> /signin while this proxy bounces /signin ->
  // /dashboard forever. The sign-in page is safe to render for anyone; a
  // genuinely signed-in user who lands there can simply sign in again.
  // Authorization is always re-checked in src/lib/auth/guard.ts.
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
