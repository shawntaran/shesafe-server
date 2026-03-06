// ═══════════════════════════════════════════════════════
//  SheSafe × SensorApp — Cloud Bridge Server
//
//  Connections:
//    Android SensorService.kt  →  ws://HOST/android   (pushes sensor frames)
//    Browser dashboard         →  ws://HOST/browser   (receives sensor frames)
//    Browser dashboard         →  HTTP /api/*          (contacts, SOS log, settings)
//
//  Deploy to: Render, Railway, Fly.io, or run locally
//  npm install express ws cors
// ═══════════════════════════════════════════════════════

const express = require('express');
const http    = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Data persistence ──────────────────────────────────
const DATA_DIR      = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');
const SOS_LOG_FILE  = path.join(DATA_DIR, 'sos_log.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, fallback) {
    try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { console.error('readJSON error:', e.message); }
    return fallback;
}
function writeJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ── In-memory latest sensor frame ────────────────────
let latestSensor = {
    accel: { x: 0, y: 0, z: 0, mag: 0 },
    gyro:  { x: 0, y: 0, z: 0, mag: 0 },
    mic:   { amplitude: 0, db: 0 },
    gps:   { lat: null, lng: null, alt: null, speed: null, accuracy: null },
    ts: null,
    androidConnected: false
};

// ── Middleware ────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Serve the dashboard HTML as the root page
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════
//  REST API
// ═══════════════════════════════════════════

// Latest sensor snapshot (polling fallback if WebSocket isn't available)
app.get('/api/sensor', (req, res) => res.json(latestSensor));

// Contacts
app.get('/api/contacts', (req, res) => {
    res.json(readJSON(CONTACTS_FILE, []));
});
app.post('/api/contacts', (req, res) => {
    const { name, phone } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'name and phone required' });
    const list = readJSON(CONTACTS_FILE, []);
    const entry = { id: Date.now(), name, phone };
    list.push(entry);
    writeJSON(CONTACTS_FILE, list);
    res.json(entry);
});
app.delete('/api/contacts/:id', (req, res) => {
    let list = readJSON(CONTACTS_FILE, []);
    list = list.filter(c => c.id !== parseInt(req.params.id));
    writeJSON(CONTACTS_FILE, list);
    res.json({ ok: true });
});

// SOS log
app.get('/api/sos-log', (req, res) => res.json(readJSON(SOS_LOG_FILE, [])));
app.post('/api/sos-log', (req, res) => {
    const { reason, lat, lng, contacts: ctList, timestamp } = req.body;
    const log = readJSON(SOS_LOG_FILE, []);
    const entry = {
        id: Date.now(),
        reason: reason || 'Manual SOS',
        lat:  lat  || null,
        lng:  lng  || null,
        contacts: ctList || [],
        timestamp: timestamp || new Date().toISOString(),
        locationUrl: (lat && lng) ? `https://maps.google.com/?q=${lat},${lng}` : null
    };
    log.unshift(entry);
    if (log.length > 100) log.pop();
    writeJSON(SOS_LOG_FILE, log);
    // Notify all browser clients about the SOS event
    broadcastToBrowsers({ type: 'sos', data: entry });
    res.json(entry);
});

// Settings
const DEFAULT_SETTINGS = {
    motion: true, sound: true, gyro: true,
    vibrate: true, beep: true, cooldown: true, background: true,
    accelThresh: 20, soundThresh: 85, gyroThresh: 8,
    sosMessage: '🆘 EMERGENCY! I need help. My live location: {location}. Please call me or contact emergency services immediately. — SheSafe',
    panicPassword: ''
};
app.get('/api/settings', (req, res) => res.json(readJSON(SETTINGS_FILE, DEFAULT_SETTINGS)));
app.post('/api/settings', (req, res) => {
    const updated = { ...readJSON(SETTINGS_FILE, DEFAULT_SETTINGS), ...req.body };
    writeJSON(SETTINGS_FILE, updated);
    res.json(updated);
});

// Status
app.get('/api/status', (req, res) => res.json({
    ok: true,
    version: '3.0.0',
    serverTime: new Date().toISOString(),
    androidConnected: latestSensor.androidConnected,
    lastSensorTs: latestSensor.ts,
    browserClients: browserClients.size
}));

// SPA fallback
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});
// ═══════════════════════════════════════════
//  HTTP SERVER + WEBSOCKET UPGRADE ROUTING
//
//  /android  ← Android SensorService.kt connects here
//  /browser  ← Dashboard browser connects here
// ═══════════════════════════════════════════
const server = http.createServer(app);

const wssAndroid = new WebSocketServer({ noServer: true });
const wssBrowser = new WebSocketServer({ noServer: true });

// Route upgrades by path
server.on('upgrade', (req, socket, head) => {
    const url = req.url;
    if (url === '/android') {
        wssAndroid.handleUpgrade(req, socket, head, ws => {
            wssAndroid.emit('connection', ws, req);
        });
    } else if (url === '/browser') {
        wssBrowser.handleUpgrade(req, socket, head, ws => {
            wssBrowser.emit('connection', ws, req);
        });
    } else {
        socket.destroy();
    }
});

// ── Android connection ────────────────────────────────
const browserClients = new Set();

wssAndroid.on('connection', (ws, req) => {
    console.log(`[Android] Connected from ${req.socket.remoteAddress}`);
    latestSensor.androidConnected = true;
    broadcastToBrowsers({ type: 'android_status', connected: true });

    ws.on('message', raw => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.type === 'sensor') {
            // Update in-memory snapshot
            if (msg.accel) latestSensor.accel = msg.accel;
            if (msg.gyro)  latestSensor.gyro  = msg.gyro;
            if (msg.mic)   latestSensor.mic   = msg.mic;
            if (msg.gps)   latestSensor.gps   = msg.gps;
            latestSensor.ts = msg.ts || Date.now();

            // Relay to all browser clients
            broadcastToBrowsers({ type: 'sensor', data: latestSensor });
        }
    });

    ws.on('close', () => {
        console.log('[Android] Disconnected');
        latestSensor.androidConnected = false;
        broadcastToBrowsers({ type: 'android_status', connected: false });
    });

    ws.on('error', err => console.error('[Android WS error]', err.message));
});

// ── Browser connection ────────────────────────────────
wssBrowser.on('connection', (ws, req) => {
    console.log(`[Browser] Connected from ${req.socket.remoteAddress}`);
    browserClients.add(ws);

    // Immediately send current state so the dashboard isn't blank
    ws.send(JSON.stringify({ type: 'init', data: latestSensor }));

    ws.on('close', () => {
        browserClients.delete(ws);
        console.log(`[Browser] Disconnected (${browserClients.size} remaining)`);
    });

    ws.on('error', err => console.error('[Browser WS error]', err.message));
});

function broadcastToBrowsers(payload) {
    const msg = JSON.stringify(payload);
    for (const ws of browserClients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
}

// ─────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`\n🛡️  SheSafe × SensorApp — Bridge Server v3.0`);
    console.log(`   HTTP  / REST API:  http://localhost:${PORT}`);
    console.log(`   Android WebSocket: ws://localhost:${PORT}/android`);
    console.log(`   Browser WebSocket: ws://localhost:${PORT}/browser`);
    console.log(`   Data dir:          ${DATA_DIR}\n`);
    console.log(`   ── Deploy checklist ──`);
    console.log(`   1. Set SERVER_WS_URL in SensorService.kt to wss://YOUR_DOMAIN/android`);
    console.log(`   2. Place shesafe-dashboard.html at public/index.html`);
    console.log(`   3. npm start\n`);
});
