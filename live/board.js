/**
 * Ruta /live board rendering, shared by the page and the build.
 *
 * This used to live inline in index.html, which meant the board existed only after JavaScript
 * ran. Fetched without a JS engine the page returned the word "Loading...", so answer engines,
 * social preview cards and crawlers that do not execute JS saw an empty document, and Google
 * indexed the loading state because it defers rendering.
 *
 * scripts/bake-live.js now renders the same markup at build time and writes it into the HTML,
 * and the page still fetches on load to refresh it. Both sides call the functions below, so
 * there is one definition of what a row looks like rather than two that drift apart. Returns
 * HTML strings and touches no DOM, which is what lets it run under Node.
 *
 * Plain UMD on purpose: the site is static, has no build step, and should not acquire one for
 * this.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RutaBoard = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Delay level -> colour. 0 calm through 4 severe, kept on-brand.
  var LEVEL_COLORS = ['#5C9B7A', '#4F7C82', '#D19E52', '#CB6B63', '#A84C44'];

  function esc(x) {
    return String(x == null ? '' : x)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Relative time, for the live refresh. The build writes an absolute time instead. */
  function ago(iso, nowMs) {
    try {
      var d = new Date(iso);
      var m = Math.round(((nowMs == null ? Date.now() : nowMs) - d.getTime()) / 60000);
      if (!isFinite(m) || m < 0) return '';
      if (m < 1) return 'just now';
      if (m < 60) return m + ' min ago';
      var h = Math.round(m / 60);
      return h + ' hr ago';
    } catch (e) { return ''; }
  }

  /**
   * A link we are willing to make clickable, or null.
   *
   * Alert URLs come from a news feed, which is to say from outside. Escaping the quotes keeps a
   * value inside the href attribute but does nothing about the scheme, so 'javascript:...' would
   * have rendered as a working link on a public page. http and https only; anything else shows
   * the source as plain text instead, which loses a link and nothing more.
   */
  function safeUrl(u) {
    var v = String(u == null ? '' : u).trim();
    if (!/^https?:\/\//i.test(v)) return null;
    return v;
  }

  function reasonLine(a) {
    var bits = [];
    if (a.level >= 1 && a.medianDelay) bits.push('typically ' + a.medianDelay + ' min late');
    if (a.cancelled) bits.push(a.cancelled + ' cancelled');
    var detail = bits.length ? (' · ' + bits.join(' · ')) : '';
    return (a.status || '') + detail;
  }

  function alertsHtml(alerts) {
    if (!alerts || !alerts.length) return '';
    var h = '<div class="sec-h">Travel alerts</div>'
      + '<div class="sec-sub">Curated from public news. Strikes, closures, security and system outages that can reshape a travel day.</div>';
    alerts.forEach(function (a) {
      var tags = [].concat(a.airports || []).concat(a.countries || []);
      var tagHtml = tags.length
        ? ('<div class="tags">' + tags.map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') + '</div>')
        : '';
      var src = '';
      var href = safeUrl(a.url);
      if (href) src = '<a href="' + esc(href) + '" target="_blank" rel="noopener nofollow">' + esc(a.source || 'Read more') + '</a>';
      else if (a.source) src = esc(a.source);
      var meta = src ? ('<div class="ameta">Source: ' + src + '</div>') : '';
      // Lead with the English summary (the classifier always writes it in English). The raw
      // source headline is intentionally not shown, it can be in the source's original
      // language, which reads as a blunder on an English board. Source link stays.
      var lead = a.summary || a.title;
      h += '<div class="alert"><div class="when">' + esc(a.when || 'Ongoing') + '</div>'
        + (lead ? '<div class="atitle">' + esc(lead) + '</div>' : '')
        + tagHtml + meta + '</div>';
    });
    return h;
  }

  var CLEAR_BOARD = '<div class="clear"><div class="big">The skies are running clear.</div>'
    + '<div>No notable delays at the major hubs we track right now. Refresh anytime.</div></div>';

  var CLEAR_ALL = '<div class="clear"><div class="big">The skies are running clear.</div>'
    + '<div>No notable delays or alerts at the hubs we track right now. Refresh anytime.</div></div>';

  function boardHtml(regions) {
    if (!regions || !regions.length) return CLEAR_BOARD;
    var h = '';
    regions.forEach(function (reg) {
      h += '<div class="sec-h">' + esc(reg.region) + '</div><div class="region">';
      (reg.airports || []).forEach(function (a) {
        var color = LEVEL_COLORS[a.level] || '#4F7C82';
        var note = a.note ? ('<div class="note">' + esc(a.note) + '</div>') : '';
        h += '<div class="row"><span class="dot" style="background:' + color + '"></span>'
          + '<div class="apt">' + esc(a.airport) + '</div>'
          + '<div class="txt"><div class="name">' + esc(a.city || a.airport) + '</div>'
          + '<div class="reason">' + esc(reasonLine(a)) + '</div>' + note + '</div></div>';
      });
      h += '</div>';
    });
    return h;
  }

  /**
   * Everything the page shows, as strings. One call so the page and the build cannot disagree
   * about the empty case, which is the branch most likely to drift.
   */
  function renderAll(d) {
    d = d || {};
    var alerts = alertsHtml(d.alerts);
    var board = boardHtml(d.regions);
    var nothing = (!d.alerts || !d.alerts.length) && (!d.regions || !d.regions.length);
    if (nothing) board = CLEAR_ALL;
    return { alerts: alerts, board: board };
  }

  return {
    LEVEL_COLORS: LEVEL_COLORS,
    esc: esc, ago: ago, reasonLine: reasonLine, safeUrl: safeUrl,
    alertsHtml: alertsHtml, boardHtml: boardHtml, renderAll: renderAll,
  };
}));
