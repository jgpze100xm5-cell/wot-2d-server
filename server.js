const { WebSocketServer, WebSocket } = require('ws');

// Render odovzdáva port automaticky cez premenné prostredia process.env.PORT
const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

console.log(`[SERVER] Tankový server beží na porte ${PORT}`);

// Globálny stav
let waitingQueue = [];      // Hráči čakajúci na zápas
let matchCounter = 1;        // ID zápasov
const matches = new Map();   // Aktívne zápasy { matchId: matchData }

// --- HEARTBEAT / PING-PONG (Ochrana proti Render timeoutu) ---
const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            console.log(`[TIMEOUT] Hráč ${ws.id} neodpovedá, odpojený.`);
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// Pravidelná kontrola matchmakingu každú 1 sekundu
setInterval(runMatchmakingLoop, 1000);

wss.on('connection', (ws) => {
    ws.id = 'player_' + Math.random().toString(36).substr(2, 9);
    ws.matchId = null;
    ws.team = null;
    ws.tankId = "fcm36";
    ws.tier = 1;
    ws.joinedAt = 0;
    ws.isAlive = true;

    console.log(`[CONNECT] Pripojený hráč: ${ws.id}`);

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    sendTo(ws, { type: 'INIT', playerId: ws.id });

    ws.on('message', (message) => {
        try {
            const rawStr = message.toString().replace(/\0/g, '').trim();
            if (!rawStr) return;

            const data = JSON.parse(rawStr);
            handleClientMessage(ws, data);
        } catch (err) {
            console.error(`[ERROR] Neplatný JSON od ${ws.id}:`, err.message);
        }
    });

    ws.on('close', () => {
        console.log(`[DISCONNECT] Odpojený hráč: ${ws.id}`);
        handleDisconnect(ws);
    });
});

wss.on('close', () => {
    clearInterval(pingInterval);
});

function handleClientMessage(ws, data) {
    switch (data.type) {
        case 'JOIN_QUEUE':
            addToQueue(ws, data);
            break;

        case 'LEAVE_QUEUE':
            removeFromQueue(ws);
            break;

        case 'LEAVE_MATCH':
            leaveCurrentMatch(ws);
            break;

        case 'PLAYER_UPDATE':
        case 'PLAYER_MOVED':
            if (ws.matchId && matches.has(ws.matchId)) {
                broadcastToMatch(ws.matchId, {
                    type: 'PLAYER_UPDATE',
                    playerId: ws.id,
                    x: data.x,
                    y: data.y,
                    hullAngle: data.hullAngle !== undefined ? data.hullAngle : data.angle,
                    turretAngle: data.turretAngle !== undefined ? data.turretAngle : data.angle,
                    tankId: ws.tankId,
                    speed: data.speed || 0
                }, ws.id);
            }
            break;

        case 'SHOOT':
        case 'PLAYER_SHOOT':
            if (ws.matchId && matches.has(ws.matchId)) {
                broadcastToMatch(ws.matchId, {
                    type: 'PLAYER_SHOOT',
                    playerId: ws.id,
                    x: data.x,
                    y: data.y,
                    angle: data.angle,
                    damage: data.damage || 10
                }, ws.id);
            }
            break;

        case 'TAKE_DAMAGE':
            if (ws.matchId && matches.has(ws.matchId)) {
                broadcastToMatch(ws.matchId, {
                    type: 'TAKE_DAMAGE',
                    targetId: data.targetId,
                    attackerId: ws.id,
                    damage: data.damage,
                    newHp: data.remainingHp !== undefined ? data.remainingHp : data.newHp
                });
            }
            break;
    }
}

function addToQueue(ws, data) {
    // Ak už je vo fronte, alebo ešte stále v neodpojenom zápase, vyčistíme starý zápas
    if (ws.matchId) {
        leaveCurrentMatch(ws);
    }

    if (waitingQueue.includes(ws)) return;

    ws.tankId = data.tankId || data.tank_id || "fcm36";
    ws.tier = Number(data.tier) || 1;
    ws.joinedAt = Date.now();

    waitingQueue.push(ws);
    console.log(`[MM] Hráč ${ws.id} vstúpil do fronty s tankom ${ws.tankId} (Tier ${ws.tier}). Celkovo vo fronte: ${waitingQueue.length}`);

    sendTo(ws, { type: 'QUEUE_JOINED', position: waitingQueue.length });
    broadcastQueueStatus();
}

function removeFromQueue(ws) {
    const index = waitingQueue.indexOf(ws);
    if (index !== -1) {
        waitingQueue.splice(index, 1);
        console.log(`[MM] Hráč ${ws.id} opustil frontu.`);
        sendTo(ws, { type: 'QUEUE_LEFT' });
        broadcastQueueStatus();
    }
}

