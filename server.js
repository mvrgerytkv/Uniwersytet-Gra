const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ── game state ─────────────────────────────────────────────────────────────
const rooms = {};

function makeRoom(code) {
  return {
    code,
    players: {},   // id -> player
    order: [],     // turn order
    turn: 0,
    started: false
  };
}

const RANKS = ['student','magister','doktor','profesor','dziekan','rektor'];
const RANK_LABELS = {
  student:'🎒 Student', magister:'📜 Magister', doktor:'🔬 Doktor',
  profesor:'📚 Profesor', dziekan:'🏛️ Dziekan', rektor:'👑 Rektor'
};

// Kariera tokens
const CAREER_TOKENS = [
  { id:'art_q4',   label:'Artykuł Q4',          pts:2,  icon:'📰' },
  { id:'art_q3',   label:'Artykuł Q3',          pts:4,  icon:'📄' },
  { id:'art_q2',   label:'Artykuł Q2',          pts:7,  icon:'📑' },
  { id:'art_q1',   label:'Artykuł Q1',          pts:12, icon:'🏆' },
  { id:'conf_loc', label:'Konferencja lokalna',  pts:3,  icon:'🎤' },
  { id:'conf_int', label:'Konferencja między.', pts:8,  icon:'✈️'  },
  { id:'grant_sm', label:'Grant NCN (mały)',    pts:5,  icon:'💰' },
  { id:'grant_lg', label:'Grant NCN (duży)',    pts:15, icon:'💎' },
  { id:'review',   label:'Recenzja ekspercka',  pts:3,  icon:'📝' },
  { id:'teaching', label:'Nagroda dydaktyczna', pts:4,  icon:'🎓' },
];

// Kostka: ściany
// 3x student, 1x magister, 1x ministerstwo, 1x event (kariera/komisja)
const DICE_FACES = [
  'student','student','student','magister','ministerstwo','event'
];

// Eventy: 8 różnych
const EVENTS = [
  { id:'komisja', icon:'🔍', title:'Komisja Akredytacyjna',
    desc:'Sprawdzają Twoje kwalifikacje. Tracisz losową kartę hierarchii!',
    type:'steal_hand' },
  { id:'grant',   icon:'💰', title:'Grant MEiN',
    desc:'Ministerstwo przyznało grant! Dostajesz kartę DOKTORA.',
    type:'give', rank:'doktor' },
  { id:'art_q1',  icon:'🏆', title:'Publikacja Q1!',
    desc:'Twój artykuł przyjęto do Nature. +12 pkt kariery!',
    type:'career_pts', pts:12 },
  { id:'conf',    icon:'✈️',  title:'Konferencja Międzynarodowa',
    desc:'Prezentowałeś w Tokio. +8 pkt kariery!',
    type:'career_pts', pts:8 },
  { id:'plagiat', icon:'⚠️',  title:'Wykryto Plagiat',
    desc:'Komisja wykryła plagiat. Najsilniejszy gracz traci swoją najcenniejszą kartę hierarchii!',
    type:'punish_strongest' },
  { id:'hab',     icon:'🎓', title:'Habilitacja',
    desc:'Najsłabszy gracz dostaje wsparcie. Losowy gracz z najniższym stopniem dostaje Studenta.',
    type:'help_weakest' },
  { id:'strajk',  icon:'✊', title:'Strajk studentów',
    desc:'Wszyscy gracze tracą po 1 Studencie (jeśli mają).',
    type:'all_lose_student' },
  { id:'nagroda', icon:'🏅', title:'Nagroda Rektora',
    desc:'Rektor docenił Twoje osiągnięcia! +5 pkt kariery.',
    type:'career_pts', pts:5 },
];

function makePlayer(id, name, isHost) {
  const hand = {};
  RANKS.forEach(r => hand[r] = 0);
  return {
    id, name, isHost,
    hand,       // karty hierarchii
    career: 0,  // punkty kariery (0-100)
    careerTokens: {}  // id -> count
  };
}

function calcScore(p) {
  const base = { student:1, magister:3, doktor:9, profesor:27, dziekan:81, rektor:243 };
  let s = 0;
  RANKS.forEach(r => s += (p.hand[r]||0) * base[r]);
  s += p.career;
  return s;
}

function checkWin(p) {
  // Wygrywa kto zebrał pełną hierarchię (po 1 z każdego) LUB 100 pkt kariery + jakiś stopień
  const hasAll = RANKS.every(r => (p.hand[r]||0) >= 1);
  const careerWin = p.career >= 100;
  return { hierarchy: hasAll, career: careerWin };
}

function broadcast(room, msg) {
  room.order.forEach(pid => {
    const pl = room.players[pid];
    if (pl && pl.ws && pl.ws.readyState === 1) {
      pl.ws.send(JSON.stringify(msg));
    }
  });
}

