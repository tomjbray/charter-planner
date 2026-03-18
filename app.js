// ═══════════════════════════════════════════════════════════
//  Charter Route Planner — app.js
//  Loads airports + aircraft data, plots routes, ranks aircraft
// ═══════════════════════════════════════════════════════════

// ── State ───────────────────────────────────────────────────
let AIRPORTS  = {};
let AIRCRAFT  = {};
let dbLoaded  = false;
let acLoaded  = false;

let origAirport = null;
let destAirport = null;
let paxCount    = 8;

let routeLayers = [];   // Leaflet layers for the drawn route

// ── Load data files ─────────────────────────────────────────

async function loadData() {
  try {
    // Load both files in parallel — faster than loading one then the other
    const [aptRes, acRes] = await Promise.all([
      fetch('./airports.json'),
      fetch('./aircraft_types.json')
    ]);

    if (!aptRes.ok) throw new Error('airports.json: HTTP ' + aptRes.status);
    if (!acRes.ok)  throw new Error('aircraft_types.json: HTTP ' + acRes.status);

    AIRPORTS = await aptRes.json();
    const acData = await acRes.json();

    // Remove the _metadata entry — it's not an aircraft
    AIRCRAFT = Object.fromEntries(
      Object.entries(acData).filter(([k]) => k !== '_metadata')
    );

    dbLoaded = true;
    acLoaded = true;

    const aptCount = Object.keys(AIRPORTS).length;
    const acCount  = Object.keys(AIRCRAFT).length;
    document.getElementById('dbStatus').textContent =
      aptCount.toLocaleString() + ' airports · ' + acCount + ' aircraft types';

    // Re-run any lookups the user may have typed before data finished loading
    const ov = document.getElementById('origInput').value;
    const dv = document.getElementById('destInput').value;
    if (ov.length === 3) lookupAirport(ov, document.getElementById('origInfo'), true);
    if (dv.length === 3) lookupAirport(dv, document.getElementById('destInfo'), false);

  } catch(e) {
    document.getElementById('dbStatus').textContent = '⚠ Data load failed: ' + e.message;
    console.error(e);
  }
}

// ── Airport lookup ───────────────────────────────────────────

function getAirport(iata) {
  const d = AIRPORTS[iata.toUpperCase().trim()];
  if (!d) return null;

  // Handle both old array format [name,country,city,lat,lon]
  // and new object format {name, country, city, lat, lon, icao, ...}
  if (Array.isArray(d)) {
    return { iata: iata.toUpperCase(), name: d[0], country: d[1], city: d[2], lat: d[3], lon: d[4] };
  }
  return { iata: iata.toUpperCase(), ...d };
}

function lookupAirport(iata, infoEl, isOrigin) {
  iata = iata.toUpperCase().trim();

  if (iata.length < 3) {
    infoEl.innerHTML = '';
    if (isOrigin) origAirport = null; else destAirport = null;
    updateUI();
    return;
  }

  if (!dbLoaded) {
    infoEl.innerHTML = '<div class="apt-loading">Loading database…</div>';
    if (isOrigin) origAirport = null; else destAirport = null;
    updateUI();
    return;
  }

  const ap = getAirport(iata);

  if (ap) {
    // Build the info display
    const icao      = ap.icao      ? ' · ' + ap.icao : '';
    const elevation = ap.elevation ? ' · ' + ap.elevation.toLocaleString() + ' ft' : '';

    // Runway info — show best (longest) runway if available
    let rwyHtml = '';
    if (ap.runways && ap.runways.length > 0) {
      const longest = Math.max(...ap.runways.map(r => r.length_ft || 0));
      if (longest > 0) {
        rwyHtml = '<div class="apt-rwy">Longest runway: ' + longest.toLocaleString() + ' ft</div>';
      }
    }

    infoEl.innerHTML =
      '<div class="apt-name">' + ap.name + '</div>' +
      '<div class="apt-meta">' + (ap.city || '') + (ap.city ? ' · ' : '') + ap.country + icao + elevation + '</div>' +
      rwyHtml;

    if (isOrigin) origAirport = ap; else destAirport = ap;

  } else {
    infoEl.innerHTML = '<div class="apt-error">Code not found</div>';
    if (isOrigin) origAirport = null; else destAirport = null;
  }

  updateUI();
}

// ── Map setup ────────────────────────────────────────────────

const map = L.map('map', {
  center: [30, 10],
  zoom: 2,
  zoomControl: true,
  attributionControl: true,
});

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 18,
}).addTo(map);

function clearRoute() {
  routeLayers.forEach(l => map.removeLayer(l));
  routeLayers = [];
}