function leaveCurrentMatch(ws) {
    if (ws.matchId && matches.has(ws.matchId)) {
        const matchId = ws.matchId;
        const match = matches.get(matchId);

        match.players = match.players.filter(p => p !== ws);

        console.log(`[MATCH] Hráč ${ws.id} opustil zápas ${matchId}. Остаáva hráčov: ${match.players.length}`);

        broadcastToMatch(matchId, {
            type: 'PLAYER_LEFT',
            playerId: ws.id
        });

        if (match.players.length === 0) {
            matches.delete(matchId);
            console.log(`[MATCH CLOSED] Bitka ${matchId} bola ukončená (všetci odišli).`);
        }
    }

    ws.matchId = null;
    ws.team = null;
}

// --- VYLEPŠENÁ LOGIKA MATCHMAKINGU (ČAKANIE A BALANS) ---
function runMatchmakingLoop() {
    if (waitingQueue.length < 2) return;

    const now = Date.now();
    const oldestPlayer = waitingQueue[0];
    const waitTimeSec = (now - oldestPlayer.joinedAt) / 1000;

    // 1. Ak máme plný počet (14 hráčov = 7v7), spustíme okamžite
    // 2. Inak čakáme minimálne 5 sekúnd, aby sa stihli pripojiť ďalší hráči
    if (waitingQueue.length < 14 && waitTimeSec < 5) {
        return; 
    }

    for (let i = 0; i < waitingQueue.length; i++) {
        const p1 = waitingQueue[i];
        if (!p1) continue;

        const pWaitSec = (now - p1.joinedAt) / 1000;

        let maxTierDiff = 0;
        if (pWaitSec >= 15) {
            maxTierDiff = 2; // Po 15s rozšírime na +-2 Tiery
        } else if (pWaitSec >= 7) {
            maxTierDiff = 1; // Po 7s rozšírime na +-1 Tier
        }

        let matchedGroup = [p1];
        let minTierInGroup = p1.tier;
        let maxTierInGroup = p1.tier;

        for (let j = i + 1; j < waitingQueue.length; j++) {
            const p2 = waitingQueue[j];
            if (!p2) continue;

            const newMin = Math.min(minTierInGroup, p2.tier);
            const newMax = Math.max(maxTierInGroup, p2.tier);

            if ((newMax - newMin) <= maxTierDiff) {
                matchedGroup.push(p2);
                minTierInGroup = newMin;
                maxTierInGroup = newMax;

                if (matchedGroup.length >= 14) break;
            }
        }

        // Pre férové týmy potrebujeme párny počet hráčov
        if (matchedGroup.length % 2 !== 0) {
            matchedGroup.pop();
        }

        if (matchedGroup.length >= 2) {
            matchedGroup.forEach(player => {
                const idx = waitingQueue.indexOf(player);
                if (idx !== -1) waitingQueue.splice(idx, 1);
            });

            i--;
            createMatchFromPlayers(matchedGroup);
            broadcastQueueStatus();
        }
    }
}

function createMatchFromPlayers(playersForMatch) {
    const matchId = 'match_' + matchCounter++;
    const sortedPlayers = [...playersForMatch].sort((a, b) => b.tier - a.tier);

    const redTeam = [];
    const blueTeam = [];

    sortedPlayers.forEach((playerWs, index) => {
        playerWs.matchId = matchId;

        const playerData = {
            id: playerWs.id,
            tankId: playerWs.tankId,
            tier: playerWs.tier
        };

        const assignToRed = (index % 4 === 0 || index % 4 === 3);

        if (assignToRed) {
            playerWs.team = 'red';
            playerData.team = 'red';
            redTeam.push(playerData);
        } else {
            playerWs.team = 'blue';
            playerData.team = 'blue';
            blueTeam.push(playerData);
        }
    });

    matches.set(matchId, {
        id: matchId,
        players: playersForMatch,
        createdAt: Date.now()
    });

    console.log(`[MATCH CREATED] Bitka ${matchId} vytvorená! Tímy: ${redTeam.length} vs ${blueTeam.length}`);

    playersForMatch.forEach((playerWs) => {
        sendTo(playerWs, {
            type: 'MATCH_START',
            matchId: matchId,
            yourTeam: playerWs.team,
            redTeam: redTeam,
            blueTeam: blueTeam
        });
    });
}

function broadcastQueueStatus() {
    waitingQueue.forEach((ws, idx) => {
        sendTo(ws, {
            type: 'QUEUE_UPDATE',
            inQueueCount: waitingQueue.length,
            yourPosition: idx + 1
        });
    });
}

function handleDisconnect(ws) {
    removeFromQueue(ws);
    leaveCurrentMatch(ws);
}

function sendTo(ws, messageObject) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(messageObject));
    }
}

function broadcastToMatch(matchId, messageObject, excludePlayerId = null) {
    const match = matches.get(matchId);
    if (!match) return;

    const payload = JSON.stringify(messageObject);
    match.players.forEach((playerWs) => {
        if (playerWs.readyState === WebSocket.OPEN && playerWs.id !== excludePlayerId) {
            playerWs.send(payload);
        }
    });
}
