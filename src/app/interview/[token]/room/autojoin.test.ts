import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the one-click join (BLOCKING review finding). The
 * waiting room's "Join now" navigates to the room page with ?autojoin=1 and the
 * room page MUST read that flag from searchParams and forward it to
 * WebRTCRoom, which connects on mount. If the page ignores searchParams the
 * flag is silently dropped and join degrades to two clicks. Next does not
 * expose the page's searchParams to a plain unit import, so the wiring is
 * asserted at the source boundary on both ends of the contract.
 */
const ROOM_PAGE = "src/app/interview/[token]/room/page.tsx";
const WAITING_ROOM = "src/components/interview/WaitingRoom.tsx";

describe("one-click join (?autojoin=1)", () => {
  it("waiting room navigates to the room page with the autojoin flag", () => {
    const source = readFileSync(WAITING_ROOM, "utf8");
    expect(source).toMatch(/autojoin=1/);
    expect(source).toMatch(/\/interview\/\$\{token\}\/room\?autojoin=1/);
  });

  it("room page reads the autojoin flag from searchParams and forwards it to WebRTCRoom", () => {
    const source = readFileSync(ROOM_PAGE, "utf8");
    // Request-time URL data: awaited, not read from the client.
    expect(source).toContain("await props.searchParams");
    expect(source).toMatch(/autojoin\s*===\s*"1"/);
    // The flag reaches the room component as the autoJoin prop.
    expect(source).toMatch(/<WebRTCRoom[^>]*autoJoin=/s);
    // Reading searchParams opts the page into dynamic rendering; it must stay
    // a request-time (non-instant) page.
    expect(source).toMatch(/export const instant = false;/);
  });
});
