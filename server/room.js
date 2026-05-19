import {
  createDeck,
  determineWinner,
  canPlayCard,
  scoreRound,
  getTrumpForRound,
  TRUMP_NAMES,
} from './game.js';

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function rotatePlayerOrder(playerIds, startIndex) {
  const n = playerIds.length;
  if (n === 0) return [];
  const idx = ((startIndex % n) + n) % n;
  return [...playerIds.slice(idx), ...playerIds.slice(0, idx)];
}

export class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  createRoom(socketId, playerName, playerToken) {
    let code;
    do {
      code = generateRoomCode();
    } while (this.rooms.has(code));

    const room = new GameRoom(code, playerToken);
    room.addPlayer(playerToken, socketId, playerName, true);
    this.rooms.set(code, room);
    return room;
  }

  joinRoom(code, socketId, playerName, playerToken) {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) return { error: 'Room not found' };

    const existing = room.getPlayer(playerToken);
    if (existing) {
      return room.reconnectPlayer(playerToken, socketId);
    }

    return room.addPlayer(playerToken, socketId, playerName, false);
  }

  rejoinRoom(code, socketId, playerToken) {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) return { error: 'Room not found' };
    if (!room.getPlayer(playerToken)) {
      return { error: 'You are not in this room anymore' };
    }
    return room.reconnectPlayer(playerToken, socketId);
  }

  getRoom(code) {
    return this.rooms.get(code?.toUpperCase());
  }

  getRoomBySocket(socketId) {
    for (const room of this.rooms.values()) {
      if (room.getTokenBySocket(socketId)) return room;
    }
    return null;
  }

  disconnectSocket(socketId) {
    const room = this.getRoomBySocket(socketId);
    if (!room) return null;
    room.disconnectPlayer(socketId);
    if (room.players.size === 0) {
      this.rooms.delete(room.code);
    }
    return room;
  }

  leaveRoom(socketId) {
    const room = this.getRoomBySocket(socketId);
    if (!room) return null;
    const token = room.getTokenBySocket(socketId);
    if (!token) return null;
    room.leavePlayer(token);
    if (room.players.size === 0) {
      this.rooms.delete(room.code);
    }
    return room;
  }
}

export class GameRoom {
  constructor(code, hostToken) {
    this.code = code;
    this.hostId = hostToken;
    this.players = new Map();
    this.status = 'lobby';
    this.roundNum = 0;
    this.totalRounds = 0;
    this.hands = {};
    this.predictions = {};
    this.wins = {};
    this.scores = {};
    this.playOrder = [];
    this.playerIds = [];
    this.currentTrick = {};
    this.leadSuit = null;
    this.subround = 0;
    this.cardsPerPlayer = 0;
    this.currentPlayerIndex = 0;
    this.predictionOrderIndex = 0;
    this.lastTrickWinner = null;
    this.roundResults = null;
    this.trumpSuit = 'S';
    this.pendingAfterTrick = null;
    this.chatMessages = [];
  }

  getPlayer(token) {
    return this.players.get(token);
  }

  getTokenBySocket(socketId) {
    for (const [token, p] of this.players) {
      if (p.socketId === socketId) return token;
    }
    return null;
  }

