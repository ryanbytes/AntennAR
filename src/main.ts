import './style.css';

type Site = {
  id: string; country: string; systemId: string; callSign: string; licensee: string; service: string;
  serviceName: string; state: string; city: string; siteName: string;
  lat: number; lon: number; frequencies: number[]; confirmedSafeT?: boolean;
  safeTLabel?: string; safeTSource?: string; recordUrl?: string;
};
type Dataset = { schemaVersion: number; country: string; source: string; sourceUrl?: string; attribution?: string; sourceDate: string; importedAt: string; scope: string; services: Record<string,string>; siteCount: number; sites: Site[] };
type TileInfo = { id: string; path: string; siteCount: number; bytes: number; transferBytes: number };
type TileCatalog = { schemaVersion: number; sourceDate: string; importedAt: string; version: string; tileSizeDegrees: number; tileCount: number; siteCount: number; services: Record<string,string>; tiles: TileInfo[] };
type Origin = { lat: number; lon: number; label: string };
type Nearby = Site & { distance: number; bearing: number; relative: number };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const field = $('field'), video = $('camera') as HTMLVideoElement, markers = $('markers'), radarPoints = $('radar-points');
const list = $('site-list'), radiusInput = $('radius') as HTMLInputElement;
const serviceFilter = $('service-filter') as HTMLSelectElement, frequencyFilter = $('frequency-filter') as HTMLSelectElement;
let dataset: Dataset | null = null;
let tileCatalog: TileCatalog | null = null;
const tileById = new Map<string, TileInfo>();
const loadedTiles = new Map<string, Site[]>();
const pendingTiles = new Set<string>();
const failedTileAt = new Map<string, number>();
let origin: Origin | null = null;
let heading: number | null = null;
let cameraStream: MediaStream | null = null;
let watchId: number | null = null;
let usingManualOrigin = false;
let nearbySites: Nearby[] = [];
let focusedSiteId: string | null = null;
let headingLastAt = 0;
let orientationEvents = 0;
let sortNearest = true;

