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

async function saveCanvas(pixels) {
  await pool.query(
    "INSERT INTO canvas (key, data) VALUES ('main', $1) ON CONFLICT (key) DO UPDATE SET data = $1",
    [JSON.stringify(pixels)]
  );
}

async function clearCanvas() {
  await pool.query("DELETE FROM canvas WHERE key = 'main'");
}

async function main() {
  await initDB();
  // pixels = { "x,y": "#color" }
  const pixels = await loadCanvas();
  // quién pintó qué pixel: { "x,y": userId }
  const pixelOwners = {};
  console.log('canvas cargado, pixels:', Object.keys(pixels).length);

  let saveTimer = null;
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveCanvas(pixels).catch(console.error);
      saveTimer = null;
    }, 3000);
  }

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
        ws.send(JSON.stringify({ type: 'init', pixels }));
      }

      if (msg.type === 'pixel') {
        const key = msg.px + ',' + msg.py;
        if (msg.color === null) {
          delete pixels[key];
          delete pixelOwners[key];
        } else {
          pixels[key] = msg.color;
          pixelOwners[key] = msg.id;
        }
        scheduleSave();
        enqueueDraw({ type: 'pixel', id: msg.id, px: msg.px, py: msg.py, color: msg.color });
      }

      if (msg.type === 'clear') {
        // borrar todos los pixels de este usuario
        for (const key in pixelOwners) {
          if (pixelOwners[key] === msg.id) {
            delete pixels[key];
            delete pixelOwners[key];
          }
        }
        scheduleSave();
        broadcast(ws, { type: 'clear_user', id: msg.id, pixels });
      }

      if (msg.type === 'cursor') {
        broadcast(ws, msg);
      }
    });

    ws.on('close', () => {
      const remaining = wss.clients.size;
      console.log('desconectado | total: ' + remaining);

      if (ws._id) {
        // borrar pixels de este usuario
        for (const key in pixelOwners) {
          if (pixelOwners[key] === ws._id) {
            delete pixels[key];
            delete pixelOwners[key];
          }
        }
        broadcast(ws, { type: 'clear_user', id: ws._id, pixels });
        scheduleSave();
      }

      // si no queda nadie, limpiar todo
      if (remaining === 0) {
        console.log('sala vacia, borrando canvas...');
        for (const key in pixels) delete pixels[key];
        for (const key in pixelOwners) delete pixelOwners[key];
        clearCanvas().catch(console.error);
      }
    });
  });

  server.listen(PORT, () => {
    console.log('paint world corriendo en puerto ' + PORT);
  });
}

main().catch(console.error);
