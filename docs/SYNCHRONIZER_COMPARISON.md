# Croquet Synchronizer Comparison: Original Reflector vs Cloudflare Workers

This document provides a systematic comparison between the original Node.js Reflector (`packages/reflector/reflector.js`) and the Cloudflare Workers Synchronizer (`workers/synchronizer/`).

> **Status**: Updated 2024-12-02 - Critical gaps have been addressed with registry integration.

## Executive Summary

The CF Workers Synchronizer now replicates all core session management functionality:

| Feature | Original Reflector | CF Workers | Gap Severity |
|---------|-------------------|------------|--------------|
| WebSocket sessions | Full | Full | None |
| Message ordering/timestamping | Full | Full | None |
| Snapshot persistence | Full (GCS/R2) | Full (R2) | None |
| Session persistence (indefinite) | Full | Full | None |
| Session registration (monitoring) | Full | Full (Fixed) | None |
| API key stats tracking | Full | Full (Fixed) | None |
| Dispatcher integration | Full | N/A (different architecture) | Low |
| DePIN support | Full | Not implemented | Medium |

---

## 1. Session Lifecycle

### 1.1 Session Registration with Central Registry

**Original Reflector** (`registerSession`, line 3798):
```javascript
function registerSession(sessionId) {
    // Records session in ALL_SESSIONS map
    // Creates dispatcher record in GCS bucket
    // Sets up deregistration timeout if no JOIN arrives
    const session = {
        stage: 'runnable',
        earliestDeregister,
        reconnectDelay: 0,
        logger: empty_logger.child({...})
    };
    ALL_SESSIONS.set(sessionId, session);
    scheduleShutdownIfNoJoin(sessionId, earliestDeregister, "no JOIN in time");
}
```
- Sessions are tracked centrally in memory (`ALL_SESSIONS` map)
- Dispatcher records written to GCS bucket for load balancing
- Monitoring systems can query session status

**CF Workers Synchronizer** (Fixed):
- Sessions exist within their Durable Object instance
- Now calls registry `/register` on first client join
- Now calls registry `/unregister` when session becomes empty
- Sends periodic heartbeats to keep session visible in registry (TTL refresh)

**FIXED**: The synchronizer now calls registry `/register` and `/unregister`

### 1.2 Session Deregistration

**Original Reflector** (`deregisterSession`, line 3557):
```javascript
async function deregisterSession(id, detail) {
    const session = ALL_SESSIONS.get(id);
    session.stage = 'closed';
    // Delete dispatcher record from GCS
    await DISPATCHER_BUCKET.file(filename).delete();
    ALL_SESSIONS.delete(id);
}
```
- Cleans up dispatcher records
- Updates session stage to 'closed'
- Removes from memory

**CF Workers Synchronizer** (Fixed):
- Sets alarm for cleanup after timeout
- State persists indefinitely in DO storage (correct for session resumability)
- Now calls `/unregister` when session becomes empty (removes from monitoring UI)

### 1.3 Session Persistence and Resumability

Both systems support indefinite session persistence:

**Original Reflector**:
- Stores `latest.json` in GCS with session state
- On first JOIN, fetches `latest.json` to resume
- Snapshots stored in cloud storage

**CF Workers Synchronizer** (lines 343-354):
```typescript
if (this.storage) {
  const latest = await this.storage.loadLatest()
  if (latest) {
    snapshot = latest.data
    snapshotTime = latest.meta.time
    snapshotSeq = latest.meta.seq
  }
}
```
- State stored in DO transactional storage
- Snapshots stored in R2
- Can resume sessions after weeks/months of inactivity

**NO GAP**: Both systems support indefinite session resumability.

---

## 2. Client Connection Lifecycle

### 2.1 JOIN Handling

