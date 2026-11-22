import { describe, expect, it } from "vitest";
import { credentialsSchema, registrationSchema } from "./validation";

const validRegistration = {
  email: "Candidate@Example.com",
  password: "password1",
  displayName: "  Jamie Doe  ",
  role: "candidate",
};

describe("registrationSchema", () => {
  it("accepts a valid registration and normalises email and display name", () => {
    const parsed = registrationSchema.parse(validRegistration);
    expect(parsed.email).toBe("candidate@example.com");
    expect(parsed.displayName).toBe("Jamie Doe");
    expect(parsed.role).toBe("candidate");
  });

  it("accepts a recruiter account (FR-AUTH-004: exactly one role per account)", () => {
    expect(
      registrationSchema.parse({ ...validRegistration, role: "recruiter" })
        .role,
    ).toBe("recruiter");
  });

  it("rejects administrator self-registration", () => {
    expect(() =>
      registrationSchema.parse({ ...validRegistration, role: "administrator" }),
    ).toThrow();
  });

  it("rejects passwords shorter than 8 characters", () => {
    expect(() =>
      registrationSchema.parse({ ...validRegistration, password: "ab1" }),
    ).toThrow();
  });

  it("rejects passwords without a digit", () => {
    expect(() =>
      registrationSchema.parse({
        ...validRegistration,
        password: "abcdefgh",
      }),
    ).toThrow();
  });

  it("rejects passwords without a letter", () => {
    expect(() =>
      registrationSchema.parse({
        ...validRegistration,
        password: "12345678",
      }),
    ).toThrow();
  });

  it("rejects an invalid email", () => {
    expect(() =>
      registrationSchema.parse({ ...validRegistration, email: "not-an-email" }),
    ).toThrow();
  });

  it("rejects a blank display name", () => {
    expect(() =>
      registrationSchema.parse({ ...validRegistration, displayName: "   " }),
    ).toThrow();
  });

  it("rejects a display name longer than the VARCHAR(100) limit", () => {
    expect(() =>
      registrationSchema.parse({
        ...validRegistration,
        displayName: "x".repeat(101),
      }),
    ).toThrow();
  });
});

describe("credentialsSchema (sign-in path)", () => {
  it("normalises the email before the database lookup", () => {
    const parsed = credentialsSchema.parse({
      email: "  User@Example.COM ",
      password: "x",
    });
    expect(parsed.email).toBe("user@example.com");
  });

  it("accepts any non-empty password (the policy governs registration only)", () => {
    expect(
      credentialsSchema.parse({ email: "u@example.com", password: "legacy" })
        .password,
    ).toBe("legacy");
  });

  it("rejects an empty password", () => {
    expect(() =>
      credentialsSchema.parse({ email: "u@example.com", password: "" }),
    ).toThrow();
  });
});