function stateSnapshot(room) {
  const players = room.order.map(pid => {
    const p = room.players[pid];
    return {
      id: p.id, name: p.name, isHost: p.isHost,
      hand: p.hand, career: p.career,
      careerTokens: p.careerTokens,
      score: calcScore(p)
    };
  });
  const currentId = room.order[room.turn % room.order.length];
  return {
    type: 'state',
    players,
    currentTurn: currentId,
    started: room.started
  };
}

function applyEvent(room, playerId, event) {
  const logs = [];
  const p = room.players[playerId];

  if (event.type === 'steal_hand') {
    // Komisja kradnie losową kartę hierarchii
    const has = RANKS.filter(r => (p.hand[r]||0) > 0);
    if (has.length > 0) {
      const r = has[Math.floor(Math.random()*has.length)];
      p.hand[r]--;
      logs.push(`🔍 Komisja Akredytacyjna: ${p.name} traci ${RANK_LABELS[r]}!`);
    } else {
      logs.push(`🔍 Komisja Akredytacyjna przyszła, ale ${p.name} nie ma nic!`);
    }
  } else if (event.type === 'give') {
    p.hand[event.rank] = (p.hand[event.rank]||0) + 1;
    logs.push(`💰 Grant MEiN: ${p.name} dostaje ${RANK_LABELS[event.rank]}!`);
  } else if (event.type === 'career_pts') {
    p.career = Math.min(100, p.career + event.pts);
    logs.push(`✨ ${p.name} +${event.pts} pkt kariery → ${p.career}/100`);
  } else if (event.type === 'punish_strongest') {
    const strongest = room.order.reduce((best, pid) => {
      return calcScore(room.players[pid]) > calcScore(room.players[best]) ? pid : best;
    }, room.order[0]);
    const sp = room.players[strongest];
    const has = RANKS.filter(r => (sp.hand[r]||0) > 0);
    if (has.length > 0) {
      const best = has[has.length-1];
      sp.hand[best]--;
      logs.push(`⚠️ Plagiat! ${sp.name} traci ${RANK_LABELS[best]}!`);
    } else {
      logs.push(`⚠️ Wykryto plagiat, ale nikt nic nie traci.`);
    }
  } else if (event.type === 'help_weakest') {
    const weakest = room.order.reduce((worst, pid) => {
      return calcScore(room.players[pid]) < calcScore(room.players[worst]) ? pid : worst;
    }, room.order[0]);
    const wp = room.players[weakest];
    wp.hand['student'] = (wp.hand['student']||0) + 1;
    logs.push(`🎓 Habilitacja: ${wp.name} dostaje Studenta!`);
  } else if (event.type === 'all_lose_student') {
    room.order.forEach(pid => {
      const pl = room.players[pid];
      if ((pl.hand['student']||0) > 0) {
        pl.hand['student']--;
        logs.push(`✊ Strajk: ${pl.name} traci Studenta!`);
      }
    });
  }

  return logs;
}

function rollDice(room, playerId) {
  const face = DICE_FACES[Math.floor(Math.random()*DICE_FACES.length)];
  const p = room.players[playerId];
  let logs = [];
  let eventData = null;

  if (face === 'student') {
    p.hand['student'] = (p.hand['student']||0) + 1;
    logs.push(`🎲 ${p.name} wylosował: 🎒 Student`);
  } else if (face === 'magister') {
    p.hand['magister'] = (p.hand['magister']||0) + 1;
    logs.push(`🎲 ${p.name} wylosował: 📜 Magister`);
  } else if (face === 'ministerstwo') {
    // Ministerstwo: cofa o 1 stopień najcenniejszej karty
    const rankOrder = [...RANKS].reverse();
    const bestRank = rankOrder.find(r => (p.hand[r]||0) > 0);
    if (bestRank && bestRank !== 'student') {
      const idx = RANKS.indexOf(bestRank);
      p.hand[bestRank]--;
      const lower = RANKS[idx-1];
      // Zwrot 3 kart niżej
      p.hand[lower] = (p.hand[lower]||0) + 3;
      logs.push(`🏛️ MINISTERSTWO! ${p.name}: ${RANK_LABELS[bestRank]} → 3× ${RANK_LABELS[lower]}`);
    } else if (bestRank === 'student') {
      p.hand['student']--;
      logs.push(`🏛️ MINISTERSTWO! ${p.name} traci ostatniego Studenta!`);
    } else {
      logs.push(`🏛️ Ministerstwo przyszło, ale ${p.name} nie ma nic!`);
    }
    eventData = { face: 'ministerstwo' };
  } else if (face === 'event') {
    const ev = EVENTS[Math.floor(Math.random()*EVENTS.length)];
    const evLogs = applyEvent(room, playerId, ev);
    logs = logs.concat(evLogs);
    eventData = { face: 'event', event: ev };
  }

  // Next turn
  room.turn = (room.turn + 1) % room.order.length;

  // Check win
  const win = checkWin(p);
  let winner = null;
  if (win.hierarchy || win.career) {
    winner = {
      id: p.id, name: p.name,
      reason: win.hierarchy ? 'Pełna hierarchia akademicka!' : '100 punktów kariery!'
    };
  }

  return { face, logs, eventData, winner };
}

