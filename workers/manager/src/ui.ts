/**
 * Admin Dashboard UI
 *
 * Lightweight shadcn-inspired UI using Tailwind CSS
 */

export function renderDashboard(data: {
  user: string
  cluster: string
  synchronizer: string
  stats: {
    apiKeys: { total: number; active: number }
    sessions: { total: number; totalClients: number }
  }
}): string {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Synq Manager</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            border: 'hsl(240 3.7% 15.9%)',
            input: 'hsl(240 3.7% 15.9%)',
            ring: 'hsl(240 4.9% 83.9%)',
            background: 'hsl(240 10% 3.9%)',
            foreground: 'hsl(0 0% 98%)',
            primary: { DEFAULT: 'hsl(0 0% 98%)', foreground: 'hsl(240 5.9% 10%)' },
            secondary: { DEFAULT: 'hsl(240 3.7% 15.9%)', foreground: 'hsl(0 0% 98%)' },
            muted: { DEFAULT: 'hsl(240 3.7% 15.9%)', foreground: 'hsl(240 5% 64.9%)' },
            accent: { DEFAULT: 'hsl(240 3.7% 15.9%)', foreground: 'hsl(0 0% 98%)' },
            destructive: { DEFAULT: 'hsl(0 62.8% 30.6%)', foreground: 'hsl(0 0% 98%)' },
            card: { DEFAULT: 'hsl(240 10% 3.9%)', foreground: 'hsl(0 0% 98%)' },
          }
        }
      }
    }
  </script>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; }
    .btn { @apply inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50; }
    .btn-primary { @apply bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2; }
    .btn-secondary { @apply bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80 h-9 px-4 py-2; }
    .btn-destructive { @apply bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 h-9 px-4 py-2; }
    .btn-ghost { @apply hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2; }
    .btn-sm { @apply h-8 rounded-md px-3 text-xs; }
    .card { @apply rounded-xl border border-border bg-card text-card-foreground shadow; }
    .input { @apply flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring; }
    .badge { @apply inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors; }
    .badge-success { @apply border-transparent bg-green-500/20 text-green-400; }
    .badge-warning { @apply border-transparent bg-yellow-500/20 text-yellow-400; }
    .badge-destructive { @apply border-transparent bg-red-500/20 text-red-400; }
    dialog::backdrop { background: rgba(0,0,0,0.8); }
    dialog { @apply rounded-xl border border-border bg-card p-0 text-card-foreground shadow-lg; }
  </style>
</head>
<body class="bg-background text-foreground min-h-screen">
  <div class="flex min-h-screen">
    <!-- Sidebar -->
    <aside class="w-64 border-r border-border p-4 flex flex-col">
      <div class="mb-8">
        <h1 class="text-xl font-bold flex items-center gap-2">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>
          </svg>
          Synq Manager
        </h1>
        <p class="text-sm text-muted-foreground mt-1">${data.cluster}</p>
      </div>

      <nav class="space-y-1 flex-1">
        <a href="/" class="flex items-center gap-3 px-3 py-2 rounded-md bg-secondary text-secondary-foreground">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/>
          </svg>
          Dashboard
        </a>
        <a href="/ui/keys" class="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/>
          </svg>
          API Keys
        </a>
        <a href="/ui/sessions" class="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/>
          </svg>
          Sessions
        </a>
      </nav>

      <div class="pt-4 border-t border-border">
        <div class="flex items-center gap-3 px-3 py-2">
          <div class="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-sm font-medium">
            ${data.user.charAt(0).toUpperCase()}
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium truncate">${data.user}</p>
            <p class="text-xs text-muted-foreground">Admin</p>
          </div>
        </div>
      </div>
    </aside>

    <!-- Main content -->
    <main class="flex-1 p-8">
      <div class="max-w-6xl">
        <div class="mb-8">
          <h2 class="text-2xl font-bold">Dashboard</h2>
          <p class="text-muted-foreground">Overview of your Synq cluster</p>
        </div>

        <!-- Stats cards -->
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <div class="card p-6">
            <div class="flex items-center justify-between">
              <p class="text-sm font-medium text-muted-foreground">Total API Keys</p>
              <svg class="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/>
              </svg>
            </div>
            <p class="text-3xl font-bold mt-2">${data.stats.apiKeys.total}</p>
            <p class="text-xs text-muted-foreground mt-1">${data.stats.apiKeys.active} active</p>
          </div>

          <div class="card p-6">
            <div class="flex items-center justify-between">
              <p class="text-sm font-medium text-muted-foreground">Active Sessions</p>
              <svg class="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
              </svg>
            </div>
            <p class="text-3xl font-bold mt-2">${data.stats.sessions.total}</p>
            <p class="text-xs text-muted-foreground mt-1">${data.stats.sessions.totalClients} clients connected</p>
          </div>

          <div class="card p-6">
            <div class="flex items-center justify-between">
              <p class="text-sm font-medium text-muted-foreground">Synchronizer</p>
              <svg class="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
              </svg>
            </div>
            <p class="text-sm font-mono mt-2 truncate">${data.synchronizer}</p>
            <p class="text-xs text-green-400 mt-1">● Online</p>
          </div>

          <div class="card p-6">
            <div class="flex items-center justify-between">
              <p class="text-sm font-medium text-muted-foreground">Cluster</p>
              <svg class="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/>
              </svg>
            </div>
            <p class="text-lg font-semibold mt-2">${data.cluster}</p>
            <p class="text-xs text-muted-foreground mt-1">Production</p>
          </div>
        </div>

        <!-- Quick actions -->
        <div class="card p-6">
          <h3 class="text-lg font-semibold mb-4">Quick Actions</h3>
          <div class="flex flex-wrap gap-3">
            <a href="/ui/keys" class="btn btn-primary">
              <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
              </svg>
              Create API Key
            </a>
            <a href="/ui/sessions" class="btn btn-secondary">
              <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
              </svg>
              View Sessions
            </a>
            <a href="/health" target="_blank" class="btn btn-ghost">
              <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
              </svg>
              Health Check
            </a>
          </div>
        </div>
      </div>
    </main>
  </div>
