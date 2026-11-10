// Simulasi 50 HP dan 1 layar proyektor. Jalankan dengan: npm test
const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3977, URL = `ws://localhost:${PORT}/ws`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const open = url => new Promise((res, rej) => { const w = new WebSocket(url); w.once('open', () => res(w)); w.once('error', rej); });

(async () => {
  const srv = spawn('node', ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, HOST_KEY: 'k' } });
  await new Promise(r => srv.stdout.once('data', r));
  try {
    const host = await open(`${URL}?key=k`);
    let s;
    host.on('message', d => { const m = JSON.parse(d); if (m.phase) s = m; });
    const phones = await Promise.all(Array.from({ length: 50 }, () => open(URL)));
    await sleep(150);
    assert.equal(s.players, 50, 'layar proyektor tidak dihitung sebagai peserta');

    const wrong = await open(`${URL}?key=salah`);
    const code = await new Promise(r => wrong.once('close', r));
    assert.equal(code, 1008, 'key salah ditolak');

    phones[0].send('start');
    await sleep(150);
    assert.equal(s.phase, 'lobby', 'peserta tidak bisa memulai acara');

    phones[0].send('t');
    await sleep(150);
    assert.equal(s.taps, 0, 'tap sebelum mulai tidak dihitung');

    host.send('start');
    await sleep(150);
    assert.equal(s.phase, 'play');
    assert.equal(s.target, 36000);

    const late = await open(URL);
    await sleep(150);
    assert.equal(s.target, 36720, 'peserta telat menambah target');
    late.close();
    await sleep(150);
    assert.equal(s.target, 36720, 'peserta keluar tidak mengurangi target');

    for (let i = 0; i < 100; i++) phones[0].send('t');
    await sleep(150);
    assert.equal(s.taps, 20, 'auto-tap dibatasi 20 per detik');
    await sleep(1000);

    while (s.phase === 'play') {
      for (const p of phones) for (let i = 0; i < 20; i++) p.send('t');
      await sleep(1050);
    }
    assert.equal(s.phase, 'done');
    assert.equal(s.taps, s.target, 'tap berhenti tepat di target');
    assert.equal(s.teams.reduce((a, b) => a + b), s.taps, 'total tap empat tim sama dengan total tap');

    phones[0].send('reset');
    await sleep(150);
    assert.equal(s.phase, 'done', 'peserta tidak bisa reset');

    host.send('reset');
    await sleep(150);
    assert.equal(s.phase, 'lobby');
    assert.equal(s.taps, 0);
    assert.deepEqual(s.teams, [0, 0, 0, 0], 'skor tim kembali nol');

    console.log('OK, 50 HP tersambung, tap terhitung, kontrol host aman');
    [host, ...phones].forEach(w => w.close());
  } finally {
    srv.kill();
  }
})().catch(e => { console.error(e); process.exit(1); });
