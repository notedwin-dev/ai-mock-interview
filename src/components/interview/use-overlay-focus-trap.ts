"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * Overlay/dialog focus behaviour shared by the interview room and the WebRTC
 * room (TT-8 review fix — the two components duplicated this verbatim).
 *
 * When `open` becomes true: move focus into the panel, trap Tab/Shift+Tab
 * inside it, close on Escape, and on close return focus to the element that
 * opened it. The container must be focusable (tabIndex={-1}).
 *
 * `onClose` is read through a ref that is synced in an effect, so the focus
 * effect only re-runs when `open` changes — depending on `onClose` directly
 * would re-run it on every render (the caller passes an inline closer) and the
 * cleanup would keep restoring focus to the opener while the overlay is open.
 */
export function useOverlayFocusTrap(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Focus a real control, not the panel: Shift+Tab from the panel would land
    // on the backdrop before the dialog and escape the focus trap.
    const firstControl = panelRef.current?.querySelector<HTMLElement>(
      'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    (firstControl ?? panelRef.current)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      // Keep keyboard focus inside the modal panel.
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
    // `panelRef` is a stable RefObject; `onClose` is tracked via onCloseRef.
  }, [open, panelRef]);
}
