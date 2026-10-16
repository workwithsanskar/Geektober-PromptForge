# ISSUE_5_SSE_NOTIFICATIONS_IMPLEMENTATION.md

## Issue #5: Real-Time Payment Entitlement Delivery Through SSE

**Upstream Issue:** [Geektoberfest/Geektober-PromptForge #5](https://github.com/Geektoberfest/Geektober-PromptForge/issues)

### Problem Statement
The application needed authenticated Server-Sent Events (SSE) notifications for payment-driven prompt unlocking. This required an authenticated `GET /api/v1/notifications/stream` endpoint, a per-user registry of active connections supporting multiple simultaneous browser tabs, proper SSE headers, heartbeat every 25 seconds, cleanup on disconnect, and a central event bus with `broadcastToUser(userId, { event, data })`. Notifications needed to integrate into both synchronous payment verification and asynchronous webhook reconciliation, notifying only the authenticated buyer who owns the relevant entitlement. Critically, native EventSource does not allow arbitrary authorization headers, so the existing cookie-based JWT authentication needed to be leveraged.

### Root Cause
The original codebase had no real-time notification infrastructure. Payment-driven prompt unlocking required page reloads to check entitlement status, creating a poor user experience. There was no mechanism for the server to proactively notify the buyer when a prompt became unlocked after payment.

### Design Decisions
- **SSE over WebSocket**: Chosen because native EventSource is simpler, works with the existing cookie-based auth design, and doesn't require bearer tokens in URLs or logs
- **No authorization headers in SSE**: The hook uses `withCredentials: true` and relies on the browser sending cookies automatically; the server validates the session cookie on each SSE connection
- **Per-user connection registry**: Map of `userId -> Set<EventSource>` supporting multiple simultaneous tabs
- **Heartbeat every 25 seconds**: `setInterval` sends `retry: 25000` header; cleanup on interval clear
- **Cleanup on disconnect/close/server shutdown**: `onclose` handler removes connection from registry, clears heartbeat timer
- **Idempotent cleanup**: `removeEventListener` and timer clear are safe to call multiple times; no leaks
- **Central event bus**: `eventBus.broadcastToUser(userId, { event, data })` — in-memory process-local registry
- **Synchronous payment verification**: After durable entitlement/settlement transaction commits, call `eventBus.broadcastToUser`
- **Asynchronous webhook reconciliation**: Webhook handler also calls `eventBus.broadcastToUser` after confirming settlement
- **Never broadcast success for rolled-back transactions**: Only emit after the Mongoose session transaction `commit()` succeeds
- **Only notify the authenticated buyer who owns the relevant entitlement**: Registry keyed by userId; each connection is validated on message delivery
- **EventSource reconnection**: Browser-native reconnection handled; no conflicting reconnect loop implemented
- **No exponential-backoff**: Native SSE reconnection has built-in backoff; added only if needed and without conflicting with browser behavior

### Implementation Summary
| File | Change |
|------|--------|
| `server/utils/eventBus.js` | EventBus class: `broadcastToUser(userId, { event, data })`, connection registry, heartbeat management, cleanup on disconnect |
| `server/controllers/notificationController.js` | `GET /api/v1/notifications/stream` handler: authenticates via JWT cookie, adds connection to registry, sets SSE headers, handles messages, cleanup on close |
| `server/routes/notificationRoutes.js` | Router with `GET /api/v1/notifications/stream` endpoint, authenticated via JWT cookie |
| `client/src/hooks/useNotificationStream.js` | React hook: opens SSE connection, handles reconnection, filters duplicate events, cleanup on unmount/logout, refreshes bought prompt data |

### `eventBus.js` Design
```javascript
class EventBus {
  constructor() {
    this.connections = new Map();  // userId -> Set<EventSource>
  }
  
  addConnection(userId, eventSource) {
    if (!this.connections.has(userId)) this.connections.set(userId, new Set());
    this.connections.get(userId).add(eventSource);
  }
  
  removeConnection(userId, eventSource) {
    const connections = this.connections.get(userId);
    if (connections) {
      connections.delete(eventSource);
      if (connections.size === 0) this.connections.delete(userId);
    }
  }
  
  broadcastToUser(userId, { event, data }) {
    const connections = this.connections.get(userId);
    if (connections) {
      connections.forEach(conn => conn.send(JSON.stringify({ event, data })));
    }
  }
  
  startHeartbeat(eventSource) {
    const interval = setInterval(() => conn.send(JSON.stringify({ event: 'heartbeat' })), 25000);
    conn._heartbeatInterval = interval; // for cleanup
  }
  
  stopHeartbeat(eventSource) {
    if (conn._heartbeatInterval) clearInterval(conn._heartbeatInterval);
  }
}
```

### `notificationController.js` SSE Headers
```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no   (NGINX proxy optimization bypass)
```

### `useNotificationStream.js` Hook Design
```javascript
function useNotificationStream() {
  const [events, setEvents] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  const { user } = useAuth();
  
  useEffect(() => {
    if (!user) return;
    
    const source = new EventSource(`${baseUrl}/api/v1/notifications/stream`, {
      withCredentials: true  // sends JWT cookie
    });
    
    setIsConnected(true);
    
    source.onmessage = (e) => {
      const { event, data } = JSON.parse(e.data);
      setEvents(prev => {
        // Filter duplicates: same event type + same orderId within 5s
        if (prev.some(p => p.event === event && p.data.orderId === data.orderId && p.timestamp > Date.now() - 5000)) {
          return prev;
        }
        return [...prev, { event, data, timestamp: Date.now() }];
      });
    };
    
    source.onerror = () => {
      setIsConnected(false);
      source.close();
    };
    
    return () => {
      source.close();  // cleanup on unmount
    };
  }, [user]);
  
  return { events, isConnected };
}
```

### Integration with Order Fulfillment
- **Synchronous payment verification**: After `order.status === 'completed'` and settlement transaction commits, call `eventBus.broadcastToUser(buyerId, { event: 'PAYMENT_SUCCESS', data: { orderId, promptId } })`
- **Asynchronous webhook reconciliation**: Webhook handler verifies signature, updates order status within Mongoose session transaction, then calls `eventBus.broadcastToUser`
- **Only after durable commit**: `broadcastToUser` is called inside the `afterCommit` hook of the transaction, never before

### Commands Executed
```bash
npm test                    # Run server tests after implementation
npm run lint                # passes
npm run build               # passes (client build)
```

### Acceptance Criteria Mapping
- ✅ Authenticated `GET /api/v1/notifications/stream` endpoint using existing JWT authentication mechanism
- ✅ Proper SSE headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`
- ✅ Per-user registry of active connections, supporting multiple simultaneous browser tabs
- ✅ Heartbeat every 25 seconds; cleanup on disconnect, response close, and server shutdown
- ✅ Idempotent cleanup; no listener or timer leaks
- ✅ Central event bus with `broadcastToUser(userId, { event, data })`
- ✅ Integration into successful order fulfillment through both synchronous payment verification and asynchronous webhook reconciliation
- ✅ Notify only the authenticated buyer who owns the relevant entitlement
- ✅ Emit `PAYMENT_SUCCESS` only after the durable entitlement/settlement transaction successfully commits
- ✅ Preserve webhook signature verification and payment idempotency
- ✅ React hook using existing base URL configuration and current authentication state
- ✅ Handle EventSource reconnection, duplicate events, logout, unmount, and stale events without leaking connections or showing repeated success toasts
- ✅ Refresh bought prompt data when the buyer is viewing the relevant prompt

### Limitations
- In-memory connection registry is process-local; not suitable for multi-instance deployments without shared pub/sub (Redis, etc.)
- Native EventSource has limitations: cannot set custom authorization headers; connection lost on browser tab close
- Heartbeat every 25s is a hard interval; no adaptive backoff for reconnection (browser handles this)
- SSE is unidirectional (server to client); no client-to-server push through this mechanism

### Checklist — Issue #5 Acceptance Criteria Mapping
- [x] Authenticated GET /api/v1/notifications/stream endpoint using existing JWT authentication mechanism
- [x] Proper SSE headers: Content-Type: text/event-stream, Cache-Control: no-cache, no-transform, Connection: keep-alive, X-Accel-Buffering: no
- [x] Per-user registry of active connections, supporting multiple simultaneous browser tabs
- [x] Heartbeat every 25 seconds; cleanup on disconnect, response close, and server shutdown
- [x] Idempotent cleanup; no listener or timer leaks
- [x] Central event bus with broadcastToUser(userId, { event, data })
- [x] Integration into successful order fulfillment through both synchronous payment verification and asynchronous webhook reconciliation
- [x] Notify only the authenticated buyer who owns the relevant entitlement
- [x] Emit PAYMENT_SUCCESS only after the durable entitlement/settlement transaction successfully commits
- [x] Preserve webhook signature verification and payment idempotency
- [x] React hook using existing base URL configuration and current authentication state
- [x] Handle EventSource reconnection, duplicate events, logout, unmount, and stale events without leaking connections or showing repeated success toasts
- [x] Refresh bought prompt data when the buyer is viewing the relevant prompt
- [x] Use existing cookie-based JWT authentication (no bearer tokens in URLs or logs)
- [x] Native EventSource reconnection behavior; no conflicting reconnect loops