**Original Reflector** (`JOIN`, line 2257):
```javascript
async function JOIN(client, args) {
    // Stage management
    session.stage = 'running';
    clearTimeout(session.timeout);

    // API key verification
    const apiResponse = await verifyApiKey(apiKey, url, ...);

    // Create island if first client
    if (!island) {
        island = { id, name, version, time: 0, seq: INITIAL_SEQ, ... };
        ALL_ISLANDS.set(id, island);
    }

    // Add to sync queue, wait for snapshot
    island.syncClients.push(client);

    // Load latest.json if needed
    if (island.yetToCheckLatest) {
        const latestSpec = await fetchJSON(`${id}/latest.json`);
        // Apply saved state
    }

    SYNC(island);
}
```

**CF Workers Synchronizer** (`handleJoin`, line 287):
```typescript
private async handleJoin(ws: WebSocket, attachment: WSAttachment, args: Record<string, unknown>): Promise<void> {
    attachment.userId = args.user as string | undefined
    attachment.joined = true

    // Initialize state if first client
    if (!this.state) {
        this.state = { id, time: 0, seq: 0, ... };
        await this.ctx.storage.put('state', this.state)
    }

    // Load snapshot from R2
    if (this.storage) {
        const latest = await this.storage.loadLatest()
    }

    // Send SYNC
    ws.send(JSON.stringify(syncResponse))

    // Mark active AFTER SYNC (fixed in recent update)
    attachment.active = true
}
```

**GAP**: No API key stats update on JOIN (see section 3)

### 2.2 Client Active State

**Original Reflector** (`announceUserJoined`, line 2631):
```javascript
function announceUserJoined(client) {
    if (!island || !client.user || client.active === true) return;
    client.active = true;  // Set AFTER SYNC is sent
    // ...
    scheduleUsersMessage(island);
}
```

**CF Workers Synchronizer** (lines 442-446):
```typescript
ws.send(JSON.stringify(syncResponse))
// Mark client as active AFTER SYNC is sent (matches original reflector)
attachment.active = true
ws.serializeAttachment(attachment)
```

**NO GAP**: Both correctly set `active` after SYNC is sent.

### 2.3 Client Leave Handling

**Original Reflector** (`clientLeft`, line 2614):
```javascript
function clientLeft(client, reason='') {
    const island = ALL_ISLANDS.get(client.sessionId);
    island.clients.delete(client);
    if (remaining === 0) provisionallyDeleteIsland(island);
    announceUserLeft(client);
}
```

**CF Workers Synchronizer** (`webSocketClose`, line 225):
```typescript
async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    if (attachment?.active && userId) {
        this.queueUserLeave(userId)
    }

    // Check if session is now empty
    const remaining = this.ctx.getWebSockets().length
    if (remaining === 0) {
        await this.ctx.storage.setAlarm(Date.now() + timeoutMs)
    }
}
```

**GAP**: No call to registry `/unregister` when session becomes empty.

---

## 3. API Key Statistics Tracking

### 3.1 Stats Update Mechanism

**Original Reflector** (`verifyApiKey`):
- Calls API server to verify key
- API server updates `lastUsed` and `totalRequests`
- Stats visible in management UI

**Registry** (`validateApiKey`, lines 89-98):
```typescript
const updated: ApiKeyRecord = {
    ...record,
    lastUsed: Date.now(),
    stats: {
        totalRequests: (record.stats?.totalRequests || 0) + 1,
        totalSessions: record.stats?.totalSessions || 0,
    },
}
env.APIKEYS.put(`key:${apiKey}`, JSON.stringify(updated))
```

**CF Workers Synchronizer** (Fixed):
- API key validated in `handleClientsJoin` (index.ts line 125)
- Production: Calls registry service binding which updates stats
- Local dev: Calls registry HTTP endpoint which updates stats
- Standalone: Now updates stats directly in KV (same as registry behavior)

**FIXED**: API key stats (lastUsed, totalRequests) now updated in all modes

---

## 4. User Presence (USERS Messages)

### 4.1 View Counting

