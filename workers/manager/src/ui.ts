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
import accountsTemplate from './templates/accounts.html'
import accountsScripts from './templates/accounts-scripts.html'

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
  activePage: 'dashboard' | 'keys' | 'sessions' | 'accounts'
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
    nav_accounts_active: options.activePage === 'accounts' ? navActive : navInactive,
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
    accountId?: string
  }>,
  accounts: Array<{ id: string; name: string }>,
  user: string,
  cluster: string
): string {
  // Create account lookup map
  const accountMap = new Map(accounts.map((a) => [a.id, a.name]))
  // Generate mobile cards
  const keyCards =
    keys.length > 0
      ? keys
          .map(
            (key) => `
    <div class="card p-6 space-y-4" data-account-id="${key.accountId || ''}">
      <div class="flex items-start justify-between">
        <div class="min-w-0 flex-1">
          <div class="font-medium truncate cursor-pointer hover:text-muted-foreground transition-colors" onclick="copyToClipboard('${escapeHtml(key.name)}', 'Name')" title="Click to copy">${escapeHtml(key.name)}</div>
          <div class="text-xs text-muted-foreground font-mono truncate mt-1.5 cursor-pointer hover:text-foreground transition-colors" onclick="copyToClipboard('${key.id}', 'Key ID')" title="Click to copy">${key.id}</div>
        </div>
        <div class="flex gap-1.5 ml-3 shrink-0">
          <span class="badge ${key.active ? 'badge-success' : 'badge-destructive'}">${key.active ? 'Active' : 'Inactive'}</span>
          <span class="badge ${tierBadgeClass(key.tier)}">${key.tier}</span>
        </div>
      </div>
      ${key.accountId ? `<div class="text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors" onclick="copyToClipboard('${key.accountId}', 'Account ID')" title="Click to copy">Account: <span class="font-medium">${escapeHtml(accountMap.get(key.accountId) || key.accountId)}</span></div>` : ''}
      <div class="flex flex-wrap gap-2">
        ${key.allowedDomains
          .slice(0, 2)
          .map(
            (d) =>
              `<span class="badge text-xs cursor-pointer hover:opacity-80" onclick="copyToClipboard('${escapeHtml(d)}', 'Domain')" title="Click to copy">${escapeHtml(d)}</span>`
          )
          .join('')}
        ${key.allowedDomains.length > 2 ? `<span class="badge text-xs cursor-pointer hover:opacity-80" onclick="copyToClipboard('${key.allowedDomains.join(', ')}', 'All domains')" title="Click to copy all">+${key.allowedDomains.length - 2}</span>` : ''}
      </div>
      <div class="flex items-center justify-between text-xs text-muted-foreground">
        <span class="cursor-pointer hover:text-foreground transition-colors" onclick="copyToClipboard('${key.stats?.totalRequests || 0}', 'Request count')" title="Click to copy">${key.stats?.totalRequests || 0} requests</span>
      </div>
      <div class="flex gap-3 pt-4 border-t border-border">
        <button onclick="editKey('${key.id}')" class="btn btn-ghost btn-sm flex-1">Edit</button>
        <button onclick="rollKey('${key.id}')" class="btn btn-ghost btn-sm flex-1">Roll</button>
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
    <tr class="border-b border-border hover:bg-secondary/30 transition-colors" data-account-id="${key.accountId || ''}">
      <td class="px-6 py-5">
        <div class="font-medium cursor-pointer hover:text-muted-foreground transition-colors" onclick="copyToClipboard('${escapeHtml(key.name)}', 'Name')" title="Click to copy">${escapeHtml(key.name)}</div>
        <div class="text-xs text-muted-foreground font-mono mt-1 cursor-pointer hover:text-foreground transition-colors" onclick="copyToClipboard('${key.id}', 'Key ID')" title="Click to copy">${key.id}</div>
      </td>
      <td class="px-6 py-5 text-sm">
        ${key.accountId ? `<span class="font-medium cursor-pointer hover:text-foreground transition-colors" onclick="copyToClipboard('${key.accountId}', 'Account ID')" title="Click to copy">${escapeHtml(accountMap.get(key.accountId) || key.accountId)}</span>` : '<span class="text-muted-foreground">—</span>'}
      </td>
      <td class="px-6 py-5">
        <div class="flex flex-wrap gap-1.5">
          ${key.allowedDomains
            .slice(0, 3)
            .map(
              (d) =>
                `<span class="badge cursor-pointer hover:opacity-80" onclick="copyToClipboard('${escapeHtml(d)}', 'Domain')" title="Click to copy">${escapeHtml(d)}</span>`
            )
            .join('')}
          ${key.allowedDomains.length > 3 ? `<span class="badge">+${key.allowedDomains.length - 3}</span>` : ''}
        </div>
      </td>
      <td class="px-6 py-5">
        <div class="flex gap-1.5">
          <span class="badge ${key.active ? 'badge-success' : 'badge-destructive'}">${key.active ? 'Active' : 'Inactive'}</span>
          <span class="badge ${tierBadgeClass(key.tier)}">${key.tier}</span>
        </div>
      </td>
      <td class="px-6 py-5 text-sm text-muted-foreground">
        ${key.stats?.totalRequests || 0} requests
      </td>
      <td class="px-6 py-5 text-sm text-muted-foreground">
        ${key.lastUsed ? new Date(key.lastUsed).toLocaleDateString() : 'Never'}
      </td>
      <td class="px-6 py-5">
        <div class="flex gap-2">
          <button onclick="editKey('${key.id}')" class="btn btn-ghost btn-sm">Edit</button>
          <button onclick="rollKey('${key.id}')" class="btn btn-ghost btn-sm">Roll</button>
          <button onclick="deleteKey('${key.id}')" class="btn btn-ghost btn-sm text-red-400 hover:text-red-300">Delete</button>
        </div>
      </td>
    </tr>
  `
          )
          .join('')
      : '<tr><td colspan="7" class="p-10 text-center text-muted-foreground">No API keys yet. Create one to get started.</td></tr>'

  // Generate account options for the dropdown
  const accountOptions = accounts.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`).join('')

  const content = render(keysTemplate, {
    key_cards: keyCards,
    key_rows: keyRows,
    account_options: accountOptions,
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
    accountId?: string
    accountName?: string
  }>,
  accounts: Array<{ id: string; name: string }>,
  user: string,
  cluster: string
): string {
  // Create account lookup map
  const accountMap = new Map(accounts.map((a) => [a.id, a.name]))

  // Generate mobile cards
  const sessionCards =
    sessions.length > 0
      ? sessions
          .map(
            (s) => `
    <div class="card p-6 space-y-4" data-account-id="${s.accountId || ''}">
      <div class="flex items-start justify-between gap-3">
        <div class="font-mono text-xs truncate flex-1 cursor-pointer hover:text-muted-foreground transition-colors" onclick="copyToClipboard('${escapeHtml(s.sessionId)}', 'Session ID')" title="Click to copy">${escapeHtml(s.sessionId)}</div>
        <span class="badge shrink-0 cursor-pointer hover:opacity-80" onclick="copyToClipboard('${escapeHtml(s.appId || 'Unknown')}', 'App ID')" title="Click to copy">${escapeHtml(s.appId || 'Unknown')}</span>
      </div>
      ${s.accountId ? `<div class="text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors" onclick="copyToClipboard('${s.accountId}', 'Account ID')" title="Click to copy">Account: <span class="font-medium">${escapeHtml(s.accountName || accountMap.get(s.accountId) || s.accountId)}</span></div>` : ''}
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
    <tr class="border-b border-border hover:bg-secondary/30 transition-colors" data-account-id="${s.accountId || ''}">
      <td class="px-6 py-5">
        <div class="font-mono text-sm truncate max-w-xs cursor-pointer hover:text-muted-foreground transition-colors" onclick="copyToClipboard('${escapeHtml(s.sessionId)}', 'Session ID')" title="Click to copy">${escapeHtml(s.sessionId)}</div>
      </td>
      <td class="px-6 py-5">
        <span class="badge cursor-pointer hover:opacity-80" onclick="copyToClipboard('${escapeHtml(s.appId || 'Unknown')}', 'App ID')" title="Click to copy">${escapeHtml(s.appId || 'Unknown')}</span>
      </td>
      <td class="px-6 py-5 text-sm">
        ${s.accountId ? `<span class="font-medium cursor-pointer hover:text-foreground transition-colors" onclick="copyToClipboard('${s.accountId}', 'Account ID')" title="Click to copy">${escapeHtml(s.accountName || accountMap.get(s.accountId) || s.accountId)}</span>` : '<span class="text-muted-foreground">—</span>'}
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
      : '<tr><td colspan="7" class="p-10 text-center text-muted-foreground">No active sessions</td></tr>'

  // Generate account options for the filter dropdown
  const accountOptions = accounts.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`).join('')

  const content = render(sessionsTemplate, {
    session_cards: sessionCards,
    session_rows: sessionRows,
    account_options: accountOptions,
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
// Accounts Page
// ============================================================================

export function renderAccountsPage(
  accounts: Array<{
    id: string
    name: string
    description?: string
    active: boolean
    createdAt: number
    createdBy: string
    lastUsed?: number
  }>,
  user: string,
  cluster: string
): string {
  // Generate mobile cards
  const accountCards =
    accounts.length > 0
      ? accounts
          .map(
            (account) => `
    <div class="card p-6 space-y-4">
      <div class="flex items-start justify-between">
        <div class="min-w-0 flex-1">
          <div class="font-medium truncate cursor-pointer hover:text-muted-foreground transition-colors" onclick="copyToClipboard('${escapeHtml(account.name)}', 'Name')" title="Click to copy">${escapeHtml(account.name)}</div>
          <div class="text-xs text-muted-foreground font-mono truncate mt-1.5 cursor-pointer hover:text-foreground transition-colors" onclick="copyToClipboard('${account.id}', 'Account ID')" title="Click to copy">${account.id}</div>
        </div>
        <span class="badge ${account.active ? 'badge-success' : 'badge-destructive'} ml-3 shrink-0">${account.active ? 'Active' : 'Inactive'}</span>
      </div>
      ${account.description ? `<div class="text-sm text-muted-foreground cursor-pointer hover:text-foreground transition-colors" onclick="copyToClipboard('${escapeHtml(account.description)}', 'Description')" title="Click to copy">${escapeHtml(account.description)}</div>` : ''}
      <div class="flex items-center justify-between text-xs text-muted-foreground">
        <span>Created ${new Date(account.createdAt).toLocaleDateString()}</span>
        <span>${account.lastUsed ? `Used ${formatTimeAgo(account.lastUsed)}` : 'Never used'}</span>
      </div>
      <div class="flex gap-3 pt-4 border-t border-border">
        <button onclick="editAccount('${account.id}')" class="btn btn-ghost btn-sm flex-1">Edit</button>
        <button onclick="rollSecret('${account.id}')" class="btn btn-ghost btn-sm flex-1">Roll Secret</button>
        <button onclick="deleteAccount('${account.id}')" class="btn btn-ghost btn-sm text-red-400 hover:text-red-300">Delete</button>
      </div>
    </div>
  `
          )
          .join('')
      : '<div class="card p-10 text-center text-muted-foreground">No accounts yet. Create one to get started.</div>'

  // Generate table rows
  const accountRows =
    accounts.length > 0
      ? accounts
          .map(
            (account) => `
    <tr class="border-b border-border hover:bg-secondary/30 transition-colors">
      <td class="px-6 py-5">
        <div class="font-medium cursor-pointer hover:text-muted-foreground transition-colors" onclick="copyToClipboard('${escapeHtml(account.name)}', 'Name')" title="Click to copy">${escapeHtml(account.name)}</div>
        ${account.description ? `<div class="text-xs text-muted-foreground mt-1 cursor-pointer hover:text-foreground transition-colors" onclick="copyToClipboard('${escapeHtml(account.description)}', 'Description')" title="Click to copy">${escapeHtml(account.description)}</div>` : ''}
      </td>
      <td class="px-6 py-5">
        <div class="font-mono text-sm cursor-pointer hover:text-muted-foreground transition-colors" onclick="copyToClipboard('${account.id}', 'Account ID')" title="Click to copy">${account.id}</div>
      </td>
      <td class="px-6 py-5">
        <span class="badge ${account.active ? 'badge-success' : 'badge-destructive'}">${account.active ? 'Active' : 'Inactive'}</span>
      </td>
      <td class="px-6 py-5 text-sm text-muted-foreground">
        ${new Date(account.createdAt).toLocaleDateString()}
      </td>
      <td class="px-6 py-5 text-sm text-muted-foreground">
        ${account.lastUsed ? formatTimeAgo(account.lastUsed) : 'Never'}
      </td>
      <td class="px-6 py-5">
        <div class="flex gap-3">
          <button onclick="editAccount('${account.id}')" class="btn btn-ghost btn-sm">Edit</button>
          <button onclick="rollSecret('${account.id}')" class="btn btn-ghost btn-sm">Roll Secret</button>
          <button onclick="deleteAccount('${account.id}')" class="btn btn-ghost btn-sm text-red-400 hover:text-red-300">Delete</button>
        </div>
      </td>
    </tr>
  `
          )
          .join('')
      : '<tr><td colspan="6" class="p-10 text-center text-muted-foreground">No accounts yet. Create one to get started.</td></tr>'

  const content = render(accountsTemplate, {
    account_cards: accountCards,
    account_rows: accountRows,
  })

  return renderPage({
    title: 'Accounts',
    content,
    scripts: accountsScripts,
    activePage: 'accounts',
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
