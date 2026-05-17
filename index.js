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

app.use(express.static(path.join(__dirname, '..', 'public')));

function emitRoomState(room) {
  for (const [socketId] of room.players) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit('gameState', room.getStateForPlayer(socketId));
    }
  }
}

function emitLobby(room) {
  io.to(room.code).emit('lobbyUpdate', {
    code: room.code,
    players: room.playerList(),
    status: room.status,
    hostId: room.hostId,
  });
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name }) => {
    const room = rooms.createRoom(socket.id, name);
    socket.join(room.code);
    socket.emit('joined', {
      roomCode: room.code,
      playerId: socket.id,
      isHost: true,
    });
    emitLobby(room);
  });

  socket.on('joinRoom', ({ code, name }) => {
    const result = rooms.joinRoom(code, socket.id, name);
    if (result.error) {
      socket.emit('error', { message: result.error });
      return;
    }
    const room = rooms.getRoom(code);
    socket.join(room.code);
    socket.emit('joined', {
      roomCode: room.code,
      playerId: socket.id,
      isHost: socket.id === room.hostId,
    });
    emitLobby(room);
    io.to(room.code).emit('playerJoined', {
      name: room.getPlayer(socket.id).name,
    });
  });

  socket.on('startGame', () => {
    const room = rooms.getRoomBySocket(socket.id);
    if (!room || socket.id !== room.hostId) {
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
    if (!room) return;
    const result = room.submitPrediction(socket.id, value);
    if (result.error) {
      socket.emit('error', { message: result.error });
      return;
    }
    emitRoomState(room);
  });

  socket.on('playCard', ({ cardIndex }) => {
    const room = rooms.getRoomBySocket(socket.id);
    if (!room) return;
    const result = room.playCard(socket.id, cardIndex);
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

    if (result.phase === 'round_end') {
      io.to(room.code).emit('roundEnd', result.roundResults);
    }
  });

  socket.on('nextRound', () => {
    const room = rooms.getRoomBySocket(socket.id);
    if (!room || socket.id !== room.hostId) return;
    const result = room.nextRound();
    if (result.phase === 'gameOver') {
      io.to(room.code).emit('gameOver', {
        standings: room.getFinalStandings(),
      });
    }
    emitRoomState(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.removePlayer(socket.id);
    if (room) {
      if (room.players.size === 0) return;
      emitLobby(room);
      emitRoomState(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Trick Prediction Game running at http://localhost:${PORT}`);
});
