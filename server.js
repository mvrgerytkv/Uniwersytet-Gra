const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = {};

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length: 5}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
}

// Kostka: 3×Student, 1×Magister, 1×Ministerstwo, 1×Zdarzenie
// Możliwe wyniki: student(3 razy), magister, ministerstwo, zdarzenie
const DICE_FACES = ['student','student','student','magister','ministerstwo','zdarzenie'];

const HIERARCHY = ['student','magister','doktor','profesor','dziekan','rektor'];
const PROMOTE_COST = { magister:3, doktor:3, profesor:3, dziekan:3, rektor:3 };

const EVENTS = [
  { id:'grant', icon:'💰', title:'Grant NCN', desc:'Gratulacje! Otrzymujesz dofinansowanie.', effect:'career', value:12 },
  { id:'article_q1', icon:'📄', title:'Artykuł w Q1', desc:'Twój artykuł ukazał się w prestiżowym czasopiśmie!', effect:'career', value:10 },
  { id:'conference', icon:'🎤', title:'Konferencja Międzynarodowa', desc:'Wygłaszasz referat — świetna prezentacja!', effect:'career', value:8 },
  { id:'article_q2', icon:'📰', title:'Artykuł w Q2', desc:'Solidna publikacja na dobrym poziomie.', effect:'career', value:6 },
  { id:'review', icon:'📋', title:'Recenzja naukowa', desc:'Piszesz recenzję dla renomowanego czasopisma.', effect:'career', value:4 },
  { id:'plagiat', icon:'⚠️', title:'Podejrzenie plagiatu', desc:'Ktoś oskarżył Cię o plagiat! Tracisz punkty kariery.', effect:'career', value:-8 },
  { id:'urlop', icon:'🌴', title:'Urlop dziekański', desc:'Masz chwilę oddechu, ale tracisz kontakt z nauką.', effect:'career', value:-4 },
  { id:'komisja', icon:'🔍', title:'Komisja Akredytacyjna!', desc:'Komisja pojawia się niespodziewanie i przeprowadza kontrolę.', effect:'komisja', value:0 },
  { id:'strajk', icon:'✊', title:'Strajk Pracowniczy', desc:'Wszyscy wychodzą na ulicę! Nikt nie dobiera kart w tej rundzie.', effect:'skip', value:0 },
  { id:'headhunt', icon:'🎯', title:'Headhunting', desc:'Inna uczelnia podkupuje Twojego kolegę. Gracz z lewej traci kartę.', effect:'steal_left', value:0 },
  { id:'doktorant', icon:'🎓', title:'Doktorant roku', desc:'Twój doktorant zdobył nagrodę! Dostajesz Doktora.', effect:'card', cardType:'doktor' },
  { id:'awans_extra', icon:'⭐', title:'Nagroda Rektora', desc:'Rektor docenia Twoje zasługi. Dostajesz Magistra!', effect:'card', cardType:'magister' },
];

// Ochrona: 3 poziomy
// promotor: broni 1 atak, potem znika
// prawnik: broni 2 ataki
// zwiazek: broni 3 ataki + może odwrócić atak na atakującego

const SHIELD_TYPES = {
  promotor:  { name:'Promotor',         icon:'👨‍🏫', maxHp:1, cost:3,  desc:'Chroni przed jednym atakiem, potem odchodzi na emeryturę.' },
  prawnik:   { name:'Prawnik',          icon:'⚖️',  maxHp:2, cost:6,  desc:'Wytrzymuje dwa ataki. Kosztuje więcej, ale wart każdej złotówki.' },
  zwiazek:   { name:'Związek Zawodowy', icon:'✊',  maxHp:3, cost:10, desc:'Trzy życia i może odwrócić jeden atak na atakującego!' },
};

function broadcast(room, msg) {
  const roomObj = rooms[room];
  if (!roomObj) return;
  const data = JSON.stringify(msg);
  roomObj.players.forEach(p => { if (p.ws && p.ws.readyState === 1) p.ws.send(data); });
}