function advanceRank(room, playerId, rank) {
  const p = room.players[playerId];
  const idx = RANKS.indexOf(rank);
  if (idx < 0 || idx >= RANKS.length-1) return null;
  if ((p.hand[rank]||0) < 3) return null;
  const next = RANKS[idx+1];
  p.hand[rank] -= 3;
  p.hand[next] = (p.hand[next]||0) + 1;
  return { from: rank, to: next, playerName: p.name };
}

// ── HTTP + WS server ────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  let file = req.url === '/' ? '/index.html' : req.url;
  const fp = path.join(__dirname, file);
  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    const ext = path.extname(fp);
    const ct = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json' }[ext]||'text/plain';
    res.writeHead(200, {'Content-Type': ct});
    fs.createReadStream(fp).pipe(res);
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let myId = null;
  let myRoom = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create') {
      const code = Math.random().toString(36).substr(2,5).toUpperCase();
      const room = makeRoom(code);
      rooms[code] = room;
      myId = msg.playerId || ('p_'+Date.now());
      const pl = makePlayer(myId, msg.name||'Gracz', true);
      pl.ws = ws;
      room.players[myId] = pl;
      room.order.push(myId);
      myRoom = room;
      ws.send(JSON.stringify({ type:'created', code, playerId: myId }));
      broadcast(room, stateSnapshot(room));
    }

    else if (msg.type === 'join') {
      const code = (msg.code||'').toUpperCase();
      const room = rooms[code];
      if (!room) { ws.send(JSON.stringify({type:'error',msg:'Nie znaleziono pokoju'})); return; }
      if (room.started) { ws.send(JSON.stringify({type:'error',msg:'Gra już trwa'})); return; }
      myId = msg.playerId || ('p_'+Date.now());
      const pl = makePlayer(myId, msg.name||'Gracz', false);
      pl.ws = ws;
      room.players[myId] = pl;
      room.order.push(myId);
      myRoom = room;
      ws.send(JSON.stringify({ type:'joined', code, playerId: myId }));
      broadcast(room, stateSnapshot(room));
    }

    else if (msg.type === 'start') {
      if (!myRoom || !myRoom.players[myId]?.isHost) return;
      if (myRoom.order.length < 2) { ws.send(JSON.stringify({type:'error',msg:'Potrzeba min. 2 graczy'})); return; }
      myRoom.started = true;
      myRoom.turn = 0;
      broadcast(myRoom, { type:'game_started' });
      broadcast(myRoom, stateSnapshot(myRoom));
    }

    else if (msg.type === 'roll') {
      if (!myRoom || !myRoom.started) return;
      const currentId = myRoom.order[myRoom.turn % myRoom.order.length];
      if (currentId !== myId) return;
      const result = rollDice(myRoom, myId);
      broadcast(myRoom, {
        type: 'roll_result',
        playerId: myId,
        face: result.face,
        logs: result.logs,
        eventData: result.eventData,
        winner: result.winner
      });
      broadcast(myRoom, stateSnapshot(myRoom));
    }

    else if (msg.type === 'advance') {
      if (!myRoom || !myRoom.started) return;
      const result = advanceRank(myRoom, myId, msg.rank);
      if (!result) return;
      const p = myRoom.players[myId];
      broadcast(myRoom, {
        type: 'advanced',
        playerId: myId,
        from: result.from, to: result.to,
        playerName: result.playerName,
        logs: [`⬆️ ${result.playerName}: 3× ${RANK_LABELS[result.from]} → ${RANK_LABELS[result.to]}`]
      });
      // Check win after advance
      const win = checkWin(p);
      let winner = null;
      if (win.hierarchy || win.career) {
        winner = {
          id: p.id, name: p.name,
          reason: win.hierarchy ? 'Pełna hierarchia akademicka!' : '100 punktów kariery!'
        };
        broadcast(myRoom, { type:'winner', winner });
      }
      broadcast(myRoom, stateSnapshot(myRoom));
    }
  });

  ws.on('close', () => {
    if (!myRoom || !myId) return;
    if (myRoom.players[myId]) {
      myRoom.players[myId].ws = null;
    }
    broadcast(myRoom, { type:'player_disconnected', playerId: myId,
      name: myRoom.players[myId]?.name });
  });
});

server.listen(PORT, () => console.log(`Uniwersytet v4 on :${PORT}`));