  addPlayer(token, socketId, name, isHost) {
    if (this.getPlayer(token)) {
      return this.reconnectPlayer(token, socketId);
    }

    if (this.status !== 'lobby') {
      return { error: 'Game already started' };
    }
    if (this.players.size >= 6) {
      return { error: 'Room is full (max 6 players)' };
    }

    const trimmed = (name || 'Player').trim().slice(0, 20) || 'Player';
    const duplicate = [...this.players.values()].some(
      (p) => p.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (duplicate) {
      return { error: 'Name already taken in this room' };
    }

    this.players.set(token, {
      id: token,
      token,
      socketId,
      name: trimmed,
      isHost: isHost || token === this.hostId,
      connected: true,
    });
    this.scores[token] = this.scores[token] ?? 0;

    if (!isHost && this.players.size === 1) {
      this.hostId = token;
      this.players.get(token).isHost = true;
    }

    return { success: true };
  }

  reconnectPlayer(token, socketId) {
    const player = this.getPlayer(token);
    if (!player) {
      return { error: 'Player not found in room' };
    }
    player.socketId = socketId;
    player.connected = true;
    return { success: true, reconnected: true };
  }

  disconnectPlayer(socketId) {
    const token = this.getTokenBySocket(socketId);
    if (!token) return;
    const player = this.getPlayer(token);
    player.socketId = null;
    player.connected = false;
  }

  leavePlayer(token) {
    const wasHost = token === this.hostId;
    this.players.delete(token);
    delete this.hands[token];
    delete this.predictions[token];
    delete this.wins[token];
    delete this.scores[token];

    this.playerIds = this.playerIds.filter((id) => id !== token);
    this.playOrder = this.playOrder.filter((id) => id !== token);

    if (Object.keys(this.currentTrick).length) {
      const trick = {};
      for (const [pid, card] of Object.entries(this.currentTrick)) {
        if (pid !== token) trick[pid] = card;
      }
      this.currentTrick = trick;
    }

    if (this.lastTrickWinner === token) {
      this.lastTrickWinner = null;
    }

    if (this.players.size > 0 && wasHost) {
      const next = this.players.keys().next().value;
      this.hostId = next;
      this.players.get(next).isHost = true;
    }
  }

  playerList() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      connected: p.connected,
      score: this.scores[p.id] ?? 0,
    }));
  }

  startGame() {
    if (this.players.size < 2) {
      return { error: 'Need at least 2 players' };
    }
    this.status = 'playing';
    this.totalRounds = Math.floor(52 / this.players.size);
    this.roundNum = 0;
    this.playerIds = [...this.players.keys()];
    for (const id of this.playerIds) {
      this.scores[id] = this.scores[id] ?? 0;
    }
    return this.startRound();
  }

  startRound() {
    this.roundNum += 1;
    if (this.roundNum > this.totalRounds) {
      this.status = 'finished';
      return { phase: 'gameOver' };
    }

    this.cardsPerPlayer = this.roundNum;
    this.trumpSuit = getTrumpForRound(this.roundNum);
    this.subround = 0;
    this.predictions = {};
    this.wins = {};
    this.currentTrick = {};
    this.leadSuit = null;
    this.lastTrickWinner = null;

    const deck = createDeck();
    const ids = this.playerIds.length
      ? this.playerIds
      : [...this.players.keys()];
    this.playerIds = ids;

    const roundLeadIndex = (this.roundNum - 1) % ids.length;
    this.playOrder = rotatePlayerOrder(ids, roundLeadIndex);
    this.hands = {};

    ids.forEach((id, i) => {
      const start = i * this.cardsPerPlayer;
      this.hands[id] = deck.slice(start, start + this.cardsPerPlayer);
    });

    this.predictionOrderIndex = 0;
    this.status = 'predicting';
    return { phase: 'predicting' };
  }

  getPredictionTurnPlayerId() {
    if (this.status !== 'predicting') return null;
    if (this.predictionOrderIndex >= this.playOrder.length) return null;
    return this.playOrder[this.predictionOrderIndex];
  }

  submitPrediction(playerId, value) {
    if (this.status !== 'predicting') {
      return { error: 'Not prediction phase' };
    }
    if (playerId !== this.getPredictionTurnPlayerId()) {
      return { error: 'Wait for your turn to predict' };
    }
    if (this.predictions[playerId] !== undefined) {
      return { error: 'You already predicted this round' };
    }
    const pred = Number(value);
    if (
      !Number.isInteger(pred) ||
      pred < 0 ||
      pred > this.cardsPerPlayer
    ) {
      return { error: `Prediction must be 0–${this.cardsPerPlayer}` };
    }
    this.predictions[playerId] = pred;
    this.predictionOrderIndex += 1;

    if (this.predictionOrderIndex >= this.playOrder.length) {
      this.status = 'playing_trick';
      this.subround = 1;
      this.wins = Object.fromEntries(
        [...this.players.keys()].map((id) => [id, 0])
      );
      this.beginTrick();
      return { phase: 'playing_trick', allPredicted: true };
    }
    return { waiting: true };
  }

  beginTrick() {
    this.currentTrick = {};
    this.leadSuit = null;
    this.currentPlayerIndex = 0;

    if (this.lastTrickWinner) {
      this.playOrder = rotatePlayerOrder(
        this.playOrder,
        this.playOrder.indexOf(this.lastTrickWinner)
      );
    }
  }

  getCurrentPlayerId() {
    return this.playOrder[this.currentPlayerIndex];
  }

  addChatMessage(playerId, text) {
    const trimmed = String(text ?? '').trim().slice(0, 200);
    if (!trimmed) return { error: 'Empty message' };
    const player = this.players.get(playerId);
    if (!player) return { error: 'Not in room' };

    const entry = {
      id: playerId,
      name: player.name,
      message: trimmed,
      time: Date.now(),
    };
    this.chatMessages.push(entry);
    if (this.chatMessages.length > 50) {
      this.chatMessages.shift();
    }
    return { entry };
  }

  finalizeTrickReveal() {
    if (this.status !== 'trick_reveal') return false;

    if (this.pendingAfterTrick === 'round_end') {
      this.status = 'round_end';
    } else {
      this.beginTrick();
      this.status = 'playing_trick';
    }
    this.pendingAfterTrick = null;
    return true;
  }

  playCard(playerId, cardIndex) {
    if (this.status !== 'playing_trick') {
      return { error: 'Not your turn to play' };
    }
    if (this.getCurrentPlayerId() !== playerId) {
      return { error: 'Not your turn' };
    }

    const hand = this.hands[playerId];
    if (!hand || cardIndex < 0 || cardIndex >= hand.length) {
      return { error: 'Invalid card' };
    }

    const card = hand[cardIndex];
    if (!canPlayCard(hand, card, this.leadSuit)) {
      return { error: `You must follow suit ${this.leadSuit}` };
    }

    hand.splice(cardIndex, 1);
    this.currentTrick[playerId] = card;

    if (this.leadSuit == null) {
      this.leadSuit = card.suit;
    }

    const player = this.players.get(playerId);
    const playResult = {
      playerId,
      playerName: player.name,
      card,
      trick: { ...this.currentTrick },
      leadSuit: this.leadSuit,
    };

    this.currentPlayerIndex += 1;

    if (this.currentPlayerIndex >= this.playOrder.length) {
      const winnerId = determineWinner(
        this.currentTrick,
        this.leadSuit,
        this.trumpSuit
      );
      this.wins[winnerId] = (this.wins[winnerId] ?? 0) + 1;
      this.lastTrickWinner = winnerId;
      const winner = this.players.get(winnerId);

      playResult.trickComplete = true;
      playResult.winnerId = winnerId;
      playResult.winnerName = winner.name;

      this.subround += 1;
      this.status = 'trick_reveal';

      if (this.subround > this.cardsPerPlayer) {
        this.pendingAfterTrick = 'round_end';
        this.roundResults = scoreRound(this.predictions, this.wins);
        for (const [id, r] of Object.entries(this.roundResults)) {
          this.scores[id] += r.points;
        }
        playResult.phase = 'round_end';
        playResult.roundResults = this.formatRoundResults();
      } else {
        this.pendingAfterTrick = 'next_trick';
        playResult.phase = 'playing_trick';
      }
    } else {
      playResult.nextPlayerId = this.getCurrentPlayerId();
    }

    return playResult;
  }

  formatRoundResults() {
    const out = {};
    for (const [id, r] of Object.entries(this.roundResults)) {
      const p = this.players.get(id);
      out[id] = {
        ...r,
        name: p?.name ?? 'Unknown',
      };
    }
    return out;
  }

  nextRound() {
    if (this.roundNum >= this.totalRounds) {
      this.status = 'finished';
      return { phase: 'gameOver' };
    }
    return this.startRound();
  }

  getStateForPlayer(playerId) {
    const hand = (this.hands[playerId] ?? []).map((c, i) => ({
      ...c,
      index: i,
    }));

    const trickPublic = {};
    for (const [pid, card] of Object.entries(this.currentTrick)) {
      const p = this.players.get(pid);
      trickPublic[pid] = {
        card,
        playerName: p?.name ?? '?',
      };
    }

    const predictionsPublic = {};
    for (const id of this.players.keys()) {
      const submitted = this.predictions[id] !== undefined;
      predictionsPublic[id] = {
        submitted,
        value: submitted ? this.predictions[id] : undefined,
      };
    }

    const predictionQueue = this.playOrder.map((id, index) => {
      const p = this.players.get(id);
      const submitted = this.predictions[id] !== undefined;
      return {
        id,
        name: p?.name ?? '?',
        submitted,
        value: submitted ? this.predictions[id] : undefined,
        isCurrent:
          this.status === 'predicting' &&
          index === this.predictionOrderIndex &&
          !submitted,
      };
    });

    const activePlayerId =
      this.status === 'predicting'
        ? this.getPredictionTurnPlayerId()
        : this.status === 'trick_reveal'
          ? null
          : this.getCurrentPlayerId();

    const trickWinner =
      this.status === 'trick_reveal' ? this.lastTrickWinner : null;

    return {
      code: this.code,
      status: this.status,
      roundNum: this.roundNum,
      totalRounds: this.totalRounds,
      cardsPerPlayer: this.cardsPerPlayer,
      subround: this.subround,
      hand,
      handCount: Object.fromEntries(
        [...this.players.keys()].map((id) => [
          id,
          (this.hands[id] ?? []).length,
        ])
      ),
      players: this.playerList(),
      playOrder: this.playOrder.map((id) => {
        const p = this.players.get(id);
        return { id, name: p?.name };
      }),
      currentPlayerId: activePlayerId,
      predictionTurnPlayerId: this.getPredictionTurnPlayerId(),
      predictionQueue,
      trickLeaderId: this.playOrder[0] ?? null,
      leadSuit: this.leadSuit,
      trick: trickPublic,
      predictions: predictionsPublic,
      myPrediction: this.predictions[playerId],
      wins: { ...this.wins },
      scores: { ...this.scores },
      isHost: playerId === this.hostId,
      myId: playerId,
      trumpSuit: this.trumpSuit,
      trumpName: TRUMP_NAMES[this.trumpSuit],
      trickRevealWinnerId: trickWinner,
      trickRevealWinnerName: trickWinner
        ? this.players.get(trickWinner)?.name
        : null,
      chatMessages: [...this.chatMessages],
    };
  }

  getFinalStandings() {
    return [...this.players.entries()]
      .map(([id, p]) => ({
        id,
        name: p.name,
        score: this.scores[id] ?? 0,
      }))
      .sort((a, b) => b.score - a.score);
  }

  emitToConnected(io, event, payload) {
    for (const p of this.players.values()) {
      if (p.socketId) {
        io.sockets.sockets.get(p.socketId)?.emit(event, payload);
      }
    }
  }

  emitStateToAll(io) {
    for (const p of this.players.values()) {
      if (p.socketId) {
        io.sockets.sockets
          .get(p.socketId)
          ?.emit('gameState', this.getStateForPlayer(p.id));
      }
    }
  }
}
