const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const RANKS = ['student','magister','doktor','profesor','dziekan','rektor'];
const RANK_EMOJI = { student:'🎒', magister:'📜', doktor:'🔬', profesor:'📚', dziekan:'🏛️', rektor:'👑' };
const RANK_LABEL = { student:'Student', magister:'Magister', doktor:'Doktor', profesor:'Profesor', dziekan:'Dziekan', rektor:'Rektor' };
const RANK_IDX = Object.fromEntries(RANKS.map((r,i)=>[r,i]));
const DICE_FACES = ['student','student','student','magister','doktor','event'];

const EVENTS = [
  { id:'artykul', emoji:'📄', name:'Artykuł naukowy', desc:'Twoja praca trafia do bazy Scopus! Dostajesz 1 losową kartę.', type:'gain_random' },
  { id:'konf', emoji:'🎤', name:'Konferencja międzynarodowa', desc:'Wygłosiłeś referat! +2 pkt bonusowe i możesz przekazać 1 kartę innemu graczowi.', type:'conference' },
  { id:'grant', emoji:'💰', name:'Grant MEiN', desc:'Ministerstwo… tym razem daje kasę. Dostajesz 1 Doktora!', type:'gain_rank', rank:'doktor' },
  { id:'publikacja', emoji:'📰', name:'Publikacja w Q1', desc:'Twój artykuł w prestiżowym piśmie! Dostajesz 1 Magistra.', type:'gain_rank', rank:'magister' },
  { id:'komisja', emoji:'📋', name:'Komisja Akredytacyjna', desc:'Komisja wchodzi bez uprzedzenia i kradnie losową kartę z Twojej ręki!', type:'steal_random_self' },
  { id:'ministerstwo', emoji:'🏛️', name:'Ministerstwo', desc:'Ministerstwo cofa Cię o jeden szczebel — tracisz awans i odzyskujesz 3 karty niżej!', type:'downgrade' },
  { id:'habilitacja', emoji:'🎓', name:'Kolokwium habilitacyjne', desc:'Twój kolega się habilituje! Gracz z najmniejszą liczbą kart dostaje 1 Studenta.', type:'gain_weakest', rank:'student' },
  { id:'plagiat', emoji:'⚠️', name:'Wykryto plagiat!', desc:'Komisja etyki wszczyna postępowanie. Gracz z największą liczbą kart traci losową kartę.', type:'steal_strongest' },
];

const rooms = {};

function makeRoom(code) {
  return { code, players: {}, order: [], turn: 0, phase: 'lobby', log: [], pendingEvent: null };
}

function newPlayerCards() { return Object.fromEntries(RANKS.map(r=>[r,0])); }
function totalCards(cards) { return RANKS.reduce((s,r)=>s+cards[r],0); }
function scoreOf(p) { let s=p.bonusPts||0; RANKS.forEach((r,i)=>{s+=p.cards[r]*Math.pow(3,i);}); return s; }
function hasFullSet(cards) { return RANKS.every(r=>cards[r]>=1); }
function randomRank(cards) { const a=RANKS.filter(r=>cards[r]>0); return a.length?a[Math.floor(Math.random()*a.length)]:null; }
function rollDice() { return DICE_FACES[Math.floor(Math.random()*DICE_FACES.length)]; }

function broadcast(room, msg) {
  room.order.forEach(id=>{
    const p=room.players[id];
    if(p&&p.ws&&p.ws.readyState===WebSocket.OPEN) p.ws.send(JSON.stringify(msg));
  });
}

function sendState(room) {
  const players=room.order.map(id=>{
    const p=room.players[id];
    return {id,name:p.name,cards:p.cards,bonusPts:p.bonusPts,connected:p.connected,score:scoreOf(p),hasWon:hasFullSet(p.cards)};
  });
  const currentId=room.order[room.turn%room.order.length];
  broadcast(room,{type:'state',room:room.code,players,currentTurn:currentId,phase:room.phase,log:room.log.slice(-40),pendingEvent:room.pendingEvent?{event:room.pendingEvent.event,actorId:room.pendingEvent.actorId,step:room.pendingEvent.step}:null});
}

function addLog(room,text,style){ room.log.push({text,style:style||'default',ts:Date.now()}); }

function checkWin(room){
  const winner=room.order.find(id=>hasFullSet(room.players[id].cards));
  if(winner){ room.phase='end'; addLog(room,`🏆 ${room.players[winner].name} zebrał/a pełną hierarchię i wygrywa!`,'win'); sendState(room); return true; }
  return false;
}

