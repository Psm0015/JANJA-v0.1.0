async function toggleFullscreen() {
  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement;
  if (fullscreenElement) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (exit) await exit.call(document);
    return;
  }
  const el = stageEl || videoEl;
  if (!el) return;
  const fallback = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
  if (fallback) await fallback.call(el);
}
