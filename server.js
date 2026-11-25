const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_, res) => res.json({ ok: true, game: "La mejor mentira" }));

const rooms = new Map();
const QUESTIONS = [
  "¿Cuál fue la peor excusa que usaste para no ir a un lugar?",
  "¿Qué comida podrías comer todos los días sin cansarte?",
  "¿Cuál es el talento más inútil que tenés?",
  "¿Qué es lo más raro que buscaste en Internet?",
  "¿Qué harías si fueras invisible por un día?",
  "¿Cuál fue tu peor compra impulsiva?",
  "¿Qué cosa te da vergüenza admitir que te gusta?",
  "¿Qué harías primero si ganaras la lotería?",
  "¿Cuál es una opinión impopular que defendés?",
  "¿Qué personaje ficticio sería tu peor compañero de casa?",
  "¿Qué es lo más extraño que comiste?",
  "¿Qué mentira pequeña decís muy seguido?"
];
const clean = (s, max=24) => String(s || "").trim().replace(/[<>]/g, "").slice(0, max);
const code = () => crypto.randomBytes(3).toString("hex").toUpperCase();
const publicRoom = r => ({
  code: r.code, hostId: r.hostId, settings: r.settings, phase: r.phase,
  round: r.round, question: r.question, readerId: r.readerId,
  players: r.players.map(p => ({
    id: p.id, name: p.name, connected: p.connected,
    submitted: !!r.answers[p.id], selected: (r.selected || []).includes(p.id),
    score: p.score
  })),
  answers: r.phase === "select" || r.phase === "reveal"
    ? r.players.filter(p => p.id !== r.readerId && r.answers[p.id]).map(p => ({ id:p.id, name:p.name, text:r.answers[p.id] }))
    : [],
  selected: r.phase === "reveal" ? (r.selected || []) : [],
  result: r.phase === "reveal" ? r.result : null
});
function broadcast(r) { io.to(r.code).emit("room:update", publicRoom(r)); }
function player(r, id) { return r.players.find(p => p.id === id); }
function sendError(socket, message) { socket.emit("notice", message); }
function assignRoles(r) {
  const eligible = r.players.filter(p => p.id !== r.readerId);
  const count = Math.min(r.settings.redCount, Math.max(1, eligible.length - 1));
  const shuffled = [...eligible].sort(() => Math.random() - .5);
  r.redIds = new Set(shuffled.slice(0, count).map(p => p.id));
  r.players.forEach(p => { p.score = p.score || 0; });
}
function beginRound(r) {
  if (r.players.length < 3) return false;
  r.round++;
  r.phase = "answer";
  r.readerId = r.players[(r.round - 1) % r.players.length].id;
  r.question = r.customQuestion || QUESTIONS[Math.floor(Math.random()*QUESTIONS.length)];
  r.answers = {};
  r.selected = [];
  r.result = null;
  assignRoles(r);
  r.players.forEach(p => io.to(p.id).emit("role", {
    role: p.id === r.readerId ? "reader" : (r.redIds.has(p.id) ? "red" : "blue"),
    question: r.question,
    round: r.round
  }));
  broadcast(r);
  return true;
}
function finishAnswerPhase(r) {
  if (r.phase !== "answer") return;
  r.phase = "select";
  broadcast(r);
}
function finishRound(r) {
  if (r.phase !== "select") return;
  const reds = [...r.redIds];
  const caught = reds.filter(id => r.selected.includes(id));
  const innocent = r.selected.filter(id => !r.redIds.has(id));
  const reader = player(r, r.readerId);
  const scoreChanges = {};
  if (reader) {
    const gain = caught.length * 2 - innocent.length;
    reader.score += gain;
    scoreChanges[reader.id] = gain;
  }
  reds.forEach(id => {
    const p = player(r,id);
    if (p && !r.selected.includes(id)) { p.score += 2; scoreChanges[id] = 2; }
    else if (p && r.selected.includes(id)) { p.score += 1; scoreChanges[id] = 1; }
  });
  r.result = {
    reds, caught, innocent, scoreChanges,
    roles: r.players.map(p => ({ id:p.id, name:p.name, role:p.id === r.readerId ? "reader" : (r.redIds.has(p.id) ? "red" : "blue") }))
  };
  r.phase = "reveal";
  broadcast(r);
}
io.on("connection", socket => {
  socket.on("room:create", ({name, settings}={}) => {
    const playerName = clean(name);
    if (!playerName) return sendError(socket, "Escribí un nombre para jugar.");
    let roomCode = code();
    while (rooms.has(roomCode)) roomCode = code();
    const host = { id: socket.id, name: playerName, connected: true, score: 0 };
    const r = {
      code: roomCode, hostId: socket.id, players: [host],
      settings: { maxPlayers: Math.min(10, Math.max(3, Number(settings?.maxPlayers)||6)), redCount: Math.min(3, Math.max(1, Number(settings?.redCount)||1)), answerSeconds: Math.min(180, Math.max(20, Number(settings?.answerSeconds)||60)), selectionSeconds: 30 },
      phase: "lobby", round: 0, question: "", readerId: null, answers: {}, selected: [], result: null,
      redIds: new Set(), customQuestion: ""
    };
    rooms.set(roomCode, r);
    socket.join(roomCode);
    socket.emit("room:joined", { code: roomCode, playerId: socket.id });
    broadcast(r);
  });

  socket.on("room:join", ({code: rawCode, name}={}) => {
    const roomCode = clean(rawCode, 6).toUpperCase();
    const r = rooms.get(roomCode);
    const playerName = clean(name);
    if (!r) return sendError(socket, "No encontramos esa sala. Revisá el código.");
    if (!playerName) return sendError(socket, "Escribí un nombre para jugar.");
    const existing = r.players.find(p => p.name.toLowerCase() === playerName.toLowerCase());
    if (existing && !existing.connected) {
      existing.id = socket.id; existing.connected = true;
    } else {
      if (r.players.length >= r.settings.maxPlayers) return sendError(socket, "La sala está completa.");
      if (r.phase !== "lobby") return sendError(socket, "La partida ya empezó.");
      r.players.push({ id: socket.id, name: playerName, connected: true, score: 0 });
    }
    socket.join(roomCode);
    socket.emit("room:joined", { code: roomCode, playerId: socket.id });
    broadcast(r);
  });

  socket.on("room:settings", settings => {
    const r = [...rooms.values()].find(x => x.players.some(p => p.id === socket.id));
    if (!r || r.hostId !== socket.id || r.phase !== "lobby") return;
    const maxPlayers = Math.min(10, Math.max(r.players.length, Number(settings?.maxPlayers)||r.settings.maxPlayers));
    r.settings.maxPlayers = maxPlayers;
    r.settings.redCount = Math.min(Math.max(1, Number(settings?.redCount)||1), Math.max(1, maxPlayers-2));
    r.settings.answerSeconds = Math.min(180, Math.max(20, Number(settings?.answerSeconds)||60));
    broadcast(r);
  });

  socket.on("game:start", () => {
    const r = [...rooms.values()].find(x => x.players.some(p => p.id === socket.id));
    if (!r || r.hostId !== socket.id) return;
    if (r.players.length < 3) return sendError(socket, "Necesitan al menos 3 jugadores para empezar.");
    r.players.forEach(p => p.score = 0);
    beginRound(r);
  });

  socket.on("answer:submit", text => {
    const r = [...rooms.values()].find(x => x.players.some(p => p.id === socket.id));
    if (!r || r.phase !== "answer" || socket.id === r.readerId || r.answers[socket.id]) return;
    const answer = clean(text, 220);
    if (!answer) return sendError(socket, "Escribí una respuesta antes de enviarla.");
    r.answers[socket.id] = answer;
    const expected = r.players.filter(p => p.id !== r.readerId && p.connected).length;
    const submitted = r.players.filter(p => p.id !== r.readerId && r.answers[p.id]).length;
    broadcast(r);
    if (submitted >= expected) finishAnswerPhase(r);
  });

  socket.on("selection:toggle", targetId => {
    const r = [...rooms.values()].find(x => x.players.some(p => p.id === socket.id));
    if (!r || r.phase !== "select" || socket.id !== r.readerId || !player(r,targetId) || targetId === r.readerId) return;
    r.selected = r.selected.includes(targetId) ? r.selected.filter(id => id !== targetId) : [...r.selected, targetId];
    broadcast(r);
  });
  socket.on("selection:finish", () => {
    const r = [...rooms.values()].find(x => x.players.some(p => p.id === socket.id));
    if (!r || r.phase !== "select" || socket.id !== r.readerId) return;
    finishRound(r);
  });
  socket.on("game:next", () => {
    const r = [...rooms.values()].find(x => x.players.some(p => p.id === socket.id));
    if (!r || r.phase !== "reveal" || r.hostId !== socket.id) return;
    beginRound(r);
  });
  socket.on("game:reset", () => {
    const r = [...rooms.values()].find(x => x.players.some(p => p.id === socket.id));
    if (!r || r.hostId !== socket.id) return;
    r.phase = "lobby"; r.round = 0; r.question = ""; r.readerId = null; r.answers = {}; r.selected = []; r.result = null;
    r.players.forEach(p => p.score = 0);
    broadcast(r);
  });
  socket.on("disconnect", () => {
    for (const [key,r] of rooms) {
      const p = player(r, socket.id);
      if (p) {
        p.connected = false;
        if (r.players.every(x => !x.connected)) rooms.delete(key);
        else broadcast(r);
        break;
      }
    }
  });
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log("La mejor mentira escuchando en " + PORT));