function bearingBetween(a: Origin, b: Site) {
  const rad = Math.PI / 180, p1 = a.lat * rad, p2 = b.lat * rad, dl = (b.lon - a.lon) * rad;
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function distanceBetween(a: Origin, b: Site) {
  const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 3958.7613 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
function compassPoint(deg: number) { return ['N','NE','E','SE','S','SW','W','NW'][Math.round(deg / 45) % 8]; }
function normalize(deg: number) { return (deg + 360) % 360; }
function formatDistance(miles: number) { return miles < 1 ? `${(miles * 5280 / 100).toFixed(0)} ft` : `${miles.toFixed(miles < 10 ? 1 : 0)} mi`; }
function formatSize(bytes: number) { return bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000))} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`; }
function isPublicSafety(site: Site) { return ['PW','GE','GF','GP','YE','YF','YP','SG','SY','YW','PA','SL','SP','QM','QO','QT','NC'].includes(site.service); }
function inFrequencyFilter(site: Site) {
  const filter = frequencyFilter.value;
  if (filter === 'all') return true;
  const inBand = (f: number) => filter === 'vhf' ? f >= 30 && f < 300 : filter === 'uhf' ? f >= 300 && f < 700 || f > 800 && f <= 1000 : filter === '700800' ? f >= 700 && f <= 800 : f < 30 || f > 1000;
  return site.frequencies.some(inBand);
}
function visibleSites() {
  return nearbySites.filter(s => (isPublicSafety(s) ? ($('show-public-safety') as HTMLInputElement).checked : ($('show-other') as HTMLInputElement).checked)
    && (serviceFilter.value === 'all' || s.service === serviceFilter.value) && inFrequencyFilter(s));
}
function updateNearby() {
  const radius = Number(radiusInput.value);
  $('radius-value').textContent = `${radius} mi`;
  $('radius-chip').textContent = `${radius} mi radius`;
  if (!origin || !dataset) { nearbySites = []; renderSites(); return; }
  nearbySites = dataset.sites.map(site => ({ ...site, distance: distanceBetween(origin!, site), bearing: bearingBetween(origin!, site), relative: 0 }))
    .filter(site => site.distance <= radius)
    .sort((a,b) => a.distance - b.distance);
  if (focusedSiteId && !nearbySites.some(site => site.id === focusedSiteId)) focusedSiteId = null;
  nearbySites.forEach(site => site.relative = heading === null ? site.bearing : normalize(site.bearing - heading));
  renderSites(); renderMarkers(); renderRadar();
}
function updateRelative() { nearbySites.forEach(site => site.relative = heading === null ? site.bearing : normalize(site.bearing - heading)); renderMarkers(); renderRadar(); }

function renderSites() {
  const items = visibleSites();
  $('nearby-total').textContent = String(items.length);
  $('site-count').textContent = items.length ? `${items.length} nearby ${items.length === 1 ? 'site' : 'sites'}` : 'No nearby sites';
  if (!items.length) {
    const message = !tileCatalog ? 'FCC coverage catalog unavailable' : !origin ? 'Start to find nearby sites' : !dataset ? 'Loading nearby FCC tiles' : nearbySites.length ? 'No sites match these filters' : 'No active records in this radius';
    list.innerHTML = `<div class="list-empty"><span>⌁</span><strong>${message}</strong><p>${!tileCatalog ? 'No current FCC tile catalog is installed. The app will not substitute another country or region.' : !origin ? 'Tap Start to use live location, or set a local manual origin. Only coarse FCC data tiles around the chosen radius are downloaded; exact coordinates stay on this phone.' : 'The phone filters licensed records locally. Your precise location is never sent to the data service.'}</p></div>`;
    updateFocusedTarget();
    return;
  }
  const ordered = [...items].sort((a,b) => sortNearest ? a.distance - b.distance : a.bearing - b.bearing);
  list.innerHTML = ordered.map(site => `<button class="site-card${site.id === focusedSiteId ? ' selected' : ''}" data-site="${escapeHtml(site.id)}" aria-pressed="${site.id === focusedSiteId}" title="Show only this site in the field view"><span class="site-direction">${compassPoint(site.bearing)}</span><span class="site-main"><span class="site-title"><strong>${escapeHtml(site.siteName || site.licensee || site.callSign)}</strong>${site.confirmedSafeT ? '<span class="badge confirmed">SAFE-T</span>' : isPublicSafety(site) ? '<span class="badge">PUBLIC SAFETY</span>' : '<span class="badge">ACTIVE LICENSE</span>'}</span><span class="site-meta">${escapeHtml(site.callSign)} · ${escapeHtml(site.licensee)} · ${escapeHtml(site.serviceName)} · ${site.country}</span></span><span class="site-distance">${formatDistance(site.distance)}<small>${Math.round(site.bearing)}° ${compassPoint(site.bearing)}</small></span></button>`).join('');
  list.querySelectorAll<HTMLButtonElement>('.site-card').forEach(button => button.addEventListener('click', () => {
    focusedSiteId = focusedSiteId === button.dataset.site ? null : button.dataset.site || null;
    renderSites(); renderMarkers();
  }));
  updateFocusedTarget();
}
function updateFocusedTarget() {
  const control = $('focused-target') as HTMLButtonElement;
  const site = nearbySites.find(item => item.id === focusedSiteId);
  control.classList.toggle('hidden', !site);
  control.textContent = site ? `AIMING: ${site.siteName || site.callSign} · CLEAR ×` : '';
  control.title = site ? 'Clear selected target and show nearby markers' : '';
}
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!)); }

function renderMarkers() {
  markers.innerHTML = '';
  if (!field.classList.contains('camera-on') || heading === null) return;
  const fov = 58;
  const candidates = visibleSites().filter(s => focusedSiteId === null || s.id === focusedSiteId).filter(s => {
    const delta = ((s.bearing - heading! + 540) % 360) - 180;
    s.relative = normalize(delta);
    return focusedSiteId !== null || Math.abs(delta) <= fov / 2;
  }).sort((a,b) => a.distance - b.distance);
  // Dense urban areas often have dozens of license records at the same bearing.
  // Show one readable representative per 12° sector; the list remains complete,
  // and selecting a row isolates that exact site in the camera view.
  const onscreen: Nearby[] = [];
  const occupiedSectors = new Set<number>();
  for (const site of candidates) {
    const delta = ((site.bearing - heading! + 540) % 360) - 180;
    const sector = Math.round(delta / 12);
    if (focusedSiteId !== null || !occupiedSectors.has(sector)) {
      onscreen.push(site);
      occupiedSectors.add(sector);
    }
    if (onscreen.length >= (focusedSiteId ? 1 : 5)) break;
  }
  const nodes = onscreen.map((site,index) => {
    const delta = ((site.bearing - heading! + 540) % 360) - 180;
    const x = Math.max(3, Math.min(97, 50 + delta / (fov / 2) * 50));
    const row = index % 3;
    const y = 8 + row * 34;
    const node = document.createElement('button');
    const offscreen = Math.abs(delta) > fov / 2;
    const edge = x < 18 ? ' edge-left' : x > 82 ? ' edge-right' : '';
    node.className = `marker${site.confirmedSafeT ? ' confirmed' : ''}${offscreen ? ' offscreen' : ''}${edge}`;
    node.style.left = `${x}%`; node.style.top = `${y}%`; node.setAttribute('aria-label', `${site.callSign}, ${Math.round(site.bearing)} degrees ${compassPoint(site.bearing)}, ${formatDistance(site.distance)}`);
    const cue = offscreen ? (delta > 0 ? 'TURN RIGHT' : 'TURN LEFT') : `${Math.round(site.bearing)}° ${compassPoint(site.bearing)}`;
    node.innerHTML = `<span class="marker-pin"></span><span class="marker-card"><strong>${escapeHtml(site.siteName || site.callSign)}</strong><span>${cue} · ${formatDistance(site.distance)}</span></span>`;
    node.addEventListener('click', () => showSite(site.id));
    return node;
  });
  nodes.forEach(node => markers.append(node));
}
function renderRadar() {
  radarPoints.innerHTML = '';
  const max = Number(radiusInput.value);
  for (const site of visibleSites().filter(item => focusedSiteId === null || item.id === focusedSiteId).slice(0, focusedSiteId ? 1 : 40)) {
    const distance = Math.min(0.46, site.distance / max * 0.46), angle = site.bearing * Math.PI / 180;
    const dot = document.createElement('i'); dot.className = `radar-dot${site.confirmedSafeT ? ' confirmed' : ''}`;
    dot.style.left = `${50 + Math.sin(angle) * distance * 100}%`; dot.style.top = `${50 - Math.cos(angle) * distance * 100}%`; dot.title = `${site.callSign} ${Math.round(site.bearing)}°`;
    radarPoints.append(dot);
  }
}
function showSite(id: string) {
  const site = nearbySites.find(s => s.id === id); if (!site) return;
  $('site-detail-heading').innerHTML = `<p class="detail-call">${escapeHtml(site.callSign)} · ${escapeHtml(site.service)}</p><div class="detail-title">${escapeHtml(site.siteName || site.licensee)}</div>`;
  const licenseLink = site.recordUrl || `https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?licKey=${encodeURIComponent(site.systemId)}`;
  $('site-detail').innerHTML = `<div class="detail-grid"><div class="detail-item"><small>DIRECTION</small><span>${Math.round(site.bearing)}° ${compassPoint(site.bearing)}</span></div><div class="detail-item"><small>DISTANCE</small><span>${formatDistance(site.distance)}</span></div><div class="detail-item"><small>LICENSEE</small><span>${escapeHtml(site.licensee)}</span></div><div class="detail-item"><small>RADIO SERVICE</small><span>${escapeHtml(site.serviceName)} (${escapeHtml(site.service)}) · United States</span></div><div class="detail-item"><small>AUTHORIZED FREQUENCIES</small><span>${site.frequencies.length ? `${site.frequencies.slice(0,8).map(f => `${f.toFixed(4)} MHz`).join(', ')}${site.frequencies.length > 8 ? ` +${site.frequencies.length-8} more` : ''}` : 'Not available in this source record'}</span></div><div class="detail-item"><small>SITE</small><span>${escapeHtml([site.siteName,site.city,site.state].filter(Boolean).join(' · ') || 'Licensed site location')}</span></div></div><p class="notice">${site.confirmedSafeT ? `Confirmed SAFE-T reference: ${escapeHtml(site.safeTLabel || 'reviewed match')}.` : isPublicSafety(site) ? 'Active FCC public-safety license. This is not by itself a confirmed SAFE-T site or proof of a transmitter on air.' : 'Active FCC license record with transmitter/location details available from the source. A license does not prove a transmitter is on air or that a radio path is clear.'} The marker shows azimuth and distance only, not tower visibility or line of sight.</p><p class="detail-actions"><a href="${escapeHtml(licenseLink)}" target="_blank" rel="noopener">Open FCC ULS record ↗</a>${site.confirmedSafeT && site.safeTSource ? `<a href="${escapeHtml(site.safeTSource)}" target="_blank" rel="noopener">SAFE-T reference ↗</a>` : ''}</p>`;
  ($('site-dialog') as HTMLDialogElement).showModal();
}

async function startField() {
  $('start-button').setAttribute('aria-busy','true');
  $('start-label').textContent = 'Starting sensors…';
  field.classList.add('started');
  field.classList.add('radar-on');
  const orientationPermission = requestOrientationPermission();
  const issues: string[] = [];
  if (!window.isSecureContext) issues.push('Camera and motion sensors require HTTPS in phone browsers. Use localhost while developing.');
  if (navigator.mediaDevices?.getUserMedia && window.isSecureContext) {
    try { cameraStream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false}); video.srcObject = cameraStream; field.classList.add('camera-on'); $('view-mode').textContent = 'CAMERA VIEW'; }
    catch { issues.push('Camera access is unavailable. The compass/radar view will still work.'); }
  } else issues.push('Camera unavailable here. The compass/radar view will still work.');
  if (!usingManualOrigin && watchId === null) requestLocation();
  if (await orientationPermission) attachOrientation();
  else showHeadingHelp('Compass permission was unavailable. Use the radar view, or allow motion access in browser settings.');
  if (issues.length) { $('sensor-warning').textContent = issues.join(' '); $('sensor-warning').classList.remove('hidden'); }
  $('start-label').textContent = 'Field view running'; $('start-button').querySelector('.start-icon')!.textContent = '●'; $('start-button').removeAttribute('aria-busy');
}
function requestLocation() {
  if (!navigator.geolocation) { $('origin-label').textContent = 'Location unavailable'; return; }
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(position => {
    origin = {lat:position.coords.latitude,lon:position.coords.longitude,label:'Live device location'}; usingManualOrigin = false;
    $('gps-dot').classList.add('active'); $('origin-label').textContent = 'Using live device location'; updateNearby(); void loadNearbyTiles();
  }, () => { if (!origin) $('origin-label').textContent = 'Location denied · set an origin'; $('gps-dot').classList.remove('active'); }, {enableHighAccuracy:true,maximumAge:15000,timeout:12000});
}
function requestOrientationPermission(): Promise<boolean> {
  if (typeof DeviceOrientationEvent === 'undefined') return Promise.resolve(false);
  type OrientationCtor = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<'granted'|'denied'> };
  const EventCtor = DeviceOrientationEvent as OrientationCtor;
  if (typeof EventCtor.requestPermission !== 'function') return Promise.resolve(true);
  // Invoke synchronously from Start's click handler; iOS requires transient user activation.
  try { return EventCtor.requestPermission().then(permission => permission === 'granted').catch(() => false); }
  catch { return Promise.resolve(false); }
}
function attachOrientation() {
  window.addEventListener('deviceorientation', onOrientation, true);
  window.addEventListener('deviceorientationabsolute', onOrientation as EventListener, true);
  $('cardinal').textContent = 'CALIBRATING'; $('radar').setAttribute('aria-hidden','false');
  setTimeout(() => {
    if (orientationEvents === 0) showHeadingHelp('Heading is unavailable. Move outdoors, calibrate the compass, or use radar bearings relative to north.');
  }, 5000);
}
function onOrientation(event: Event) {
  const e = event as DeviceOrientationEvent & { webkitCompassHeading?:number; webkitCompassAccuracy?:number; absolute?:boolean };
  let degrees: number | null = null;
  if (typeof e.webkitCompassHeading === 'number' && (e.webkitCompassAccuracy === undefined || e.webkitCompassAccuracy < 45)) degrees = e.webkitCompassHeading;
  else if (e.absolute && typeof e.alpha === 'number') {
    const screenAngle = screen.orientation?.angle ?? (typeof window.orientation === 'number' ? window.orientation : 0);
    degrees = normalize(360 - e.alpha + screenAngle);
  }
  if (degrees === null) return;
  const now = Date.now(); if (now - headingLastAt < 75) return; headingLastAt = now; orientationEvents++;
  heading = normalize(degrees); $('heading').textContent = `${String(Math.round(heading)).padStart(3,'0')}°`; $('cardinal').textContent = compassPoint(heading); $('sensor-warning').classList.add('hidden');
  if (field.classList.contains('camera-on')) field.classList.remove('radar-on'); else field.classList.add('radar-on');
  updateRelative();
}
function showHeadingHelp(message: string) {
  heading = null; $('heading').textContent = '—'; $('cardinal').textContent = 'NO HEADING';
  field.classList.remove('camera-on'); field.classList.add('radar-on'); $('view-mode').textContent = 'RADAR VIEW';
  $('sensor-warning').textContent = message; $('sensor-warning').classList.remove('hidden'); updateNearby();
}
function saveManualOrigin(latText: string, lonText: string) {
  const lat = Number(latText), lon = Number(lonText);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat)>90 || Math.abs(lon)>180) { alert('Enter a valid latitude and longitude.'); return; }
  localStorage.setItem('antennar.manual-origin', JSON.stringify({lat,lon}));
  origin = {lat,lon,label:'Manual origin · stored on this device'}; usingManualOrigin = true;
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  $('gps-dot').classList.add('active'); $('origin-label').textContent = 'Using manual origin · on device'; updateNearby(); void loadNearbyTiles();
  ($('origin-dialog') as HTMLDialogElement).close(); ($('settings-dialog') as HTMLDialogElement).close();
}
function useLiveLocation() {
  localStorage.removeItem('antennar.manual-origin'); origin = null; usingManualOrigin = false;
  $('origin-label').textContent = 'Location not started'; $('gps-dot').classList.remove('active');
  requestLocation(); ($('origin-dialog') as HTMLDialogElement).close(); ($('settings-dialog') as HTMLDialogElement).close();
}

function tileIdsForOrigin(point: Origin, radiusMiles: number): string[] {
  if (!tileCatalog) return [];
  const size = tileCatalog.tileSizeDegrees;
  const latPad = radiusMiles / 69;
  const lonPad = radiusMiles / (69 * Math.max(0.15, Math.cos(point.lat * Math.PI / 180)));
  const minLat = Math.max(-90, point.lat - latPad), maxLat = Math.min(90, point.lat + latPad);
  const minLon = point.lon - lonPad, maxLon = point.lon + lonPad;
  const firstLat = Math.floor(minLat / size), lastLat = Math.floor(maxLat / size);
  const firstLon = Math.floor(minLon / size), lastLon = Math.floor(maxLon / size);
  const longitudeCells = Math.round(360 / size), found: string[] = [];
  for (let latIndex = firstLat; latIndex <= lastLat; latIndex++) {
    for (let rawLonIndex = firstLon; rawLonIndex <= lastLon; rawLonIndex++) {
      let lonIndex = ((rawLonIndex % longitudeCells) + longitudeCells) % longitudeCells;
      if (lonIndex >= longitudeCells / 2) lonIndex -= longitudeCells;
      const id = `${latIndex}_${lonIndex}`;
      if (tileById.has(id)) found.push(id);
    }
  }
  return [...new Set(found)];
}
function rebuildDataset() {
  if (!tileCatalog) { dataset = null; return; }
  const sites = [...loadedTiles.values()].flat();
  dataset = {
    schemaVersion: 1, country: 'US', source: 'FCC Universal Licensing System (ULS) complete license public access files',
    sourceDate: tileCatalog.sourceDate, importedAt: tileCatalog.importedAt,
    sourceUrl: 'https://wireless.fcc.gov/uls/documentation/pa_intro24.pdf',
    scope: `${loadedTiles.size} cached geographic tiles`, services: tileCatalog.services, siteCount: sites.length, sites,
  };
}
function updateTileStatus(ids: string[], failed = false) {
  if (!tileCatalog) return;
  const stale = (Date.now() - Date.parse(`${tileCatalog.sourceDate}T00:00:00Z`)) / 86400000 > 14;
  const loaded = ids.filter(id => loadedTiles.has(id));
  const neededBytes = ids.reduce((total, id) => total + (tileById.get(id)?.transferBytes || 0), 0);
  const label = failed ? ' · some tiles unavailable' : '';
  $('data-status').textContent = `${stale ? 'STALE · ' : ''}FCC ULS · ${loaded.length}/${ids.length} nearby tiles loaded${label}`;
  $('data-date').textContent = `Source ${tileCatalog.sourceDate} · imported ${tileCatalog.importedAt} · up to ${formatSize(neededBytes)} for this radius`;
  $('data-status').parentElement?.querySelector('.data-dot')?.classList.toggle('active', !stale && !failed && loaded.length === ids.length);
}
async function loadNearbyTiles() {
  if (!tileCatalog || !origin) return;
  const ids = tileIdsForOrigin(origin, Number(radiusInput.value));
  const wanted = new Set(ids);
  for (const id of loadedTiles.keys()) if (!wanted.has(id)) loadedTiles.delete(id);
  rebuildDataset();
  const missing = ids.filter(id => !loadedTiles.has(id) && !pendingTiles.has(id) && Date.now() - (failedTileAt.get(id) || 0) > 30_000);
  const recentFailure = ids.some(id => Date.now() - (failedTileAt.get(id) || 0) <= 30_000);
  updateTileStatus(ids, recentFailure);
  if (!missing.length) { updateNearby(); return; }
  $('data-status').textContent = `FCC ULS · downloading ${missing.length} nearby tile${missing.length === 1 ? '' : 's'}…`;
  await Promise.all(missing.map(async id => {
    const tile = tileById.get(id);
    if (!tile) return;
    pendingTiles.add(id);
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}${tile.path}`, {cache:'force-cache'});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = await response.json() as Dataset;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.sites)) throw new Error('Invalid FCC tile');
      loadedTiles.set(id, parsed.sites);
      failedTileAt.delete(id);
    } catch {
      failedTileAt.set(id, Date.now());
    } finally {
      pendingTiles.delete(id);
    }
  }));
  rebuildDataset();
  const failed = ids.some(id => !loadedTiles.has(id) && failedTileAt.has(id));
  updateTileStatus(ids, failed);
  updateNearby();
}
async function loadDataset() {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}data/fcc-catalog.json`, {cache:'no-cache'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    tileCatalog = await response.json() as TileCatalog;
    if (tileCatalog.schemaVersion !== 1 || !Array.isArray(tileCatalog.tiles)) throw new Error('Invalid FCC catalog');
    tileById.clear();
    for (const tile of tileCatalog.tiles) tileById.set(tile.id, tile);
    serviceFilter.replaceChildren(new Option('All included services', 'all'));
    for (const [code, name] of Object.entries(tileCatalog.services)) { const option=document.createElement('option'); option.value=code; option.textContent=`${name} · ${code}`; serviceFilter.append(option); }
    $('data-status').textContent = `FCC ULS · ${tileCatalog.tileCount.toLocaleString()} populated geographic tiles`;
    $('data-date').textContent = `Source ${tileCatalog.sourceDate} · imported ${tileCatalog.importedAt}`;
    $('filter-explainer').textContent = `FCC ULS site-oriented records only. The phone requests versioned 0.5° geographic cells around the current radius, downloads new cells as you move, and caches them on this device. Exact coordinates are not sent; service and frequency filters run locally. ${tileCatalog.siteCount.toLocaleString()} mapped active license locations are available across ${tileCatalog.tileCount.toLocaleString()} populated cells.`;
    if (origin) void loadNearbyTiles(); else renderSites();
  } catch {
    tileCatalog = null; dataset = null; tileById.clear();
    $('data-status').textContent = 'FCC data catalog unavailable · coverage gap';
    $('data-date').textContent = 'No current FCC tile snapshot is installed';
    $('data-status').parentElement?.querySelector('.data-dot')?.classList.remove('active');
    $('filter-explainer').textContent = 'No FCC site snapshot is installed. The app does not substitute other-country records for U.S. coverage.';
    $('site-list').innerHTML = '<div class="list-empty"><span>⌁</span><strong>FCC coverage is not installed</strong><p>Camera and compass view can run, but FCC site markers require a current tile import. The VPS stores only static public FCC files, not a user database.</p></div>';
  }
}

radiusInput.addEventListener('input', () => { updateNearby(); void loadNearbyTiles(); });
for (const id of ['show-public-safety','show-other']) $(id).addEventListener('change', () => { renderSites(); renderMarkers(); renderRadar(); });
serviceFilter.addEventListener('change', () => { renderSites(); renderMarkers(); renderRadar(); });
frequencyFilter.addEventListener('change', () => { renderSites(); renderMarkers(); renderRadar(); });
$('sort-button').addEventListener('click', () => { sortNearest = !sortNearest; $('sort-button').textContent = sortNearest ? 'Nearest first ↓' : 'Direction ↑'; renderSites(); });
$('settings-toggle').addEventListener('click', () => ($('settings-dialog') as HTMLDialogElement).showModal());
$('origin-edit').addEventListener('click', () => ($('origin-dialog') as HTMLDialogElement).showModal());
$('start-button').addEventListener('click', () => { if (field.classList.contains('started')) { locationStop(); } else void startField(); });
$('focused-target').addEventListener('click', () => { focusedSiteId = null; renderSites(); renderMarkers(); });
function locationStop() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId); watchId = null;
  cameraStream?.getTracks().forEach(track => track.stop()); cameraStream = null; video.srcObject = null;
  window.removeEventListener('deviceorientation', onOrientation, true); window.removeEventListener('deviceorientationabsolute', onOrientation as EventListener, true);
  field.classList.remove('started','camera-on'); $('start-label').textContent='Start field view'; $('start-button').querySelector('.start-icon')!.textContent='▶'; $('view-mode').textContent='RADAR VIEW';
  heading = null; orientationEvents = 0; $('heading').textContent='—'; $('cardinal').textContent='HEADING'; field.classList.remove('radar-on'); renderMarkers(); renderRadar();
}
$('save-origin').addEventListener('click', () => saveManualOrigin(($('manual-lat') as HTMLInputElement).value, ($('manual-lon') as HTMLInputElement).value));
$('quick-save').addEventListener('click', () => saveManualOrigin(($('quick-lat') as HTMLInputElement).value, ($('quick-lon') as HTMLInputElement).value));
$('clear-origin').addEventListener('click', useLiveLocation); $('quick-live').addEventListener('click', useLiveLocation);
const saved = localStorage.getItem('antennar.manual-origin');
if (saved) try { const point=JSON.parse(saved) as {lat:number;lon:number}; if (Number.isFinite(point.lat)&&Number.isFinite(point.lon)) { origin={...point,label:'Manual origin · stored on this device'}; usingManualOrigin=true; $('origin-label').textContent='Using manual origin · on device'; $('gps-dot').classList.add('active'); } } catch { localStorage.removeItem('antennar.manual-origin'); }
window.addEventListener('beforeunload', locationStop);
void loadDataset();
if ('serviceWorker' in navigator && import.meta.env.PROD) void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL });
