# Croquet Project Guide

## Overview

Croquet is a real-time multiuser framework that synchronizes application state across clients using deterministic virtual machines. Instead of traditional client-server architecture, multiplayer code executes on each client in synchronized VMs.

## Repository Structure

```
croquet/
├── packages/
│   ├── croquet/          # Client SDK (@croquet/croquet)
│   │   ├── teatime/      # Core synchronization engine
│   │   │   └── src/
│   │   │       ├── controller.js   # Connection & session orchestration
│   │   │       ├── session.js      # Session management
│   │   │       ├── messenger.js    # Event pub/sub system
│   │   │       ├── webrtc.js       # WebRTC connection for DEPIN mode
│   │   │       ├── vm.js           # Virtual machine
│   │   │       ├── model.js        # Synchronized model base
│   │   │       └── view.js         # Client-side view base
│   │   ├── math/         # Math utilities
│   │   └── croquet.js    # Main entry point
│   │
│   └── reflector/        # Server package (@croquet/reflector)
│       ├── reflector.js  # Main reflector server (~4k lines)
│       ├── ws.js         # BroadcastChannel WebSocket shim (browser)
│       └── fs.js         # Empty fs shim (browser)
│
├── server/
│   └── croquet-in-a-box/ # Docker Compose local dev environment
│       ├── docker-compose.yml
│       └── nginx.conf
│
├── apps/                 # Example applications
└── docs/                 # JSDoc sources
```

## Key Concepts

### Reflector vs Synchronizer
- **Reflector**: Lightweight message relay server (Node.js). Routes messages between clients with timestamps. No state.
- **Synchronizer**: Cloudflare Workers replacement for the reflector. Durable Objects provide per-session isolation, R2 stores snapshots, KV handles session registry. Uses `setInterval` for tick loop (same pattern as the original reflector). See `workers/` for the open-source, self-hostable implementation.

### Connection Modes

1. **Standard WebSocket** (`reflector` param or default)
   - Direct WebSocket to reflector server
   - URL: `wss://croquet.io/reflector-v1/...`

2. **Cloudflare** (`?reflector=CF` or `?reflector=LAX`)
   - Routes through Cloudflare Workers
   - URL: `wss://croquet.network/reflector/`
   - Supports colo codes (LAX, ORD, etc.)

3. **DEPIN/Decentralized** (`?depin=true`)
   - WebRTC connections via `CroquetWebRTCConnection`
   - Connects to synchronizer via `DEPIN_API`
   - Uses WebRTC data channels for messaging

4. **Local/Box** (`?box=/`)
   - Local reflector via croquet-in-a-box
   - For development without API key

## Core Files

### Client (`packages/croquet/teatime/src/`)

| File | Purpose |
|------|---------|
| `controller.js` | Session lifecycle, connection management, reflector negotiation |
| `session.js` | Session class, join/leave, snapshot handling |
| `webrtc.js` | `CroquetWebRTCConnection` for DEPIN mode |
| `vm.js` | Deterministic virtual machine execution |
| `model.js` | Base class for synchronized models |
| `view.js` | Base class for client views |

### Server (`packages/reflector/`)

| File | Purpose |
|------|---------|
| `reflector.js` | Main server: WebSocket handling, session/island management, storage |

Key reflector concepts:
- **Island**: A synchronized state instance (time + clients)
- **Session**: Registered session lifecycle (runnable → running → closable → closed)
- **Client**: WebSocket connection with metadata

## Build Commands

```bash
# Build client library
cd packages/croquet && ./build.sh

# Run reflector locally
cd packages/reflector && npm start

# Run croquet-in-a-box
cd server/croquet-in-a-box && ./croquet-in-a-box.sh
```

## Storage

Current reflector uses Google Cloud Storage:
- `SESSION_BUCKET`: Session snapshots
- `DISPATCHER_BUCKET`: Dispatcher records
- `FILE_BUCKETS`: Persistent data (us/eu/jp regions)

For local dev: `--storage=none` disables GCP.

## Protocol

Messages are JSON arrays: `[type, ...args]`

Key message types:
- `JOIN`: Client joining session
- `SYNC`: Server sync response
- `SEND`: Client event broadcast
- `TICK`: Time advancement
- `SNAP`: Snapshot request/response
- `USERS`: User presence updates

## Environment Variables

Reflector:
- `CLUSTER_LABEL`: Cluster identifier
- `GCP_PROJECT`: Google Cloud project
- `PORT`: Server port (default varies)

## Debug Flags

URL params for debugging:
- `?debug=session` - Session lifecycle logs
- `?debug=messages` - Message traffic
- `?debug=snapshot` - Snapshot operations
- `?debug=reflector` - Use dev reflector

### Synchronizer Diagnostic Tool

The synchronizer serves a browser diagnostic script at `/diag.js`. Tracks tick gaps, WebSocket lifecycle, and tab visibility:

```javascript
fetch('https://synq.alma.dev/diag.js').then(r=>r.text()).then(eval)
__diag.stats()  // View tick timing, WS events, tab visibility
__diag.stop()   // Stop monitoring
```

### Force Snapshot

Trigger a snapshot manually from the browser console:

```javascript
MULTISYNQVM.forceSnapshot()
```
