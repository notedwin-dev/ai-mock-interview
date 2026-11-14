import { describe, expect, it } from "vitest";
import { evaluateBaseUrl } from "./ssrf";

describe("evaluateBaseUrl (BYOK Base URL guard)", () => {
  it("accepts canonical provider endpoints", () => {
    for (const url of [
      "https://api.openai.com/v1",
      "https://api.anthropic.com",
      "http://provider.example.com:8080/v1",
      "https://gateway.corp.example.com",
    ]) {
      expect(evaluateBaseUrl(url)).toMatchObject({ ok: true });
    }
  });

  it("accepts public IP-literal endpoints", () => {
    expect(evaluateBaseUrl("https://8.8.8.8/v1")).toMatchObject({ ok: true });
    expect(evaluateBaseUrl("https://[2606:4700::1111]/v1")).toMatchObject({
      ok: true,
    });
  });

  it("rejects non-absolute URLs", () => {
    expect(evaluateBaseUrl("api.openai.com/v1")).toMatchObject({
      ok: false,
      reason: "not_an_absolute_url",
    });
    expect(evaluateBaseUrl("")).toMatchObject({
      ok: false,
      reason: "not_an_absolute_url",
    });
  });

  it("rejects unsupported protocols", () => {
    for (const url of ["ftp://api.openai.com/v1", "file:///etc/passwd", "javascript:alert(1)"]) {
      expect(evaluateBaseUrl(url)).toMatchObject({
        ok: false,
        reason: "unsupported_protocol",
      });
    }
  });

  it("rejects embedded credentials", () => {
    expect(evaluateBaseUrl("https://user:pass@api.openai.com/v1")).toMatchObject({
      ok: false,
      reason: "credentials_in_url",
    });
  });

  it("rejects loopback and private hostnames", () => {
    for (const url of [
      "http://localhost:11434/v1",
      "http://sub.localhost/v1",
      "http://myserver.local/v1",
      "http://svc.internal/v1",
    ]) {
      expect(evaluateBaseUrl(url)).toMatchObject({
        ok: false,
        reason: "blocked_hostname",
      });
    }
  });

  it("rejects loopback, private, link-local and metadata IP literals", () => {
    for (const url of [
      "http://127.0.0.1:8080/v1",
      "http://127.10.20.30/v1",
      "http://10.1.2.3/v1",
      "http://172.16.0.5/v1",
      "http://172.31.255.255/v1",
      "http://192.168.1.50/v1",
      "http://169.254.169.254/latest/meta-data",
      "http://0.0.0.0/v1",
      "http://100.100.1.1/v1",
      "http://[::1]/v1",
      "http://[::1]:8080/v1",
      "http://[fe80::1]/v1",
      "http://[fd00::1]/v1",
      // WHATWG serialises ::ffff:192.168.0.10 as ::ffff:c0a8:a — the hex form
      // must be blocked even though the dotted form never survives parsing.
      "http://[::ffff:192.168.0.10]/v1",
      "http://[::ffff:c0a8:a]/v1",
      // WHATWG normalises decimal/hex/octal/shorthand IPv4 into a dotted quad,
      // so these all arrive as 127.0.0.1 and are blocked with it.
      "http://2130706433/",
      "http://0x7f.0.0.1/",
      "http://127.1/",
    ]) {
      expect(evaluateBaseUrl(url)).toMatchObject({
        ok: false,
        reason: "blocked_address",
      });
    }
  });

  it("fails closed on IPv4-mapped public addresses (0000::/8 is reserved)", () => {
    expect(evaluateBaseUrl("http://[::ffff:8.8.8.8]/v1")).toMatchObject({
      ok: false,
      reason: "blocked_address",
    });
  });

  it("allows non-private 172.x and 192.x ranges", () => {
    expect(evaluateBaseUrl("https://172.32.0.1/v1")).toMatchObject({ ok: true });
    expect(evaluateBaseUrl("https://192.169.0.1/v1")).toMatchObject({ ok: true });
  });

  it("normalises accepted URLs", () => {
    const decision = evaluateBaseUrl("  https://api.openai.com/v1  ");
    expect(decision).toMatchObject({
      ok: true,
      normalizedUrl: "https://api.openai.com/v1",
    });
  });
});
