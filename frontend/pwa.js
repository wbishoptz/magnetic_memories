// Registers the service worker so the site can be installed to the home screen
// and still loads when the connection drops. Fails silently if unsupported.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
