/**
 * Admin Dashboard UI
 *
 * Template-based rendering system for easy HTML editing.
 * Templates are imported as raw text and use {{placeholder}} syntax.
 */

// Import templates as raw text
import baseTemplate from './templates/base.html'
import dashboardTemplate from './templates/dashboard.html'
import keysTemplate from './templates/keys.html'
import keysScripts from './templates/keys-scripts.html'
import sessionsTemplate from './templates/sessions.html'
import sessionsScripts from './templates/sessions-scripts.html'

/**
 * Simple template engine - replaces {{key}} with values
 */
function render(template: string, data: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = data[key]
    return value !== undefined ? String(value) : ''
  })
}

/**
 * Render a page with the base layout
 */
function renderPage(options: {
  title: string
  content: string
  scripts?: string
  activePage: 'dashboard' | 'keys' | 'sessions'
  user: string
  cluster: string
}): string {
  const navActive = 'bg-secondary text-secondary-foreground'
  const navInactive = 'hover:bg-secondary/50 text-muted-foreground hover:text-foreground'

  return render(baseTemplate, {
    title: options.title,
    content: options.content,
    scripts: options.scripts || '',
    cluster: options.cluster,
    user: options.user,
    user_initial: options.user.charAt(0).toUpperCase(),
    nav_dashboard_active: options.activePage === 'dashboard' ? navActive : navInactive,
    nav_keys_active: options.activePage === 'keys' ? navActive : navInactive,
    nav_sessions_active: options.activePage === 'sessions' ? navActive : navInactive,
  })
}

// ============================================================================
// Dashboard
// ============================================================================

export function renderDashboard(data: {
  user: string
  cluster: string
  synchronizer: string
  stats: {
    apiKeys: { total: number; active: number }
    sessions: { total: number; totalClients: number }
  }
}): string {
  const content = render(dashboardTemplate, {
    cluster: data.cluster,
    synchronizer: data.synchronizer,
    stats_apikeys_total: data.stats.apiKeys.total,
    stats_apikeys_active: data.stats.apiKeys.active,
    stats_sessions_total: data.stats.sessions.total,
    stats_sessions_clients: data.stats.sessions.totalClients,
  })

  return renderPage({
    title: 'Dashboard',
    content,
    activePage: 'dashboard',
    user: data.user,
    cluster: data.cluster,
  })
}

// ============================================================================
// Keys Page
// ============================================================================

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
  // Generate mobile cards
  const keyCards =
    keys.length > 0
      ? keys
          .map(
            (key) => `
    <div class="card p-6 space-y-4">
      <div class="flex items-start justify-between">
        <div class="min-w-0 flex-1">
          <div class="font-medium truncate">${escapeHtml(key.name)}</div>
          <div class="text-xs text-muted-foreground font-mono truncate mt-1.5">${key.id}</div>
        </div>
        <span class="badge ${key.active ? 'badge-success' : 'badge-destructive'} ml-3 shrink-0">${key.active ? 'Active' : 'Inactive'}</span>
      </div>
      <div class="flex flex-wrap gap-2">
        ${key.allowedDomains
          .slice(0, 2)
          .map((d) => `<span class="badge text-xs">${escapeHtml(d)}</span>`)
          .join('')}
        ${key.allowedDomains.length > 2 ? `<span class="badge text-xs">+${key.allowedDomains.length - 2}</span>` : ''}
      </div>
      <div class="flex items-center justify-between text-xs text-muted-foreground">
        <span class="badge ${tierBadgeClass(key.tier)}">${key.tier}</span>
        <span>${key.stats?.totalRequests || 0} requests</span>
      </div>
      <div class="flex gap-3 pt-4 border-t border-border">
        <button onclick="toggleKey('${key.id}', ${!key.active})" class="btn btn-ghost btn-sm flex-1">${key.active ? 'Disable' : 'Enable'}</button>
        <button onclick="deleteKey('${key.id}')" class="btn btn-ghost btn-sm text-red-400 hover:text-red-300">Delete</button>
      </div>
    </div>
  `
          )
          .join('')
      : '<div class="card p-10 text-center text-muted-foreground">No API keys yet. Create one to get started.</div>'

  // Generate table rows
  const keyRows =
    keys.length > 0
      ? keys
          .map(
            (key) => `
    <tr class="border-b border-border hover:bg-secondary/30 transition-colors">
      <td class="px-6 py-5">
        <div class="font-medium">${escapeHtml(key.name)}</div>
        <div class="text-xs text-muted-foreground font-mono mt-1">${key.id}</div>
      </td>
      <td class="px-6 py-5">
        <div class="flex flex-wrap gap-1.5">
          ${key.allowedDomains
            .slice(0, 3)
            .map((d) => `<span class="badge">${escapeHtml(d)}</span>`)
            .join('')}
          ${key.allowedDomains.length > 3 ? `<span class="badge">+${key.allowedDomains.length - 3}</span>` : ''}
        </div>
      </td>
      <td class="px-6 py-5">
        <span class="badge ${tierBadgeClass(key.tier)}">${key.tier}</span>
      </td>
      <td class="px-6 py-5">
        <span class="badge ${key.active ? 'badge-success' : 'badge-destructive'}">${key.active ? 'Active' : 'Inactive'}</span>
      </td>
      <td class="px-6 py-5 text-sm text-muted-foreground">
        ${key.stats?.totalRequests || 0} requests
      </td>
      <td class="px-6 py-5 text-sm text-muted-foreground">
        ${key.lastUsed ? new Date(key.lastUsed).toLocaleDateString() : 'Never'}
      </td>
      <td class="px-6 py-5">
        <div class="flex gap-3">
          <button onclick="toggleKey('${key.id}', ${!key.active})" class="btn btn-ghost btn-sm">${key.active ? 'Disable' : 'Enable'}</button>
          <button onclick="deleteKey('${key.id}')" class="btn btn-ghost btn-sm text-red-400 hover:text-red-300">Delete</button>
        </div>
      </td>
    </tr>
  `
          )
          .join('')
      : '<tr><td colspan="7" class="p-10 text-center text-muted-foreground">No API keys yet. Create one to get started.</td></tr>'

  const content = render(keysTemplate, {
    key_cards: keyCards,
    key_rows: keyRows,
  })

  return renderPage({
    title: 'API Keys',
    content,
    scripts: keysScripts,
    activePage: 'keys',
    user,
    cluster,
  })
}

