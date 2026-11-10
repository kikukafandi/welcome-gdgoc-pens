const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const HOST_KEY = process.env.HOST_KEY || crypto.randomBytes(4).toString('hex');

// Angka yang bisa disetel saat gladi
const TAPS_PER_PERSON = 80; // target = jumlah orang saat Mulai x angka ini, 80 kira-kira 20 detik tap
const MIN_TARGET = 80;
const MAX_TAPS_PER_SEC = 20; // lebih cepat dari jari manusia, membatasi script auto-tap
const MAX_CONNECTIONS = 300;

// ponytail: satu acara, satu ruangan, state di memori. Server restart = mulai dari lobby lagi.
let phase = 'lobby', taps = 0, target = 0, delta = [0, 0, 0, 0], teams = [0, 0, 0, 0], dirty = true, nextColor = 0;

function lanAddress() {
  const nics = Object.entries(os.networkInterfaces())
    .filter(([name]) => !/^(lo|docker|br-|veth|virbr|tailscale|zt)/.test(name))
    .flatMap(([, list]) => list);
  return nics.find(n => n.family === 'IPv4' && !n.internal)?.address;
}

function joinUrl(req) {
  let host = req.headers.host;
  // Kalau layar dibuka lewat localhost, QR harus tetap menunjuk alamat yang bisa dicapai HP
  if (/^(localhost|127\.|\[::1\])/.test(host) && lanAddress()) host = `${lanAddress()}:${PORT}`;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  return `${proto}://${host}/`;
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/' || pathname === '/screen') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }
  if (pathname === '/font.woff2' || pathname === '/bagel.woff2') {
    res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'max-age=86400' });
    return fs.createReadStream(path.join(__dirname, pathname)).pipe(res);
  }
  if (pathname === '/join') {
    const url = joinUrl(req);
    const svg = await QRCode.toString(url, { type: 'svg', margin: 2 });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ url, svg }));
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 });
const players = () => [...wss.clients].filter(c => !c.isHost).length;

function hostCommand(cmd) {
  if (cmd === 'start' && phase === 'lobby') {
    target = Math.max(MIN_TARGET, players() * TAPS_PER_PERSON);
    phase = 'play';
  } else if (cmd === 'pop' && phase === 'play') {
    phase = 'done';
  } else if (cmd === 'reset') {
    phase = 'lobby'; taps = 0; target = 0; delta = [0, 0, 0, 0]; teams = [0, 0, 0, 0];
  }
  dirty = true;
}

function playerTap(ws) {
  if (phase !== 'play') return;
  const now = Date.now();
  if (now - ws.windowStart >= 1000) { ws.windowStart = now; ws.count = 0; }
  if (++ws.count > MAX_TAPS_PER_SEC) return;
  taps++;
  delta[ws.color]++;
  teams[ws.color]++;
  dirty = true;
  if (taps >= target) phase = 'done';
}

wss.on('connection', (ws, req) => {
  ws.on('error', () => {}); // pesan kebesaran atau koneksi putus tidak boleh mematikan server
  const key = new URL(req.url, 'http://x').searchParams.get('key');
  if (key !== null && key !== HOST_KEY) return ws.close(1008, 'wrong key');
  if (wss.clients.size > MAX_CONNECTIONS) return ws.close(1013, 'full');

  ws.isHost = key === HOST_KEY;
  ws.alive = true;
  ws.windowStart = 0;
  ws.count = 0;
  ws.color = nextColor++ % 4;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('close', () => { dirty = true; });
  ws.on('message', data => ws.isHost ? hostCommand(data.toString()) : playerTap(ws));

  ws.send(JSON.stringify({ color: ws.color }));
  dirty = true;
});

// Kirim state 20x per detik, bukan per tap, supaya beban tetap rata walau semua tap bersamaan
setInterval(() => {
  if (!dirty) return;
  const msg = JSON.stringify({ phase, taps, target, players: players(), delta, teams });
  for (const c of wss.clients) if (c.readyState === c.OPEN) c.send(msg);
  delta = [0, 0, 0, 0];
  dirty = false;
}, 50);

// HP yang mati atau terkunci jangan ikut terhitung saat target dihitung
setInterval(() => {
  for (const c of wss.clients) {
    if (!c.alive) { c.terminate(); continue; }
    c.alive = false;
    c.ping();
  }
}, 10000);

server.listen(PORT, () => {
  const lan = lanAddress();
  console.log(`\nLayar proyektor (jangan dibagikan):\n  http://localhost:${PORT}/screen?key=${HOST_KEY}`);
  console.log(`\nLink peserta:\n  ${lan ? `http://${lan}:${PORT}/` : `http://localhost:${PORT}/`}\n`);
});
