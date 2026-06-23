# Local Package Patches

This directory contains patched versions of npm packages that override the versions installed in `node_modules`.

## How It Works

Vite's `resolve.alias` in `vite.config.ts` intercepts all imports and redirects them to local files:

```typescript
resolve: {
  alias: {
    '@multisynq/client': path.resolve(__dirname, 'patches/@multisynq/client'),
  }
}
```

This applies to **all imports** in the bundle, including:
- Your application code
- Dependencies in `node_modules` (e.g., `@multisynq/react` importing `@multisynq/client`)

## TypeScript Configuration

To ensure TypeScript resolves types from patches (not `node_modules`), add path mappings in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@multisynq/client": ["./patches/@multisynq/client"],
      "react-together": ["./patches/react-together"]
    }
  }
}
```

This ensures both runtime imports (via Vite) and type checking (via TypeScript) use the patched versions.

## Directory Structure

```
patches/
├── README.md
└── @multisynq/
    └── client/
        ├── package.json
        └── dist/
            ├── multisynq-client.esm.js
            └── multisynq-client.d.ts
```

## Adding a Patch

1. Copy the built package files to `patches/@multisynq/client/`
2. Ensure `package.json` has correct `main`/`module` fields pointing to the entry files
3. Restart the dev server (`npm run dev`)

## Removing a Patch

1. Delete the corresponding directory in `patches/`
2. Remove the alias from `vite.config.ts`
3. Run `npm install` to restore the original package

## Why Patch?

The `@multisynq/client` from npm uses the standard Croquet protocol. Our custom reflector uses a different protocol, requiring a patched client that understands our message format.
