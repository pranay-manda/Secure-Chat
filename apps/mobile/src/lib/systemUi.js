/**
 * System screens the app opens itself (the photo picker, permission dialogs) pause the app
 * exactly as if the user had left it: Android reports "background". The user is still in the
 * app, though, so work that normally stops in the background (the live connection, online
 * status) keeps going while such a screen is open. Without this, every photo pick dropped the
 * connection and showed "Connecting…" on return, and the other person briefly saw "offline".
 *
 * The grace is bounded by SYSTEM_UI_MAX_MS: a user who goes to the home screen from the picker
 * and stays away is treated as in the background after that.
 */
export const SYSTEM_UI_MAX_MS = 2 * 60 * 1000;

let open = 0;
let openedAt = 0;

/** Runs `task` (which opens a system screen) with the grace in effect. Returns its result. */
export async function withSystemUi(task) {
  open += 1;
  openedAt = Date.now();
  try {
    return await task();
  } finally {
    open = Math.max(0, open - 1);
  }
}

/** How much longer the grace lasts (ms), or 0 when no system screen of ours is open. */
export function systemUiGraceMs(now = Date.now()) {
  return open > 0 ? Math.max(0, openedAt + SYSTEM_UI_MAX_MS - now) : 0;
}
