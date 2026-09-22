const { WebSocketServer, WebSocket } = require('ws');

// Render odovzdáva port automaticky cez premenné prostredia process.env.PORT
const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

console.log(`[SERVER] Tankový server beží na porte ${PORT}`);

// Globálny stav
let waitingQueue = [];      // Hráči čakajúci na zápas
let queueTimer = null;       // Odpočet matchmakingu
let matchCounter = 1;        // ID zápasov
const matches = new Map();   // Aktívne zápasy { matchId: matchData }

// Konštanta časového limitu (30 sekúnd)
const MATCHMAKING_TIMEOUT_MS = 30000;

wss.on('connection', (ws) => {
    ws.id = 'player_' + Math.random().toString(36).substr(2, 9);
    ws.matchId = null;
    ws.team = null;

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
            addToQueue(ws);
            break;

        case 'LEAVE_QUEUE':
            removeFromQueue(ws);
            break;

        case 'PLAYER_UPDATE':
        case 'PLAYER_MOVED':
            if (ws.matchId && matches.has(ws.matchId)) {
                // Posielame späť oba typy/kľúče pre maximálnu kompatibilitu s klientskym kódom
                broadcastToMatch(ws.matchId, {
                    type: 'PLAYER_UPDATE',
                    playerId: ws.id,
                    x: data.x,
                    y: data.y,
                    hullAngle: data.hullAngle !== undefined ? data.hullAngle : data.angle,
                    turretAngle: data.turretAngle !== undefined ? data.turretAngle : data.angle,
                    tankId: data.tankId || data.tank_id || "fcm36",
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

function addToQueue(ws) {
    if (waitingQueue.includes(ws) || ws.matchId) return;

    waitingQueue.push(ws);
    console.log(`[MM] Hráč ${ws.id} vstúpil do fronty. Celkovo vo fronte: ${waitingQueue.length}`);

    sendTo(ws, { type: 'QUEUE_JOINED', position: waitingQueue.length });

    if (waitingQueue.length === 1 && !queueTimer) {
        console.log(`[MM] Spustený 30s odpočet pre vytvorenie bitky...`);
        queueTimer = setTimeout(() => {
            createMatchFromQueue();
        }, MATCHMAKING_TIMEOUT_MS);
    }

    broadcastQueueStatus();

    if (waitingQueue.length >= 14) {
        clearTimeout(queueTimer);
        queueTimer = null;
        createMatchFromQueue();
    }
}

function removeFromQueue(ws) {
    const index = waitingQueue.indexOf(ws);
    if (index !== -1) {
        waitingQueue.splice(index, 1);
        console.log(`[MM] Hráč ${ws.id} opustil frontu.`);
        sendTo(ws, { type: 'QUEUE_LEFT' });

        if (waitingQueue.length === 0 && queueTimer) {
            clearTimeout(queueTimer);
            queueTimer = null;
            console.log(`[MM] Fronta je prázdna, odpočet zrušený.`);
        } else {
            broadcastQueueStatus();
        }
    }
}

function createMatchFromQueue() {
    queueTimer = null;

    if (waitingQueue.length < 2) {
        console.log(`[MM] Nedostatok hráčov pre zápas (menej ako 2). Čaká sa ďalej...`);
        if (waitingQueue.length === 1) {
            queueTimer = setTimeout(() => {
                createMatchFromQueue();
            }, MATCHMAKING_TIMEOUT_MS);
        }
        return;
    }

    const playersForMatch = waitingQueue.splice(0, 14);
    const matchId = 'match_' + matchCounter++;

    const redTeam = [];
    const blueTeam = [];

    playersForMatch.forEach((playerWs, index) => {
        playerWs.matchId = matchId;
        if (index % 2 === 0) {
            playerWs.team = 'red';
            redTeam.push({ id: playerWs.id, team: 'red' });
        } else {
            playerWs.team = 'blue';
            blueTeam.push({ id: playerWs.id, team: 'blue' });
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

    if (waitingQueue.length > 0) {
        queueTimer = setTimeout(() => {
            createMatchFromQueue();
        }, MATCHMAKING_TIMEOUT_MS);
        broadcastQueueStatus();
    }
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