</body>
</html>`
}

export function renderKeysPage(
  keys: Array<{
    id: string
    name: string
    allowedDomains: string[]
    tier: string
    active: boolean
    createdAt: number
    lastUsed?: number
    stats?: { totalRequests: number; totalSessions: number }
  }>,
  user: string,
  cluster: string
): string {
  const keyRows = keys
    .map(
      (key) => `
    <tr class="border-b border-border hover:bg-secondary/30 transition-colors">
      <td class="p-4">
        <div class="font-medium">${key.name}</div>
        <div class="text-xs text-muted-foreground font-mono">${key.id}</div>
      </td>
      <td class="p-4">
        <div class="flex flex-wrap gap-1">
          ${key.allowedDomains
            .slice(0, 3)
            .map((d) => `<span class="badge">${d}</span>`)
            .join('')}
          ${key.allowedDomains.length > 3 ? `<span class="badge">+${key.allowedDomains.length - 3}</span>` : ''}
        </div>
      </td>
      <td class="p-4">
        <span class="badge ${key.tier === 'enterprise' ? 'badge-warning' : key.tier === 'pro' ? 'badge-success' : ''}">${key.tier}</span>
      </td>
      <td class="p-4">
        <span class="badge ${key.active ? 'badge-success' : 'badge-destructive'}">${key.active ? 'Active' : 'Inactive'}</span>
      </td>
      <td class="p-4 text-sm text-muted-foreground">
        ${key.stats?.totalRequests || 0} requests
      </td>
      <td class="p-4 text-sm text-muted-foreground">
        ${key.lastUsed ? new Date(key.lastUsed).toLocaleDateString() : 'Never'}
      </td>
      <td class="p-4">
        <div class="flex gap-2">
          <button onclick="editKey('${key.id}')" class="btn btn-ghost btn-sm">Edit</button>
          <button onclick="toggleKey('${key.id}', ${!key.active})" class="btn btn-ghost btn-sm">${key.active ? 'Disable' : 'Enable'}</button>
          <button onclick="deleteKey('${key.id}')" class="btn btn-ghost btn-sm text-red-400 hover:text-red-300">Delete</button>
        </div>
      </td>
    </tr>
  `
    )
    .join('')

  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API Keys - Synq Manager</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            border: 'hsl(240 3.7% 15.9%)',
            input: 'hsl(240 3.7% 15.9%)',
            ring: 'hsl(240 4.9% 83.9%)',
            background: 'hsl(240 10% 3.9%)',
            foreground: 'hsl(0 0% 98%)',
            primary: { DEFAULT: 'hsl(0 0% 98%)', foreground: 'hsl(240 5.9% 10%)' },
            secondary: { DEFAULT: 'hsl(240 3.7% 15.9%)', foreground: 'hsl(0 0% 98%)' },
            muted: { DEFAULT: 'hsl(240 3.7% 15.9%)', foreground: 'hsl(240 5% 64.9%)' },
            accent: { DEFAULT: 'hsl(240 3.7% 15.9%)', foreground: 'hsl(0 0% 98%)' },
            destructive: { DEFAULT: 'hsl(0 62.8% 30.6%)', foreground: 'hsl(0 0% 98%)' },
            card: { DEFAULT: 'hsl(240 10% 3.9%)', foreground: 'hsl(0 0% 98%)' },
          }
        }
      }
    }
  </script>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; }
    .btn { @apply inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50; }
    .btn-primary { @apply bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2; }
    .btn-secondary { @apply bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80 h-9 px-4 py-2; }
    .btn-destructive { @apply bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 h-9 px-4 py-2; }
    .btn-ghost { @apply hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2; }
    .btn-sm { @apply h-8 rounded-md px-3 text-xs; }
    .card { @apply rounded-xl border border-border bg-card text-card-foreground shadow; }
    .input { @apply flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring; }
    .badge { @apply inline-flex items-center rounded-md border border-border px-2.5 py-0.5 text-xs font-semibold transition-colors; }
    .badge-success { @apply border-transparent bg-green-500/20 text-green-400; }
    .badge-warning { @apply border-transparent bg-yellow-500/20 text-yellow-400; }
    .badge-destructive { @apply border-transparent bg-red-500/20 text-red-400; }
    dialog::backdrop { background: rgba(0,0,0,0.8); }
    dialog { @apply rounded-xl border border-border bg-card p-0 text-card-foreground shadow-lg max-w-lg w-full; }
  </style>
</head>
<body class="bg-background text-foreground min-h-screen">
  <div class="flex min-h-screen">
    <!-- Sidebar -->
    <aside class="w-64 border-r border-border p-4 flex flex-col">
      <div class="mb-8">
        <h1 class="text-xl font-bold flex items-center gap-2">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>
          </svg>
          Synq Manager
        </h1>
        <p class="text-sm text-muted-foreground mt-1">${cluster}</p>
      </div>

      <nav class="space-y-1 flex-1">
        <a href="/" class="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/>
          </svg>
          Dashboard
        </a>
        <a href="/ui/keys" class="flex items-center gap-3 px-3 py-2 rounded-md bg-secondary text-secondary-foreground">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/>
          </svg>
          API Keys
        </a>
        <a href="/ui/sessions" class="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/>
          </svg>
          Sessions
        </a>
      </nav>

      <div class="pt-4 border-t border-border">
        <div class="flex items-center gap-3 px-3 py-2">
          <div class="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-sm font-medium">
            ${user.charAt(0).toUpperCase()}
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium truncate">${user}</p>
            <p class="text-xs text-muted-foreground">Admin</p>
          </div>
        </div>
      </div>
    </aside>

    <!-- Main content -->
    <main class="flex-1 p-8">
      <div class="max-w-6xl">
        <div class="flex items-center justify-between mb-8">
          <div>
            <h2 class="text-2xl font-bold">API Keys</h2>
            <p class="text-muted-foreground">Manage API keys for your applications</p>
          </div>
          <button onclick="document.getElementById('createDialog').showModal()" class="btn btn-primary">
            <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
            </svg>
            Create Key
          </button>
        </div>

        <!-- Keys table -->
        <div class="card overflow-hidden">
          <table class="w-full">
            <thead class="bg-secondary/50">
              <tr class="text-left text-sm text-muted-foreground">
                <th class="p-4 font-medium">Name</th>
                <th class="p-4 font-medium">Allowed Domains</th>
                <th class="p-4 font-medium">Tier</th>
                <th class="p-4 font-medium">Status</th>
                <th class="p-4 font-medium">Usage</th>
                <th class="p-4 font-medium">Last Used</th>
                <th class="p-4 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${keyRows || '<tr><td colspan="7" class="p-8 text-center text-muted-foreground">No API keys yet. Create one to get started.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  </div>

  <!-- Create Key Dialog -->
  <dialog id="createDialog" class="p-6">
    <form method="dialog" id="createForm">
      <h3 class="text-lg font-semibold mb-4">Create API Key</h3>

      <div class="space-y-4">
        <div>
          <label class="text-sm font-medium mb-2 block">Name</label>
          <input type="text" name="name" required class="input" placeholder="My App">
        </div>

        <div>
          <label class="text-sm font-medium mb-2 block">Allowed Domains</label>
          <input type="text" name="domains" required class="input" placeholder="localhost:*, *.myapp.com">
          <p class="text-xs text-muted-foreground mt-1">Comma-separated. Supports wildcards: *, *.domain.com, localhost:*</p>
        </div>

        <div>
          <label class="text-sm font-medium mb-2 block">Tier</label>
          <select name="tier" class="input">
            <option value="free">Free</option>
            <option value="pro">Pro</option>
            <option value="enterprise">Enterprise</option>
            <option value="unlimited">Unlimited</option>
          </select>
        </div>
      </div>

      <div class="flex justify-end gap-3 mt-6">
        <button type="button" onclick="document.getElementById('createDialog').close()" class="btn btn-ghost">Cancel</button>
        <button type="submit" class="btn btn-primary">Create Key</button>
      </div>
    </form>
  </dialog>

  <!-- Key Created Dialog -->
  <dialog id="keyCreatedDialog" class="p-6">
    <h3 class="text-lg font-semibold mb-4">API Key Created</h3>
    <p class="text-sm text-muted-foreground mb-4">Save this key now. You won't be able to see it again!</p>
    <div class="bg-secondary p-4 rounded-md font-mono text-sm break-all" id="newKeyDisplay"></div>
    <div class="flex justify-end gap-3 mt-6">
      <button onclick="copyKey()" class="btn btn-secondary">Copy</button>
      <button onclick="document.getElementById('keyCreatedDialog').close(); location.reload();" class="btn btn-primary">Done</button>
    </div>
  </dialog>

  <script>
    let newKey = '';

    document.getElementById('createForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const data = {
        name: form.name.value,
        allowedDomains: form.domains.value.split(',').map(d => d.trim()).filter(Boolean),
        tier: form.tier.value
      };

      try {
        const res = await fetch('/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });

        if (!res.ok) throw new Error(await res.text());

        const result = await res.json();
        newKey = result.key;
        document.getElementById('newKeyDisplay').textContent = newKey;
        document.getElementById('createDialog').close();
        document.getElementById('keyCreatedDialog').showModal();
      } catch (err) {
        alert('Error creating key: ' + err.message);
      }
    });

    function copyKey() {
      navigator.clipboard.writeText(newKey);
    }

    async function toggleKey(id, active) {
      if (!confirm(\`\${active ? 'Enable' : 'Disable'} this API key?\`)) return;

      try {
        const res = await fetch('/keys/' + id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active })
        });
        if (!res.ok) throw new Error(await res.text());
        location.reload();
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    async function deleteKey(id) {
      if (!confirm('Delete this API key? This cannot be undone.')) return;

      try {
        const res = await fetch('/keys/' + id, { method: 'DELETE' });
        if (!res.ok) throw new Error(await res.text());
        location.reload();
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    function editKey(id) {
      // TODO: Implement edit dialog
      alert('Edit functionality coming soon. Use PATCH /keys/' + id + ' for now.');
    }
  </script>
</body>
</html>`
}

