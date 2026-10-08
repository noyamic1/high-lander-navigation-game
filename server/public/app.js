// Browser client: reads the host's real location, sends it to the server and renders server state.
// All game decisions (goal, goal reached, winner, route) are made server-side.

const params = new URLSearchParams(location.search);
const sessionId = params.get('session') || 'default';
const playerName = params.get('name') || ''; // empty -> server assigns "Player-xxxx"
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
  players: el('players'),
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
let lastState = null; // latest game:state snapshot
const otherMarkers = new Map(); // playerId -> Leaflet marker for everyone else in the session

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
const OTHER_ICON = L.icon({ iconUrl: 'img/ball.png', iconSize: [24, 24], iconAnchor: [12, 12], className: 'other-player' });

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

// Membership comes from full snapshots (game:state); positions also from player:moved deltas.
function renderOthers(players) {
  const others = players.filter((p) => p.id !== socket.id);
  const present = new Set(others.map((p) => p.id));
  for (const [id, marker] of otherMarkers) {
    if (!present.has(id)) { marker.remove(); otherMarkers.delete(id); }
  }
  for (const p of others) moveOther(p.id, p.position, p.name);
}

function moveOther(id, pos, name) {
  const marker = otherMarkers.get(id);
  if (marker) return marker.setLatLng([pos.lat, pos.lng]);
  if (!name) return; // unknown player; the next game:state will add them
  otherMarkers.set(id, L.marker([pos.lat, pos.lng], { icon: OTHER_ICON })
    .addTo(map)
    .bindTooltip(name, { permanent: true, direction: 'top', offset: [0, -12] }));
}

function renderPlayerList(state) {
  ui.players.replaceChildren(...state.players.map((p) => {
    const li = document.createElement('li');
    const you = p.id === socket.id ? ' (you)' : '';
    const trophy = state.winner?.playerId === p.id ? ' 🏆' : '';
    li.textContent = `${p.name}${you}${trophy}`;
    return li;
  }));
}

function showWinner(winner) {
  const iWon = winner.playerId === socket.id;
  ui.banner.textContent = iWon ? '⚽ You won!' : `🏆 ${winner.name} won!`;
  ui.banner.hidden = false;
  setStatus('reached', iWon ? 'You reached the goal first!' : `${winner.name} reached the goal first`);
}

function clearRoute() {
  if (routeLine) { routeLine.remove(); routeLine = null; }
  ui.route.textContent = '-';
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
  socket.emit('game:join', { sessionId, position, name: playerName }, (ack) => {
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

// Sent on join/leave/restart, so it must render the whole truth: a player joining after the
// round was won still sees the winner.
socket.on('game:state', (state) => {
  lastState = state;
  goal = state.goal;
  renderGoal();
  renderOthers(state.players);
  renderPlayerList(state);
  ui.restart.disabled = false;
  if (state.winner) {
    showWinner(state.winner);
  } else {
    ui.banner.hidden = true;
    setStatus('playing', 'Playing: race to the goal');
  }
});

socket.on('player:moved', ({ id, position: pos }) => moveOther(id, pos));

socket.on('route:update', renderRoute);

socket.on('game:won', (winner) => {
  showWinner(winner);
  if (winner.playerId === socket.id) clearRoute();
  if (lastState) renderPlayerList({ ...lastState, winner });
});

// Only sent to a player who arrives after someone else already won.
socket.on('goal:reached', () => {
  clearRoute();
  setStatus('reached', 'You reached the goal, but not first');
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