// ============================================================================
// Sessions Page
// ============================================================================

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
  // Generate mobile cards
  const sessionCards =
    sessions.length > 0
      ? sessions
          .map(
            (s) => `
    <div class="card p-6 space-y-4">
      <div class="flex items-start justify-between gap-3">
        <div class="font-mono text-xs truncate flex-1" title="${escapeHtml(s.sessionId)}">${escapeHtml(s.sessionId)}</div>
        <span class="badge shrink-0">${escapeHtml(s.appId || 'Unknown')}</span>
      </div>
      <div class="flex items-center justify-between text-sm">
        <span class="text-muted-foreground">Clients</span>
        <span class="font-semibold">${s.clientCount}</span>
      </div>
      <div class="flex items-center justify-between text-xs text-muted-foreground">
        <span>Last activity</span>
        <span>${formatTimeAgo(s.lastSeen)}</span>
      </div>
      <div class="pt-3 border-t border-border">
        <button onclick="deleteSession('${escapeHtml(s.sessionId)}')" class="btn btn-ghost btn-sm w-full text-red-400 hover:text-red-300">End Session</button>
      </div>
    </div>
  `
          )
          .join('')
      : '<div class="card p-10 text-center text-muted-foreground">No active sessions</div>'

  // Generate table rows
  const sessionRows =
    sessions.length > 0
      ? sessions
          .map(
            (s) => `
    <tr class="border-b border-border hover:bg-secondary/30 transition-colors">
      <td class="px-6 py-5">
        <div class="font-mono text-sm truncate max-w-xs" title="${escapeHtml(s.sessionId)}">${escapeHtml(s.sessionId)}</div>
      </td>
      <td class="px-6 py-5">
        <span class="badge">${escapeHtml(s.appId || 'Unknown')}</span>
      </td>
      <td class="px-6 py-5">
        <span class="text-lg font-semibold">${s.clientCount}</span>
      </td>
      <td class="px-6 py-5 text-sm text-muted-foreground">
        ${new Date(s.createdAt).toLocaleString()}
      </td>
      <td class="px-6 py-5 text-sm text-muted-foreground">
        ${formatTimeAgo(s.lastSeen)}
      </td>
      <td class="px-6 py-5">
        <button onclick="deleteSession('${escapeHtml(s.sessionId)}')" class="btn btn-ghost btn-sm text-red-400 hover:text-red-300">End Session</button>
      </td>
    </tr>
  `
          )
          .join('')
      : '<tr><td colspan="6" class="p-10 text-center text-muted-foreground">No active sessions</td></tr>'

  const content = render(sessionsTemplate, {
    session_cards: sessionCards,
    session_rows: sessionRows,
  })

  return renderPage({
    title: 'Sessions',
    content,
    scripts: sessionsScripts,
    activePage: 'sessions',
    user,
    cluster,
  })
}

// ============================================================================
// Helpers
// ============================================================================

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'Just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

function tierBadgeClass(tier: string): string {
  switch (tier) {
    case 'enterprise':
      return 'badge-warning'
    case 'pro':
      return 'badge-success'
    default:
      return ''
  }
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}
