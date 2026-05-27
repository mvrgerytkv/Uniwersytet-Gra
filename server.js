const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// Simple HTTP server to serve client files
const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const mimeTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
  const contentType = mimeTypes[ext] || 'text/plain';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// WebSocket game server
const wss = new WebSocketServer({ server });

// Game rooms: { roomCode: { players: [], state: {}, host: ws } }
const rooms = {};

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function broadcast(room, message, excludeWs = null) {
  if (!rooms[room]) return;
  rooms[room].players.forEach(p => {
    if (p.ws !== excludeWs && p.ws.readyState === 1) {
      p.ws.send(JSON.stringify(message));
    }
  });
}

function broadcastAll(room, message) {
  if (!rooms[room]) return;
  rooms[room].players.forEach(p => {
    if (p.ws.readyState === 1) p.ws.send(JSON.stringify(message));
  });
}

function sendTo(ws, message) {
  if (ws.readyState === 1) ws.send(JSON.stringify(message));
}

// GAME LOGIC
const HIERARCHY = ['student','magister','doktor','profesor','dziekan','rektor'];
const POINTS = { student:1, magister:3, doktor:9, profesor:27, dziekan:81, rektor:243 };
const DICE_FACES = ['student','student','student','magister','doktor','villain'];

function createInitialPlayerState(name) {
  return {
    name,
    hand: { student:0, magister:0, doktor:0, profesor:0, dziekan:0, rektor:0 },
    score: 0,
    hasRolled: false
  };
}

function initGameState(players) {
  return {
    players: players.map(p => ({ ...p })),
    currentPlayerIdx: 0,
    round: 1,
    totalRounds: 15,
    phase: 'roll', // 'roll' | 'villain_effect' | 'waiting'
    lastRoll: null,
    log: [],
    started: true,
    ended: false
  };
}

function getPublicState(state, room) {
  return {
    players: state.players.map(p => ({
      name: p.name,
      hand: { ...p.hand },
      score: p.score
    })),
    currentPlayer: state.players[state.currentPlayerIdx]?.name,
    currentPlayerIdx: state.currentPlayerIdx,
    round: state.round,
    totalRounds: state.totalRounds,
    phase: state.phase,
    lastRoll: state.lastRoll,
    log: state.log.slice(-5),
    ended: state.ended
  };
}

function tryUpgrades(playerState) {
  let upgraded = false;
  for (let i = 0; i < HIERARCHY.length - 1; i++) {
    const lower = HIERARCHY[i];
    const upper = HIERARCHY[i+1];
    while ((playerState.hand[lower] || 0) >= 3) {
      playerState.hand[lower] -= 3;
      playerState.hand[upper] = (playerState.hand[upper] || 0) + 1;
      playerState.score += POINTS[upper];
      upgraded = true;
    }
  }
  return upgraded;
}

function addLog(state, msg) {
  state.log.push(msg);
  if (state.log.length > 20) state.log.shift();
}

function handleRoll(room, ws) {
  const r = rooms[room];
  if (!r) return;
  const state = r.state;
  const pidx = state.currentPlayerIdx;
  const player = state.players[pidx];

  if (state.phase !== 'roll') {
    sendTo(ws, { type: 'error', msg: 'Nie twoja tura lub zła faza!' });
    return;
  }
  if (r.players[pidx].ws !== ws) {
    sendTo(ws, { type: 'error', msg: 'Nie twoja tura!' });
    return;
  }

  // Roll dice
  const rollIdx = Math.floor(Math.random() * DICE_FACES.length);
  const result = DICE_FACES[rollIdx];
  state.lastRoll = result;

  if (result === 'villain') {
    // Villain: steal one card from random other player
    const others = state.players.filter((p, i) => i !== pidx && Object.values(p.hand).some(v => v > 0));
    let villainMsg = '';
    if (others.length > 0) {
      const victim = others[Math.floor(Math.random() * others.length)];
      // Find highest card they have
      let stealType = null;
      for (let i = HIERARCHY.length - 1; i >= 0; i--) {
        if ((victim.hand[HIERARCHY[i]] || 0) > 0) {
          stealType = HIERARCHY[i];
          break;
        }
      }
      if (stealType) {
        victim.hand[stealType]--;
        victim.score = Math.max(0, victim.score - POINTS[stealType]);
        villainMsg = `📋 Ministerstwo! ${player.name} kradnie ${stealType} od ${victim.name}!`;
        addLog(state, villainMsg);
      } else {
        villainMsg = '📋 Ministerstwo przyszło, ale nie miało co kraść!';
        addLog(state, villainMsg);
      }
    } else {
      villainMsg = '📋 Ministerstwo przyszło, ale nikt nic nie ma!';
      addLog(state, villainMsg);
    }
    state.phase = 'villain_effect';
    broadcastAll(room, { type: 'villain', roll: result, msg: villainMsg, state: getPublicState(state, room) });
  } else {
    // Normal roll: player gets the card
    player.hand[result] = (player.hand[result] || 0) + 1;
    addLog(state, `🎲 ${player.name} wyrzucił/a: ${result}!`);

    // Auto upgrades
    const upgraded = tryUpgrades(player);
    if (upgraded) {
      addLog(state, `⬆️ ${player.name} awansował/a!`);
    }

    // Advance turn
    advanceTurn(room, state);
    broadcastAll(room, { type: 'rolled', roll: result, state: getPublicState(state, room) });
  }
}

