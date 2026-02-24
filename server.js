const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3001;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS strokes (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '[]'
    )
  `);
}

async function loadStrokes() {
  const res = await pool.query('SELECT id, data FROM strokes');
  const strokes = {};
  for (const row of res.rows) strokes[row.id] = row.data;
  return strokes;
}

async function saveUserStrokes(id, segs) {
  await pool.query(
    'INSERT INTO strokes (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2',
    [id, JSON.stringify(segs)]
  );
}

async function deleteUserStrokes(id) {
  await pool.query('DELETE FROM strokes WHERE id = $1', [id]);
}

async function main() {
  await initDB();
  const allStrokes = await loadStrokes();
  console.log('DB lista, strokes cargados:', Object.keys(allStrokes).length);

  // servidor HTTP que sirve el HTML
  const server = http.createServer((req, res) => {
    const file = path.join(__dirname, 'paint-world.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  });

  // WebSocket encima del mismo servidor HTTP
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
        ws.send(JSON.stringify({ type: 'init', strokes: allStrokes }));
      }

      if (msg.type === 'draw') {
        if (!allStrokes[msg.id]) allStrokes[msg.id] = [];
        allStrokes[msg.id].push({ x0: msg.x0, y0: msg.y0, x1: msg.x1, y1: msg.y1, color: msg.color, size: msg.size, erase: msg.erase });
        saveUserStrokes(msg.id, allStrokes[msg.id]).catch(console.error);
        enqueueDraw(msg);
      }

      if (msg.type === 'clear') {
        delete allStrokes[msg.id];
        deleteUserStrokes(msg.id).catch(console.error);
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
        deleteUserStrokes(ws._id).catch(console.error);
        broadcast(ws, { type: 'clear', id: ws._id });
      }
    });
  });

  server.listen(PORT, () => {
    console.log('paint world corriendo en puerto ' + PORT);
  });
}

main().catch(console.error);
