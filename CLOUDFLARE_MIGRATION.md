# Cloudflare Migration: Reflector & Synchronizer

## Current State

The codebase already has partial Cloudflare support:
- Client supports `?reflector=CF` routing to `wss://croquet.network/reflector/`
- DEPIN mode exists with WebRTC synchronizers
- Reflector runs on Node.js with GCP Storage

## Target Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Cloudflare Edge                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐     ┌──────────────────────────────────────┐  │
│  │   Worker     │────▶│         Durable Object               │  │
│  │  (Router)    │     │        (Synchronizer)                │  │
│  └──────────────┘     │                                      │  │
│         │             │  - Session state                     │  │
│         │             │  - Client connections (WebSocket)    │  │
│         │             │  - Message ordering & timestamps     │  │
│         ▼             │  - Snapshot coordination             │  │
│  ┌──────────────┐     └──────────────────────────────────────┘  │
│  │      R2      │                      │                        │
│  │  (Snapshots) │◀─────────────────────┘                        │
│  └──────────────┘                                               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Router Worker (`workers/router/`)

Entry point for all connections. Routes to appropriate Durable Object.

```typescript
// src/index.ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      const sessionId = extractSessionId(url);
      const id = env.SYNCHRONIZER.idFromName(sessionId);
      const stub = env.SYNCHRONIZER.get(id);
      return stub.fetch(request);
    }

    // Health check
    if (url.pathname === '/healthz') {
      return new Response('OK');
    }

    return new Response('Croquet Reflector', { status: 200 });
  }
}
```

### 2. Synchronizer Durable Object (`workers/synchronizer/`)

Handles session state, message routing, and client management.

```typescript
// src/synchronizer.ts
export class Synchronizer implements DurableObject {
  private clients: Map<string, WebSocket> = new Map();
  private time: number = 0;
  private seq: number = 0;

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 400 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    await this.handleSession(server, request);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleSession(ws: WebSocket, request: Request) {
    ws.accept();
    const clientId = crypto.randomUUID();
    this.clients.set(clientId, ws);

    ws.addEventListener('message', (event) => {
      this.handleMessage(clientId, event.data);
    });

    ws.addEventListener('close', () => {
      this.clients.delete(clientId);
      this.broadcastUserLeft(clientId);
    });
  }

  private handleMessage(clientId: string, data: string) {
    const msg = JSON.parse(data);
    const type = msg[0];

    switch (type) {
      case 'JOIN':
        this.handleJoin(clientId, msg);
        break;
      case 'SEND':
        this.handleSend(clientId, msg);
        break;
      case 'PING':
        this.handlePing(clientId, msg);
        break;
      // ... other message types
    }
  }

  private handleSend(clientId: string, msg: any[]) {
    const now = Date.now();
    this.seq++;

    // Broadcast with timestamp
    const outMsg = JSON.stringify(['RECV', this.seq, now, msg.slice(1)]);
    for (const [id, ws] of this.clients) {
      ws.send(outMsg);
    }
  }
}
```

### 3. Storage Layer

Replace GCP Storage with R2 for snapshots and persistent data.

```typescript
// src/storage.ts
export class SnapshotStorage {
  constructor(private bucket: R2Bucket) {}

  async saveSnapshot(sessionId: string, snapshot: Uint8Array): Promise<void> {
    const key = `snapshots/${sessionId}/${Date.now()}.bin`;
    await this.bucket.put(key, snapshot);
  }

  async loadLatestSnapshot(sessionId: string): Promise<Uint8Array | null> {
    const list = await this.bucket.list({ prefix: `snapshots/${sessionId}/` });
    if (list.objects.length === 0) return null;

    const latest = list.objects.sort((a, b) =>
      b.uploaded.getTime() - a.uploaded.getTime()
    )[0];

    const obj = await this.bucket.get(latest.key);
    return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
  }
}
```

## Implementation Phases

### Phase 1: Minimal Reflector (Week 1-2)
Port core message routing without persistence.

Files to port from `reflector.js`:
- `SEND` / `RECV` message handling
- `JOIN` / `SYNC` protocol
- `TICK` generation
- Client connection management

Skip initially:
- Snapshot storage
- Persistent data
- Metrics/Prometheus
- Token verification

### Phase 2: State Persistence (Week 3)
Add R2 storage for snapshots.

- Implement `SNAP` request handling
- R2 read/write for snapshots
- Session recovery from snapshot

### Phase 3: Full Feature Parity (Week 4+)
- Token verification (use Workers secrets)
- User presence (`USERS` messages)
- Persistent data storage
- Metrics (Workers Analytics)

## Project Structure

```
workers/
├── router/
│   ├── src/
│   │   └── index.ts
│   ├── wrangler.toml
│   └── package.json
│
├── synchronizer/
│   ├── src/
│   │   ├── index.ts      # DO export
│   │   ├── synchronizer.ts
│   │   ├── protocol.ts   # Message types
│   │   └── storage.ts    # R2 helpers
│   ├── wrangler.toml
│   └── package.json
│
└── shared/
    └── src/
        ├── types.ts
        └── constants.ts
```

## wrangler.toml

```toml
name = "croquet-synchronizer"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[durable_objects]
bindings = [
  { name = "SYNCHRONIZER", class_name = "Synchronizer" }
]

[[r2_buckets]]
binding = "SNAPSHOTS"
bucket_name = "croquet-snapshots"

[[migrations]]
tag = "v1"
new_classes = ["Synchronizer"]
```

## Key Protocol Mappings

| Reflector (Node) | Synchronizer (DO) |
|------------------|-------------------|
| `ALL_SESSIONS` Map | DO instances (one per session) |
| `ALL_ISLANDS` Map | DO state (`this.state.storage`) |
| `client.send()` | `ws.send()` |
| GCP Storage | R2 Bucket |
| `setInterval` ticker | DO alarm or `waitUntil` |

## Message Protocol (No Changes Needed)

Client protocol remains unchanged:
```
JOIN  → [session, user, snapshot?]
SYNC  ← [time, seq, users, snapshot?]
SEND  → [scope, event, data]
RECV  ← [seq, time, scope, event, data]
TICK  ← [time]
SNAP  ↔ [request/response]
```

## Testing Strategy

1. **Local**: Use `wrangler dev` with miniflare
2. **Integration**: Deploy to workers.dev subdomain
3. **Client compat**: Test with existing apps using `?reflector=<worker-url>`

## Migration Path

1. Deploy new Cloudflare synchronizer
2. Update `CLOUDFLARE_REFLECTOR` constant in `controller.js`
3. Test with `?reflector=CF` flag
4. Gradually route traffic

## Considerations

### Durable Object Limits
- 128KB per storage key
- 1MB WebSocket message
- 30s CPU per request (use alarms for long operations)

### Cost Optimization
- Use DO hibernation for idle sessions
- Batch R2 operations
- Consider KV for hot metadata

### Differences from Node Reflector
- No file system access
- No child processes
- Single-threaded per DO
- WebSocket API differs slightly
