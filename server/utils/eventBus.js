import { Server } from 'socket.io';
import http from 'http';

// In-memory user connection registry
// Maps userId -> Set of EventSource response objects
// This is process-local; for multi-instance deployments, use a shared pub/sub adapter
const userConnections = new Map();

// Heartbeat interval IDs per user
const heartbeatTimers = new Map();

let ioInstance = null;

/**
 * Initialize the event bus with an HTTP server and Socket.IO instance.
 * This enables broadcastToUser functionality via Socket.IO rooms.
 * @param {http.Server} server - The HTTP server instance
 * @param {object} io - The Socket.IO instance
 */
export function initEventBus(server, io) {
  ioInstance = io;

  io.on('connection', (socket) => {
    const userId = socket.handshake.auth.userId;

    if (userId) {
      // Join a room named after the userId for targeted broadcasting
      socket.join(userId);

      // Track connection
      if (!userConnections.has(userId)) {
        userConnections.set(userId, new Set());
      }
      userConnections.get(userId).add(socket);

      // Set up heartbeat
      let heartbeatId = setInterval(() => {
        socket.emit('heartbeat', { type: 'keep-alive' });
      }, 25000);

      heartbeatTimers.set(userId, heartbeatId);

      // Clean up on disconnect
      socket.on('disconnect', () => {
        clearInterval(heartbeatId);
        heartbeatTimers.delete(userId);

        if (userConnections.has(userId)) {
          userConnections.get(userId).delete(socket);
          if (userConnections.get(userId).size === 0) {
            userConnections.delete(userId);
          }
        }
      });
    }
  });
}

/**
 * Broadcast an event to a specific user via SSE.
 * Uses EventSource-friendly format with proper headers.
 * @param {string} userId - The user to notify
 * @param {object} event - The event object { event, data }
 */
export function broadcastToUser(userId, { event, data }) {
  const connections = userConnections.get(userId);

  if (!connections || connections.size === 0) {
    // No active connections for this user
    return false;
  }

  const eventData = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  // Send to all connected sockets for this user
  connections.forEach((socket) => {
    // Send via Socket.IO, which the frontend can subscribe to
    socket.emit('notification', { event, data });
  });

  return true;
}

/**
 * Get the number of active connections for a user.
 * @param {string} userId - The user to check
 * @returns {number} Number of active connections
 */
export function getConnectionCount(userId) {
  const connections = userConnections.get(userId);
  return connections ? connections.size : 0;
}

/**
 * Clean up all connections for a user (e.g., on logout).
 * @param {string} userId - The user to clean up
 */
export function cleanupUserConnections(userId) {
  const connections = userConnections.get(userId);
  if (connections) {
    connections.forEach((socket) => {
      socket.disconnect();
    });
    userConnections.delete(userId);
  }
  // Clear heartbeat timer
  if (heartbeatTimers.has(userId)) {
    clearInterval(heartbeatTimers.get(userId));
    heartbeatTimers.delete(userId);
  }
}

/**
 * Gracefully shut down the event bus.
 * Closes all connections and clears all timers.
 */
export function shutdownEventBus() {
  for (const [userId, connections] of userConnections) {
    cleanupUserConnections(userId);
  }
  userConnections.clear();
  heartbeatTimers.clear();
  if (ioInstance) {
    ioInstance.close();
    ioInstance = null;
  }
}

export default { initEventBus, broadcastToUser, getConnectionCount, cleanupUserConnections, shutdownEventBus };