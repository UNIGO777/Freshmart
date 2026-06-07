require('dotenv').config();

process.on('unhandledRejection', (reason) => {
  require('../../shared/utils/logger').error('Unhandled rejection:', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  if (err.type === 'request.aborted' || err.message === 'request aborted') return;
  require('../../shared/utils/logger').error('Uncaught exception:', err);
  process.exit(1);
});
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const logger = require('../../shared/utils/logger');
const { customerRoom, vendorRoom, riderRoom } = require('./rooms');
const { registerOrderTracking } = require('./handlers/orderTracking.handler');
const { registerRiderLocation } = require('./handlers/riderLocation.handler');

const PORT = process.env.PORT_SOCKET || 3010;

// ── Express app for internal HTTP endpoints ───────────────────────
const app = express();
app.use(express.json({ limit: '10kb' }));

const httpServer = http.createServer(app);

// ── Socket.io server ──────────────────────────────────────────────
// ALLOWED_ORIGINS env var: comma-separated list of trusted origins.
// Falls back to '*' only in development so local clients can connect.
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : (process.env.NODE_ENV === 'production' ? [] : '*');

const io = new Server(httpServer, {
  cors: { origin: allowedOrigins, methods: ['GET', 'POST'], credentials: true },
  transports: ['websocket', 'polling'],
});

// ── JWT authentication middleware ─────────────────────────────────
io.use((socket, next) => {
  // Token can come from handshake.auth.token or query param (for older clients)
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('Authentication required'));

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = payload; // { id, role, ... }
    next();
  } catch {
    next(new Error('Invalid or expired token'));
  }
});

// ── Connection handler ────────────────────────────────────────────
io.on('connection', (socket) => {
  const { id: userId, role } = socket.user;
  logger.info(`Socket connected: ${socket.id} (${role}:${userId})`);

  // Each user joins their own identity room so other services can emit to them by ID
  switch (role) {
    case 'customer':
      socket.join(customerRoom(userId));
      socket.join('serviceability:broadcast'); // real-time vendor availability updates
      break;
    case 'vendor':   socket.join(vendorRoom(userId));   break;
    case 'rider':    socket.join(riderRoom(userId));    break;
    case 'admin':    socket.join('admin:panel');        break;
    default: break;
  }

  // All roles can join/leave order tracking rooms
  registerOrderTracking(io, socket);

  // Riders send real-time location updates via socket
  if (role === 'rider') {
    registerRiderLocation(io, socket, { riderId: userId });
  }

  socket.on('disconnect', async (reason) => {
    logger.info(`Socket disconnected: ${socket.id} (${role}:${userId}) — ${reason}`);

    // Auto-offline vendors when they disconnect (app killed / network lost)
    if (role === 'vendor') {
      try {
        const axios = require('axios');
        const USER_URL = `http://localhost:${process.env.PORT_USER || 3002}`;
        await axios.patch(
          `${USER_URL}/set-offline`,
          { vendorId: userId },
          { headers: { 'x-internal-secret': process.env.INTERNAL_SECRET || 'internal' }, timeout: 5000 },
        );
        logger.info(`Vendor ${userId} auto-set offline on disconnect`);
      } catch (err) {
        logger.warn(`Failed to auto-offline vendor ${userId}: ${err.message}`);
      }
    }
  });

  socket.on('error', (err) => {
    logger.error(`Socket error for ${socket.id}: ${err.message}`);
  });
});

// ── Internal HTTP: POST /internal/emit ───────────────────────────
// Used by all other services to emit real-time events to clients.
// Body: { room: string, event: string, payload: any }
app.post('/internal/emit', (req, res) => {
  const { room, event, payload } = req.body;
  if (!room || !event) {
    return res.status(400).json({ success: false, message: 'room and event are required' });
  }

  io.to(room).emit(event, payload ?? {});
  logger.debug(`[internal/emit] → room="${room}" event="${event}"`);
  return res.json({ success: true });
});

// ── Internal HTTP: POST /internal/emit-many ───────────────────────
// Emit the same event to multiple rooms in one call.
// Body: { rooms: string[], event: string, payload: any }
app.post('/internal/emit-many', (req, res) => {
  const { rooms, event, payload } = req.body;
  if (!Array.isArray(rooms) || !event) {
    return res.status(400).json({ success: false, message: 'rooms[] and event are required' });
  }

  for (const room of rooms) {
    io.to(room).emit(event, payload ?? {});
  }
  logger.debug(`[internal/emit-many] → rooms=${rooms.join(',')} event="${event}"`);
  return res.json({ success: true });
});

// ── 404 (HTTP side only — socket errors handled separately) ───────
app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found', errorCode: 'NOT_FOUND' }));

// ── Health ────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    success: true,
    service: 'socket',
    connections: io.engine.clientsCount,
    timestamp: new Date().toISOString(),
  });
});

httpServer.listen(PORT, () => {
  logger.info(`Socket Server running on port ${PORT}`);
});

module.exports = { io, app };
