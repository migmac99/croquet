# Croquet Workers - Cloudflare Deployment

Cloudflare-native Croquet infrastructure using Workers, Durable Objects, R2, and KV.

## Architecture

```
                    ┌─────────────────┐
                    │    Registry     │  ← synqreg.alma.dev
                    │   (KV-backed)   │     Session discovery
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
     ┌────────────┐  ┌────────────┐  ┌────────────┐
     │   Synq DO  │  │   Synq DO  │  │   Synq DO  │  ← synq.alma.dev
     │ (Session A)│  │ (Session B)│  │ (Session C)│     One DO per session
     └─────┬──────┘  └─────┬──────┘  └─────┬──────┘
           │               │               │
           └───────────────┴───────────────┘
                           │
                    ┌──────┴──────┐
                    │     R2      │  ← Snapshots
                    └─────────────┘
```

## Quick Start

### 1. Configure

Edit `deploy.config.json`:

```json
{
  "accountId": "your-cloudflare-account-id",
  "zoneId": "your-zone-id-for-alma-dev",

  "synchronizer": {
    "name": "synq",
    "domain": "synq.alma.dev"
  },

  "registry": {
    "name": "synqreg",
    "domain": "synqreg.alma.dev"
  }
}
```

### 2. Deploy

```bash
cd workers
./deploy.sh          # Deploy everything
```

### 3. Use

```javascript
Session.join({
  appId: 'com.yourapp.name',
  name: 'session-name',
  reflector: 'wss://synq.alma.dev',
})
```

## Commands

| Command               | Description                      |
| --------------------- | -------------------------------- |
| `./deploy.sh`         | Deploy all workers to production |
| `./deploy.sh staging` | Deploy to staging                |
| `./deploy.sh dev`     | Run synchronizer locally         |
| `./deploy.sh sync`    | Deploy only synchronizer         |
| `./deploy.sh reg`     | Deploy only registry             |

## Structure

```
workers/
├── deploy.config.json    # All configuration
├── deploy.sh            # One-button deploy (uses Bun)
├── README.md
│
├── synchronizer/        # WebSocket + Durable Object
│   ├── src/
│   │   ├── index.ts         # Router
│   │   ├── synchronizer.ts  # DO with hibernation
│   │   ├── storage.ts       # R2 helpers
│   │   └── types.ts
│   ├── wrangler.toml
│   └── package.json
│
└── registry/            # Session discovery API
    ├── src/
    │   ├── index.ts         # HTTP API
    │   └── types.ts
    ├── wrangler.toml
    └── package.json
```

## Configuration

### deploy.config.json

```json
{
  "accountId": "cf-account-id",
  "zoneId": "zone-id-for-domain",

  "synchronizer": {
    "name": "synq",
    "domain": "synq.alma.dev",
    "r2": {
      "bucketName": "synq-snapshots",
      "createIfMissing": true
    },
    "vars": {
      "MAX_CLIENTS_PER_SESSION": "100",
      "SESSION_TIMEOUT_MS": "300000"
    }
  },

  "registry": {
    "name": "synqreg",
    "domain": "synqreg.alma.dev",
    "kv": {
      "namespace": "synq-sessions",
      "createIfMissing": true
    },
    "vars": {
      "SYNCHRONIZER_URL": "wss://synq.alma.dev",
      "SESSION_TTL_SECONDS": "3600"
    }
  }
}
```

## Endpoints

### Synchronizer (synq.alma.dev)

| Endpoint                          | Protocol  | Description        |
| --------------------------------- | --------- | ------------------ |
| `wss://synq.alma.dev/{sessionId}` | WebSocket | Session connection |
| `GET /health`                     | HTTP      | Health check       |

### Registry (synqreg.alma.dev)

| Endpoint                 | Method | Description                      |
| ------------------------ | ------ | -------------------------------- |
| `/dispatch?session={id}` | GET    | Get synchronizer URL for session |
| `/register`              | POST   | Register/update session          |
| `/sessions`              | GET    | List active sessions             |
| `/health`                | GET    | Health check                     |

## Finding Zone ID

1. Cloudflare Dashboard → Select domain (alma.dev)
2. Overview page → Right sidebar → **Zone ID**

Or via CLI:

```bash
bunx wrangler zones list | grep alma
```

## Local Development

```bash
# Run synchronizer locally
./deploy.sh dev

# In another terminal, test
wscat -c ws://localhost:8787/test-session
```

## Monitoring

```bash
# Live logs
cd synchronizer && bunx wrangler tail

# Registry logs
cd registry && bunx wrangler tail
```

## Cost Optimization

- **DO Hibernation**: Sessions sleep when idle, only wake on messages
- **KV for Registry**: Fast global reads, low cost
- **R2 for Snapshots**: Cheap object storage, auto-prune old snapshots
- **Alarm-based ticking**: No continuous compute when idle
