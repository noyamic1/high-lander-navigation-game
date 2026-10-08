// Browser client: reads the host's location, sends it to the server and renders server state.
// All game decisions (goal, goal reached, route) are made server-side.

const FALLBACK_POSITION = { lat: 32.0853, lng: 34.7818 }; // used only if geolocation is unavailable
const SIM_STEP_METERS = 5;
const METERS_PER_DEGREE_LAT = 111320;

const sessionId = new URLSearchParams(location.search).get('session') || 'default';
const socket = io();

// keyboard: false so arrow keys drive the simulated player instead of panning the map.
const map = L.map('map', { keyboard: false }).setView([FALLBACK_POSITION.lat, FALLBACK_POSITION.lng], 16);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const ui = {
  status: document.getElementById('status'),
  session: document.getElementById('session'),
  distance: document.getElementById('distance'),
  route: document.getElementById('route'),
  simulate: document.getElementById('simulate'),
  restart: document.getElementById('restart'),
  banner: document.getElementById('banner'),
};
ui.session.textContent = sessionId;

let position = null; // last known player position { lat, lng }
let joined = false;
let playerMarker = null;
let goalMarker = null;
let routeLine = null;

const formatMeters = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const setStatus = (text) => { ui.status.textContent = text; };

// ---- rendering ----

function renderPlayer() {
  const latLng = [position.lat, position.lng];
  if (!playerMarker) {
    // The "ball" marker.
    playerMarker = L.circleMarker(latLng, { radius: 9, color: '#fff', weight: 3, fillColor: '#1976d2', fillOpacity: 1 })
      .addTo(map)
      .bindTooltip('You');
    map.setView(latLng, 16);
  } else {
    playerMarker.setLatLng(latLng);
  }
}

function renderGoal(goal) {
  const latLng = [goal.lat, goal.lng];
  const icon = L.divIcon({ className: 'goal-icon', html: '🏁', iconSize: [28, 28], iconAnchor: [4, 26] });
  if (goalMarker) goalMarker.setLatLng(latLng);
  else goalMarker = L.marker(latLng, { icon }).addTo(map).bindTooltip('Goal');
}

function renderRoute(route) {
  if (routeLine) routeLine.setLatLngs(route.coordinates);
  else routeLine = L.polyline(route.coordinates, { color: '#d32f2f', weight: 5, opacity: 0.8 }).addTo(map);
  ui.route.textContent = formatMeters(route.distanceMeters);
}

function onAck(ack) {
  if (!ack.ok) return setStatus(`Error: ${ack.error}`);
  if (ack.distanceToGoal !== undefined) ui.distance.textContent = formatMeters(ack.distanceToGoal);
}

// ---- talking to the server ----

function join() {
  if (joined || !position || !socket.connected) return;
  joined = true;
  socket.emit('game:join', { sessionId, position }, (ack) => {
    if (!ack.ok) joined = false;
    onAck(ack);
  });
}

function moveTo(next) {
  position = next;
  renderPlayer();
  if (joined) socket.emit('player:move', { position }, onAck);
  else join();
}

socket.on('connect', () => {
  setStatus(position ? 'Connected' : 'Connected, waiting for location…');
  join();
});

// A reconnect gets a new socket id (= new player), so we must re-join with our last position.
socket.on('disconnect', () => {
  joined = false;
  setStatus('Disconnected, reconnecting…');
});

socket.on('game:state', (state) => {
  renderGoal(state.goal);
  ui.banner.hidden = true;
  ui.restart.disabled = false;
  setStatus('Head to the 🏁 goal!');
});

socket.on('route:update', renderRoute);

socket.on('goal:reached', () => {
  ui.banner.hidden = false;
  setStatus('Goal reached! Press "New goal" to play again.');
  if (routeLine) { routeLine.remove(); routeLine = null; }
  ui.route.textContent = '-';
});

ui.restart.addEventListener('click', () => socket.emit('game:restart', {}, onAck));

// ---- location sources ----

// Real location from the host machine (OS location services via the browser Geolocation API).
if ('geolocation' in navigator) {
  navigator.geolocation.watchPosition(
    (pos) => {
      if (ui.simulate.checked) return; // simulation overrides real GPS
      moveTo({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    },
    (err) => {
      setStatus(`Location unavailable (${err.message}). Using simulation mode.`);
      startSimulation();
    },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
  );
} else {
  setStatus('Geolocation not supported. Using simulation mode.');
  startSimulation();
}

function startSimulation() {
  ui.simulate.checked = true;
  if (!position) moveTo(FALLBACK_POSITION);
}

ui.simulate.addEventListener('change', () => {
  if (ui.simulate.checked) startSimulation();
});

// Simulation: arrow keys walk the player, clicking teleports. Lets you demo rerouting from a desk.
const ARROWS = { ArrowUp: [1, 0], ArrowDown: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1] };
document.addEventListener('keydown', (e) => {
  const dir = ARROWS[e.key];
  if (!dir || !ui.simulate.checked || !position) return;
  e.preventDefault();
  const dLat = (dir[0] * SIM_STEP_METERS) / METERS_PER_DEGREE_LAT;
  const dLng = (dir[1] * SIM_STEP_METERS) / (METERS_PER_DEGREE_LAT * Math.cos((position.lat * Math.PI) / 180));
  moveTo({ lat: position.lat + dLat, lng: position.lng + dLng });
});

map.on('click', (e) => {
  if (ui.simulate.checked) moveTo({ lat: e.latlng.lat, lng: e.latlng.lng });
});
