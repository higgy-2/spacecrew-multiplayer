const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, "public");
const rooms = new Map();
const clients = new Map();

function code() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function roomState(room) {
  return {
    type: "state",
    room: room.code,
    phase: room.phase,
    hostId: room.hostId,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, x: p.x, y: p.y,
      alive: p.alive, isImpostor: room.phase !== "lobby" && p.isImpostor,
      tasks: p.tasks, done: p.done
    })),
    message: room.message,
    votes: room.votes.size
  };
}
function broadcast(room) {
  const state = roomState(room);
  for (const p of room.players.values()) send(p.ws, state);
}
function notice(room, message) {
  room.message = message;
  broadcast(room);
}
function leave(ws) {
  const info = clients.get(ws);
  if (!info) return;
  clients.delete(ws);
  const room = rooms.get(info.room);
  if (!room) return;
  room.players.delete(info.id);
  if (room.players.size === 0) rooms.delete(info.room);
  else {
    if (room.hostId === info.id) room.hostId = room.players.keys().next().value;
    broadcast(room);
  }
}
const server = http.createServer((req, res) => {
  let file = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
  const full = path.join(publicDir, file);
  if (!full.startsWith(publicDir)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const ext = path.extname(full);
    const types = {".html":"text/html", ".js":"text/javascript", ".css":"text/css"};
    res.writeHead(200, {"Content-Type": types[ext] || "application/octet-stream"});
    res.end(data);
  });
});
const wss = new WebSocket.Server({ server });

wss.on("connection", ws => {
  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "create" || msg.type === "join") {
      if (clients.has(ws)) return;
      let roomCode = (msg.code || "").toUpperCase().trim();
      if (msg.type === "create") {
        do { roomCode = code(); } while (rooms.has(roomCode));
        rooms.set(roomCode, { code: roomCode, players: new Map(), hostId: null, phase: "lobby", votes: new Map(), message: "Waiting for crewmates..." });
      }
      const room = rooms.get(roomCode);
      if (!room) return send(ws, {type:"error", message:"Room not found. Check the code."});
      if (room.phase !== "lobby") return send(ws, {type:"error", message:"That game has already started."});
      if (room.players.size >= 10) return send(ws, {type:"error", message:"Room is full (10 players max)."});
      const id = Math.random().toString(36).slice(2, 10);
      const p = {
        id, ws, name: String(msg.name || "Crewmate").slice(0, 14),
        color: msg.color || "#45d6ff",
        x: 350 + Math.random() * 100, y: 250 + Math.random() * 80,
        alive: true, isImpostor: false, tasks: 3, done: 0
      };
      room.players.set(id, p);
      if (!room.hostId) room.hostId = id;
      clients.set(ws, {room: roomCode, id});
      send(ws, {type:"joined", id, code:roomCode});
      broadcast(room);
      return;
    }
    const info = clients.get(ws);
    if (!info) return;
    const room = rooms.get(info.room);
    if (!room) return;
    const p = room.players.get(info.id);
    if (!p) return;

    if (msg.type === "move" && room.phase === "playing" && p.alive) {
      p.x = Math.max(35, Math.min(665, Number(msg.x) || p.x));
      p.y = Math.max(35, Math.min(465, Number(msg.y) || p.y));
      broadcast(room);
    }
    if (msg.type === "start" && p.id === room.hostId && room.phase === "lobby") {
      if (room.players.size < 2) return send(ws, {type:"error", message:"You need at least 2 players to start."});
      const players = [...room.players.values()];
      players.forEach(q => { q.alive = true; q.done = 0; q.isImpostor = false; });
      players[Math.floor(Math.random() * players.length)].isImpostor = true;
      room.phase = "playing";
      notice(room, "The game has started. Complete your tasks and watch your back!");
    }
    if (msg.type === "task" && room.phase === "playing" && p.alive && !p.isImpostor) {
      if (p.done < p.tasks) {
        p.done++;
        notice(room, p.name + " completed a task.");
        if ([...room.players.values()].filter(q => !q.isImpostor && q.alive).every(q => q.done >= q.tasks))
          room.phase = "crewmates_win";
        broadcast(room);
      }
    }
    if (msg.type === "kill" && room.phase === "playing" && p.alive && p.isImpostor) {
      const target = room.players.get(msg.target);
      if (target && target.alive && !target.isImpostor && Math.hypot(target.x-p.x, target.y-p.y) < 55) {
        target.alive = false;
        notice(room, "A crewmate was eliminated! Report a body or call a meeting.");
      }
    }
    if (msg.type === "report" && room.phase === "playing" && p.alive) {
      room.phase = "meeting"; room.votes.clear();
      notice(room, p.name + " called an emergency meeting. Vote for a player!");
    }
    if (msg.type === "vote" && room.phase === "meeting" && p.alive) {
      room.votes.set(p.id, msg.target || "skip");
      const living = [...room.players.values()].filter(q => q.alive);
      if (room.votes.size >= living.length) {
        const counts = {};
        for (const v of room.votes.values()) counts[v] = (counts[v] || 0) + 1;
        const top = Object.entries(counts).sort((a,b) => b[1]-a[1]);
        if (top.length && top[0][0] !== "skip" && (!top[1] || top[0][1] > top[1][1])) {
          const out = room.players.get(top[0][0]);
          if (out) out.alive = false;
        }
        const impostorAlive = [...room.players.values()].some(q => q.alive && q.isImpostor);
        const crewAlive = [...room.players.values()].filter(q => q.alive && !q.isImpostor).length;
        room.phase = !impostorAlive ? "crewmates_win" : crewAlive <= 1 ? "impostor_win" : "playing";
        room.votes.clear();
        notice(room, room.phase === "playing" ? "Meeting over. Back to work!" : (room.phase === "crewmates_win" ? "Crewmates win!" : "Impostor wins!"));
      } else broadcast(room);
    }
  });
  ws.on("close", () => leave(ws));
  ws.on("error", () => leave(ws));
});
server.listen(PORT, () => console.log(`SpaceCrew running at http://localhost:${PORT}`));
