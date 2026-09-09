/**
 * Opens the print dialog, having first shown that something is happening.
 *
 * `window.print()` blocks while the browser lays the page out, and on a full
 * sheet that is a second or more of a screen that looks frozen. Two things
 * are needed to make that visible. React has to paint before the call, which
 * takes two frames — one to commit the state, one to put it on the glass; a
 * single frame commits but never reaches the screen. And the indicator has to
 * be an overlay rather than a change of button label, because by the time
 * somebody has filled in the sheet they have scrolled the toolbar off the top
 * of the page and would never see it.
 *
 * Cleared by `afterprint`, and deliberately NOT when print() returns. Safari
 * returns from that call straight away and carries on building the sheet in
 * the background, so clearing there made the indicator flash up and vanish
 * while the wait it was reporting had barely started.
 */
export function openPrintDialog(setPrinting: (printing: boolean) => void) {
  setPrinting(true);

  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    window.removeEventListener('afterprint', done);
    window.clearTimeout(guard);
    setPrinting(false);
  };
  // Backstop for a browser that never fires afterprint. Long, because
  // stopping early is the failure people actually notice.
  const guard = window.setTimeout(done, 60000);
  window.addEventListener('afterprint', done);

  requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
}