function plotRoute(orig, dest) {
  clearRoute();

  // Great circle arc — 120 intermediate points
  const points = [];
  for (let i = 0; i <= 120; i++) {
    const f = i / 120;
    const pt = interpolateGreatCircle(orig.lat, orig.lon, dest.lat, dest.lon, f);
    points.push(pt);
  }

  // Split at antimeridian to avoid lines crossing the whole map
  const segments = splitAtAntimeridian(points);

  segments.forEach(seg => {
    const line = L.polyline(seg, {
      color: '#9a7235',
      weight: 1.5,
      opacity: 0.7,
      dashArray: '6,4',
    }).addTo(map);
    routeLayers.push(line);
  });

  // Origin marker
  const origMarker = L.marker([orig.lat, orig.lon], {
    icon: L.divIcon({
      className: '',
      html: '<div style="background:#9a7235;color:#ffffff;font-family:\'Barlow Condensed\',sans-serif;font-weight:700;font-size:11px;letter-spacing:0.1em;padding:3px 7px;border-radius:3px;white-space:nowrap;">' + orig.iata + '</div>',
      iconAnchor: [20, 10],
    })
  }).addTo(map);
  routeLayers.push(origMarker);

  // Destination marker
  const destMarker = L.marker([dest.lat, dest.lon], {
    icon: L.divIcon({
      className: '',
      html: '<div style="background:#2a6fd4;color:#ffffff;font-family:\'Barlow Condensed\',sans-serif;font-weight:700;font-size:11px;letter-spacing:0.1em;padding:3px 7px;border-radius:3px;white-space:nowrap;">' + dest.iata + '</div>',
      iconAnchor: [20, 10],
    })
  }).addTo(map);
  routeLayers.push(destMarker);

  // Fit map to route
  const bounds = L.latLngBounds([[orig.lat, orig.lon], [dest.lat, dest.lon]]);
  map.fitBounds(bounds, { padding: [40, 40] });

  // Hide the empty state overlay
  document.getElementById('mapEmpty').classList.add('hidden');
}

function interpolateGreatCircle(lat1, lon1, lat2, lon2, f) {
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const φ1 = toRad(lat1), λ1 = toRad(lon1);
  const φ2 = toRad(lat2), λ2 = toRad(lon2);
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((φ2-φ1)/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin((λ2-λ1)/2)**2
  ));
  if (d === 0) return [lat1, lon1];
  const A = Math.sin((1-f)*d) / Math.sin(d);
  const B = Math.sin(f*d)     / Math.sin(d);
  const x = A*Math.cos(φ1)*Math.cos(λ1) + B*Math.cos(φ2)*Math.cos(λ2);
  const y = A*Math.cos(φ1)*Math.sin(λ1) + B*Math.cos(φ2)*Math.sin(λ2);
  const z = A*Math.sin(φ1)              + B*Math.sin(φ2);
  return [toDeg(Math.atan2(z, Math.sqrt(x*x+y*y))), toDeg(Math.atan2(y, x))];
}

function splitAtAntimeridian(points) {
  const segments = [];
  let current = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const dLon = Math.abs(points[i][1] - points[i-1][1]);
    if (dLon > 180) {
      segments.push(current);
      current = [];
    }
    current.push(points[i]);
  }
  segments.push(current);
  return segments;
}

// ── Distance calculation ─────────────────────────────────────

function haversineNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065;   // Earth radius in nautical miles
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ── Aircraft matching ────────────────────────────────────────

function getLongestRunway(airport) {
  // If new format has runway data, use it
  if (airport.runways && airport.runways.length > 0) {
    return Math.max(...airport.runways.map(r => r.length_ft || 0));
  }
  // Otherwise return null — runway check will be skipped
  return null;
}

