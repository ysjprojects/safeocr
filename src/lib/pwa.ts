/**
 * The app-shell service worker (public/sw.js). In production it is registered once the page has
 * loaded, so it does not compete with first-paint resources. Anywhere else it is actively removed:
 * a worker left behind by a production run on the same origin would serve stale chunks to the dev
 * server and trap Fast Refresh in a reload loop.
 */

/**
 * Inline script for `_document.tsx` in development. The document comes from the network even
 * under a stale worker (navigations are network-first), so this runs before any cached chunk can:
 * it unregisters every worker, drops the shell caches, and reloads once so the page runs fresh.
 */
export const UNREGISTER_BOOT_SCRIPT =
  `(function(){if(!('serviceWorker' in navigator))return;` +
  `var had=!!navigator.serviceWorker.controller;` +
  `navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister()}))})` +
  `.then(function(){return 'caches' in window?caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k.indexOf('safeocr-shell')===0}).map(function(k){return caches.delete(k)}))}):null})` +
  `.then(function(){if(had&&!sessionStorage.getItem('safeocr-sw-reset')){sessionStorage.setItem('safeocr-sw-reset','1');location.reload()}else{sessionStorage.removeItem('safeocr-sw-reset')}})` +
  `.catch(function(){})})()`;

export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  if (process.env.NODE_ENV !== 'production') {
    void navigator.serviceWorker.getRegistrations().then(registrations => registrations.map(r => r.unregister()));
    return;
  }
  const register = () => {
    navigator.serviceWorker
      .register('/sw.js')
      .catch(error => console.debug('service worker registration failed', error));
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, {once: true});
}