function resolveEvent(room,event,actorId,extraData){
  const actor=room.players[actorId];
  switch(event.type){
    case 'gain_random':{const r=RANKS[Math.floor(Math.random()*RANKS.length)];actor.cards[r]++;addLog(room,`📄 ${actor.name} dostaje: ${RANK_EMOJI[r]} ${RANK_LABEL[r]}`,'bonus');break;}
    case 'gain_rank':{actor.cards[event.rank]++;addLog(room,`${event.emoji} ${actor.name} dostaje ${RANK_EMOJI[event.rank]} ${RANK_LABEL[event.rank]}!`,'bonus');break;}
    case 'conference':{
      actor.bonusPts=(actor.bonusPts||0)+2;
      if(extraData&&extraData.targetId&&extraData.giftRank&&room.players[extraData.targetId]&&actor.cards[extraData.giftRank]>0){
        actor.cards[extraData.giftRank]--;room.players[extraData.targetId].cards[extraData.giftRank]++;
        addLog(room,`🎤 ${actor.name} +2 pkt i przekazuje ${RANK_EMOJI[extraData.giftRank]} do ${room.players[extraData.targetId].name}`,'bonus');
      } else {addLog(room,`🎤 ${actor.name} zdobywa +2 pkt za konferencję!`,'bonus');}
      break;
    }
    case 'steal_random_self':{const r=randomRank(actor.cards);if(r){actor.cards[r]--;addLog(room,`📋 Komisja Akredytacyjna zabrała ${actor.name}: ${RANK_EMOJI[r]} ${RANK_LABEL[r]}!`,'danger');}else{addLog(room,`📋 Komisja przyszła, ale ${actor.name} nic nie miał/a.`,'info');}break;}
    case 'downgrade':{
      let highest=null;for(let i=RANKS.length-1;i>=0;i--){if(actor.cards[RANKS[i]]>0){highest=RANKS[i];break;}}
      if(highest&&RANK_IDX[highest]>0){actor.cards[highest]--;const lower=RANKS[RANK_IDX[highest]-1];actor.cards[lower]+=3;addLog(room,`🏛️ Ministerstwo cofa ${actor.name}: traci ${RANK_EMOJI[highest]}, odzyskuje 3× ${RANK_EMOJI[lower]}!`,'danger');}
      else if(highest){actor.cards[highest]--;addLog(room,`🏛️ Ministerstwo konfiskuje ${RANK_EMOJI[highest]} ${actor.name}!`,'danger');}
      else{addLog(room,`🏛️ Ministerstwo przyszło, ale ${actor.name} nic nie miał/a.`,'info');}
      break;
    }
    case 'gain_weakest':{let weakId=room.order.reduce((a,b)=>totalCards(room.players[a].cards)<=totalCards(room.players[b].cards)?a:b);room.players[weakId].cards['student']++;addLog(room,`🎓 ${room.players[weakId].name} dostaje 1 ${RANK_EMOJI['student']} (habilitacja kolegi!)`,'bonus');break;}
    case 'steal_strongest':{let strongId=room.order.reduce((a,b)=>totalCards(room.players[a].cards)>=totalCards(room.players[b].cards)?a:b);const r2=randomRank(room.players[strongId].cards);if(r2){room.players[strongId].cards[r2]--;addLog(room,`⚠️ Plagiat! ${room.players[strongId].name} traci ${RANK_EMOJI[r2]}!`,'danger');}break;}
  }
}

function nextTurn(room){ room.turn=(room.turn+1)%room.order.length; }

const server=http.createServer((req,res)=>{
  fs.readFile(path.join(__dirname,'index.html'),(err,data)=>{
    if(err){res.writeHead(404);res.end('Not found');return;}
    res.writeHead(200,{'Content-Type':'text/html'});res.end(data);
  });
});

const wss=new WebSocket.Server({server});

