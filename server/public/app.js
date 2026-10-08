// Browser client: reads the host's real location, sends it to the server and renders server state.
// All game decisions (goal, goal reached, route) are made server-side.

const sessionId = new URLSearchParams(location.search).get('session') || 'default';
const socket = io();

// World view until the first GPS fix arrives; we never invent a position.
const map = L.map('map').setView([20, 0], 2);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const el = (id) => document.getElementById(id);
const ui = {
  status: el('status'),
  error: el('error'),
  playerCoords: el('player-coords'),
  accuracy: el('accuracy'),
  goalCoords: el('goal-coords'),
  copyGoal: el('copy-goal'),
  distance: el('distance'),
  route: el('route'),
  session: el('session'),
  restart: el('restart'),
  banner: el('banner'),
};
ui.session.textContent = sessionId;

let position = null; // last known player position { lat, lng }
let goal = null;
let joined = false;
let joining = false; // game:join sent, ack not received yet — the server has no session for us until then
let playerMarker = null;
let accuracyCircle = null;
let goalMarker = null;
let routeLine = null;

const formatMeters = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const formatCoords = (p) => `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;

function setStatus(state, text) {
  ui.status.dataset.state = state;
  ui.status.textContent = text;
}

function showError(message) {
  ui.error.textContent = message;
  ui.error.hidden = !message;
}

// ---- rendering ----

// Anchors are the image centers, so the exact coordinate sits in the middle of the ball / goal.
const BALL_ICON = L.icon({ iconUrl: 'img/ball.png', iconSize: [32, 32], iconAnchor: [16, 16] });
const GOAL_ICON = L.icon({ iconUrl: 'img/goal.png', iconSize: [70, 30], iconAnchor: [35, 15] });

function renderPlayer(accuracy) {
  const latLng = [position.lat, position.lng];
  ui.playerCoords.textContent = formatCoords(position);
  ui.accuracy.textContent = `±${Math.round(accuracy)} m`;

  if (!playerMarker) {
    accuracyCircle = L.circle(latLng, { radius: accuracy, color: '#1976d2', weight: 1, fillOpacity: 0.1 }).addTo(map);
    // zIndexOffset keeps the ball drawn above the goal when they overlap at the finish.
    playerMarker = L.marker(latLng, { icon: BALL_ICON, zIndexOffset: 1000 }).addTo(map).bindTooltip('You');
    map.setView(latLng, 16);
  } else {
    playerMarker.setLatLng(latLng);
    accuracyCircle.setLatLng(latLng).setRadius(accuracy);
  }
}

function renderGoal() {
  const latLng = [goal.lat, goal.lng];
  ui.goalCoords.textContent = formatCoords(goal);
  ui.copyGoal.disabled = false;
  if (goalMarker) goalMarker.setLatLng(latLng);
  else goalMarker = L.marker(latLng, { icon: GOAL_ICON }).addTo(map).bindTooltip('Goal');
}

function renderRoute(route) {
  if (routeLine) routeLine.setLatLngs(route.coordinates);
  else routeLine = L.polyline(route.coordinates, { color: '#d32f2f', weight: 5, opacity: 0.8 }).addTo(map);
  ui.route.textContent = formatMeters(route.distanceMeters);
}

function onAck(ack) {
  if (!ack.ok) return showError(`Server error: ${ack.error}`);
  if (ack.distanceToGoal !== undefined) ui.distance.textContent = formatMeters(ack.distanceToGoal);
}

// ---- talking to the server ----

function join() {
  if (joined || joining || !position || !socket.connected) return;
  joining = true;
  const sent = position;
  socket.emit('game:join', { sessionId, position }, (ack) => {
    joining = false;
    joined = ack.ok;
    onAck(ack);
    // Fixes that arrived while joining weren't sent; catch the server up with the latest one.
    if (joined && position !== sent) socket.emit('player:move', { position }, onAck);
  });
}

socket.on('connect', () => {
  showError('');
  join();
});

// A reconnect gets a new socket id (= new player), so we must re-join with our last position.
socket.on('disconnect', () => {
  joined = false;
  joining = false;
  showError('Disconnected from server, reconnecting…');
});

socket.on('game:state', (state) => {
  goal = state.goal;
  renderGoal();
  ui.banner.hidden = true;
  ui.restart.disabled = false;
  setStatus('playing', 'Playing: head to the goal');
});

socket.on('route:update', renderRoute);

socket.on('goal:reached', () => {
  ui.banner.hidden = false;
  setStatus('reached', 'Goal reached!');
  if (routeLine) { routeLine.remove(); routeLine = null; }
  ui.route.textContent = '-';
});

ui.restart.addEventListener('click', () => socket.emit('game:restart', {}, onAck));

ui.copyGoal.addEventListener('click', async () => {
  if (!goal) return;
  try {
    await navigator.clipboard.writeText(`${goal.lat.toFixed(6)}, ${goal.lng.toFixed(6)}`);
    ui.copyGoal.textContent = 'Copied!';
  } catch {
    ui.copyGoal.textContent = 'Failed';
  }
  setTimeout(() => { ui.copyGoal.textContent = 'Copy'; }, 1500);
});

// ---- location: host machine's location services via the Geolocation API ----

const GEO_ERRORS = {
  1: 'Location permission denied. Allow location access for this site in the browser settings and reload.',
  2: 'Position unavailable. Make sure location services are enabled on this machine.',
  3: 'Timed out waiting for a location fix. Still trying…',
};

function onPosition(pos) {
  showError('');
  position = { lat: pos.coords.latitude, lng: pos.coords.longitude };
  renderPlayer(pos.coords.accuracy);
  if (joined) socket.emit('player:move', { position }, onAck);
  else join();
}

function onPositionError(err) {
  showError(GEO_ERRORS[err.code] ?? `Location error: ${err.message}`);
  if (err.code === 1) setStatus('waiting', 'No location access');
}

if ('geolocation' in navigator) {
  navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 0, // always a fresh fix, never a cached one
    timeout: 15000,
  });
} else {
  showError('This browser does not support geolocation.');
}
