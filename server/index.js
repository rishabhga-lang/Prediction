import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { RoomManager } from './room.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const rooms = new RoomManager();
const TRICK_REVEAL_MS = 2800;

const trickFinalizeTimers = new Map();

function scheduleTrickFinalize(room) {
  const code = room.code;
  if (trickFinalizeTimers.has(code)) {
    clearTimeout(trickFinalizeTimers.get(code));
  }
  const timer = setTimeout(() => {
    trickFinalizeTimers.delete(code);
    const current = rooms.getRoom(code);
    if (!current || current.status !== 'trick_reveal') return;

    const winnerId = current.lastTrickWinner;
    const winnerName = current.players.get(winnerId)?.name;
    const wasRoundEnd = current.pendingAfterTrick === 'round_end';

    current.finalizeTrickReveal();
    emitRoomState(current);

    io.to(code).emit('trickResolved', { winnerId, winnerName });

    if (wasRoundEnd && current.status === 'round_end') {
      io.to(code).emit('roundEnd', current.formatRoundResults());
    }
  }, TRICK_REVEAL_MS);
  trickFinalizeTimers.set(code, timer);
}

app.use(express.static(path.join(__dirname, '..', 'public')));

function emitLobby(room) {
  io.to(room.code).emit('lobbyUpdate', {
    code: room.code,
    players: room.playerList(),
    status: room.status,
    hostId: room.hostId,
  });
}

function emitRoomState(room) {
  room.emitStateToAll(io);
}

function sendJoined(socket, room, playerId) {
  socket.emit('joined', {
    roomCode: room.code,
    playerId,
    playerToken: playerId,
    isHost: playerId === room.hostId,
    status: room.status,
  });
}

function afterJoin(socket, room, playerId) {
  socket.join(room.code);
  sendJoined(socket, room, playerId);
  socket.emit('chatHistory', room.chatMessages);
  if (room.status === 'lobby') {
    emitLobby(room);
  } else {
    socket.emit('gameState', room.getStateForPlayer(playerId));
    room.emitStateToAll(io);
  }
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, playerToken }) => {
    if (!playerToken) {
      socket.emit('error', { message: 'Missing player token' });
      return;
    }
    const room = rooms.createRoom(socket.id, name, playerToken);
    afterJoin(socket, room, playerToken);
  });

  socket.on('joinRoom', ({ code, name, playerToken }) => {
    if (!playerToken) {
      socket.emit('error', { message: 'Missing player token' });
      return;
    }
    const result = rooms.joinRoom(code, socket.id, name, playerToken);
    if (result.error) {
      socket.emit('error', { message: result.error });
      return;
    }
    const room = rooms.getRoom(code);
    afterJoin(socket, room, playerToken);
    if (!result.reconnected) {
      io.to(room.code).emit('playerJoined', {
        name: room.getPlayer(playerToken).name,
      });
    }
  });

  socket.on('rejoinRoom', ({ code, playerToken }) => {
    if (!playerToken) {
      socket.emit('error', { message: 'Missing player token' });
      return;
    }
    const result = rooms.rejoinRoom(code, socket.id, playerToken);
    if (result.error) {
      socket.emit('sessionExpired', { message: result.error });
      return;
    }
    const room = rooms.getRoom(code);
    afterJoin(socket, room, playerToken);
  });

  socket.on('leaveRoom', () => {
    const room = rooms.leaveRoom(socket.id);
    socket.leave(room?.code ?? '');
    socket.emit('leftRoom');
    if (room && room.players.size > 0) {
      emitLobby(room);
      emitRoomState(room);
    }
  });

  socket.on('startGame', () => {
    const room = rooms.getRoomBySocket(socket.id);
    const token = room?.getTokenBySocket(socket.id);
    if (!room || token !== room.hostId) {
      socket.emit('error', { message: 'Only the host can start' });
      return;
    }
    const result = room.startGame();
    if (result.error) {
      socket.emit('error', { message: result.error });
      return;
    }
    emitRoomState(room);
  });

  socket.on('submitPrediction', ({ value }) => {
    const room = rooms.getRoomBySocket(socket.id);
    const token = room?.getTokenBySocket(socket.id);
    if (!room || !token) return;
    const result = room.submitPrediction(token, value);
    if (result.error) {
      socket.emit('error', { message: result.error });
      return;
    }
    emitRoomState(room);
  });

  socket.on('playCard', ({ cardIndex }) => {
    const room = rooms.getRoomBySocket(socket.id);
    const token = room?.getTokenBySocket(socket.id);
    if (!room || !token) return;
    const result = room.playCard(token, cardIndex);
    if (result.error) {
      socket.emit('error', { message: result.error });
      return;
    }

    io.to(room.code).emit('cardPlayed', {
      playerId: result.playerId,
      playerName: result.playerName,
      card: result.card,
      trickComplete: result.trickComplete,
      winnerId: result.winnerId,
      winnerName: result.winnerName,
    });

    emitRoomState(room);

    if (result.trickComplete) {
      scheduleTrickFinalize(room);
    }
  });

  socket.on('chatMessage', ({ message }) => {
    const room = rooms.getRoomBySocket(socket.id);
    const token = room?.getTokenBySocket(socket.id);
    if (!room || !token) return;

    const result = room.addChatMessage(token, message);
    if (result.error) {
      socket.emit('error', { message: result.error });
      return;
    }

    io.to(room.code).emit('chatMessage', result.entry);
  });

  socket.on('nextRound', () => {
    const room = rooms.getRoomBySocket(socket.id);
    const token = room?.getTokenBySocket(socket.id);
    if (!room || token !== room.hostId) return;
    const result = room.nextRound();
    if (result.phase === 'gameOver') {
      io.to(room.code).emit('gameOver', {
        standings: room.getFinalStandings(),
      });
    }
    emitRoomState(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.disconnectSocket(socket.id);
    if (room && room.players.size > 0) {
      emitLobby(room);
      emitRoomState(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Trick Prediction Game running at http://localhost:${PORT}`);
});
