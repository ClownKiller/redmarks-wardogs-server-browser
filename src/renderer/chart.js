'use strict';
/*
 * RedMarks Wardogs Server Browser - tiny line chart
 * Draws [[timeMs, value], ...] as an SVG line. Written for this app.
 */

(function () {
  const NS = 'http://www.w3.org/2000/svg';

  function svgEl(name, attrs) {
    const e = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, String(v));
    return e;
  }

  function clean(points) {
    return (Array.isArray(points) ? points : [])
      .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .sort((a, b) => a[0] - b[0]);
  }

  function niceMax(v) {
    if (v <= 0) return 10;
    const step = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= v) return m * step;
    return 10 * step;
  }

  function fmtTime(ms, spanMs) {
    const d = new Date(ms);
    if (spanMs <= 36 * 3600 * 1000) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }

  /**
   * Full chart with axes and a hover readout.
   * opts: { readout: HTMLElement, unit: 'players', yMax: number }
   */
  function line(container, rawPoints, opts) {
    opts = opts || {};
    const points = clean(rawPoints);
    container.textContent = '';
    if (points.length < 2) {
      const p = document.createElement('div');
      p.className = 'dim';
      p.style.padding = '80px 0';
      p.style.textAlign = 'center';
      p.textContent = 'Not enough history yet for this time range.';
      container.appendChild(p);
      return;
    }

    const W = Math.max(container.clientWidth, 300);
    const H = Math.max(container.clientHeight, 150);
    const pad = { l: 64, r: 10, t: 10, b: 26 };
    const t0 = points[0][0];
    const t1 = points[points.length - 1][0];
    const span = Math.max(t1 - t0, 1);
    const yMax = opts.yMax || niceMax(Math.max(...points.map((p) => p[1])));
    const x = (t) => pad.l + ((t - t0) / span) * (W - pad.l - pad.r);
    const y = (v) => pad.t + (1 - v / yMax) * (H - pad.t - pad.b);

    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Player count over time' });

    for (const f of [0, 0.5, 1]) {
      const v = yMax * f;
      svg.appendChild(svgEl('line', { class: 'grid-line', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
      const lbl = svgEl('text', { class: 'axis-label', x: pad.l - 8, y: y(v) + 5, 'text-anchor': 'end' });
      lbl.textContent = Math.round(v).toLocaleString();
      svg.appendChild(lbl);
    }
    for (const [t, anchor] of [[t0, 'start'], [t0 + span / 2, 'middle'], [t1, 'end']]) {
      const lbl = svgEl('text', { class: 'axis-label', x: x(t), y: H - 6, 'text-anchor': anchor });
      lbl.textContent = fmtTime(t, span);
      svg.appendChild(lbl);
    }

    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
    svg.appendChild(svgEl('path', { class: 'area', d: `${d}L${x(t1).toFixed(1)},${y(0)}L${x(t0).toFixed(1)},${y(0)}Z` }));
    svg.appendChild(svgEl('path', { class: 'line', d }));

    const cursor = svgEl('line', { class: 'cursor', y1: pad.t, y2: H - pad.b, visibility: 'hidden' });
    const dot = svgEl('circle', { class: 'dot', r: 4, visibility: 'hidden' });
    svg.appendChild(cursor);
    svg.appendChild(dot);

    const unit = opts.unit || '';
    const readout = opts.readout;
    const showDefault = () => {
      if (!readout) return;
      const last = points[points.length - 1];
      readout.textContent = `Latest: ${Math.round(last[1]).toLocaleString()} ${unit}`;
    };
    showDefault();

    svg.addEventListener('mousemove', (ev) => {
      const box = svg.getBoundingClientRect();
      const mx = ((ev.clientX - box.left) / box.width) * W;
      const t = t0 + ((mx - pad.l) / (W - pad.l - pad.r)) * span;
      let best = points[0];
      for (const p of points) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
      cursor.setAttribute('x1', x(best[0])); cursor.setAttribute('x2', x(best[0]));
      dot.setAttribute('cx', x(best[0])); dot.setAttribute('cy', y(best[1]));
      cursor.setAttribute('visibility', 'visible'); dot.setAttribute('visibility', 'visible');
      if (readout) {
        const when = new Date(best[0]).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
        readout.textContent = `${when}: ${Math.round(best[1]).toLocaleString()} ${unit}`;
      }
    });
    svg.addEventListener('mouseleave', () => {
      cursor.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden');
      showDefault();
    });

    container.appendChild(svg);
  }

  /** Small sparkline with no labels. */
  function spark(container, rawPoints) {
    const points = clean(rawPoints);
    container.textContent = '';
    if (points.length < 2) return;
    const W = Math.max(container.clientWidth, 100);
    const H = Math.max(container.clientHeight, 30);
    const t0 = points[0][0];
    const span = Math.max(points[points.length - 1][0] - t0, 1);
    const max = Math.max(...points.map((p) => p[1]), 1);
    const x = (t) => ((t - t0) / span) * W;
    const y = (v) => 2 + (1 - v / max) * (H - 4);
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    svg.appendChild(svgEl('path', { class: 'area', d: `${d}L${W},${H}L0,${H}Z` }));
    svg.appendChild(svgEl('path', { class: 'line', d }));
    container.appendChild(svg);
  }

  window.RMChart = { line, spark };
})();
