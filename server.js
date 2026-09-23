const { WebSocketServer, WebSocket } = require('ws');

// Render odovzdáva port automaticky cez premenné prostredia process.env.PORT
const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

console.log(`[SERVER] Tankový server beží na porte ${PORT}`);

// Globálny stav
let waitingQueue = [];      // Hráči čakajúci na zápas
let matchCounter = 1;        // ID zápasov
const matches = new Map();   // Aktívne zápasy { matchId: matchData }

// Pravidelná kontrola matchmakingu každú 1 sekundu (pre postupné rozširovanie Tierov podľa času)
setInterval(runMatchmakingLoop, 1000);

wss.on('connection', (ws) => {
    ws.id = 'player_' + Math.random().toString(36).substr(2, 9);
    ws.matchId = null;
    ws.team = null;
    ws.tankId = "fcm36";
    ws.tier = 1;
    ws.joinedAt = 0;

    console.log(`[CONNECT] Pripojený hráč: ${ws.id}`);

    sendTo(ws, { type: 'INIT', playerId: ws.id });

    ws.on('message', (message) => {
        try {
            // Očistenie od nulových bajtov (\0) z GameMakeru a orezanie medzier
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

function handleClientMessage(ws, data) {
    switch (data.type) {
        case 'JOIN_QUEUE':
            addToQueue(ws, data);
            break;

        case 'LEAVE_QUEUE':
            removeFromQueue(ws);
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
    if (waitingQueue.includes(ws) || ws.matchId) return;

    ws.tankId = data.tankId || data.tank_id || "fcm36";
    ws.tier = Number(data.tier) || 1;
    ws.joinedAt = Date.now();

    waitingQueue.push(ws);
    console.log(`[MM] Hráč ${ws.id} vstúpil do fronty s tankom ${ws.tankId} (Tier ${ws.tier}). Celkovo vo fronte: ${waitingQueue.length}`);

    sendTo(ws, { type: 'QUEUE_JOINED', position: waitingQueue.length });

    broadcastQueueStatus();
    runMatchmakingLoop(); // Okamžitá kontrola
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

// --- TIER-SPREAD MATCHMAKING LOGIKA ( +-1 AŽ +-2 TIER ) ---
function runMatchmakingLoop() {
    if (waitingQueue.length < 2) return;

    const now = Date.now();

    for (let i = 0; i < waitingQueue.length; i++) {
        const p1 = waitingQueue[i];
        if (!p1) continue;

        const waitTimeSec = (now - p1.joinedAt) / 1000;

        // Tolerancia rozdielu Tierov podľa času čakania
        let maxTierDiff = 0; // 0-3s: Iba rovnaký Tier
        if (waitTimeSec >= 7) {
            maxTierDiff = 2; // Po 7s: +-2 Tiery
        } else if (waitTimeSec >= 3) {
            maxTierDiff = 1; // Po 3s: +-1 Tier
        }

        let matchedGroup = [p1];

        // Hľadáme ďalších hráčov vyhovujúcich Tier pravidlu
        for (let j = i + 1; j < waitingQueue.length; j++) {
            const p2 = waitingQueue[j];
            if (!p2) continue;

            const tierDifference = Math.abs(p1.tier - p2.tier);

            if (tierDifference <= maxTierDiff) {
                matchedGroup.push(p2);
                if (matchedGroup.length >= 14) break; // Maximálny počet hráčov pre zápas
            }
        }

        // Ak máme aspoň 2 hráčov na zápas
        if (matchedGroup.length >= 2) {
            // Odstránime vybraných hráčov z fronty
            matchedGroup.forEach(player => {
                const idx = waitingQueue.indexOf(player);
                if (idx !== -1) waitingQueue.splice(idx, 1);
            });

            i--; // Úprava indexu cyklu po vymazaní

            createMatchFromPlayers(matchedGroup);
            broadcastQueueStatus();
        }
    }
}

function createMatchFromPlayers(playersForMatch) {
    const matchId = 'match_' + matchCounter++;

    const redTeam = [];
    const blueTeam = [];

    playersForMatch.forEach((playerWs, index) => {
        playerWs.matchId = matchId;
        
        const playerData = {
            id: playerWs.id,
            tankId: playerWs.tankId,
            tier: playerWs.tier
        };

        if (index % 2 === 0) {
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

    if (ws.matchId && matches.has(ws.matchId)) {
        const match = matches.get(ws.matchId);
        match.players = match.players.filter(p => p !== ws);

        broadcastToMatch(ws.matchId, {
            type: 'PLAYER_DISCONNECTED',
            playerId: ws.id
        });

        if (match.players.length === 0) {
            matches.delete(ws.matchId);
            console.log(`[MATCH CLOSED] Bitka ${ws.matchId} bola ukončená (všetci odišli).`);
        }
    }
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
