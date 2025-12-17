/**
 * Admin Dashboard UI
 *
 * Template-based rendering system for easy HTML editing.
 * Templates are imported as raw text and use {{placeholder}} syntax.
 */

import { LATENCY_BUCKETS, type SessionMetrics } from './types'

// Import templates as raw text
import baseTemplate from './templates/base.html'
import dashboardTemplate from './templates/dashboard.html'
import keysTemplate from './templates/keys.html'
import keysScripts from './templates/keys-scripts.html'
import sessionsTemplate from './templates/sessions.html'
import sessionsScripts from './templates/sessions-scripts.html'
import accountsTemplate from './templates/accounts.html'
import accountsScripts from './templates/accounts-scripts.html'
import synchronizersTemplate from './templates/synchronizers.html'
import mapTemplate from './templates/map.html'
import metricsTemplate from './templates/metrics.html'
import storageTemplate from './templates/storage.html'
import settingsTemplate from './templates/settings.html'
import sessionInspectorTemplate from './templates/session-inspector.html'
// Import compiled Tailwind CSS (wrangler rules configured to import as text)
import compiledStyles from './styles/output.css'

/**
 * Simple template engine - replaces {{key}} with values
 */
function render(template: string, data: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = data[key]
    return value !== undefined ? String(value) : ''
  })
}

// ============================================================================
// UI Components
// ============================================================================

/**
 * Generate a dialog/modal with consistent styling
 */
export function dialog(options: {
  id: string
  title: string
  content: string
  footer?: string
  description?: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
}): string {
  const sizeClass = options.size && options.size !== 'lg' ? ` modal-${options.size}` : ''
  const desc = options.description ? `<p class="modal-description">${options.description}</p>` : ''
  const footer = options.footer ? `<div class="modal-footer">${options.footer}</div>` : ''

  return `<dialog id="${options.id}" class="modal${sizeClass}">
  <h3 class="modal-title">${options.title}</h3>
  ${desc}${options.content}${footer}
</dialog>`
}

/**
 * Common button helpers for dialog footers
 */
export const btn = {
  cancel: (dialogId: string, text = 'Cancel') =>
    `<button type="button" onclick="document.getElementById('${dialogId}').close()" class="btn btn-ghost">${text}</button>`,
  close: (dialogId: string, text = 'Close') =>
    `<button type="button" onclick="document.getElementById('${dialogId}').close()" class="btn btn-ghost">${text}</button>`,
  submit: (text = 'Submit') => `<button type="submit" class="btn btn-primary">${text}</button>`,
  primary: (onclick: string, text: string) => `<button onclick="${onclick}" class="btn btn-primary">${text}</button>`,
  secondary: (onclick: string, text: string) => `<button onclick="${onclick}" class="btn btn-secondary">${text}</button>`,
  danger: (onclick: string, text: string) => `<button onclick="${onclick}" class="btn btn-destructive">${text}</button>`,
}

/**
 * Form field helpers
 */
export const field = {
  text: (opts: { name: string; label: string; placeholder?: string; required?: boolean; id?: string; mono?: boolean }) =>
    `<div>
      <label class="text-sm font-medium mb-2 block">${opts.label}</label>
      <input type="text" name="${opts.name}"${opts.id ? ` id="${opts.id}"` : ''}${opts.required ? ' required' : ''} class="input${opts.mono ? ' font-mono' : ''}" placeholder="${opts.placeholder || ''}" />
    </div>`,
  select: (opts: { name: string; label: string; options: string; id?: string; hint?: string }) =>
    `<div>
      <label class="text-sm font-medium mb-2 block">${opts.label}</label>
      <select name="${opts.name}"${opts.id ? ` id="${opts.id}"` : ''} class="input">${opts.options}</select>
      ${opts.hint ? `<p class="text-xs text-muted-foreground mt-1">${opts.hint}</p>` : ''}
    </div>`,
}

/**
 * Render a page with the base layout
 */
