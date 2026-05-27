const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

// Game state
const rooms = {};

function generateCode() {
  return Math.random().toString(36).substr(2, 5).toUpperCase();
}

function createRoom(hostWs, hostName) {
  const code = generateCode();
  rooms[code] = {
    code,
    host: hostWs,
    players: [{ ws: hostWs, name: hostName, id: 0 }],
    gameState: null,
    started: false
  };
  return code;
}

function broadcast(room, msg, exceptWs = null) {
  room.players.forEach(p => {
    if (p.ws !== exceptWs && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify(msg));
    }
  });
}

function broadcastAll(room, msg) {
  room.players.forEach(p => {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(msg));
  });
}

function getPublicPlayers(room) {
  return room.players.map((p, i) => ({ id: i, name: p.name }));
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create') {
      const code = createRoom(ws, msg.name);
      ws.roomCode = code;
      ws.playerId = 0;
      ws.send(JSON.stringify({ type: 'created', code, playerId: 0 }));
    }

    else if (msg.type === 'join') {
      const room = rooms[msg.code];
      if (!room) { ws.send(JSON.stringify({ type: 'error', msg: 'Nie znaleziono pokoju' })); return; }
      if (room.started) { ws.send(JSON.stringify({ type: 'error', msg: 'Gra już trwa' })); return; }
      if (room.players.length >= 6) { ws.send(JSON.stringify({ type: 'error', msg: 'Pokój pełny' })); return; }
      const id = room.players.length;
      room.players.push({ ws, name: msg.name, id });
      ws.roomCode = msg.code;
      ws.playerId = id;
      ws.send(JSON.stringify({ type: 'joined', code: msg.code, playerId: id, players: getPublicPlayers(room) }));
      broadcastAll(room, { type: 'players_update', players: getPublicPlayers(room) });
    }

    else if (msg.type === 'start') {
      const room = rooms[ws.roomCode];
      if (!room || ws !== room.host) return;
      if (room.players.length < 1) return;
      room.started = true;
      // Initialize game state
      const RANKS = ['student','magister','doktor','profesor','dziekan','rektor'];
      room.gameState = {
        turn: 0,
        round: 1,
        players: room.players.map((p, i) => ({
          id: i,
          name: p.name,
          cards: { student:0, magister:0, doktor:0, profesor:0, dziekan:0, rektor:0 },
          career: 0,
          promotors: 0,
          hierarchy: []
        })),
        log: [],
        phase: 'roll'
      };
      broadcastAll(room, { type: 'game_start', gameState: room.gameState });
    }

    else if (msg.type === 'roll') {
      const room = rooms[ws.roomCode];
      if (!room || !room.gameState) return;
      const gs = room.gameState;
      if (gs.players[gs.turn].id !== ws.playerId) return;
      if (gs.phase !== 'roll') return;

      // Dice faces: 3x student, 1x magister, 1x event, 1x villain
      const faces = ['student','student','student','magister','event','villain'];
      const roll = faces[Math.floor(Math.random() * 6)];
      const rollingPlayer = gs.players[gs.turn];
      let result = { roll, effects: [], eventData: null };

      if (roll === 'student' || roll === 'magister') {
        rollingPlayer.cards[roll]++;
        result.effects.push({ type: 'gain', player: rollingPlayer.id, card: roll, amount: 1 });
        gs.log.unshift({ text: `🎒 ${rollingPlayer.name} zdobywa: ${roll}!`, type: 'gain' });
      }

      else if (roll === 'villain') {
        const villains = ['ministerstwo', 'komisja', 'komisja'];
        const villain = villains[Math.floor(Math.random() * villains.length)];
        result.eventData = { villain };

        if (villain === 'ministerstwo') {
          // Steal best card from random other player — unless they have a promotor
          const others = gs.players.filter(p => p.id !== rollingPlayer.id);
          if (others.length > 0) {
            const target = others[Math.floor(Math.random() * others.length)];
            const RANKS = ['rektor','dziekan','profesor','doktor','magister','student'];
            let stolen = null;
            for (const r of RANKS) {
              if (target.cards[r] > 0) { stolen = r; break; }
            }
            if (stolen) {
              if (target.promotors > 0) {
                target.promotors--;
                result.effects.push({ type: 'promotor_saved', player: target.id });
                gs.log.unshift({ text: `🛡️ Promotor ${target.name} uratował ${target.name} przed Ministerstwem!`, type: 'shield' });
                result.eventData.saved = true;
                result.eventData.savedPlayer = target.id;
              } else {
                target.cards[stolen]--;
                rollingPlayer.cards[stolen]++;
                result.effects.push({ type: 'stolen', from: target.id, to: rollingPlayer.id, card: stolen });
                gs.log.unshift({ text: `🏛️ MINISTERSTWO: ${target.name} traci ${stolen}! Przejmuje ${rollingPlayer.name}`, type: 'villain' });
              }
            } else {
              gs.log.unshift({ text: `🏛️ Ministerstwo przyszło, ale ${target.name} nie ma nic do zabrania!`, type: 'villain' });
            }
          }
        } else {
          // komisja — steal random card from rolling player
          const RANKS = ['student','magister','doktor','profesor','dziekan','rektor'];
          const playerCards = RANKS.filter(r => rollingPlayer.cards[r] > 0);
          if (playerCards.length > 0) {
            if (rollingPlayer.promotors > 0) {
              rollingPlayer.promotors--;
              result.effects.push({ type: 'promotor_saved', player: rollingPlayer.id });
              gs.log.unshift({ text: `🛡️ Promotor ${rollingPlayer.name} uratował go przed Komisją!`, type: 'shield' });
              result.eventData.saved = true;
              result.eventData.savedPlayer = rollingPlayer.id;
            } else {
              const stolen = playerCards[Math.floor(Math.random() * playerCards.length)];
              rollingPlayer.cards[stolen]--;
              result.effects.push({ type: 'komisja', player: rollingPlayer.id, card: stolen });
              gs.log.unshift({ text: `📋 KOMISJA: ${rollingPlayer.name} traci ${stolen}!`, type: 'villain' });
            }
          } else {
            gs.log.unshift({ text: `📋 Komisja przyszła, ale ${rollingPlayer.name} nie ma nic!`, type: 'villain' });
          }
        }
      }

      else if (roll === 'event') {
        const events = [
          { id:'grant', label:'Grant NCN', desc:'Dostajesz doktorat z grantu!', effect: p => { p.cards.doktor++; } , career:0, icon:'💰'},
          { id:'artykul_q1', label:'Artykuł Q1', desc:'Publikacja w prestiżowym czasopiśmie!', effect: p => { p.career += 15; p.cards.magister++; }, career:15, icon:'📄'},
          { id:'artykul_q2', label:'Artykuł Q2', desc:'Dobry artykuł w sprawdzonym piśmie.', effect: p => { p.career += 8; p.cards.student++; }, career:8, icon:'📰'},
          { id:'konferencja', label:'Konferencja Międzynarodowa', desc:'Wystąpienie na konferencji. +12 pkt kariery!', effect: p => { p.career += 12; }, career:12, icon:'🎤'},
          { id:'recenzja', label:'Recenzja w czasopiśmie', desc:'Byłeś recenzentem. +5 pkt kariery.', effect: p => { p.career += 5; }, career:5, icon:'✍️'},
          { id:'habilitacja', label:'Habilitacja otwarta', desc:'Najsłabszy gracz dostaje magistra!', effect: null, special:'weakest_gets_magister', icon:'🎓'},
          { id:'plagiat', label:'Zarzut plagiatu!', desc:'Najsilniejszy gracz traci kartę!', effect: null, special:'strongest_loses', icon:'⚠️'},
          { id:'promotor', label:'Nowy Promotor!', desc:'Zdobywasz Promotora — ochronę przed złoczyńcami!', effect: p => { if(p.promotors < 2) p.promotors++; }, career:0, icon:'🤝'},
          { id:'urlop', label:'Urlop dziekański', desc:'Nic się nie dzieje. Ale przynajmniej odpoczywasz...', effect: p => {}, career:0, icon:'🏖️'},
          { id:'stypendium', label:'Stypendium rektora', desc:'+20 pkt kariery i student!', effect: p => { p.career += 20; p.cards.student++; }, career:20, icon:'🏆'},
        ];
        const ev = events[Math.floor(Math.random() * events.length)];
        result.eventData = { event: ev };

        if (ev.special === 'weakest_gets_magister') {
          const weakest = gs.players.reduce((a,b) => (b.career + Object.values(b.cards).reduce((s,v)=>s+v,0)) < (a.career + Object.values(a.cards).reduce((s,v)=>s+v,0)) ? b : a);
          weakest.cards.magister++;
          result.effects.push({ type: 'event_card', player: weakest.id, card: 'magister' });
          gs.log.unshift({ text: `🎓 Habilitacja: ${weakest.name} dostaje magistra!`, type: 'event' });
        } else if (ev.special === 'strongest_loses') {
          const strongest = gs.players.reduce((a,b) => (b.career + Object.values(b.cards).reduce((s,v)=>s+v,0)) > (a.career + Object.values(a.cards).reduce((s,v)=>s+v,0)) ? b : a);
          const RANKS = ['rektor','dziekan','profesor','doktor','magister','student'];
          for (const r of RANKS) {
            if (strongest.cards[r] > 0) { strongest.cards[r]--; break; }
          }
          result.effects.push({ type: 'event_lose', player: strongest.id });
          gs.log.unshift({ text: `⚠️ Plagiat! ${strongest.name} traci kartę!`, type: 'villain' });
        } else if (ev.effect) {
          ev.effect(rollingPlayer);
          if (ev.career > 0) result.effects.push({ type: 'career', player: rollingPlayer.id, amount: ev.career });
          gs.log.unshift({ text: `${ev.icon} ${ev.label}: ${rollingPlayer.name}! ${ev.desc}`, type: 'event' });
        }
      }

      // Check win condition
      let winner = null;
      for (const p of gs.players) {
        const RANKS = ['student','magister','doktor','profesor','dziekan','rektor'];
        const hasAll = RANKS.every(r => p.cards[r] > 0 || p.hierarchy.includes(r));
        if (hasAll || p.career >= 100) {
          winner = p;
          break;
        }
      }

      gs.phase = 'promote';
      result.gameState = gs;
      if (winner) result.winner = winner;

      broadcastAll(room, { type: 'roll_result', ...result });
    }

    else if (msg.type === 'promote') {
      const room = rooms[ws.roomCode];
      if (!room || !room.gameState) return;
      const gs = room.gameState;
      const p = gs.players.find(pl => pl.id === ws.playerId);
      if (!p) return;
      const { from, to } = msg;
      const PROMOTE = { student:'magister', magister:'doktor', doktor:'profesor', profesor:'dziekan', dziekan:'rektor' };
      const needed = { student:3, magister:3, doktor:3, profesor:3, dziekan:3 };
      if (PROMOTE[from] !== to) return;
      if (p.cards[from] < needed[from]) return;
      p.cards[from] -= needed[from];
      p.cards[to] = (p.cards[to] || 0) + 1;
      gs.log.unshift({ text: `⬆️ ${p.name} awansował: ${from} → ${to}!`, type: 'promote' });

      // Check win
      let winner = null;
      const RANKS = ['student','magister','doktor','profesor','dziekan','rektor'];
      for (const pl of gs.players) {
        const hasAll = RANKS.every(r => pl.cards[r] > 0);
        if (hasAll || pl.career >= 100) { winner = pl; break; }
      }

      broadcastAll(room, { type: 'promote_result', playerId: ws.playerId, from, to, gameState: gs, winner: winner || null });
    }

    else if (msg.type === 'end_turn') {
      const room = rooms[ws.roomCode];
      if (!room || !room.gameState) return;
      const gs = room.gameState;
      if (gs.players[gs.turn].id !== ws.playerId) return;
      gs.turn = (gs.turn + 1) % gs.players.length;
      gs.round++;
      gs.phase = 'roll';
      broadcastAll(room, { type: 'turn_change', turn: gs.turn, round: gs.round, gameState: gs });
    }

    else if (msg.type === 'buy_promotor') {
      const room = rooms[ws.roomCode];
      if (!room || !room.gameState) return;
      const gs = room.gameState;
      const p = gs.players.find(pl => pl.id === ws.playerId);
      if (!p || p.career < 3 || p.promotors >= 2) return;
      p.career -= 3;
      p.promotors++;
      gs.log.unshift({ text: `🤝 ${p.name} zatrudnił Promotora za 3 pkt kariery!`, type: 'shield' });
      broadcastAll(room, { type: 'promotor_update', gameState: gs });
    }
  });

  ws.on('close', () => {
    if (ws.roomCode && rooms[ws.roomCode]) {
      const room = rooms[ws.roomCode];
      room.players = room.players.filter(p => p.ws !== ws);
      if (room.players.length === 0) {
        delete rooms[ws.roomCode];
      } else {
        broadcastAll(room, { type: 'players_update', players: getPublicPlayers(room) });
        if (ws === room.host && room.players.length > 0) room.host = room.players[0].ws;
      }
    }
  });
});

server.listen(PORT, () => console.log(`Uniwersytet v5 running on port ${PORT}`));
