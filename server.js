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

async function saveCanvas(strokes) {
  await pool.query(
    "INSERT INTO canvas (key, data) VALUES ('main', $1) ON CONFLICT (key) DO UPDATE SET data = $1",
    [JSON.stringify(strokes)]
  );
}

async function clearCanvas() {
  await pool.query("DELETE FROM canvas WHERE key = 'main'");
}

async function main() {
  await initDB();
  const allStrokes = await loadCanvas();
  console.log('canvas cargado, trazos:', Object.keys(allStrokes).length);

  // guardar canvas con debounce pa no tronar la DB
  let saveTimer = null;
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveCanvas(allStrokes).catch(console.error);
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
        ws.send(JSON.stringify({ type: 'init', strokes: allStrokes }));
      }

      if (msg.type === 'draw') {
        if (!allStrokes[msg.id]) allStrokes[msg.id] = [];
        allStrokes[msg.id].push({ x0: msg.x0, y0: msg.y0, x1: msg.x1, y1: msg.y1, color: msg.color, size: msg.size, erase: msg.erase });
        scheduleSave();
        enqueueDraw(msg);
      }

      if (msg.type === 'clear') {
        delete allStrokes[msg.id];
        scheduleSave();
        broadcast(ws, { type: 'clear', id: msg.id });
      }

      if (msg.type === 'cursor') {
        broadcast(ws, msg);
      }
    });

    ws.on('close', () => {
      const remaining = wss.clients.size;
      console.log('desconectado | total: ' + remaining);

      if (ws._id) {
        delete allStrokes[ws._id];
        broadcast(ws, { type: 'clear', id: ws._id });
      }

      // si no queda nadie, borrar todo el canvas
      if (remaining === 0) {
        console.log('sala vacia, borrando canvas...');
        for (const key in allStrokes) delete allStrokes[key];
        clearCanvas().catch(console.error);
        // avisar a todos (no hay nadie pero por si acaso)
        const msg = JSON.stringify({ type: 'clear_all' });
        for (const c of wss.clients)
          if (c.readyState === 1) c.send(msg);
      }
    });
  });

  server.listen(PORT, () => {
    console.log('paint world corriendo en puerto ' + PORT);
  });
}

main().catch(console.error);