export function renderSessionsPage(
  sessions: Array<{
    sessionId: string
    synchronizerUrl: string
    createdAt: number
    lastSeen: number
    clientCount: number
    appId?: string
    apiKeyId?: string
  }>,
  user: string,
  cluster: string
): string {
  const sessionRows = sessions
    .map(
      (s) => `
    <tr class="border-b border-border hover:bg-secondary/30 transition-colors">
      <td class="p-4">
        <div class="font-mono text-sm truncate max-w-xs" title="${s.sessionId}">${s.sessionId}</div>
      </td>
      <td class="p-4">
        <span class="badge">${s.appId || 'Unknown'}</span>
      </td>
      <td class="p-4">
        <span class="text-lg font-semibold">${s.clientCount}</span>
      </td>
      <td class="p-4 text-sm text-muted-foreground">
        ${new Date(s.createdAt).toLocaleString()}
      </td>
      <td class="p-4 text-sm text-muted-foreground">
        ${formatTimeAgo(s.lastSeen)}
      </td>
      <td class="p-4">
        <button onclick="deleteSession('${s.sessionId}')" class="btn btn-ghost btn-sm text-red-400 hover:text-red-300">End Session</button>
      </td>
    </tr>
  `
    )
    .join('')

  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sessions - Synq Manager</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            border: 'hsl(240 3.7% 15.9%)',
            input: 'hsl(240 3.7% 15.9%)',
            ring: 'hsl(240 4.9% 83.9%)',
            background: 'hsl(240 10% 3.9%)',
            foreground: 'hsl(0 0% 98%)',
            primary: { DEFAULT: 'hsl(0 0% 98%)', foreground: 'hsl(240 5.9% 10%)' },
            secondary: { DEFAULT: 'hsl(240 3.7% 15.9%)', foreground: 'hsl(0 0% 98%)' },
            muted: { DEFAULT: 'hsl(240 3.7% 15.9%)', foreground: 'hsl(240 5% 64.9%)' },
            accent: { DEFAULT: 'hsl(240 3.7% 15.9%)', foreground: 'hsl(0 0% 98%)' },
            destructive: { DEFAULT: 'hsl(0 62.8% 30.6%)', foreground: 'hsl(0 0% 98%)' },
            card: { DEFAULT: 'hsl(240 10% 3.9%)', foreground: 'hsl(0 0% 98%)' },
          }
        }
      }
    }
  </script>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; }
    .btn { @apply inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50; }
    .btn-primary { @apply bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2; }
    .btn-secondary { @apply bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80 h-9 px-4 py-2; }
    .btn-ghost { @apply hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2; }
    .btn-sm { @apply h-8 rounded-md px-3 text-xs; }
    .card { @apply rounded-xl border border-border bg-card text-card-foreground shadow; }
    .badge { @apply inline-flex items-center rounded-md border border-border px-2.5 py-0.5 text-xs font-semibold; }
  </style>
