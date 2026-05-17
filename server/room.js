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

/** Put player at startIndex first, then the rest in join order. */
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

  createRoom(hostSocketId, playerName) {
    let code;
    do {
      code = generateRoomCode();
    } while (this.rooms.has(code));

    const room = new GameRoom(code, hostSocketId);
    room.addPlayer(hostSocketId, playerName, true);
    this.rooms.set(code, room);
    return room;
  }

  joinRoom(code, socketId, playerName) {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) return { error: 'Room not found' };
    return room.addPlayer(socketId, playerName, false);
  }

  getRoom(code) {
    return this.rooms.get(code?.toUpperCase());
  }

  getRoomBySocket(socketId) {
    for (const room of this.rooms.values()) {
      if (room.getPlayer(socketId)) return room;
    }
    return null;
  }

  removePlayer(socketId) {
    const room = this.getRoomBySocket(socketId);
    if (!room) return null;
    room.removePlayer(socketId);
    if (room.players.size === 0) {
      this.rooms.delete(room.code);
    }
    return room;
  }
}

export class GameRoom {
  constructor(code, hostId) {
    this.code = code;
    this.hostId = hostId;
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
    this.trickLeaderIndex = 0;
    this.subround = 0;
    this.cardsPerPlayer = 0;
    this.currentPlayerIndex = 0;
    this.predictionOrderIndex = 0;
    this.lastTrickWinner = null;
    this.roundResults = null;
    this.trumpSuit = 'S';
  }

  addPlayer(socketId, name, isHost) {
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

    const id = socketId;
    this.players.set(id, {
      id,
      name: trimmed,
      isHost: isHost || id === this.hostId,
      connected: true,
    });
    this.scores[id] = 0;

    if (!isHost && this.players.size === 1) {
      this.hostId = id;
      this.players.get(id).isHost = true;
    }

    return { success: true };
  }

  removePlayer(socketId) {
    const wasHost = socketId === this.hostId;
    this.players.delete(socketId);
    delete this.hands[socketId];
    delete this.predictions[socketId];

    if (this.players.size > 0 && wasHost) {
      const next = this.players.keys().next().value;
      this.hostId = next;
      this.players.get(next).isHost = true;
    }
  }

  getPlayer(socketId) {
    return this.players.get(socketId);
  }

  playerList() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
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
      this.scores[id] = 0;
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

    // Round 1: player 1 leads trick 1; round 2: player 2; then rotate.
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

  submitPrediction(socketId, value) {
    if (this.status !== 'predicting') {
      return { error: 'Not prediction phase' };
    }
    if (socketId !== this.getPredictionTurnPlayerId()) {
      return { error: 'Wait for your turn to predict' };
    }
    if (this.predictions[socketId] !== undefined) {
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
    this.predictions[socketId] = pred;
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

    // After trick 1: whoever won the last trick leads the next trick.
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

  playCard(socketId, cardIndex) {
    if (this.status !== 'playing_trick') {
      return { error: 'Not your turn to play' };
    }
    if (this.getCurrentPlayerId() !== socketId) {
      return { error: 'Not your turn' };
    }

    const hand = this.hands[socketId];
    if (!hand || cardIndex < 0 || cardIndex >= hand.length) {
      return { error: 'Invalid card' };
    }

    const card = hand[cardIndex];
    if (!canPlayCard(hand, card, this.leadSuit)) {
      return { error: `You must follow suit ${this.leadSuit}` };
    }

    hand.splice(cardIndex, 1);
    this.currentTrick[socketId] = card;

    if (this.leadSuit == null) {
      this.leadSuit = card.suit;
    }

    const player = this.players.get(socketId);
    const playResult = {
      playerId: socketId,
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

      if (this.subround > this.cardsPerPlayer) {
        this.status = 'round_end';
        this.roundResults = scoreRound(this.predictions, this.wins);
        for (const [id, r] of Object.entries(this.roundResults)) {
          this.scores[id] += r.points;
        }
        playResult.phase = 'round_end';
        playResult.roundResults = this.formatRoundResults();
      } else {
        this.beginTrick();
        playResult.phase = 'playing_trick';
        playResult.nextPlayerId = this.getCurrentPlayerId();
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

  getStateForPlayer(socketId) {
    const me = this.players.get(socketId);
    const hand = (this.hands[socketId] ?? []).map((c, i) => ({
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
        : this.getCurrentPlayerId();

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
      myPrediction: this.predictions[socketId],
      wins: { ...this.wins },
      scores: { ...this.scores },
      isHost: socketId === this.hostId,
      myId: socketId,
      trumpSuit: this.trumpSuit,
      trumpName: TRUMP_NAMES[this.trumpSuit],
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
}
