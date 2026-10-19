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

  /**
   * The URL slug for an airport's own page: 'los-angeles-lax'.
   *
   * Defined here rather than in the generator because both sides need it and they must agree:
   * the board links to it, and scripts/bake-airports.js names the directory from it. A mismatch
   * is a 404 that nothing would catch until someone clicked.
   *
   * City first because that is the word people search with, code last because it disambiguates
   * the cities that share a name.
   */
  function slugFor(a) {
    var city = String((a && a.city) || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    var code = String((a && a.airport) || '').toLowerCase().trim();
    var base = (city + ' ' + code).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return base || code || null;
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

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  /**
   * The empty board, which used to say one thing about three different situations.
   *
   * `regions` carries only airports that HAVE a delay, so an empty board means either that every
   * hub we polled is quiet or that nothing reported at all. Both rendered as "The skies are
   * running clear", which is an all-clear over 44 airports drawn from, in the second case, zero
   * readings. The headline also read as a statement about the sky rather than about a board that
   * watches 44 major airports and not the other several thousand.
   *
   * `watched` and `reporting` come from the API. They are absent on a page served before the
   * server carrying them deploys, so that case keeps a vaguer line rather than inventing a count.
   */
  function clearHtml(d, alsoNoAlerts) {
    var watched = Number(d && d.watched) || 0;
    var reporting = Number(d && d.reporting) || 0;
    var tail = ' Refresh anytime.';
    if (watched && !reporting) {
      // Not an all clear. Saying so is the whole point of carrying the second number.
      return '<div class="clear"><div class="big">No readings right now.</div>'
        + '<div>None of the ' + plural(watched, 'hub', 'hubs') + ' we track reported on the last poll,'
        + ' so this is not an all clear.' + tail + '</div></div>';
    }
    var what = alsoNoAlerts ? 'No delays or alerts' : 'No notable delays';
    if (!watched) {
      return '<div class="clear"><div class="big">Clear at the hubs we track.</div>'
        + '<div>' + what + ' right now.' + tail + '</div></div>';
    }
    if (reporting < watched) {
      return '<div class="clear"><div class="big">Clear at the '
        + plural(reporting, 'hub', 'hubs') + ' reporting right now.</div>'
        + '<div>' + what + '. The other ' + plural(watched - reporting, 'hub', 'hubs')
        + ' we track had no reading on the last poll.' + tail + '</div></div>';
    }
    var head = watched === 1
      ? 'The hub we track is clear.'
      : ('All ' + watched + ' hubs we track are clear.');
    return '<div class="clear"><div class="big">' + head + '</div>'
      + '<div>' + what + ' right now. This board watches '
      + plural(watched, 'major airport', 'major airports')
      + ' rather than every airport.' + tail + '</div></div>';
  }

  function boardHtml(regions, d) {
    if (!regions || !regions.length) return clearHtml(d, false);
    var h = '';
    regions.forEach(function (reg) {
      h += '<div class="sec-h">' + esc(reg.region) + '</div><div class="region">';
      (reg.airports || []).forEach(function (a) {
        var color = LEVEL_COLORS[a.level] || '#4F7C82';
        var note = a.note ? ('<div class="note">' + esc(a.note) + '</div>') : '';
        // The row links to the airport's own page. Without a link from somewhere those pages are
        // orphans: generated, in the sitemap, and reachable by nothing a crawler follows.
        var slug = slugFor(a);
        var inner = '<span class="dot" style="background:' + color + '"></span>'
          + '<div class="apt">' + esc(a.airport) + '</div>'
          + '<div class="txt"><div class="name">' + esc(a.city || a.airport) + '</div>'
          + '<div class="reason">' + esc(reasonLine(a)) + '</div>' + note + '</div>';
        h += slug
          ? ('<a class="row row-link" href="/live/' + esc(slug) + '/">' + inner + '</a>')
          : ('<div class="row">' + inner + '</div>');
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
    var board = boardHtml(d.regions, d);
    var nothing = (!d.alerts || !d.alerts.length) && (!d.regions || !d.regions.length);
    if (nothing) board = clearHtml(d, true);
    return { alerts: alerts, board: board };
  }

  return {
    LEVEL_COLORS: LEVEL_COLORS,
    esc: esc, ago: ago, reasonLine: reasonLine, safeUrl: safeUrl, slugFor: slugFor,
    alertsHtml: alertsHtml, boardHtml: boardHtml, clearHtml: clearHtml, renderAll: renderAll,
  };
}));