</head>
<body class="bg-background text-foreground min-h-screen">
  <div class="flex min-h-screen">
    <!-- Sidebar -->
    <aside class="w-64 border-r border-border p-4 flex flex-col">
      <div class="mb-8">
        <h1 class="text-xl font-bold flex items-center gap-2">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>
          </svg>
          Synq Manager
        </h1>
        <p class="text-sm text-muted-foreground mt-1">${cluster}</p>
      </div>

      <nav class="space-y-1 flex-1">
        <a href="/" class="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/>
          </svg>
          Dashboard
        </a>
        <a href="/ui/keys" class="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/>
          </svg>
          API Keys
        </a>
        <a href="/ui/sessions" class="flex items-center gap-3 px-3 py-2 rounded-md bg-secondary text-secondary-foreground">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/>
          </svg>
          Sessions
        </a>
      </nav>

      <div class="pt-4 border-t border-border">
        <div class="flex items-center gap-3 px-3 py-2">
          <div class="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-sm font-medium">
            ${user.charAt(0).toUpperCase()}
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium truncate">${user}</p>
            <p class="text-xs text-muted-foreground">Admin</p>
          </div>
        </div>
      </div>
    </aside>

    <!-- Main content -->
    <main class="flex-1 p-8">
      <div class="max-w-6xl">
        <div class="flex items-center justify-between mb-8">
          <div>
            <h2 class="text-2xl font-bold">Sessions</h2>
            <p class="text-muted-foreground">Active sessions on your cluster</p>
          </div>
          <button onclick="location.reload()" class="btn btn-secondary">
            <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
            </svg>
            Refresh
          </button>
        </div>

        <!-- Sessions table -->
        <div class="card overflow-hidden">
          <table class="w-full">
            <thead class="bg-secondary/50">
              <tr class="text-left text-sm text-muted-foreground">
                <th class="p-4 font-medium">Session ID</th>
                <th class="p-4 font-medium">App</th>
                <th class="p-4 font-medium">Clients</th>
                <th class="p-4 font-medium">Created</th>
                <th class="p-4 font-medium">Last Activity</th>
                <th class="p-4 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${sessionRows || '<tr><td colspan="6" class="p-8 text-center text-muted-foreground">No active sessions</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  </div>

  <script>
    async function deleteSession(id) {
      if (!confirm('End this session? All connected clients will be disconnected.')) return;

      try {
        const res = await fetch('/sessions/' + encodeURIComponent(id), { method: 'DELETE' });
        if (!res.ok) throw new Error(await res.text());
        location.reload();
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }
  </script>
</body>
</html>`
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'Just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}
