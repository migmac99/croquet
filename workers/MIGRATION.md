# Migrating to Alma.dev Synq

Quick guide for migrating from MultiSynq's official API to the self-hosted Alma.dev deployment.

## Configuration Changes

### Reflector URL

```diff
- reflector: 'wss://croquet.io/reflector'
+ reflector: 'wss://synq.alma.dev'
```

### API Key

Replace your MultiSynq API key with one from your Alma.dev admin panel:

```diff
- apiKey: 'your-multisynq-api-key'
+ apiKey: 'synq_...'  // Get from https://synqmanager.alma.dev
```

## Code Example

**Before:**

```javascript
Session.join({
  appId: 'com.mycompany.myapp',
  name: 'my-session',
  apiKey: 'multisynq-api-key',
  password: 'secret',
  model: MyModel,
  view: MyView,
})
```

**After:**

```javascript
Session.join({
  appId: 'com.mycompany.myapp',
  name: 'my-session',
  apiKey: 'synq_...', // New key from synqmanager.alma.dev
  reflector: 'wss://synq.alma.dev', // Self-hosted reflector
  password: 'secret',
  model: MyModel,
  view: MyView,
})
```

## Environment Variables

```bash
# .env
CROQUET_API_KEY=synq_...
CROQUET_REFLECTOR=wss://synq.alma.dev
```

## Endpoints

| Service   | MultiSynq                    | Alma.dev                     |
| --------- | ---------------------------- | ---------------------------- |
| Reflector | wss://croquet.io/reflector   | wss://synq.alma.dev          |
| Registry  | (internal)                   | https://synqreg.alma.dev     |
| Admin     | https://croquet.io/dashboard | https://synqmanager.alma.dev |

## Getting an API Key

1. Go to [synqmanager.alma.dev](https://synqmanager.alma.dev)
2. Authenticate via Cloudflare Access
3. Navigate to **API Keys** > **Create Key**
4. Add your allowed domains (e.g., `localhost:*`, `*.myapp.com`)
5. Copy the generated key (shown only once)

## Notes

- Sessions are fully isolated between deployments
- Existing MultiSynq sessions won't migrate (clients rejoin on new server)
- No code changes needed beyond configuration
