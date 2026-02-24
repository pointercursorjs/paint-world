const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3001;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS canvas (
      key TEXT PRIMARY KEY,
      data JSONB NOT NULL
    )
  `);
}

async function loadCanvas() {
  const res = await pool.query("SELECT data FROM canvas WHERE key = 'main'");
  if (res.rows.length === 0) return {};
  return res.rows[0].data;
}

// solo guarda usuarios que ya no estan conectados (el canvas permanente)
async function saveCanvas(strokes) {
  await pool.query(
    "INSERT INTO canvas (key, data) VALUES ('main', $1) ON CONFLICT (key) DO UPDATE SET data = $1",
    [JSON.stringify(strokes)]
  );
}

async function main() {
  await initDB();

  // canvas permanente = trazos de sesiones anteriores que el usuario decidio no borrar
  // ahorita lo dejamos vacio porque cada sesion es temporal
  const permanentStrokes = {};
  // strokes activos en memoria (se pierden si el server se reinicia, eso es lo correcto)
  const allStrokes = {};

  console.log('DB lista');

  const server = http.createServer((req, res) => {
    const file = path.join(__dirname, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server });

  const queue = [];
  let batchTimer = null;
  function flushBatch() {
    if (!queue.length) { batchTimer = null; return; }
    const msg = JSON.stringify({ type: 'batch', items: queue.splice(0) });
    for (const c of wss.clients)
      if (c.readyState === 1) c.send(msg);
    batchTimer = null;
  }
  function enqueueDraw(item) {
    queue.push(item);
    if (!batchTimer) batchTimer = setTimeout(flushBatch, 16);
  }

  function broadcast(sender, data) {
    const str = JSON.stringify(data);
    for (const c of wss.clients)
      if (c !== sender && c.readyState === 1) c.send(str);
  }

  wss.on('connection', (ws) => {
    console.log('conectado | total: ' + wss.clients.size);

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'hello') {
        ws._id = msg.id;
        // solo mandamos los trazos activos en memoria, no los de DB
        ws.send(JSON.stringify({ type: 'init', strokes: allStrokes }));
      }

      if (msg.type === 'draw') {
        if (!allStrokes[msg.id]) allStrokes[msg.id] = [];
        allStrokes[msg.id].push({ x0: msg.x0, y0: msg.y0, x1: msg.x1, y1: msg.y1, color: msg.color, size: msg.size, erase: msg.erase });
        enqueueDraw(msg);
      }

      if (msg.type === 'clear') {
        delete allStrokes[msg.id];
        broadcast(ws, { type: 'clear', id: msg.id });
      }

      if (msg.type === 'cursor') {
        broadcast(ws, msg);
      }
    });

    ws.on('close', () => {
      console.log('desconectado | total: ' + wss.clients.size);
      if (ws._id) {
        delete allStrokes[ws._id];
        broadcast(ws, { type: 'clear', id: ws._id });
      }
    });
  });

  server.listen(PORT, () => {
    console.log('paint world corriendo en puerto ' + PORT);
  });
}

main().catch(console.error);
