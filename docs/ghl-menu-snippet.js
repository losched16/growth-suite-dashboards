/**
 * Growth Suite — per-sub-account CRM menu hider.
 *
 * GHL has no native per-location menu toggle, so this agency-level snippet
 * hides sidebar items per sub-account, driven by each school's own settings
 * in Growth Suite (school Settings → CRM sidebar menus). Install ONCE:
 *
 *   Agency view → Settings → Company → Custom Javascript  →  paste this file
 *
 * Notes:
 *  - Custom JS only runs on your WHITE-LABELED domain (not app.gohighlevel.com).
 *  - Unknown/unconfigured locations hide nothing, so it's safe agency-wide.
 *  - This is cosmetic decluttering, not security — a user with a deep link
 *    can still reach a hidden area. Use GHL user permissions for real access
 *    control.
 *  - Config is served by Growth Suite:
 *      GET https://growth-suite-dashboards.vercel.app/api/ghl-menu-config/{locationId}
 *    and cached for 5 minutes, so a settings change shows up on next reload.
 */
(function () {
  var API = 'https://growth-suite-dashboards.vercel.app/api/ghl-menu-config/';
  var cache = {};      // locationId → ['payments', ...]
  var current = null;  // locationId currently applied

  function apply(hide) {
    var el = document.getElementById('gs-menu-hide');
    if (!el) {
      el = document.createElement('style');
      el.id = 'gs-menu-hide';
      document.head.appendChild(el);
    }
    el.textContent = (hide || [])
      .map(function (h) { return '#sb_' + h + '{display:none !important;}'; })
      .join('\n');
  }

  function tick() {
    var m = window.location.pathname.match(/\/location\/([A-Za-z0-9]+)/);
    var loc = m && m[1];
    if (!loc) { if (current !== '') { current = ''; apply([]); } return; }
    if (loc === current) return;
    current = loc;
    if (cache[loc]) { apply(cache[loc]); return; }
    fetch(API + loc)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        cache[loc] = (d && d.hide) || [];
        if (current === loc) apply(cache[loc]);
      })
      .catch(function () { /* leave menus visible on any failure */ });
  }

  // GHL is an SPA — poll for location changes (cheap; string compare only).
  setInterval(tick, 800);
  tick();
})();
