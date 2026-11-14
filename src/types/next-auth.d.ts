import type { DefaultSession } from "next-auth";

// Auth.js v5 module augmentation: the AIMIS Credentials provider returns the
// account id and its single role (FR-AUTH-004), and both must survive the
// JWT round-trip onto every session.
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: string;
    } & DefaultSession["user"];
  }

  interface User {
    id?: string;
    role?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role?: string;
  }
}