**Original Reflector** (`USERS`, line 3169):
```javascript
function USERS(island) {
    const activeClients = [...clients].filter(each => each.active);
    const active = activeClients.length;
    const total = clients.size;
    const payload = { what: 'users', active, total };
    // ...
}
```

**CF Workers Synchronizer** (`sendUsersEvent`, line 474):
```typescript
private sendUsersEvent(joined, left): void {
    const activeClients = sockets.filter((s) => {
        const att = s.deserializeAttachment() as WSAttachment
        return att?.active === true
    })
    const active = activeClients.length
    const total = sockets.length
    // ...
}
```

**NO GAP**: Both count only active clients.

### 4.2 Batching Mechanism

**Original Reflector**:
- Uses `USERS_INTERVAL = 200ms` batching
- `scheduleUsersMessage()` schedules batched send

**CF Workers Synchronizer** (line 10):
```typescript
const USERS_INTERVAL = 200 // Batch users events within 200ms
```

**NO GAP**: Same batching interval.

---

## 5. Snapshot Handling

### 5.1 Snapshot Storage

**Original Reflector**:
- Stores in Google Cloud Storage
- `latest.json` contains session state + snapshot reference
- Snapshots are persistent

**CF Workers Synchronizer**:
- Stores in Cloudflare R2
- DO storage contains session state
- R2 contains actual snapshot data

**NO GAP**: Functionally equivalent.

### 5.2 Message Buffer Management

**Original Reflector** (`SNAP`, line 2784):
```javascript
function SNAP(client, args) {
    // Purge messages up to snapshot seq
    const firstToKeep = msgs.findIndex(msg => after(seq, msg[1]));
    if (firstToKeep > 0) {
        messagesToStore = msgs.splice(0, firstToKeep);
    }
    island.snapshotUrl = url;
}
```

**CF Workers Synchronizer** (`handleSnap`, line 756):
```typescript
// Purge messages up to snapshot seq
const firstToKeep = msgs.findIndex((msg) => (msg[1] as number) > snapshotSeq)
if (firstToKeep > 0) {
    msgs.splice(0, firstToKeep)
}
```

**NO GAP**: Same logic.

---

## 6. Timing and Ticks

### 6.1 Time Management

**Original Reflector**:
```javascript
const TICK_MS = 20;  // Default tick rate (50ms = 20 ticks/sec)
const INITIAL_SEQ = 0xfffffff0 >>> 0;  // 4294967280
```

**CF Workers Synchronizer**:
```typescript
const DEFAULT_TICK_MS = 50   // 20 ticks per second (matches original reflector tps=20)
const INITIAL_SEQ = 0xfffffff0 >>> 0
```

**NO GAP**: Same effective tick rate.

### 6.2 Tick Loop Architecture

**Original Reflector**: Uses `setInterval(tick, tickMS)` in Node.js.

**CF Workers Synchronizer**: Uses `setInterval` (matching the original reflector pattern).

Each session's Durable Object stays in memory while clients are connected. The tick loop runs via `setInterval` at the session's configured tick rate. When all clients disconnect, the loop stops and the DO can hibernate.

A safety alarm (30s) acts as a watchdog — if the DO is evicted and reconstituted by Cloudflare while clients are still connected, the alarm restarts the tick loop.

> **Note**: DO alarms were previously used for sub-second ticking but proved unreliable. Cloudflare throttles alarm delivery for hibernating DOs — each wake-up requires constructor + hydrate + storage reads, causing 15-20s delivery gaps instead of the scheduled 50-200ms. This caused the client's lag to exceed `SYNCED_MAX` (2000ms), triggering `synced=false` cycling.

### 6.3 Scale/Time Advancement

Both systems correctly implement:
- Scaled time advancement (`time.ts:advanceTime`)
- Min/max scale limits
- Scale change handling

**NO GAP**.

---

## 7. Monitoring and Observability

### 7.1 Session Visibility

**Original Reflector**:
- Sessions tracked in `ALL_SESSIONS` map
- Dispatcher records in GCS bucket
- Can query all active sessions

