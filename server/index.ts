import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});

interface PlayerInfo {
  id: string;
  name: string;
  alive: boolean;
  survivalTime: number;
  score: number;
  lines: number;
}

interface Room {
  id: string;
  name: string;
  ownerId: string;
  maxPlayers: number;
  passkey: string | null;
  players: PlayerInfo[];
  status: 'waiting' | 'countdown' | 'playing';
  gameStartTime: number;
}

const rooms = new Map<string, Room>();
let playerCounter = 0;
const playerNames = new Map<string, string>();

function mkId(): string {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

function playerName(id: string): string {
  if (!playerNames.has(id)) {
    playerCounter += 1;
    playerNames.set(id, `TETRIS${playerCounter}`);
  }
  return playerNames.get(id)!;
}

function roomToClient(r: Room) {
  return {
    id: r.id,
    name: r.name,
    ownerId: r.ownerId,
    maxPlayers: r.maxPlayers,
    hasPasskey: r.passkey !== null,
    players: r.players.map(p => ({ id: p.id, name: p.name, alive: p.alive, survivalTime: p.survivalTime })),
    status: r.status,
  };
}

function getRoomList() {
  return Array.from(rooms.values()).map(r => ({
    id: r.id,
    name: r.name,
    hasPasskey: r.passkey !== null,
    playerCount: r.players.length,
    maxPlayers: r.maxPlayers,
    status: r.status,
  }));
}

function broadcastRoomList() {
  io.emit('room_list', getRoomList());
}

function findRoom(socketId: string): Room | undefined {
  return Array.from(rooms.values()).find(r => r.players.some(p => p.id === socketId));
}

function checkGameEnd(room: Room) {
  const alive = room.players.filter(p => p.alive);
  if (alive.length <= 1 && room.status === 'playing') {
    const now = Date.now();
    alive.forEach(p => { p.survivalTime = now - room.gameStartTime; });
    const result = room.players
      .map(p => ({ id: p.id, name: p.name, time: p.survivalTime, score: p.score, lines: p.lines }))
      .sort((a, b) => b.time - a.time);
    io.to(room.id).emit('game_ended', { result });
    room.status = 'waiting';
    room.gameStartTime = 0;
    room.players.forEach(p => { p.alive = true; p.survivalTime = 0; p.score = 0; p.lines = 0; });
    broadcastRoomList();
  }
}

io.on('connection', (socket) => {
  socket.emit('room_list', getRoomList());

  socket.on('get_rooms', () => {
    socket.emit('room_list', getRoomList());
  });

  socket.on('create_room', ({ name, maxPlayers, passkey }: { name: string; maxPlayers: number; passkey: string }) => {
    const id = mkId();
    const room: Room = {
      id,
      name: (name || '').trim() || `ROOM-${id}`,
      ownerId: socket.id,
      maxPlayers: Math.max(2, Math.min(100, Number(maxPlayers) || 10)),
      passkey: passkey ? passkey.trim() : null,
      players: [{ id: socket.id, name: playerName(socket.id), alive: true, survivalTime: 0, score: 0, lines: 0 }],
      status: 'waiting',
      gameStartTime: 0,
    };
    rooms.set(id, room);
    socket.join(id);
    socket.emit('room_joined', { room: roomToClient(room), myId: socket.id });
    broadcastRoomList();
  });

  socket.on('join_room', ({ roomId, passkey }: { roomId: string; passkey?: string }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('join_error', 'Room not found');
    if (room.status !== 'waiting') return socket.emit('join_error', 'Game already started');
    if (room.players.length >= room.maxPlayers) return socket.emit('join_error', 'Room is full');
    if (room.passkey && room.passkey !== (passkey || '')) return socket.emit('join_error', 'Wrong passkey');

    room.players.push({ id: socket.id, name: playerName(socket.id), alive: true, survivalTime: 0, score: 0, lines: 0 });
    socket.join(roomId);
    socket.emit('room_joined', { room: roomToClient(room), myId: socket.id });
    io.to(roomId).emit('room_updated', roomToClient(room));
    broadcastRoomList();
  });

  socket.on('leave_room', () => doLeave(socket));

  socket.on('start_game', () => {
    const room = findRoom(socket.id);
    if (!room || room.ownerId !== socket.id || room.status !== 'waiting') return;
    room.status = 'countdown';
    broadcastRoomList();
    io.to(room.id).emit('game_countdown');
    setTimeout(() => {
      if (rooms.has(room.id) && room.status === 'countdown') {
        room.status = 'playing';
        room.gameStartTime = Date.now();
        io.to(room.id).emit('game_start');
      }
    }, 4000);
  });

  socket.on('board_update', ({ board }: { board: (string | 0)[][] }) => {
    const room = findRoom(socket.id);
    if (!room || room.status !== 'playing') return;
    socket.to(room.id).emit('player_board', { playerId: socket.id, board });
  });

  socket.on('player_dead', ({ time, score, lines }: { time: number; score: number; lines: number }) => {
    const room = findRoom(socket.id);
    if (!room) return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (p) { p.alive = false; p.survivalTime = time; p.score = score; p.lines = lines; }
    io.to(room.id).emit('player_died', { playerId: socket.id, time });
    checkGameEnd(room);
  });

  socket.on('disconnect', () => doLeave(socket));

  function doLeave(s: typeof socket) {
    playerNames.delete(s.id);
    const room = findRoom(s.id);
    if (!room) return;
    room.players = room.players.filter(p => p.id !== s.id);
    s.leave(room.id);
    if (room.players.length === 0) {
      rooms.delete(room.id);
    } else {
      if (room.ownerId === s.id) room.ownerId = room.players[0].id;
      if (room.status === 'playing') checkGameEnd(room);
      io.to(room.id).emit('room_updated', roomToClient(room));
    }
    broadcastRoomList();
  }
});

if (process.env.NODE_ENV === 'production') {
  const distDir = path.join(__dirname, '../dist/public');
  app.use(express.static(distDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

const PORT = parseInt(process.env.SOCKET_PORT || '3001', 10);
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[socket-server] listening on :${PORT}`);
});
