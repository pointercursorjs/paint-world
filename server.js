const { WebSocketServer } = require('ws');
const fs = require('fs');

const PORT = 3001;
const STROKES_FILE = './strokes.json';

let allStrokes = {};
try { allStrokes = JSON.parse(fs.readFileSync(STROKES_FILE, 'utf8')); } catch {}

let strokesTimer = null;
function saveStrokes() {
  if (strokesTimer) return;
  strokesTimer = setTimeout(() => {
    fs.writeFileSync(STROKES_FILE, JSON.stringify(allStrokes, null, 2));
    strokesTimer = null;
  }, 3000);
}

const wss = new WebSocketServer({ port: PORT });

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

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // cliente se presenta con su id y color random
    if (msg.type === 'hello') {
      ws._id = msg.id;
      ws.send(JSON.stringify({ type: 'init', strokes: allStrokes }));
    }

    if (msg.type === 'draw') {
      if (!allStrokes[msg.id]) allStrokes[msg.id] = [];
      allStrokes[msg.id].push({ x0: msg.x0, y0: msg.y0, x1: msg.x1, y1: msg.y1, color: msg.color, size: msg.size, erase: msg.erase });
      saveStrokes();
      enqueueDraw(msg);
    }

    if (msg.type === 'clear') {
      delete allStrokes[msg.id];
      saveStrokes();
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
      saveStrokes();
      broadcast(ws, { type: 'clear', id: ws._id });
    }
  });
});

console.log('paint world corriendo en ws://localhost:' + PORT);