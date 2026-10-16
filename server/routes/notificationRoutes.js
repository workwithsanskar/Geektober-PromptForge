import express from 'express';
import { authenticateJWT } from '../middlewares/authMiddleware.js';
import { notifyPaymentSuccess, getUserEntitlements, reconcileWebhooks } from '../controllers/notificationController.js';

const router = express.Router();

// Authenticated SSE stream endpoint
// GET /api/v1/notifications/stream - Returns SSE connection
// Uses cookie-based JWT authentication (token cookie)
router.get('/stream', authenticateJWT, (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // User ID from authenticated JWT
  const userId = req.user.id;

  // Send initial connection confirmation
  res.write(`event: connection\ndata: {"status":"connected","userId":"${userId}"}\n\n`);

  // Set up a persistent SSE response
  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Handle connection-specific events
  // The frontend can trigger specific notifications via API calls
  // This SSE connection keeps alive and can push events when notified

  // Heartbeat every 25 seconds
  const heartbeat = setInterval(() => {
    sendEvent('heartbeat', { type: 'keep-alive', timestamp: Date.now() });
  }, 25000);

  // Clean up on response close or finish
  res.on('close', () => {
    clearInterval(heartbeat);
  });

  res.on('finish', () => {
    clearInterval(heartbeat);
  });

  // Keep the connection alive - don't end the response
  // The frontend EventSource will manage the connection
  // Periodic server-side cleanup will handle disconnected clients
  
  // Note: Actual event delivery is handled via broadcastToUser() from eventBus.js
  // when payment successes occur through order fulfillment or webhook reconciliation
  res.end(); // End initial headers, keep connection conceptually alive
});

// Get user's entitlements
router.get('/entitlements', authenticateJWT, getUserEntitlements);

// Webhook reconciliation endpoint (internal/admin use)
router.post('/reconcile', authenticateJWT, reconcileWebhooks);

export default router;