function matchAircraft(orig, dest, pax) {
  const distNm  = haversineNm(orig.lat, orig.lon, dest.lat, dest.lon);
  const distKm  = distNm * 1.852;

  // Add 15% to distance for real-world routing, weather, reserves
  const effectiveDist = distNm * 1.15;

  const origRwy = getLongestRunway(orig);
  const destRwy = getLongestRunway(dest);

  // Limiting runway is the shorter of the two airports
  const limitingRwy = (origRwy && destRwy) ? Math.min(origRwy, destRwy) : null;

  const results = [];

  for (const [code, ac] of Object.entries(AIRCRAFT)) {

    const reasons = [];   // why this aircraft was eliminated
    const warnings = []; // soft warnings (not eliminated, just flagged)
    const goods = [];    // positive fit indicators

    // ── Hard filter 1: passenger capacity ──────────────────
    if (ac.pax_max < pax) {
      continue;   // skip entirely — too small
    }

    // ── Hard filter 2: range ───────────────────────────────
    if (ac.range_nm < effectiveDist) {
      continue;   // skip entirely — can't make the distance
    }

    // ── Hard filter 3: runway (only if we have data) ───────
    if (limitingRwy !== null && ac.runway_required_ft > 0) {
      if (ac.runway_required_ft > limitingRwy) {
        continue;   // skip — runway too short
      }
    }

    // ── Soft checks (add to warnings/goods, don't eliminate) ──

    // Passenger fit
    const paxRatio = pax / ac.pax_typical;
    if (paxRatio <= 0.5) {
      warnings.push('Oversized for ' + pax + ' pax');
    } else if (paxRatio <= 0.85) {
      goods.push('Good pax fit');
    } else if (paxRatio <= 1.0) {
      goods.push('Full cabin');
    } else {
      // Over typical but under max
      warnings.push('Above typical capacity');
    }

    // Range efficiency — how much of the range is being used
    const rangeRatio = effectiveDist / ac.range_nm;
    if (rangeRatio < 0.25) {
      warnings.push('Significant excess range');
    } else if (rangeRatio < 0.5) {
      goods.push('Comfortable range margin');
    } else if (rangeRatio < 0.85) {
      goods.push('Efficient range use');
    } else {
      warnings.push('Near range limit');
    }

    // Runway margin
    if (limitingRwy !== null && ac.runway_required_ft > 0) {
      const rwyMargin = limitingRwy - ac.runway_required_ft;
      if (rwyMargin < 500) {
        warnings.push('Tight runway margin');
      } else if (rwyMargin > 3000) {
        goods.push('Ample runway margin');
      }
    }

    // ── Score calculation ──────────────────────────────────
    // Score 0-100. Higher = better fit for this route and pax count.

    let score = 50;   // start at midpoint

    // Range score: peak around 60-80% range utilisation
    const rangePct = effectiveDist / ac.range_nm;
    if      (rangePct >= 0.6 && rangePct <= 0.8) score += 25;
    else if (rangePct >= 0.4 && rangePct <  0.6) score += 15;
    else if (rangePct >= 0.8 && rangePct <  0.9) score += 10;
    else if (rangePct >= 0.9 && rangePct <  1.0) score -= 5;
    else if (rangePct < 0.2)                     score -= 20;
    else if (rangePct < 0.4)                     score -= 5;

    // Passenger score: peak around 80-100% of typical
    if      (paxRatio >= 0.8 && paxRatio <= 1.0) score += 20;
    else if (paxRatio >= 0.5 && paxRatio <  0.8) score += 8;
    else if (paxRatio >  1.0 && paxRatio <= 1.2) score += 5;
    else if (paxRatio <  0.5)                    score -= 10;

    // Bonus for good indicator count
    score += goods.length * 3;
    score -= warnings.length * 4;

    // Clamp to 0-100
    score = Math.max(0, Math.min(100, Math.round(score)));

    results.push({
      code, ac,
      distNm, distKm,
      effectiveDist,
      rangeRatio,
      paxRatio,
      score,
      goods,
      warnings,
      limitingRwy,
    });
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  return { results, distNm, distKm, limitingRwy };
}

// ── Render aircraft cards ────────────────────────────────────

let activeFilter = 'all';

function categoryLabel(cat) {
  const labels = {
    helicopter:           'Helicopter',
    turboprop:            'Turboprop',
    light_jet:            'Light Jet',
    midsize_jet:          'Midsize Jet',
    super_midsize_jet:    'Super Midsize',
    large_jet:            'Large Jet',
    ultra_long_range_jet: 'Ultra Long Range',
    airliner_narrow:      'Narrow Body',
    airliner_wide:        'Wide Body',
  };
  return labels[cat] || cat;
}

function renderResults(matchData) {
  const { results, distNm, distKm, limitingRwy } = matchData;

  const area = document.getElementById('resultsArea');
  const grid = document.getElementById('aircraftGrid');
  const meta = document.getElementById('resultsMeta');
  const tabs = document.getElementById('filterTabs');

  area.style.display = 'block';

  // Meta line
  const rwyNote = limitingRwy
    ? ' · Limiting runway: ' + limitingRwy.toLocaleString() + ' ft'
    : ' · Runway data not yet available';
  meta.textContent = results.length + ' aircraft found · ' +
    Math.round(distNm).toLocaleString() + ' nm (' +
    Math.round(distKm).toLocaleString() + ' km)' + rwyNote;

  // Build category filter tabs
  const cats = ['all', ...new Set(results.map(r => r.ac.category))];
  tabs.innerHTML = '';
  cats.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'filter-tab' + (cat === activeFilter ? ' active' : '');
    btn.textContent = cat === 'all' ? 'All (' + results.length + ')' : categoryLabel(cat);
    btn.addEventListener('click', () => {
      activeFilter = cat;
      renderCards(results);
      tabs.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    tabs.appendChild(btn);
  });

  renderCards(results);
}

function renderCards(results) {
  const grid = document.getElementById('aircraftGrid');
  grid.innerHTML = '';

  const filtered = activeFilter === 'all'
    ? results
    : results.filter(r => r.ac.category === activeFilter);

  if (filtered.length === 0) {
    grid.innerHTML = '<div class="no-results"><strong>No aircraft found</strong>Try adjusting passengers or selecting a different route.</div>';
    return;
  }

  filtered.forEach((r, idx) => {
    const { ac, code, score, goods, warnings, rangeRatio, paxRatio } = r;

    const card = document.createElement('div');
    card.className = 'aircraft-card';

    // Score bar width
    const barWidth = score + '%';

    // Fit pills
    const allPills = [
      ...goods.map(g    => '<span class="fit-pill fit-good">' + g + '</span>'),
      ...warnings.map(w => '<span class="fit-pill fit-' + (w.includes('limit') || w.includes('tight') ? 'warning' : 'ok') + '">' + w + '</span>'),
    ].join('');

    // Range display
    const rangeUsed = Math.round(rangeRatio * 100) + '% range';

    card.innerHTML = `
      <div class="card-score-bar" style="width:${barWidth}"></div>
      <div class="card-score">${score}</div>
      <div class="card-rank">#${idx + 1} match</div>
      <div class="card-manufacturer">${ac.manufacturer}</div>
      <div class="card-model">${ac.model}</div>
      <span class="card-category cat-${ac.category}">${categoryLabel(ac.category)}</span>
      <div class="card-stats">
        <div class="card-stat">
          <div class="card-stat-val">${ac.pax_typical}</div>
          <div class="card-stat-key">Typical Pax</div>
        </div>
        <div class="card-stat">
          <div class="card-stat-val">${ac.range_nm.toLocaleString()}</div>
          <div class="card-stat-key">Range (nm)</div>
        </div>
        <div class="card-stat">
          <div class="card-stat-val">${ac.runway_required_ft > 0 ? ac.runway_required_ft.toLocaleString() : '—'}</div>
          <div class="card-stat-key">Runway (ft)</div>
        </div>
        <div class="card-stat">
          <div class="card-stat-val">${ac.engines}</div>
          <div class="card-stat-key">Engines</div>
        </div>
        <div class="card-stat">
          <div class="card-stat-val">${ac.cruise_speed_kts}</div>
          <div class="card-stat-key">Speed (kts)</div>
        </div>
        <div class="card-stat">
          <div class="card-stat-val">${rangeUsed}</div>
          <div class="card-stat-key">Route Use</div>
        </div>
      </div>
      <div class="card-fit">${allPills}</div>
    `;

    grid.appendChild(card);
  });
}

// ── UI state ─────────────────────────────────────────────────

function updateUI() {
  const ready = origAirport && destAirport;
  document.getElementById('findBtn').disabled = !ready;

  if (ready) {
    const distNm = haversineNm(origAirport.lat, origAirport.lon, destAirport.lat, destAirport.lon);
    const distKm = distNm * 1.852;

    // Show route summary
    const summary = document.getElementById('routeSummary');
    summary.style.display = 'block';
    document.getElementById('summaryDist').textContent = Math.round(distNm).toLocaleString();
    document.getElementById('summaryKm').textContent   = Math.round(distKm).toLocaleString();
    document.getElementById('summaryPax').textContent  = paxCount;
    document.getElementById('summaryRwy').textContent  = '—';  // updated after matching

    plotRoute(origAirport, destAirport);
  }
}

// ── Event listeners ──────────────────────────────────────────

document.getElementById('origInput').addEventListener('input', function() {
  lookupAirport(this.value, document.getElementById('origInfo'), true);
});
document.getElementById('destInput').addEventListener('input', function() {
  lookupAirport(this.value, document.getElementById('destInfo'), false);
});

// Passenger buttons
document.getElementById('paxDown').addEventListener('click', () => {
  if (paxCount > 1) {
    paxCount--;
    document.getElementById('paxCount').textContent = paxCount;
    updateUI();
  }
});
document.getElementById('paxUp').addEventListener('click', () => {
  if (paxCount < 900) {
    paxCount++;
    document.getElementById('paxCount').textContent = paxCount;
    updateUI();
  }
});

// Find aircraft
document.getElementById('findBtn').addEventListener('click', () => {
  if (!origAirport || !destAirport || !acLoaded) return;

  activeFilter = 'all';
  const matchData = matchAircraft(origAirport, destAirport, paxCount);

  // Update runway summary
  if (matchData.limitingRwy) {
    document.getElementById('summaryRwy').textContent =
      matchData.limitingRwy.toLocaleString();
  }

  renderResults(matchData);

  // Scroll results into view on mobile
  document.getElementById('resultsArea').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ── Start ────────────────────────────────────────────────────
loadData();