function renderPage(options: {
  title: string
  content: string
  scripts?: string
  activePage: 'dashboard' | 'keys' | 'sessions' | 'accounts' | 'synchronizers' | 'map' | 'metrics' | 'storage' | 'settings'
  user: string
  cluster: string
}): string {
  const navActive = 'bg-secondary text-secondary-foreground'
  const navInactive = 'hover:bg-secondary/50 text-muted-foreground hover:text-foreground'

  return render(baseTemplate, {
    title: options.title,
    content: options.content,
    scripts: options.scripts || '',
    styles: compiledStyles,
    cluster: options.cluster,
    user: options.user,
    user_initial: options.user.charAt(0).toUpperCase(),
    nav_dashboard_active: options.activePage === 'dashboard' ? navActive : navInactive,
    nav_keys_active: options.activePage === 'keys' ? navActive : navInactive,
    nav_sessions_active: options.activePage === 'sessions' ? navActive : navInactive,
    nav_accounts_active: options.activePage === 'accounts' ? navActive : navInactive,
    nav_synchronizers_active: options.activePage === 'synchronizers' ? navActive : navInactive,
    nav_map_active: options.activePage === 'map' ? navActive : navInactive,
    nav_metrics_active: options.activePage === 'metrics' ? navActive : navInactive,
    nav_storage_active: options.activePage === 'storage' ? navActive : navInactive,
    nav_settings_active: options.activePage === 'settings' ? navActive : navInactive,
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
        <button onclick="revealKey('${key.id}')" class="btn btn-ghost btn-sm flex-1">Reveal</button>
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
          <button onclick="revealKey('${key.id}')" class="btn btn-ghost btn-sm">Reveal</button>
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
    apiKeyName?: string
    accountId?: string
    accountName?: string
    colo?: string
    region?: string
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
        <a href="/ui/session/${encodeURIComponent(s.sessionId)}" class="font-mono text-xs truncate flex-1 hover:text-primary transition-colors" title="Inspect session">${escapeHtml(s.sessionId)}</a>
        <span class="badge shrink-0 cursor-pointer hover:opacity-80" onclick="copyToClipboard('${escapeHtml(s.appId || 'Unknown')}', 'App ID')" title="Click to copy">${escapeHtml(s.appId || 'Unknown')}</span>
      </div>
      ${s.apiKeyName ? `<div class="text-xs text-muted-foreground">API Key: <span class="font-medium">${escapeHtml(s.apiKeyName)}</span></div>` : ''}
      ${s.accountId ? `<div class="text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors" onclick="copyToClipboard('${s.accountId}', 'Account ID')" title="Click to copy">Account: <span class="font-medium">${escapeHtml(s.accountName || accountMap.get(s.accountId) || s.accountId)}</span></div>` : ''}
      <div class="flex items-center justify-between text-sm">
        <span class="text-muted-foreground">Clients</span>
        <span class="font-semibold">${s.clientCount}</span>
      </div>
      <div class="flex items-center justify-between text-xs text-muted-foreground">
        <span>Location</span>
        <span>${s.region || s.colo || '—'}</span>
      </div>
      <div class="flex items-center justify-between text-xs text-muted-foreground">
        <span>Last activity</span>
        <span>${formatTimeAgo(s.lastSeen)}</span>
      </div>
      <div class="pt-3 border-t border-border flex gap-2">
        <a href="/ui/session/${encodeURIComponent(s.sessionId)}" class="btn btn-ghost btn-sm flex-1">Inspect</a>
        <button onclick="deleteSession('${escapeHtml(s.sessionId)}')" class="btn btn-ghost btn-sm flex-1 text-red-400 hover:text-red-300">End</button>
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
        <a href="/ui/session/${encodeURIComponent(s.sessionId)}" class="font-mono text-sm truncate max-w-xs block hover:text-primary transition-colors" title="Inspect session">${escapeHtml(s.sessionId)}</a>
      </td>
      <td class="px-6 py-5">
        <span class="badge cursor-pointer hover:opacity-80" onclick="copyToClipboard('${escapeHtml(s.appId || 'Unknown')}', 'App ID')" title="Click to copy">${escapeHtml(s.appId || 'Unknown')}</span>
      </td>
      <td class="px-6 py-5 text-sm">
        ${s.apiKeyName ? `<span class="font-medium">${escapeHtml(s.apiKeyName)}</span>` : '<span class="text-muted-foreground">—</span>'}
      </td>
      <td class="px-6 py-5 text-sm">
        ${s.accountId ? `<span class="font-medium cursor-pointer hover:text-foreground transition-colors" onclick="copyToClipboard('${s.accountId}', 'Account ID')" title="Click to copy">${escapeHtml(s.accountName || accountMap.get(s.accountId) || s.accountId)}</span>` : '<span class="text-muted-foreground">—</span>'}
      </td>
      <td class="px-6 py-5">
        <span class="text-lg font-semibold">${s.clientCount}</span>
      </td>
      <td class="px-6 py-5 text-sm text-muted-foreground whitespace-nowrap">
        ${s.region || s.colo || '—'}
      </td>
      <td class="px-6 py-5 text-sm text-muted-foreground whitespace-nowrap">
        ${new Date(s.createdAt).toLocaleString()}
      </td>
      <td class="px-6 py-5 text-sm text-muted-foreground whitespace-nowrap">
        ${formatTimeAgo(s.lastSeen)}
      </td>
      <td class="px-6 py-5 whitespace-nowrap">
        <div class="flex gap-2">
          <a href="/ui/session/${encodeURIComponent(s.sessionId)}" class="btn btn-ghost btn-sm">Inspect</a>
          <button onclick="deleteSession('${escapeHtml(s.sessionId)}')" class="btn btn-ghost btn-sm text-red-400 hover:text-red-300">End</button>
        </div>
      </td>
    </tr>
  `
          )
          .join('')
      : '<tr><td colspan="9" class="p-10 text-center text-muted-foreground">No active sessions</td></tr>'

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
// Synchronizers Page
// ============================================================================

export function renderSynchronizersPage(
  synchronizers: Array<{
    url: string
    label: string
    sessionCount: number
    clientCount: number
    lastSeen: number
    region?: string
  }>,
  user: string,
  cluster: string
): string {
  // Calculate totals
  const totalSynchronizers = synchronizers.length
  const totalSessions = synchronizers.reduce((sum, s) => sum + s.sessionCount, 0)
  const totalClients = synchronizers.reduce((sum, s) => sum + s.clientCount, 0)

  // Generate mobile cards
  const synchronizerCards =
    synchronizers.length > 0
      ? synchronizers
          .map(
            (sync) => `
    <div class="card p-6 space-y-4">
      <div class="flex items-start justify-between">
        <div class="min-w-0 flex-1">
          <div class="font-medium truncate">${escapeHtml(sync.label)}</div>
          <div class="text-xs text-muted-foreground font-mono truncate mt-1.5 cursor-pointer hover:text-foreground transition-colors" onclick="copyToClipboard('${escapeHtml(sync.url)}', 'URL')" title="Click to copy">${escapeHtml(sync.url)}</div>
        </div>
        <span class="badge badge-success ml-3 shrink-0">Active</span>
      </div>
      <div class="flex items-center justify-between text-sm">
        <span class="text-muted-foreground">Region</span>
        <span class="font-medium">${sync.region || 'Unknown'}</span>
      </div>
      <div class="flex items-center justify-between text-sm">
        <span class="text-muted-foreground">Sessions</span>
        <span class="font-semibold">${sync.sessionCount}</span>
      </div>
      <div class="flex items-center justify-between text-sm">
        <span class="text-muted-foreground">Clients</span>
        <span class="font-semibold">${sync.clientCount}</span>
      </div>
      <div class="flex items-center justify-between text-xs text-muted-foreground">
        <span>Last activity</span>
        <span>${formatTimeAgo(sync.lastSeen)}</span>
      </div>
    </div>
  `
          )
          .join('')
      : '<div class="card p-10 text-center text-muted-foreground">No active synchronizers</div>'

  // Generate table rows
  const synchronizerRows =
    synchronizers.length > 0
      ? synchronizers
          .map(
            (sync) => `
    <tr class="border-b border-border hover:bg-secondary/30 transition-colors">
      <td class="px-6 py-5">
        <div class="font-medium">${escapeHtml(sync.label)}</div>
        <div class="text-xs text-muted-foreground font-mono mt-1 cursor-pointer hover:text-foreground transition-colors" onclick="copyToClipboard('${escapeHtml(sync.url)}', 'URL')" title="Click to copy">${escapeHtml(sync.url)}</div>
      </td>
      <td class="px-6 py-5">
        <span class="badge">${sync.region || 'Unknown'}</span>
      </td>
      <td class="px-6 py-5">
        <span class="text-lg font-semibold">${sync.sessionCount}</span>
      </td>
      <td class="px-6 py-5">
        <span class="text-lg font-semibold">${sync.clientCount}</span>
      </td>
      <td class="px-6 py-5 text-sm text-muted-foreground">
        ${formatTimeAgo(sync.lastSeen)}
      </td>
      <td class="px-6 py-5">
        <span class="badge badge-success">Active</span>
      </td>
    </tr>
  `
          )
          .join('')
      : '<tr><td colspan="6" class="p-10 text-center text-muted-foreground">No active synchronizers</td></tr>'

  const content = render(synchronizersTemplate, {
    total_synchronizers: totalSynchronizers,
    total_sessions: totalSessions,
    total_clients: totalClients,
    synchronizer_cards: synchronizerCards,
    synchronizer_rows: synchronizerRows,
  })

  return renderPage({
    title: 'Synchronizers',
    content,
    activePage: 'synchronizers',
    user,
    cluster,
  })
}

// ============================================================================
// Map Page
// ============================================================================

export function renderMapPage(geoJsonData: object, totals: { locations: number; sessions: number; clients: number }, user: string, cluster: string): string {
  const content = render(mapTemplate, {
    total_locations: totals.locations,
    total_sessions: totals.sessions,
    total_clients: totals.clients,
    geojson_data: JSON.stringify(geoJsonData),
  })

  return renderPage({
    title: 'World Map',
    content,
    activePage: 'map',
    user,
    cluster,
  })
}

// ============================================================================
// Metrics Page
// ============================================================================

export function renderMetricsPage(
  sessions: Array<{
    sessionId: string
    appId?: string
    clientCount: number
    metrics?: SessionMetrics
  }>,
  user: string,
  cluster: string
): string {
  // Aggregate totals across all sessions
  const totals = {
    messagesTotal: 0,
    ticksTotal: 0,
    latencyBuckets: new Array(LATENCY_BUCKETS.length).fill(0),
    latencySum: 0,
    latencyCount: 0,
  }

  for (const session of sessions) {
    if (session.metrics) {
      totals.messagesTotal += session.metrics.messagesTotal
      totals.ticksTotal += session.metrics.ticksTotal
      totals.latencySum += session.metrics.latencySum
      totals.latencyCount += session.metrics.latencyCount
      for (let i = 0; i < LATENCY_BUCKETS.length; i++) {
        totals.latencyBuckets[i] += session.metrics.latencyBuckets[i] || 0
      }
    }
  }

  const meanLatency = totals.latencyCount > 0 ? (totals.latencySum / totals.latencyCount).toFixed(1) + 'ms' : 'N/A'

  // Generate latency histogram bars (CSS-based chart)
  const maxBucket = Math.max(...totals.latencyBuckets, 1)
  const latencyChart =
    totals.latencyCount > 0
      ? `<div class="flex items-end gap-1 h-full pb-6">
        ${LATENCY_BUCKETS.map((bucket, i) => {
          const height = Math.max((totals.latencyBuckets[i] / maxBucket) * 100, 4)
          const count = totals.latencyBuckets[i]
          return `<div class="flex-1 relative h-full group">
            <div class="absolute bottom-0 left-0 right-0 bg-primary/80 rounded-t transition-all hover:bg-primary cursor-pointer" style="height: ${height}%" title="${count} requests ≤ ${bucket}ms"></div>
            <span class="absolute -bottom-6 left-1/2 -translate-x-1/2 text-xs text-muted-foreground whitespace-nowrap">${bucket}</span>
          </div>`
        }).join('')}
      </div>`
      : '<div class="flex items-center justify-center h-full text-muted-foreground">No latency data available</div>'

  // Generate session cards for mobile
  const sessionCards =
    sessions.length > 0
      ? sessions
          .map((s) => {
            const sessionMean = s.metrics && s.metrics.latencyCount > 0 ? (s.metrics.latencySum / s.metrics.latencyCount).toFixed(1) + 'ms' : 'N/A'
            return `
    <div class="card p-6 space-y-3">
      <div class="flex items-start justify-between gap-3">
        <div class="font-mono text-xs truncate flex-1 cursor-pointer hover:text-muted-foreground transition-colors" onclick="copyToClipboard('${escapeHtml(s.sessionId)}', 'Session ID')" title="Click to copy">${escapeHtml(s.sessionId.slice(0, 20))}...</div>
        <span class="badge shrink-0">${escapeHtml(s.appId || 'Unknown')}</span>
      </div>
      <div class="grid grid-cols-2 gap-4 text-sm">
        <div>
          <span class="text-muted-foreground">Messages:</span>
          <span class="font-semibold ml-1">${formatNumber(s.metrics?.messagesTotal || 0)}</span>
        </div>
        <div>
          <span class="text-muted-foreground">Ticks:</span>
          <span class="font-semibold ml-1">${formatNumber(s.metrics?.ticksTotal || 0)}</span>
        </div>
        <div>
          <span class="text-muted-foreground">Latency:</span>
          <span class="font-semibold ml-1">${sessionMean}</span>
        </div>
        <div>
          <span class="text-muted-foreground">Clients:</span>
          <span class="font-semibold ml-1">${s.clientCount}</span>
        </div>
      </div>
    </div>`
          })
          .join('')
      : '<div class="p-10 text-center text-muted-foreground">No sessions with metrics data</div>'

  // Generate session rows for desktop table
  const sessionRows =
    sessions.length > 0
      ? sessions
          .map((s) => {
            const sessionMean = s.metrics && s.metrics.latencyCount > 0 ? (s.metrics.latencySum / s.metrics.latencyCount).toFixed(1) + 'ms' : 'N/A'
            return `
    <tr class="border-b border-border hover:bg-secondary/30 transition-colors">
      <td class="px-6 py-4">
        <div class="font-mono text-sm truncate max-w-xs cursor-pointer hover:text-muted-foreground transition-colors" onclick="copyToClipboard('${escapeHtml(s.sessionId)}', 'Session ID')" title="Click to copy">${escapeHtml(s.sessionId)}</div>
      </td>
      <td class="px-6 py-4">
        <span class="badge">${escapeHtml(s.appId || 'Unknown')}</span>
      </td>
      <td class="px-6 py-4 font-semibold">${formatNumber(s.metrics?.messagesTotal || 0)}</td>
      <td class="px-6 py-4 font-semibold">${formatNumber(s.metrics?.ticksTotal || 0)}</td>
      <td class="px-6 py-4 font-semibold">${sessionMean}</td>
      <td class="px-6 py-4 font-semibold">${s.clientCount}</td>
    </tr>`
          })
          .join('')
      : '<tr><td colspan="6" class="p-10 text-center text-muted-foreground">No sessions with metrics data</td></tr>'

  const content = render(metricsTemplate, {
    total_messages: formatNumber(totals.messagesTotal),
    total_ticks: formatNumber(totals.ticksTotal),
    mean_latency: meanLatency,
    active_sessions: sessions.filter((s) => s.metrics).length,
    latency_chart: latencyChart,
    session_count: sessions.length,
    session_cards: sessionCards,
    session_rows: sessionRows,
  })

  return renderPage({
    title: 'Metrics',
    content,
    activePage: 'metrics',
    user,
    cluster,
  })
}

function formatNumber(num: number): string {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M'
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K'
  return num.toString()
}

// ============================================================================
// Storage Page
// ============================================================================

interface StorageNamespace {
  name: string
  binding: string
  keyCount: number
  estimatedSize: number
  description: string
}

interface StorageKey {
  namespace: string
  key: string
  size: number
  updatedAt?: number
}

interface SnapshotMetrics {
  totalSessions: number
  totalSnapshots: number
  totalSize: number
  avgSnapshotsPerSession: number
  avgSizePerSession: number
  avgSnapshotSize: number
}

export function renderStoragePage(
  namespaces: StorageNamespace[],
  recentKeys: StorageKey[],
  snapshotMetrics: SnapshotMetrics | null,
  user: string,
  cluster: string
): string {
  // Calculate totals
  const totalKeys = namespaces.reduce((sum, ns) => sum + ns.keyCount, 0)
  const totalSize = namespaces.reduce((sum, ns) => sum + ns.estimatedSize, 0)

  // Format size helper
  const formatSize = (bytes: number): string => {
    if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
    if (bytes >= 1024) return (bytes / 1024).toFixed(2) + ' KB'
    return bytes + ' B'
  }

  // Generate namespace cards for mobile
  const namespaceCards =
    namespaces.length > 0
      ? namespaces
          .map(
            (ns) => `
    <div class="card p-6 space-y-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="font-semibold">${escapeHtml(ns.name)}</div>
          <div class="text-xs text-muted-foreground mt-1">${escapeHtml(ns.binding)}</div>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-4 text-sm">
        <div>
          <span class="text-muted-foreground">Keys:</span>
          <span class="font-semibold ml-1">${formatNumber(ns.keyCount)}</span>
        </div>
        <div>
          <span class="text-muted-foreground">Size:</span>
          <span class="font-semibold ml-1">${formatSize(ns.estimatedSize)}</span>
        </div>
      </div>
      <div class="text-sm text-muted-foreground">${escapeHtml(ns.description)}</div>
    </div>`
          )
          .join('')
      : '<div class="p-10 text-center text-muted-foreground">No KV namespaces configured</div>'

  // Generate namespace rows for desktop table
  const namespaceRows =
    namespaces.length > 0
      ? namespaces
          .map(
            (ns) => `
    <tr class="border-b border-border hover:bg-secondary/30 transition-colors">
      <td class="px-6 py-4">
        <div class="font-semibold">${escapeHtml(ns.name)}</div>
        <div class="text-xs text-muted-foreground">${escapeHtml(ns.binding)}</div>
      </td>
      <td class="px-6 py-4 font-semibold">${formatNumber(ns.keyCount)}</td>
      <td class="px-6 py-4 font-semibold">${formatSize(ns.estimatedSize)}</td>
      <td class="px-6 py-4 text-muted-foreground">${escapeHtml(ns.description)}</td>
    </tr>`
          )
          .join('')
      : '<tr><td colspan="4" class="p-10 text-center text-muted-foreground">No KV namespaces configured</td></tr>'

  // Generate recent keys list
  const recentKeysHtml =
    recentKeys.length > 0
      ? recentKeys
          .map(
            (k) => `
    <div class="card p-4 flex items-center justify-between gap-4">
      <div class="flex-1 min-w-0">
        <div class="font-mono text-sm truncate cursor-pointer hover:text-muted-foreground transition-colors" onclick="copyToClipboard('${escapeHtml(k.key)}', 'Key')" title="Click to copy">${escapeHtml(k.key)}</div>
        <div class="text-xs text-muted-foreground mt-1">${escapeHtml(k.namespace)}${k.updatedAt ? ' • ' + formatTimeAgo(k.updatedAt) : ''}</div>
      </div>
      <div class="text-sm font-semibold shrink-0">${formatSize(k.size)}</div>
    </div>`
          )
          .join('')
      : '<div class="p-10 text-center text-muted-foreground">No recent keys</div>'

  // Generate snapshot statistics section
  const snapshotStatsHtml = snapshotMetrics
    ? `
    <div class="card">
      <div class="p-6 border-b border-border">
        <h3 class="font-semibold">Snapshot Statistics</h3>
        <p class="text-sm text-muted-foreground mt-1">R2 storage breakdown for session snapshots</p>
      </div>
      <div class="p-6">
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-6">
          <div>
            <div class="text-muted-foreground text-sm font-medium">Sessions with Snapshots</div>
            <div class="text-2xl font-bold mt-1">${formatNumber(snapshotMetrics.totalSessions)}</div>
          </div>
          <div>
            <div class="text-muted-foreground text-sm font-medium">Total Snapshots</div>
            <div class="text-2xl font-bold mt-1">${formatNumber(snapshotMetrics.totalSnapshots)}</div>
          </div>
          <div>
            <div class="text-muted-foreground text-sm font-medium">Total Size</div>
            <div class="text-2xl font-bold mt-1">${formatSize(snapshotMetrics.totalSize)}</div>
          </div>
          <div>
            <div class="text-muted-foreground text-sm font-medium">Avg. Snapshots/Session</div>
            <div class="text-2xl font-bold mt-1">${snapshotMetrics.avgSnapshotsPerSession.toFixed(1)}</div>
          </div>
          <div>
            <div class="text-muted-foreground text-sm font-medium">Avg. Size/Session</div>
            <div class="text-2xl font-bold mt-1">${formatSize(snapshotMetrics.avgSizePerSession)}</div>
          </div>
          <div>
            <div class="text-muted-foreground text-sm font-medium">Avg. Snapshot Size</div>
            <div class="text-2xl font-bold mt-1">${formatSize(snapshotMetrics.avgSnapshotSize)}</div>
          </div>
        </div>
      </div>
    </div>`
    : ''

  const content = render(storageTemplate, {
    total_keys: formatNumber(totalKeys),
    total_size: formatSize(totalSize),
    namespace_count: namespaces.length,
    namespace_cards: namespaceCards,
    namespace_rows: namespaceRows,
    recent_keys: recentKeysHtml,
    snapshot_stats: snapshotStatsHtml,
  })

  return renderPage({
    title: 'Storage',
    content,
    activePage: 'storage',
    user,
    cluster,
  })
}

// ============================================================================
// Settings Page
// ============================================================================

export function renderSettingsPage(
  settings: {
    synchronizer_registration_enabled: boolean
    require_api_key: boolean
    max_sessions_per_synchronizer: number
    track_client_locations: boolean
    snapshot_retention_days: number
  },
  user: string,
  cluster: string
): string {
  const content = render(settingsTemplate, {
    synchronizer_registration_checked: settings.synchronizer_registration_enabled ? 'checked' : '',
    require_api_key_checked: settings.require_api_key ? 'checked' : '',
    max_sessions_per_synchronizer: settings.max_sessions_per_synchronizer,
    track_client_locations_checked: settings.track_client_locations ? 'checked' : '',
    snapshot_retention_days: settings.snapshot_retention_days,
  })

  return renderPage({
    title: 'Settings',
    content,
    activePage: 'settings',
    user,
    cluster,
  })
}

// ============================================================================
// Session Inspector Page
// ============================================================================

export interface SessionInspectorData {
  sessionId: string
  sessionName?: string
  status: string
  location: { edge?: string; durable?: string }
  timing?: {
    time: number
    seq: number
    tick: number
    scale: number
    createdAt: number
    lastActivity: number
  }
  snapshot?: {
    time?: number
    seq?: number
    url?: string
    persistentUrl?: string
  }
  messages: { buffered: number; maxBuffer: number }
  clients: {
    count: number
    list: Array<{
      clientId: string
      active: boolean
      joined: boolean
      colo?: string
      joinedAt: number
      lastSeen: number
      userId?: unknown // Can be string, object, or array per Croquet protocol
      isLeader?: boolean
    }>
  }
  metrics?: SessionMetrics
  tallies: number
  flags?: Record<string, unknown>
  snapshots: Array<{
    time: number
    seq: number
    size: number
    sizeHuman: string
    createdAt: number
    createdAtHuman: string
  }>
  synchronizerUrl: string
}

export function renderSessionInspectorPage(data: SessionInspectorData, user: string, cluster: string): string {
  // Generate client rows
  const clientRows =
    data.clients.list.length > 0
      ? data.clients.list
          .map(
            (c) => `
    <div class="p-4 hover:bg-secondary/30 transition-colors">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          ${c.isLeader ? '<span class="badge badge-success text-xs">Leader</span>' : ''}
          <span class="badge ${c.active ? 'badge-success' : 'badge-warning'}">${c.active ? 'Active' : 'Joining'}</span>
        </div>
        <span class="text-sm text-muted-foreground">${c.colo || 'Unknown'}</span>
      </div>
      <div class="mt-2 space-y-1">
        <div class="font-mono text-xs text-muted-foreground truncate cursor-pointer hover:text-foreground transition-colors" onclick="copyToClipboard('${c.clientId}', 'Client ID')" title="Click to copy">${c.clientId}</div>
        ${c.userId ? `<div class="text-xs text-muted-foreground">User: ${escapeHtml(formatUserId(c.userId))}</div>` : ''}
        <div class="text-xs text-muted-foreground">Joined: ${formatTimeAgo(c.joinedAt)} • Last seen: ${formatTimeAgo(c.lastSeen)}</div>
      </div>
    </div>`
          )
          .join('')
      : '<div class="p-6 text-center text-muted-foreground">No connected clients</div>'

  // Generate snapshot rows
  const snapshotRows =
    data.snapshots.length > 0
      ? data.snapshots
          .map(
            (s) => `
    <div class="p-4 hover:bg-secondary/30 transition-colors">
      <div class="flex items-center justify-between">
        <div>
          <div class="font-mono text-sm">seq: ${s.seq}, time: ${s.time}</div>
          <div class="text-xs text-muted-foreground mt-1">${s.createdAtHuman}</div>
        </div>
        <span class="badge">${s.sizeHuman}</span>
      </div>
    </div>`
          )
          .join('')
      : '<div class="p-6 text-center text-muted-foreground">No snapshots stored</div>'

  // Generate flags section
  const flagsSection =
    data.flags && Object.keys(data.flags).length > 0
      ? `<div class="card">
        <div class="p-5 border-b border-border">
          <h3 class="font-semibold">Flags</h3>
        </div>
        <div class="p-5 space-y-2">
          ${Object.entries(data.flags)
            .map(([key, value]) => `<div class="flex justify-between"><span class="text-muted-foreground">${escapeHtml(key)}</span><span class="font-mono text-sm">${escapeHtml(String(value))}</span></div>`)
            .join('')}
        </div>
      </div>`
      : ''

  const content = render(sessionInspectorTemplate, {
    session_id: data.sessionId,
    session_id_encoded: encodeURIComponent(data.sessionId),
    status: data.status,
    status_badge: data.status === 'active' ? 'badge-success' : 'badge-warning',
    client_count: data.clients.count,
    messages_buffered: data.messages.buffered,
    messages_max: formatNumber(data.messages.maxBuffer),
    session_time: data.timing?.time ?? 0,
    session_seq: data.timing?.seq ?? 0,
    edge_colo: data.location.edge || '—',
    do_colo: data.location.durable || '—',
    tick_interval: data.timing?.tick ?? 50,
    time_scale: data.timing?.scale ?? 1,
    created_at: data.timing?.createdAt ? new Date(data.timing.createdAt).toLocaleString() : '—',
    last_activity: data.timing?.lastActivity ? formatTimeAgo(data.timing.lastActivity) : '—',
    snapshot_time: data.snapshot?.time ?? '—',
    snapshot_seq: data.snapshot?.seq ?? '—',
    has_snapshot: data.snapshot?.url ? 'Yes' : 'No',
    snapshot_badge: data.snapshot?.url ? 'badge-success' : '',
    has_persistent: data.snapshot?.persistentUrl ? 'Yes' : 'No',
    persistent_badge: data.snapshot?.persistentUrl ? 'badge-success' : '',
    metrics_messages: formatNumber(data.metrics?.messagesTotal ?? 0),
    metrics_ticks: formatNumber(data.metrics?.ticksTotal ?? 0),
    tallies_count: data.tallies,
    client_rows: clientRows,
    snapshot_count: data.snapshots.length,
    snapshot_rows: snapshotRows,
    flags_section: flagsSection,
    sync_url: data.synchronizerUrl,
  })

  return renderPage({
    title: `Session: ${data.sessionId.slice(0, 20)}...`,
    content,
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

function escapeHtml(str: unknown): string {
  const s = String(str ?? '')
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}

/**
 * Format userId for display - can be string, object, or array
 */
function formatUserId(userId: unknown): string {
  if (!userId) return ''
  if (typeof userId === 'string') return userId
  if (Array.isArray(userId)) return userId.map((u) => (typeof u === 'string' ? u : JSON.stringify(u))).join(', ')
  if (typeof userId === 'object') {
    // Try to extract common user fields
    const u = userId as Record<string, unknown>
    if (u.name) return String(u.name)
    if (u.id) return String(u.id)
    if (u.userId) return String(u.userId)
    // Fallback to compact JSON
    return JSON.stringify(userId)
  }
  return String(userId)
}
