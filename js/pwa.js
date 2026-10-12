/* Registers the service worker (offline support + installability).
 * Does nothing on file:// or in browsers without service worker support, so opening index.html
 * straight from disk keeps working exactly as before. */
(function () {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

  // Resolve sw.js relative to this script (js/pwa.js -> ../sw.js) so it is found at the domain
  // root and under /<repo-name>/ alike, even if the page was opened without a trailing slash.
  var script = document.currentScript;
  var swUrl = script && script.src ? new URL('../sw.js', script.src).href : 'sw.js';

  function register() {
    navigator.serviceWorker.register(swUrl, { updateViaCache: 'none' }).catch(function (err) {
      console.warn('Movie Vault: service worker not registered', err);
    });
  }

  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register);
})();