function sendToPlayer(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function getPublicState(roomObj) {
  return {
    type: 'state',
    roomCode: roomObj.code,
    phase: roomObj.phase,
    currentTurn: roomObj.currentTurn,
    players: roomObj.players.map(p => ({
      id: p.id, name: p.name, isHost: p.isHost,
      hierarchy: p.hierarchy,
      careerPts: p.careerPts,
      shields: p.shields.map(s => ({ type:s.type, hp:s.hp, maxHp:SHIELD_TYPES[s.type].maxHp, icon:SHIELD_TYPES[s.type].icon, name:SHIELD_TYPES[s.type].name })),
      totalHierarchy: HIERARCHY.filter(r => p.hierarchy[r] > 0).length,
    }))
  };
}

function nextTurn(roomObj) {
  const alive = roomObj.players.filter(p => p.connected);
  if (alive.length === 0) return;
  const cur = roomObj.currentTurn;
  const idx = alive.findIndex(p => p.id === cur);
  const nextIdx = (idx + 1) % alive.length;
  roomObj.currentTurn = alive[nextIdx].id;
  broadcast(roomObj.code, { type:'turn_change', currentTurn: roomObj.currentTurn });
  broadcast(roomObj.code, getPublicState(roomObj));
}

function checkWin(roomObj) {
  for (const p of roomObj.players) {
    const fullHierarchy = HIERARCHY.every(r => p.hierarchy[r] > 0);
    const fullCareer = p.careerPts >= 100;
    if (fullHierarchy || fullCareer) {
      const reason = fullHierarchy ? 'hierarchia' : 'kariera';
      broadcast(roomObj.code, { type:'game_over', winner: p.name, winnerId: p.id, reason });
      roomObj.phase = 'ended';
      return true;
    }
  }
  return false;
}

function applyShield(attacker, victim, roomObj, attackType) {
  // Returns true if attack was blocked
  if (victim.shields.length === 0) return false;
  const shield = victim.shields[0];
  shield.hp -= 1;
  let shieldMsg = `🛡️ ${SHIELD_TYPES[shield.type].icon} ${SHIELD_TYPES[shield.type].name} gracza ${victim.name} blokuje atak!`;
  // Związek może odwrócić
  let reversed = false;
  if (shield.type === 'zwiazek' && Math.random() < 0.4) {
    // Odwróć atak
    if (attackType === 'steal' && attacker) {
      const topCard = getTopCard(attacker);
      if (topCard) {
        attacker.hierarchy[topCard] = Math.max(0, attacker.hierarchy[topCard] - 1);
        shieldMsg += ` KONTRATAK! Związek odwraca atak — ${attacker.name} traci kartę ${topCard}!`;
        reversed = true;
      }
    }
  }
  if (shield.hp <= 0) {
    victim.shields.shift();
    shieldMsg += ` ${SHIELD_TYPES[shield.type].name} wyczerpał się i odszedł.`;
  }
  broadcast(roomObj.code, { type:'shield_block', message: shieldMsg, victimId: victim.id, reversed });
  return true;
}

function getTopCard(player) {
  for (let i = HIERARCHY.length - 1; i >= 0; i--) {
    if (player.hierarchy[HIERARCHY[i]] > 0) return HIERARCHY[i];
  }
  return null;
}

function applyMinisterstwo(victim, attacker, roomObj) {
  if (applyShield(attacker, victim, roomObj, 'steal')) return null;
  // Cofnij najcenniejszą kartę hierarchii: X -> traci 1, dostaje 3 niżej
  const topCard = getTopCard(victim);
  if (!topCard) {
    broadcast(roomObj.code, { type:'event_overlay', icon:'🏛️', title:'Ministerstwo', desc:`${victim.name} nie ma nic do zabrania!`, color:'red' });
    return null;
  }
  victim.hierarchy[topCard] = Math.max(0, victim.hierarchy[topCard] - 1);
  const idx = HIERARCHY.indexOf(topCard);
  if (idx > 0) {
    victim.hierarchy[HIERARCHY[idx-1]] = (victim.hierarchy[HIERARCHY[idx-1]] || 0) + 3;
  }
  return { lost: topCard, gainedThree: idx > 0 ? HIERARCHY[idx-1] : null };
}

function applyKomisja(victim, attacker, roomObj) {
  if (applyShield(attacker, victim, roomObj, 'steal')) return null;
  const topCard = getTopCard(victim);
  if (!topCard) return null;
  victim.hierarchy[topCard] = Math.max(0, victim.hierarchy[topCard] - 1);
  return topCard;
}

wss.on('connection', (ws) => {
  let myRoomCode = null;
  let myPlayerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create_room') {
      const code = genCode();
      const playerId = 'p_' + Date.now();
      myRoomCode = code;
      myPlayerId = playerId;
      rooms[code] = {
        code, phase: 'lobby',
        currentTurn: playerId,
        players: [{
          id: playerId, name: msg.name || 'Gospodarz', isHost: true,
          ws, connected: true,
          hierarchy: { student:0, magister:0, doktor:0, profesor:0, dziekan:0, rektor:0 },
          careerPts: 0,
          shields: [],
        }]
      };
      sendToPlayer(ws, { type:'joined', roomCode: code, playerId, isHost: true });
      broadcast(code, getPublicState(rooms[code]));
    }

    else if (msg.type === 'join_room') {
      const code = msg.code?.toUpperCase();
      if (!rooms[code] || rooms[code].phase === 'ended') {
        sendToPlayer(ws, { type:'error', message: 'Pokój nie istnieje lub gra zakończona.' }); return;
      }
      if (rooms[code].players.length >= 6) {
        sendToPlayer(ws, { type:'error', message: 'Pokój pełny (max 6 graczy).' }); return;
      }
      const playerId = 'p_' + Date.now();
      myRoomCode = code;
      myPlayerId = playerId;
      rooms[code].players.push({
        id: playerId, name: msg.name || 'Gracz', isHost: false,
        ws, connected: true,
        hierarchy: { student:0, magister:0, doktor:0, profesor:0, dziekan:0, rektor:0 },
        careerPts: 0,
        shields: [],
      });
      sendToPlayer(ws, { type:'joined', roomCode: code, playerId, isHost: false });
      broadcast(code, getPublicState(rooms[code]));
    }

    else if (msg.type === 'start_game') {
      const room = rooms[myRoomCode];
      if (!room || room.players.find(p=>p.id===myPlayerId)?.isHost === false) return;
      if (room.players.length < 2) { sendToPlayer(ws, { type:'error', message:'Potrzeba minimum 2 graczy.' }); return; }
      room.phase = 'playing';
      room.currentTurn = room.players[0].id;
      broadcast(myRoomCode, { type:'game_started' });
      broadcast(myRoomCode, getPublicState(room));
    }

    else if (msg.type === 'roll_dice') {
      const room = rooms[myRoomCode];
      if (!room || room.phase !== 'playing') return;
      if (room.currentTurn !== myPlayerId) { sendToPlayer(ws, { type:'error', message:'Nie Twoja tura!' }); return; }
      const player = room.players.find(p => p.id === myPlayerId);
      if (!player) return;

      const face = DICE_FACES[Math.floor(Math.random() * DICE_FACES.length)];
      broadcast(myRoomCode, { type:'dice_rolled', playerId: myPlayerId, playerName: player.name, face });

      if (face === 'student' || face === 'magister') {
        player.hierarchy[face] = (player.hierarchy[face] || 0) + 1;
        broadcast(myRoomCode, {
          type:'card_gained', playerId: myPlayerId, playerName: player.name, card: face,
          icon: face === 'student' ? '🎒' : '📜',
          message: `${player.name} dobiera: ${face}!`
        });
        if (!checkWin(room)) { nextTurn(room); }
      }

      else if (face === 'ministerstwo') {
        // Atakuje losowego innego gracza
        const others = room.players.filter(p => p.id !== myPlayerId && p.connected);
        if (others.length === 0) {
          broadcast(myRoomCode, { type:'event_overlay', icon:'🏛️', title:'Ministerstwo', desc:'Ministerstwo przybyło, ale jesteś sam — nic się nie dzieje.', color:'red' });
          nextTurn(room);
          return;
        }
        const victim = others[Math.floor(Math.random() * others.length)];
        const result = applyMinisterstwo(victim, player, room);
        let desc = '';
        if (!result) { desc = `${victim.name} nie ma nic do stracenia. Ministerstwo odchodzi z kwitkiem.`; }
        else if (result.gainedThree) {
          desc = `Ministerstwo konfiskuje ${result.lost} od ${victim.name}! W zamian dostaje 3× ${result.gainedThree}.`;
        } else {
          desc = `Ministerstwo konfiskuje ${result.lost} od ${victim.name}!`;
        }
        broadcast(myRoomCode, { type:'event_overlay', icon:'🏛️', title:'Ministerstwo', desc, color:'red', victimId: victim.id });
        broadcast(myRoomCode, getPublicState(room));
        if (!checkWin(room)) { nextTurn(room); }
      }

      else if (face === 'zdarzenie') {
        const event = EVENTS[Math.floor(Math.random() * EVENTS.length)];
        let desc = event.desc;

        if (event.effect === 'career') {
          player.careerPts = Math.max(0, player.careerPts + event.value);
          desc += event.value > 0 ? ` (+${event.value} pkt kariery)` : ` (${event.value} pkt kariery)`;
        } else if (event.effect === 'card') {
          player.hierarchy[event.cardType] = (player.hierarchy[event.cardType] || 0) + 1;
          desc += ` Dostajesz: ${event.cardType}!`;
        } else if (event.effect === 'komisja') {
          const others = room.players.filter(p => p.id !== myPlayerId && p.connected);
          if (others.length > 0) {
            const victim = others[Math.floor(Math.random() * others.length)];
            const stolen = applyKomisja(victim, player, room);
            desc = stolen ? `Komisja Akredytacyjna zjawia się u ${victim.name} i zabiera ${stolen}!` : `Komisja przyszła do ${victim.name}, ale nie miał nic wartościowego.`;
            broadcast(myRoomCode, { type:'event_overlay', icon:'🔍', title:'Komisja Akredytacyjna', desc, color:'orange', victimId: victim.id });
            broadcast(myRoomCode, getPublicState(room));
            if (!checkWin(room)) { nextTurn(room); }
            return;
          }
        } else if (event.effect === 'skip') {
          broadcast(myRoomCode, { type:'event_overlay', icon:event.icon, title:event.title, desc, color:'purple' });
          nextTurn(room);
          return;
        } else if (event.effect === 'steal_left') {
          const idx = room.players.findIndex(p => p.id === myPlayerId);
          const leftIdx = (idx - 1 + room.players.length) % room.players.length;
          const leftPlayer = room.players[leftIdx];
          const stolen = applyKomisja(leftPlayer, player, room);
          desc = stolen ? `Headhunterzy kuszą ${leftPlayer.name} i zabierają mu ${stolen}!` : `Headhunterzy celują w ${leftPlayer.name}, ale ten nie ma nic wartościowego.`;
        }

        broadcast(myRoomCode, { type:'event_overlay', icon:event.icon, title:event.title, desc, color:'purple', playerId: myPlayerId });
        broadcast(myRoomCode, getPublicState(room));
        if (!checkWin(room)) { nextTurn(room); }
      }
    }

    else if (msg.type === 'promote') {
      const room = rooms[myRoomCode];
      if (!room || room.phase !== 'playing') return;
      const player = room.players.find(p => p.id === myPlayerId);
      if (!player) return;
      const { from, to } = msg;
      if (!HIERARCHY.includes(from) || !HIERARCHY.includes(to)) return;
      const fromIdx = HIERARCHY.indexOf(from);
      const toIdx = HIERARCHY.indexOf(to);
      if (toIdx !== fromIdx + 1) return;
      const cost = PROMOTE_COST[to];
      if (player.hierarchy[from] < cost) {
        sendToPlayer(ws, { type:'error', message:`Potrzebujesz ${cost}× ${from} do awansu na ${to}.` }); return;
      }
      player.hierarchy[from] -= cost;
      player.hierarchy[to] = (player.hierarchy[to] || 0) + 1;
      broadcast(myRoomCode, {
        type:'promoted', playerId: myPlayerId, playerName: player.name, from, to,
        message: `🎓 ${player.name} awansuje z ${from} na ${to}!`
      });
      broadcast(myRoomCode, getPublicState(room));
      checkWin(room);
    }

    else if (msg.type === 'buy_shield') {
      const room = rooms[myRoomCode];
      if (!room || room.phase !== 'playing') return;
      const player = room.players.find(p => p.id === myPlayerId);
      if (!player) return;
      const shieldType = msg.shieldType;
      if (!SHIELD_TYPES[shieldType]) return;
      const cost = SHIELD_TYPES[shieldType].cost;
      if (player.careerPts < cost) {
        sendToPlayer(ws, { type:'error', message:`Potrzebujesz ${cost} pkt kariery na ${SHIELD_TYPES[shieldType].name}.` }); return;
      }
      if (player.shields.length >= 2) {
        sendToPlayer(ws, { type:'error', message:'Masz już maksymalną ochronę (2 tarcze).' }); return;
      }
      player.careerPts -= cost;
      player.shields.push({ type: shieldType, hp: SHIELD_TYPES[shieldType].maxHp });
      broadcast(myRoomCode, {
        type:'shield_bought', playerId: myPlayerId, playerName: player.name, shieldType,
        icon: SHIELD_TYPES[shieldType].icon, name: SHIELD_TYPES[shieldType].name,
        message: `${SHIELD_TYPES[shieldType].icon} ${player.name} zatrudnia ${SHIELD_TYPES[shieldType].name}!`
      });
      broadcast(myRoomCode, getPublicState(room));
    }
  });

  ws.on('close', () => {
    if (myRoomCode && myPlayerId && rooms[myRoomCode]) {
      const player = rooms[myRoomCode].players.find(p => p.id === myPlayerId);
      if (player) { player.connected = false; player.ws = null; }
    }
  });
});

server.listen(PORT, () => console.log(`Serwer działa na porcie ${PORT}`));
