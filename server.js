const { WebSocketServer, WebSocket } = require('ws');
const fs = require('fs');

// Render odovzdáva port automaticky cez premenné prostredia process.env.PORT
const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

console.log(`[SERVER] Tankový server beží na porte ${PORT}`);
console.log(`[SERVER] Očakávané pripojenie z: wss://wot-2d-server.onrender.com`);

// Globálny stav
let waitingQueue = [];       // Hráči čakajúci na zápas
let matchCounter = 1;        // ID zápasov
const matches = new Map();   // Aktívne zápasy { matchId: matchData }
const parties = new Map();   // Aktívne čety { partyId: partyData }
let partyCounter = 1;

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

// Pravidelná kontrola a aktualizácia stavu základen (Cap loop každých 100ms)
setInterval(runBasesLoop, 100);

wss.on('connection', (ws) => {
    ws.id = 'player_' + Math.random().toString(36).substr(2, 9);
    ws.playerName = 'Player';
    ws.matchId = null;
    ws.team = null;
    ws.tankId = "fcm36";
    ws.tier = 1;
    ws.joinedAt = 0;
    ws.isAlive = true;
    ws.isDead = false;
    ws.partyId = null;

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
            if (ws.partyId) {
                const p = parties.get(ws.partyId);
                if (p) sendPartyUpdate(p);
            }
            break;

        case 'LEAVE_QUEUE':
            removeFromQueue(ws);
            break;

        case 'LEAVE_MATCH':
            leaveCurrentMatch(ws);
            break;

        // --- SYSTÉM ČET (PLATOONS) ---
        case 'CREATE_PARTY':
            if (ws.partyId) leaveParty(ws);
            
            const newPartyId = 'party_' + partyCounter++;
            const newParty = {
                id: newPartyId,
                leaderId: ws.id,
                members: [ws]
            };
            parties.set(newPartyId, newParty);
            ws.partyId = newPartyId;

            console.log(`[PARTY] Hráč ${ws.id} vytvoril četu ${newPartyId}`);
            sendPartyUpdate(newParty);
            break;

        case 'JOIN_PARTY':
            const targetPartyId = data.partyId;
            const party = parties.get(targetPartyId);

            if (!party) {
                sendTo(ws, { type: 'PARTY_ERROR', message: 'Četa neexistuje.' });
                return;
            }
            if (party.members.length >= 3) {
                sendTo(ws, { type: 'PARTY_ERROR', message: 'Četa je plná (max 3 hráči).' });
                return;
            }
            if (ws.partyId) leaveParty(ws);

            party.members.push(ws);
            ws.partyId = targetPartyId;

            console.log(`[PARTY] Hráč ${ws.id} vstúpil do čety ${targetPartyId}`);
            sendPartyUpdate(party);
            break;

        case 'LEAVE_PARTY':
            leaveParty(ws);
            break;

        // --- AKTUALIZACE TANKU V ČETĚ ---
        case 'UPDATE_PARTY_TANK':
            if (data.tankId) {
                ws.tankId = data.tankId;
                if (ws.partyId) {
                    const activeParty = parties.get(ws.partyId);
                    if (activeParty) {
                        sendPartyUpdate(activeParty);
                        console.log(`[PARTY] Hráč ${ws.id} zmenil tank v čete na: ${ws.tankId}`);
                    }
                }
            }
            break;

        // --- OVĚŘENÍ JEDNORÁZOVÉHO KÓDU PRO PRÉMIOVÝ TANK ---
        case 'REDEEM_CODE':
            const targetTankId = data.tankId;
            const enteredCode = data.code;

            try {
                if (!fs.existsSync('codes.json')) {
                    sendTo(ws, {
                        type: 'CODE_INVALID',
                        message: 'Chybí soubor s kódy na serveru.'
                    });
                    return;
                }

                let rawData = fs.readFileSync('codes.json', 'utf8');
                let codesData = JSON.parse(rawData);

                if (codesData[targetTankId] && codesData[targetTankId].includes(enteredCode)) {
                    codesData[targetTankId] = codesData[targetTankId].filter(c => c !== enteredCode);
                    fs.writeFileSync('codes.json', JSON.stringify(codesData, null, 2), 'utf8');

                    sendTo(ws, {
                        type: 'CODE_SUCCESS',
                        tankId: targetTankId
                    });

                    console.log(`[CODE] Hráč ${ws.id} úspěšně uplatnil kód pro tank: ${targetTankId}`);
                } else {
                    sendTo(ws, {
                        type: 'CODE_INVALID',
                        message: 'Tento kód je neplatný nebo již byl použit.'
                    });

                    console.log(`[CODE] Hráč ${ws.id} zadal neplatný/použitý kód: ${enteredCode}`);
                }
            } catch (err) {
                console.error("[CODE ERROR] Chyba při čtení/zápisu codes.json:", err);
                sendTo(ws, {
                    type: 'CODE_INVALID',
                    message: 'Chyba serveru při ověřování kódu.'
                });
            }
            break;

        case 'PLAYER_UPDATE':
        case 'PLAYER_MOVED':
            if (ws.isDead) return;

            const updatedName = data.player_name || data.playerName || data.name || data.nickname;
            if (updatedName && updatedName !== 'Player') {
                ws.playerName = updatedName;
            }

            if (ws.matchId && matches.has(ws.matchId)) {
                broadcastToMatch(ws.matchId, {
                    type: 'PLAYER_UPDATE',
                    playerId: ws.id,
                    playerName: ws.playerName,
                    player_name: ws.playerName,
                    team: ws.team,
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
            if (ws.isDead) return;

            if (ws.matchId && matches.has(ws.matchId)) {
                broadcastToMatch(ws.matchId, {
                    type: 'PLAYER_SHOOT',
                    playerId: ws.id,
                    tankId: data.tankId || ws.tankId,
                    bulletType: data.bulletType || data.bullet_obj || data.bulletObj || null,
                    x: data.x,
                    y: data.y,
                    angle: data.angle,
                    damage: data.damage || 10
                }, ws.id);
            }
            break;

        // --- PŘEPOSÍLANÍ VÝSTŘELU SEKUNDÁRNÍ ZBRANĚ OSTATNÍM ---
        case 'FIRE_SECONDARY':
            if (ws.isDead) return;

            if (ws.matchId && matches.has(ws.matchId)) {
                broadcastToMatch(ws.matchId, {
                    type: 'REMOTE_FIRE_SECONDARY',
                    playerId: ws.id,
                    tankId: data.tankId || ws.tankId,
                    x: data.x,
                    y: data.y,
                    dir: data.dir
                }, ws.id);
            }
            break;

        // --- PŘEPOSÍLANÍ NAVÁDĚNÍ RAKETY OSTATNÍM ---
        case 'ROCKET_STEER':
            if (ws.isDead) return;

            if (ws.matchId && matches.has(ws.matchId)) {
                broadcastToMatch(ws.matchId, {
                    type: 'REMOTE_ROCKET_STEER',
                    playerId: ws.id,
                    x: data.x,
                    y: data.y,
                    angle: data.angle
                }, ws.id);
            }
            break;

        case 'TAKE_DAMAGE':
            if (ws.matchId && matches.has(ws.matchId)) {
                const targetHp = data.remainingHp !== undefined ? data.remainingHp : data.newHp;
                
                const match = matches.get(ws.matchId);
                if (match) {
                    const targetWs = match.players.find(p => p.id === data.targetId);
                    if (targetWs && targetHp <= 0) {
                        targetWs.isDead = true;
                        
                        match.bases.forEach(base => {
                            base.cappingPlayers.delete(targetWs.id);
                        });

                        broadcastToMatch(ws.matchId, {
                            type: 'PLAYER_DIED',
                            playerId: data.targetId,
                            killerId: ws.id
                        });
                    }

                    match.bases.forEach((base, baseOwner) => {
                        if (base.cappingPlayers.has(data.targetId)) {
                            base.cappingPlayers.delete(data.targetId);
                            base.progress = 0;
                            base.cappingTeam = null;

                            broadcastToMatch(ws.matchId, {
                                type: 'CAP_UPDATE',
                                baseOwner: baseOwner,
                                cappingTeam: null,
                                progress: 0
                            });

                            console.log(`[DECAP] Hráč ${data.targetId} dostal zásah v base ${baseOwner} - cap zresetován!`);
                        }
                    });

                    broadcastToMatch(ws.matchId, {
                        type: 'CAP_DECAP',
                        targetId: data.targetId
                    });
                }

                broadcastToMatch(ws.matchId, {
                    type: 'TAKE_DAMAGE',
                    targetId: data.targetId,
                    attackerId: ws.id,
                    damage: data.damage,
                    newHp: targetHp
                });
            }
            break;

        case 'CAP_PROGRESS':
            if (ws.matchId && matches.has(ws.matchId)) {
                const match = matches.get(ws.matchId);
                if (match && match.bases.has(data.baseOwner)) {
                    const base = match.bases.get(data.baseOwner);
                    const isInside = data.progress !== undefined && data.progress > 0;

                    if (ws.team !== data.baseOwner && isInside) {
                        base.cappingPlayers.set(ws.id, {
                            team: ws.team,
                            lastUpdate: Date.now()
                        });
                    } else {
                        base.cappingPlayers.delete(ws.id);
                    }
                }
            }
            break;

        case 'BASE_CAPTURED':
            break;
    }
}

// Pomocná funkcia pre opustenie čety
function leaveParty(ws) {
    if (!ws.partyId) return;
    const party = parties.get(ws.partyId);
    if (party) {
        party.members = party.members.filter(m => m !== ws);
        console.log(`[PARTY] Hráč ${ws.id} opustil četu ${ws.partyId}`);

        if (party.members.length === 0) {
            parties.delete(ws.partyId);
            console.log(`[PARTY CLOSED] Četa ${ws.partyId} bola zrušená (prázdna).`);
        } else {
            if (party.leaderId === ws.id) {
                party.leaderId = party.members[0].id;
            }
            sendPartyUpdate(party);
        }
    }
    ws.partyId = null;
    sendTo(ws, { type: 'PARTY_LEFT' });
}

function sendPartyUpdate(party) {
    const memberData = party.members.map(m => ({
        id: m.id,
        player_name: m.playerName || "Player",
        playerName: m.playerName || "Player",
        name: m.playerName || "Player",
        nickname: m.playerName || "Player",
        tankId: m.tankId,
        tier: m.tier
    }));

    party.members.forEach(m => {
        sendTo(m, {
            type: 'PARTY_UPDATE',
            partyId: party.id,
            leaderId: party.leaderId,
            members: memberData
        });
    });
}

// --- SERVER LOOP PRE SPRÁVU ZÁKLADEN ---
function runBasesLoop() {
    const now = Date.now();

    matches.forEach((match, matchId) => {
        match.bases.forEach((base, baseOwner) => {
            
            base.cappingPlayers.forEach((playerInfo, playerId) => {
                if (now - playerInfo.lastUpdate > 1000) {
                    base.cappingPlayers.delete(playerId);
                }
            });

            const teamsInBase = new Set();
            base.cappingPlayers.forEach((playerInfo) => {
                teamsInBase.add(playerInfo.team);
            });

            if (teamsInBase.size > 0) {
                const cappingTeam = Array.from(teamsInBase)[0];

                if (base.cappingTeam !== cappingTeam) {
                    base.cappingTeam = cappingTeam;
                }

                base.progress = Math.min(100, base.progress + 0.167);

                broadcastToMatch(matchId, {
                    type: 'CAP_UPDATE',
                    baseOwner: baseOwner,
                    cappingTeam: base.cappingTeam,
                    progress: base.progress
                });

                if (base.progress >= 100) {
                    console.log(`[MATCH] Základna ${baseOwner} v zápase ${matchId} byla obsazena týmem ${base.cappingTeam}!`);
                    broadcastToMatch(matchId, {
                        type: 'BASE_CAPTURED',
                        winnerTeam: base.cappingTeam,
                        baseOwner: baseOwner
                    });
                    base.progress = 0;
                    base.cappingTeam = null;
                    base.cappingPlayers.clear();
                }
            } else {
                if (base.progress > 0) {
                    base.progress = Math.max(0, base.progress - 0.25);

                    broadcastToMatch(matchId, {
                        type: 'CAP_UPDATE',
                        baseOwner: baseOwner,
                        cappingTeam: base.cappingTeam,
                        progress: base.progress
                    });

                    if (base.progress === 0) {
                        base.cappingTeam = null;
                    }
                }
            }
        });
    });
}

function addToQueue(ws, data) {
    if (ws.matchId) {
        leaveCurrentMatch(ws);
    }

    if (waitingQueue.includes(ws)) return;

    const extractedName = data.player_name || data.playerName || data.name || data.nickname;
    if (extractedName && extractedName !== "") {
        ws.playerName = String(extractedName);
    } else if (!ws.playerName || ws.playerName === "") {
        ws.playerName = "Player";
    }

    ws.tankId = data.tankId || data.tank_id || "fcm36";
    ws.tier = Number(data.tier) || 1;
    ws.joinedAt = Date.now();
    ws.isDead = false;

    waitingQueue.push(ws);
    console.log(`[MM] Hráč ${ws.playerName} (${ws.id}) vstúpil do fronty s tankom ${ws.tankId} (Tier ${ws.tier}).`);

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

        match.bases.forEach(base => {
            base.cappingPlayers.delete(ws.id);
        });

        console.log(`[MATCH] Hráč ${ws.id} opustil zápas ${matchId}. Ostáva hráčov: ${match.players.length}`);

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
    ws.isDead = false;
}

function runMatchmakingLoop() {
    if (waitingQueue.length < 2) return;

    const now = Date.now();
    const oldestPlayer = waitingQueue[0];
    if (!oldestPlayer) return;
    const waitTimeSec = (now - oldestPlayer.joinedAt) / 1000;

    if (waitingQueue.length < 14 && waitTimeSec < 10) {
        return; 
    }

    for (let i = 0; i < waitingQueue.length; i++) {
        const p1 = waitingQueue[i];
        if (!p1) continue;

        let groupToMatch = [];
        if (p1.partyId) {
            const party = parties.get(p1.partyId);
            if (party && party.leaderId === p1.id) {
                groupToMatch = party.members.filter(m => waitingQueue.includes(m));
            } else {
                continue; 
            }
        } else {
            groupToMatch = [p1];
        }

        let minTierInGroup = Math.min(...groupToMatch.map(m => m.tier));
        let maxTierInGroup = Math.max(...groupToMatch.map(m => m.tier));

        for (let j = 0; j < waitingQueue.length; j++) {
            const p2 = waitingQueue[j];
            if (!p2 || groupToMatch.includes(p2)) continue;

            let p2Group = [p2];
            if (p2.partyId) {
                const p2Party = parties.get(p2.partyId);
                if (p2Party) {
                    p2Group = p2Party.members.filter(m => waitingQueue.includes(m));
                    if (p2Party.leaderId !== p2.id) continue;
                }
            }

            const p1IsEndgame = (minTierInGroup >= 9);
            const p2MinTier = Math.min(...p2Group.map(m => m.tier));
            const p2MaxTier = Math.max(...p2Group.map(m => m.tier));
            const p2IsEndgame = (p2MinTier >= 9);

            if (p1IsEndgame !== p2IsEndgame) continue;

            const newMin = Math.min(minTierInGroup, p2MinTier);
            const newMax = Math.max(maxTierInGroup, p2MaxTier);

            if (!p1IsEndgame && (newMax - newMin) > 2) continue;

            groupToMatch.push(...p2Group);
            minTierInGroup = newMin;
            maxTierInGroup = newMax;

            if (groupToMatch.length >= 14) break;
        }

        while (groupToMatch.length % 2 !== 0 && groupToMatch.length >= 2) {
            const lastPlayer = groupToMatch[groupToMatch.length - 1];
            if (lastPlayer.partyId) {
                groupToMatch = groupToMatch.filter(m => m.partyId !== lastPlayer.partyId);
            } else {
                groupToMatch.pop();
            }
        }

        if (groupToMatch.length >= 2) {
            const testRed = [];
            const testBlue = [];
            const processedPartiesTest = new Set();

            groupToMatch.forEach(playerWs => {
                if (playerWs.partyId) {
                    if (!processedPartiesTest.has(playerWs.partyId)) {
                        processedPartiesTest.add(playerWs.partyId);
                        const p = parties.get(playerWs.partyId);
                        
                        const targetTeam = (testRed.length <= testBlue.length) ? testRed : testBlue;

                        if (p) {
                            p.members.forEach(m => {
                                if (groupToMatch.includes(m)) {
                                    targetTeam.push(m);
                                }
                            });
                        }
                    }
                } else {
                    if (testRed.length <= testBlue.length) {
                        testRed.push(playerWs);
                    } else {
                        testBlue.push(playerWs);
                    }
                }
            });

            if (testRed.length === 0 || testBlue.length === 0) {
                continue; 
            }

            groupToMatch.forEach(player => {
                const idx = waitingQueue.indexOf(player);
                if (idx !== -1) waitingQueue.splice(idx, 1);
            });

            i--;
            createMatchFromPlayers(groupToMatch);
            broadcastQueueStatus();
            break;
        }
    }
}

function createMatchFromPlayers(playersForMatch) {
    const matchId = 'match_' + matchCounter++;
    
    const redTeam = [];
    const blueTeam = [];

    const processedParties = new Set();

    playersForMatch.forEach((playerWs) => {
        if (redTeam.some(p => p.id === playerWs.id) || blueTeam.some(p => p.id === playerWs.id)) {
            return;
        }

        playerWs.matchId = matchId;
        playerWs.isDead = false;

        if (playerWs.partyId) {
            if (!processedParties.has(playerWs.partyId)) {
                processedParties.add(playerWs.partyId);
                
                const partyTeam = (redTeam.length <= blueTeam.length) ? 'red' : 'blue';

                const party = parties.get(playerWs.partyId);
                if (party) {
                    party.members.forEach(member => {
                        if (playersForMatch.includes(member)) {
                            member.matchId = matchId;
                            member.isDead = false;
                            member.team = partyTeam;
                            
                            const mData = { 
                                id: member.id, 
                                player_name: member.playerName, 
                                playerName: member.playerName, 
                                tankId: member.tankId, 
                                tier: member.tier, 
                                team: partyTeam 
                            };
                            
                            if (partyTeam === 'red') {
                                redTeam.push(mData);
                            } else {
                                blueTeam.push(mData);
                            }
                        }
                    });
                }
            }
        } else {
            const soloTeam = (redTeam.length <= blueTeam.length) ? 'red' : 'blue';

            playerWs.team = soloTeam;
            const playerData = {
                id: playerWs.id,
                player_name: playerWs.playerName,
                playerName: playerWs.playerName,
                tankId: playerWs.tankId,
                tier: playerWs.tier,
                team: soloTeam
            };

            if (soloTeam === 'red') {
                redTeam.push(playerData);
            } else {
                blueTeam.push(playerData);
            }
        }
    });

    const matchBases = new Map();
    matchBases.set("red", {
        progress: 0,
        cappingTeam: null,
        cappingPlayers: new Map()
    });
    matchBases.set("blue", {
        progress: 0,
        cappingTeam: null,
        cappingPlayers: new Map()
    });

    matches.set(matchId, {
        id: matchId,
        players: playersForMatch,
        bases: matchBases,
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
    leaveParty(ws);
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