**CF Workers Synchronizer** (Fixed):
- Sessions exist in isolated DOs
- Now registers with registry on first client join
- Now unregisters when session becomes empty
- Sends periodic heartbeats to keep session visible

**FIXED**: Sessions now visible in monitoring UI (`/ui/sessions`)

### 7.2 Metrics

**Original Reflector**:
- Prometheus metrics (connections, sessions, latency)
- BigQuery logging

**CF Workers Synchronizer** (index.ts line 39):
```typescript
if (url.pathname === '/metrics') {
    // TODO: Implement proper metrics
    return new Response('# Croquet Synchronizer Metrics\n', {...})
}
```

**GAP: Metrics not implemented**

---

## 8. Implemented Fixes

All critical gaps have been addressed:

### Session Registry Integration (Implemented)

Added to `Synchronizer.handleJoin()` when `isEffectivelyFirstClient`:
```typescript
// Register session with registry for monitoring visibility
if (isEffectivelyFirstClient) {
    this.registerSession(1, args.appId as string | undefined)
}
```

Added to `Synchronizer.webSocketClose()` when session becomes empty:
```typescript
if (remaining === 0) {
    this.unregisterSession()  // Removes from monitoring UI
}
```

### API Key Stats Tracking (Implemented)

Stats are now updated in all modes:
- **Production**: Registry service binding updates stats
- **Local dev**: Registry HTTP endpoint updates stats
- **Standalone**: Synchronizer now updates stats directly in KV

### Heartbeat for Long Sessions (Implemented)

Added to alarm handler for periodic heartbeat:
```typescript
if (this.registeredWithRegistry) {
    this.heartbeatRegistry(sockets.length)
}
```

Heartbeats are sent every 60 seconds to keep session visible in registry (which uses TTL on records).

---

## 9. Architecture Differences

| Aspect | Original | CF Workers |
|--------|----------|------------|
| Process model | Single Node.js process | Durable Objects (per-session) |
| WebSocket handling | ws library | Native CF WebSockets + Hibernation API |
| Tick loop | `setInterval` in Node.js | `setInterval` in DO (same pattern) |
| Session isolation | In-memory maps | DO isolation |
| Persistence | GCS + memory | DO storage + R2 |
| Snapshot storage | Google Cloud Storage | R2 (file server at `/files/*`) |
| Scaling | Single node | Global edge |
| Cost model | Server uptime | Request-based + storage |

---

## 10. Diagnostic Tooling

The synchronizer serves a browser diagnostic script at `GET /diag.js`. It intercepts WebSocket messages to track tick timing, connection lifecycle, and tab visibility.

```javascript
// Load in browser console:
fetch('https://synq.alma.dev/diag.js').then(r=>r.text()).then(eval)

// Check stats (tick gaps, WS events, tab visibility):
__diag.stats()

// Stop monitoring:
__diag.stop()
```

Key metrics reported:
- **Tick gap distribution**: min/max/avg/p95 time between TICK messages
- **WebSocket lifecycle**: open/close/error events with timestamps
- **Tab visibility**: hidden/visible transitions (detects tab throttling)

---

## 11. Conclusion

The CF Workers Synchronizer now correctly implements:
- Core session management protocol
- Message ordering and timestamping
- Snapshot persistence and resumability (R2 + file server)
- User presence tracking (USERS messages)
- Client active state management
- Session registration with registry (monitoring visibility)
- API key stats tracking (lastUsed, totalRequests)
- Periodic heartbeat to keep sessions visible
- In-memory tick loop via `setInterval` (matches original reflector)

**Remaining gaps** (non-critical):
1. **Metrics** - Prometheus/OpenMetrics endpoint not implemented
2. **DePIN support** - WebRTC mode not implemented in CF Workers

The synchronizer is now functionally equivalent to the original reflector for standard WebSocket sessions, with full operational visibility through the management UI.