function genCode(){const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';return Array.from({length:5},()=>c[Math.floor(Math.random()*c.length)]).join('');}

wss.on('connection',ws=>{
  let playerId=null,roomCode=null;

  ws.on('message',raw=>{
    let msg;try{msg=JSON.parse(raw);}catch{return;}

    if(msg.type==='create'){
      let code=genCode();while(rooms[code])code=genCode();
      rooms[code]=makeRoom(code);const room=rooms[code];
      playerId='p_'+Date.now();roomCode=code;
      room.players[playerId]={name:msg.name||'Host',cards:newPlayerCards(),bonusPts:0,connected:true,ws};
      room.order.push(playerId);
      ws.send(JSON.stringify({type:'joined',code,playerId,isHost:true}));
      sendState(room);return;
    }

    if(msg.type==='join'){
      const room=rooms[msg.code];
      if(!room){ws.send(JSON.stringify({type:'error',msg:'Pokój nie istnieje.'}));return;}
      if(room.phase!=='lobby'){ws.send(JSON.stringify({type:'error',msg:'Gra już trwa.'}));return;}
      if(room.order.length>=6){ws.send(JSON.stringify({type:'error',msg:'Pokój pełny (max 6).'}));return;}
      playerId='p_'+Date.now();roomCode=msg.code;
      room.players[playerId]={name:msg.name||'Gracz',cards:newPlayerCards(),bonusPts:0,connected:true,ws};
      room.order.push(playerId);
      ws.send(JSON.stringify({type:'joined',code:msg.code,playerId,isHost:false}));
      addLog(room,`👋 ${room.players[playerId].name} dołączył/a`,'info');
      sendState(room);return;
    }

    if(!playerId||!roomCode)return;
    const room=rooms[roomCode];if(!room)return;

    if(msg.type==='start'){if(room.phase!=='lobby')return;room.phase='playing';room.turn=0;addLog(room,'🎓 Gra start! Cel: zebrać komplet Student→Magister→Doktor→Profesor→Dziekan→Rektor','system');sendState(room);return;}

    if(msg.type==='roll'){
      if(room.phase!=='playing'||room.pendingEvent)return;
      const currentId=room.order[room.turn%room.order.length];
      if(playerId!==currentId)return;
      const face=rollDice();const player=room.players[playerId];
      if(face==='event'){
        const event=EVENTS[Math.floor(Math.random()*EVENTS.length)];
        if(event.type==='conference'&&totalCards(player.cards)>0&&room.order.length>1){
          room.pendingEvent={event,actorId:playerId,step:'choose_target'};
          addLog(room,`🎲 ${player.name} → 🎭 ${event.emoji} ${event.name}`,'event');
          sendState(room);
        } else {
          addLog(room,`🎲 ${player.name} → 🎭 ${event.emoji} ${event.name}`,'event');
          resolveEvent(room,event,playerId,{});
          if(!checkWin(room)){nextTurn(room);sendState(room);}
        }
      } else {
        player.cards[face]++;
        addLog(room,`🎲 ${player.name} → ${RANK_EMOJI[face]} ${RANK_LABEL[face]}`,'roll');
        if(!checkWin(room)){nextTurn(room);sendState(room);}
      }
      return;
    }

    if(msg.type==='promote'){
      if(room.phase!=='playing')return;
      const {fromRank}=msg;const player=room.players[playerId];
      if(!fromRank||RANK_IDX[fromRank]===undefined||RANK_IDX[fromRank]>=RANKS.length-1)return;
      if(player.cards[fromRank]<3)return;
      const toRank=RANKS[RANK_IDX[fromRank]+1];
      player.cards[fromRank]-=3;player.cards[toRank]++;
      addLog(room,`⬆️ ${player.name}: 3× ${RANK_EMOJI[fromRank]} → ${RANK_EMOJI[toRank]} ${RANK_LABEL[toRank]}!`,'promote');
      if(!checkWin(room))sendState(room);return;
    }

    if(msg.type==='event_response'){
      if(!room.pendingEvent||room.pendingEvent.actorId!==playerId)return;
      const pe=room.pendingEvent;room.pendingEvent=null;
      resolveEvent(room,pe.event,playerId,{targetId:msg.targetId,giftRank:msg.giftRank});
      if(!checkWin(room)){nextTurn(room);sendState(room);}return;
    }

    if(msg.type==='event_skip'){
      if(!room.pendingEvent||room.pendingEvent.actorId!==playerId)return;
      const pe=room.pendingEvent;room.pendingEvent=null;
      resolveEvent(room,pe.event,playerId,{});
      if(!checkWin(room)){nextTurn(room);sendState(room);}return;
    }

    if(msg.type==='restart'){
      room.phase='lobby';room.turn=0;room.log=[];room.pendingEvent=null;
      room.order.forEach(id=>{if(room.players[id]){room.players[id].cards=newPlayerCards();room.players[id].bonusPts=0;}});
      addLog(room,'🔄 Nowa gra!','system');sendState(room);return;
    }
  });

  ws.on('close',()=>{
    if(playerId&&roomCode&&rooms[roomCode]&&rooms[roomCode].players[playerId])
      rooms[roomCode].players[playerId].connected=false;
  });
});

server.listen(PORT,()=>console.log(`🎓 Uniwersytet v3 on port ${PORT}`));
