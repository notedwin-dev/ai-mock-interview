/**
 * Raised by `RoomStore.openUnit` when the (session, unit number) pair is already
 * claimed by another turn. It is the ONLY failure the room turn treats as a
 * concurrency conflict — every other store failure propagates unchanged.
 */
export class UnitConflictError extends Error {
  constructor() {
    super("The assessment unit is already owned by another turn.");
    this.name = "UnitConflictError";
  }
}