function handleConfirmVillain(room) {
  const r = rooms[room];
  if (!r) return;
  advanceTurn(room, r.state);
  broadcastAll(room, { type: 'villain_done', state: getPublicState(r.state, room) });
}

function advanceTurn(room, state) {
  state.currentPlayerIdx = (state.currentPlayerIdx + 1) % state.players.length;
  if (state.currentPlayerIdx === 0) state.round++;
  if (state.round > state.totalRounds) {
    state.ended = true;
    state.phase = 'ended';
    addLog(state, '🏁 Koniec gry!');
  } else {
    state.phase = 'roll';
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create_room': {
        const code = generateRoomCode();
        const player = { name: msg.name || 'Gracz 1', ws };
        rooms[code] = {
          players: [player],
          state: null,
          hostWs: ws
        };
        ws._room = code;
        ws._name = msg.name;
        ws._isHost = true;
        sendTo(ws, { type: 'room_created', code, playerIdx: 0, name: msg.name });
        break;
      }
      case 'join_room': {
        const code = msg.code?.toUpperCase();
        if (!rooms[code]) { sendTo(ws, { type: 'error', msg: 'Nie ma takiego pokoju!' }); return; }
        if (rooms[code].state?.started) { sendTo(ws, { type: 'error', msg: 'Gra już trwa!' }); return; }
        if (rooms[code].players.length >= 4) { sendTo(ws, { type: 'error', msg: 'Pokój pełny (max 4)!' }); return; }
        const player = { name: msg.name || `Gracz ${rooms[code].players.length + 1}`, ws };
        rooms[code].players.push(player);
        ws._room = code;
        ws._name = msg.name;
        ws._isHost = false;
        const pidx = rooms[code].players.length - 1;
        sendTo(ws, { type: 'room_joined', code, playerIdx: pidx, name: msg.name });
        broadcastAll(code, {
          type: 'lobby_update',
          players: rooms[code].players.map(p => p.name),
          count: rooms[code].players.length
        });
        break;
      }
      case 'start_game': {
        const code = ws._room;
        if (!rooms[code]) return;
        if (rooms[code].hostWs !== ws) { sendTo(ws, { type: 'error', msg: 'Tylko host może startować!' }); return; }
        if (rooms[code].players.length < 1) { sendTo(ws, { type: 'error', msg: 'Za mało graczy!' }); return; }
        rooms[code].state = initGameState(rooms[code].players.map(p => createInitialPlayerState(p.name)));
        broadcastAll(code, { type: 'game_started', state: getPublicState(rooms[code].state, code) });
        break;
      }
      case 'roll': {
        const code = ws._room;
        handleRoll(code, ws);
        break;
      }
      case 'confirm_villain': {
        const code = ws._room;
        handleConfirmVillain(code);
        break;
      }
    }
  });

  ws.on('close', () => {
    const code = ws._room;
    if (!code || !rooms[code]) return;
    rooms[code].players = rooms[code].players.filter(p => p.ws !== ws);
    if (rooms[code].players.length === 0) {
      delete rooms[code];
    } else {
      broadcastAll(code, {
        type: 'player_left',
        name: ws._name,
        players: rooms[code].players.map(p => p.name)
      });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎓 UNIWERSYTET - Serwer gry uruchomiony!`);
  console.log(`📡 Adres lokalny: http://localhost:${PORT}`);
  console.log(`📱 Aby grać przez telefon, otwórz adres IP Twojego komputera:3000`);
  console.log(`   Sprawdź IP kommandem: ipconfig (Windows) lub ifconfig (Mac/Linux)\n`);
});
