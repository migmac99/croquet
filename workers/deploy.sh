#!/usr/bin/env bash
set -euo pipefail

#
# Croquet Workers - One-Button Deploy
#
# Generates wrangler.toml from deploy.config.json and deploys.
#
# Usage:
#   ./deploy.sh              # Deploy all to production
#   ./deploy.sh staging      # Deploy all to staging
#   ./deploy.sh dev          # Run all workers locally
#   ./deploy.sh dev:sync     # Run only synchronizer locally
#   ./deploy.sh sync         # Deploy only synchronizer
#   ./deploy.sh mgr          # Deploy only manager
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/deploy.config.json"
SYNC_DIR="${SCRIPT_DIR}/synchronizer"
MGR_DIR="${SCRIPT_DIR}/manager"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${BLUE}[deploy]${NC} $1" >&2; }
success() { echo -e "${GREEN}✓${NC} $1" >&2; }
warn() { echo -e "${YELLOW}⚠${NC} $1" >&2; }
error() { echo -e "${RED}✗${NC} $1" >&2; exit 1; }
header() { echo -e "\n${CYAN}━━━ $1 ━━━${NC}\n" >&2; }

# Check dependencies
check_deps() {
    if ! command -v bun >/dev/null 2>&1; then
        warn "bun not found, attempting to install..."
        curl -fsSL https://bun.sh/install | bash
        export PATH="$HOME/.bun/bin:$PATH"
    fi
    command -v bun >/dev/null 2>&1 || error "bun is required"
    command -v jq >/dev/null 2>&1 || error "jq is required (brew install jq)"
    success "Dependencies OK (bun $(bun --version))"
}

# Read config value
config() {
    jq -r "$1 // empty" "$CONFIG_FILE"
}

# Install dependencies
install_deps() {
    local dir="$1"
    cd "$dir"
    if [ ! -d "node_modules" ] || [ "package.json" -nt "node_modules" ]; then
        log "Installing dependencies in $(basename "$dir")..."
        bun install
    fi
}

# Check Cloudflare auth
check_auth() {
    log "Checking Cloudflare authentication..."
    if ! bunx wrangler whoami >/dev/null 2>&1; then
        warn "Not logged in to Cloudflare"
        bunx wrangler login
    fi
    success "Authenticated with Cloudflare"
}

# Create R2 bucket if needed
setup_r2() {
    local bucket_name=$(config '.synchronizer.r2.bucketName')
    local create_if_missing=$(config '.synchronizer.r2.createIfMissing')

    if [ "$create_if_missing" = "true" ] && [ -n "$bucket_name" ]; then
        log "Checking R2 bucket: $bucket_name"
        if ! CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" bunx wrangler r2 bucket list 2>/dev/null | grep -q "\"$bucket_name\""; then
            log "Creating R2 bucket: $bucket_name"
            CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" bunx wrangler r2 bucket create "$bucket_name" 2>/dev/null || warn "Bucket may already exist"
        fi
        success "R2 bucket ready: $bucket_name"
    fi
}

# Create KV namespace and return ID
# Usage: setup_kv_namespace <namespace_name>
setup_kv_namespace() {
    local namespace="$1"

    if [ -z "$namespace" ]; then
        echo ""
        return
    fi

    log "Checking KV namespace: $namespace"

    # Get existing namespace ID
    local kv_list=$(CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" bunx wrangler kv namespace list 2>/dev/null || echo "[]")
    local kv_id=$(echo "$kv_list" | jq -r ".[] | select(.title==\"$namespace\") | .id" 2>/dev/null || echo "")

    if [ -z "$kv_id" ]; then
        log "Creating KV namespace: $namespace"
        local output=$(CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" bunx wrangler kv namespace create "$namespace" 2>&1)
        kv_id=$(echo "$output" | grep -o 'id = "[^"]*"' | cut -d'"' -f2 || echo "")
    fi

    if [ -n "$kv_id" ]; then
        success "KV namespace ready: $namespace ($kv_id)"
        echo "$kv_id"
    else
        warn "Could not get KV namespace ID for $namespace"
        echo ""
    fi
}

# Setup synchronizer KV namespaces
setup_sync_kv() {
    local sessions_ns=$(config '.synchronizer.kv.sessions.namespace')
    local apikeys_ns=$(config '.synchronizer.kv.apikeys.namespace')
    local persist_ns=$(config '.synchronizer.kv.persist.namespace')

    SESSIONS_KV_ID=$(setup_kv_namespace "$sessions_ns")
    APIKEYS_KV_ID=$(setup_kv_namespace "$apikeys_ns")
    PERSIST_KV_ID=$(setup_kv_namespace "$persist_ns")
}

# Setup manager KV namespaces (includes accounts)
setup_manager_kv() {
    local sessions_ns=$(config '.manager.kv.sessions.namespace')
    local apikeys_ns=$(config '.manager.kv.apikeys.namespace')
    local accounts_ns=$(config '.manager.kv.accounts.namespace')
    local synchronizers_ns=$(config '.manager.kv.synchronizers.namespace')
    local settings_ns=$(config '.manager.kv.settings.namespace')

    # Reuse synchronizer KV IDs for sessions and apikeys
    SESSIONS_KV_ID=$(setup_kv_namespace "$sessions_ns")
    APIKEYS_KV_ID=$(setup_kv_namespace "$apikeys_ns")

    # Setup accounts KV (manager-specific)
    if [ -n "$accounts_ns" ]; then
        ACCOUNTS_KV_ID=$(setup_kv_namespace "$accounts_ns")
        if [ -z "$ACCOUNTS_KV_ID" ]; then
            ACCOUNTS_KV_ID="synq-accounts-local-dev"
            warn "Using placeholder ID for accounts KV (local dev only)"
        fi
    fi

    # Setup synchronizers KV (manager-specific)
    if [ -n "$synchronizers_ns" ]; then
        SYNCHRONIZERS_KV_ID=$(setup_kv_namespace "$synchronizers_ns")
        if [ -z "$SYNCHRONIZERS_KV_ID" ]; then
            SYNCHRONIZERS_KV_ID="db78ac82d365452e803bf7219b1e141c"
            warn "Using placeholder ID for synchronizers KV (local dev only)"
        fi
    fi

    # Setup settings KV (manager-specific)
    if [ -n "$settings_ns" ]; then
        SETTINGS_KV_ID=$(setup_kv_namespace "$settings_ns")
        if [ -z "$SETTINGS_KV_ID" ]; then
            SETTINGS_KV_ID="74e70219a8c247fdb8fbf2549fc0a84b"
            warn "Using placeholder ID for settings KV (local dev only)"
        fi
    fi
}

# Generate synchronizer wrangler.toml from config
generate_sync_config() {
    local sessions_kv_id="$1"
    local apikeys_kv_id="$2"
    local persist_kv_id="$3"
    local account_id=$(config '.accountId')
    local name=$(config '.synchronizer.name')
    local domain=$(config '.synchronizer.domain')
    local bucket=$(config '.synchronizer.r2.bucketName')

    # Get vars as JSON and convert to TOML
    local vars=$(config '.synchronizer.vars')
    local vars_toml=$(echo "$vars" | jq -r 'to_entries | .[] | "\(.key) = \"\(.value)\""')
    # Local dev vars - override CLUSTER_LABEL
    local local_vars_toml=$(echo "$vars" | jq -r '.CLUSTER_LABEL = "local-dev" | to_entries | .[] | "\(.key) = \"\(.value)\""')

    cat > "$SYNC_DIR/wrangler.toml" << EOF
# Croquet Synchronizer Worker
# Direct client connections - no registry needed
name = "$name"
main = "src/index.ts"
compatibility_date = "2024-11-01"
compatibility_flags = ["nodejs_compat"]
account_id = "$account_id"

[[migrations]]
tag = "v1"
new_classes = ["Synchronizer"]

# ============================================================================
# Default/Local development configuration
# ============================================================================
[durable_objects]
bindings = [
  { name = "SYNCHRONIZER", class_name = "Synchronizer" }
]

[[r2_buckets]]
binding = "SNAPSHOTS"
bucket_name = "${bucket}-dev"

# KV namespaces
[[kv_namespaces]]
binding = "APIKEYS"
id = "$apikeys_kv_id"

[[kv_namespaces]]
binding = "SESSIONS"
id = "$sessions_kv_id"

[[kv_namespaces]]
binding = "PERSIST"
id = "$persist_kv_id"

[vars]
$local_vars_toml

# ============================================================================
# Production environment
# ============================================================================
[env.production]
name = "$name"
routes = [
  { pattern = "$domain", custom_domain = true }
]

[env.production.observability]
enabled = true

[env.production.durable_objects]
bindings = [
  { name = "SYNCHRONIZER", class_name = "Synchronizer" }
]

[[env.production.r2_buckets]]
binding = "SNAPSHOTS"
bucket_name = "$bucket"

[[env.production.kv_namespaces]]
binding = "APIKEYS"
id = "$apikeys_kv_id"

[[env.production.kv_namespaces]]
binding = "SESSIONS"
id = "$sessions_kv_id"

[[env.production.kv_namespaces]]
binding = "PERSIST"
id = "$persist_kv_id"

[env.production.vars]
$vars_toml

# ============================================================================
# Staging environment
# ============================================================================
[env.staging]
name = "${name}-staging"
routes = [
  { pattern = "${domain/synq/synq-staging}", custom_domain = true }
]

[env.staging.observability]
enabled = true

[env.staging.durable_objects]
bindings = [
  { name = "SYNCHRONIZER", class_name = "Synchronizer" }
]

[[env.staging.r2_buckets]]
binding = "SNAPSHOTS"
bucket_name = "${bucket}-staging"

[[env.staging.kv_namespaces]]
binding = "APIKEYS"
id = "$apikeys_kv_id"

[[env.staging.kv_namespaces]]
binding = "SESSIONS"
id = "$sessions_kv_id"

[[env.staging.kv_namespaces]]
binding = "PERSIST"
id = "$persist_kv_id"

[env.staging.vars]
$vars_toml
EOF

    success "Generated synchronizer wrangler.toml"
}

# Deploy synchronizer
deploy_sync() {
    header "Deploying Synchronizer"

    setup_sync_kv
    generate_sync_config "$SESSIONS_KV_ID" "$APIKEYS_KV_ID" "$PERSIST_KV_ID"
    setup_r2

    cd "$SYNC_DIR"
    install_deps "$SYNC_DIR"

    log "Deploying synchronizer..."
    if [ "$ENV" = "production" ]; then
        CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" bunx wrangler deploy --env production
    elif [ "$ENV" = "staging" ]; then
        CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" bunx wrangler deploy --env staging
    else
        CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" bunx wrangler deploy
    fi
    success "Synchronizer deployed!"
}

# Generate manager wrangler.toml from config
generate_mgr_config() {
    local sessions_kv_id="$1"
    local apikeys_kv_id="$2"
    local accounts_kv_id="$3"
    local synchronizers_kv_id="$4"
    local settings_kv_id="$5"
    local account_id=$(config '.accountId')
    local name=$(config '.manager.name')
    local domain=$(config '.manager.domain')
    local bucket=$(config '.manager.r2.bucketName // empty')

    # R2 bindings (only if bucket configured)
    local r2_dev="" r2_prod="" r2_staging=""
    if [ -n "$bucket" ]; then
        r2_dev=$'\n[[r2_buckets]]\nbinding = "SNAPSHOTS"\nbucket_name = "'"${bucket}-dev"'"'
        r2_prod=$'\n[[env.production.r2_buckets]]\nbinding = "SNAPSHOTS"\nbucket_name = "'"${bucket}"'"'
        r2_staging=$'\n[[env.staging.r2_buckets]]\nbinding = "SNAPSHOTS"\nbucket_name = "'"${bucket}-staging"'"'
    fi

    # Get vars as JSON
    local vars=$(config '.manager.vars')
    local vars_toml=$(echo "$vars" | jq -r 'to_entries | .[] | "\(.key) = \"\(.value)\""')

    cat > "$MGR_DIR/wrangler.toml" << EOF
# Auto-generated from deploy.config.json - do not edit manually
name = "$name"
main = "src/index.ts"
compatibility_date = "2024-11-01"
compatibility_flags = ["nodejs_compat"]
account_id = "$account_id"

# Asset import rules - treat HTML and CSS as text
[[rules]]
type = "Text"
globs = ["**/*.html", "**/*.css"]
fallthrough = true

# Local dev bindings (wrangler creates local KV stores)
[[kv_namespaces]]
binding = "SESSIONS"
id = "$sessions_kv_id"

[[kv_namespaces]]
binding = "APIKEYS"
id = "$apikeys_kv_id"

[[kv_namespaces]]
binding = "ACCOUNTS"
id = "$accounts_kv_id"

[[kv_namespaces]]
binding = "SYNCHRONIZERS"
id = "$synchronizers_kv_id"

[[kv_namespaces]]
binding = "SETTINGS"
id = "$settings_kv_id"
$r2_dev

[vars]
SYNCHRONIZER_URL = "ws://localhost:8787"
CLUSTER_LABEL = "local-dev"
ACCESS_AUD = ""

# ============================================================================
# Production environment
# ============================================================================
[env.production]
name = "$name"
routes = [
  { pattern = "$domain", custom_domain = true }
]

[env.production.observability]
enabled = true

[[env.production.kv_namespaces]]
binding = "SESSIONS"
id = "$sessions_kv_id"

[[env.production.kv_namespaces]]
binding = "APIKEYS"
id = "$apikeys_kv_id"

[[env.production.kv_namespaces]]
binding = "ACCOUNTS"
id = "$accounts_kv_id"

[[env.production.kv_namespaces]]
binding = "SYNCHRONIZERS"
id = "$synchronizers_kv_id"

[[env.production.kv_namespaces]]
binding = "SETTINGS"
id = "$settings_kv_id"
$r2_prod

[env.production.vars]
$vars_toml
ACCESS_AUD = "e17f88cd436d653b7dd5c79b1f0f3258382f9eb9ee79928a0d49e1cd7841199b"

# ============================================================================
# Staging environment
# ============================================================================
[env.staging]
name = "${name}-staging"
routes = [
  { pattern = "${domain/synqmanager/synqmanager-staging}", custom_domain = true }
]

[env.staging.observability]
enabled = true

[[env.staging.kv_namespaces]]
binding = "SESSIONS"
id = "$sessions_kv_id"

[[env.staging.kv_namespaces]]
binding = "APIKEYS"
id = "$apikeys_kv_id"

[[env.staging.kv_namespaces]]
binding = "ACCOUNTS"
id = "$accounts_kv_id"

[[env.staging.kv_namespaces]]
binding = "SYNCHRONIZERS"
id = "$synchronizers_kv_id"

[[env.staging.kv_namespaces]]
binding = "SETTINGS"
id = "$settings_kv_id"
$r2_staging

[env.staging.vars]
$vars_toml
ACCESS_AUD = ""
EOF

    success "Generated manager wrangler.toml"
}

# Deploy manager
deploy_mgr() {
    header "Deploying Manager"
    local domain=$(config '.manager.domain')

    # Setup manager KV namespaces (includes accounts, synchronizers, settings)
    setup_manager_kv
    generate_mgr_config "$SESSIONS_KV_ID" "$APIKEYS_KV_ID" "$ACCOUNTS_KV_ID" "$SYNCHRONIZERS_KV_ID" "$SETTINGS_KV_ID"

    cd "$MGR_DIR"
    install_deps "$MGR_DIR"

    log "Deploying manager..."
    if [ "$ENV" = "production" ]; then
        CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" bunx wrangler deploy --env production
    elif [ "$ENV" = "staging" ]; then
        CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" bunx wrangler deploy --env staging
    else
        CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" bunx wrangler deploy
    fi
    success "Manager deployed!"

    warn "IMPORTANT: Configure Cloudflare Access for https://$domain"
    echo "  1. Go to Cloudflare Zero Trust Dashboard"
    echo "  2. Access > Applications > Add Application > Self-hosted"
    echo "  3. Set domain: $domain"
    echo "  4. Add policy: Allow emails from your domain"
    echo "  5. Copy the Application Audience (AUD) tag"
    echo "  6. Set ACCESS_AUD in wrangler.toml or as secret"
}

# Run single worker locally
run_dev_sync() {
    header "Starting Synchronizer (dev)"
    setup_sync_kv
    generate_sync_config "$SESSIONS_KV_ID" "$APIKEYS_KV_ID" "$PERSIST_KV_ID"
    cd "$SYNC_DIR"
    install_deps "$SYNC_DIR"
    CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" bunx wrangler dev --port 8787 2>&1 | sed -l 's/\[wrangler:info\] //g; s/\[wrangler:err\] //g; s/\[wrangler:warn\] //g'
}

# Run all workers locally in parallel
run_dev_all() {
    header "Starting Full Stack (dev)"

    # Generate configs
    setup_sync_kv
    setup_manager_kv  # Also sets up ACCOUNTS_KV_ID, SYNCHRONIZERS_KV_ID, SETTINGS_KV_ID
    generate_sync_config "$SESSIONS_KV_ID" "$APIKEYS_KV_ID" "$PERSIST_KV_ID"
    generate_mgr_config "$SESSIONS_KV_ID" "$APIKEYS_KV_ID" "$ACCOUNTS_KV_ID" "$SYNCHRONIZERS_KV_ID" "$SETTINGS_KV_ID"

    # Install deps
    install_deps "$SYNC_DIR"
    install_deps "$MGR_DIR"

    echo ""
    echo -e "${CYAN}Starting workers on:${NC}"
    echo "  Synchronizer: http://localhost:8787 (ws://localhost:8787)"
    echo "  Manager:      http://localhost:8789"
    echo ""
    echo -e "${YELLOW}Press Ctrl+C to stop all workers${NC}"
    echo ""

    # Trap to kill all background processes on exit
    trap 'kill $(jobs -p) 2>/dev/null; exit' INT TERM

    # Shared local state directory for KV namespaces
    local PERSIST_DIR="$SCRIPT_DIR/wrangler_shared"

    # Start all workers in background with colored prefixes
    (cd "$SYNC_DIR" && FORCE_COLOR=1 CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" bunx wrangler dev --port 8787 --inspector-port 9229 --persist-to "$PERSIST_DIR" 2>&1 | sed -l 's/\[wrangler:info\] //g; s/\[wrangler:err\] //g; s/\[wrangler:warn\] //g' | sed -l $'s/^/\033[0;36m[syq] \033[0m /') &
    (cd "$MGR_DIR" && FORCE_COLOR=1 CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" bunx wrangler dev --port 8789 --inspector-port 9231 --persist-to "$PERSIST_DIR" 2>&1 | sed -l 's/\[wrangler:info\] //g; s/\[wrangler:err\] //g; s/\[wrangler:warn\] //g' | sed -l $'s/^/\033[1;33m[mgr] \033[0m /') &

    # Wait for all background jobs
    wait
}

# Print deployment info
print_info() {
    local sync_domain=$(config '.synchronizer.domain')
    local mgr_domain=$(config '.manager.domain')

    echo ""
    echo -e "${GREEN}════════════════════════════════════════${NC}"
    echo -e "${GREEN}         Deployment Complete!           ${NC}"
    echo -e "${GREEN}════════════════════════════════════════${NC}"
    echo ""
    echo "  Synchronizer: wss://$sync_domain"
    echo "  Manager:      https://$mgr_domain"
    echo ""
    echo "  Use in app:"
    echo "    Session.join({ reflector: 'wss://$sync_domain' })"
    echo ""
    echo "  Admin (requires Cloudflare Access login):"
    echo "    https://$mgr_domain"
    echo ""
    echo "  Dashboard: https://dash.cloudflare.com"
    echo ""
}

# Tail logs from deployed workers
# Filter out noisy Alarm logs
TAIL_FILTER='grep -v -i "alarm"'

tail_sync() {
    local env_flag=""
    [ "$ENV" = "staging" ] && env_flag="--env staging"
    header "Tailing Synchronizer logs ($ENV)"
    cd "$SYNC_DIR"
    CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" bunx wrangler tail $env_flag --format pretty 2>&1 | eval "$TAIL_FILTER"
}

tail_mgr() {
    local env_flag=""
    [ "$ENV" = "staging" ] && env_flag="--env staging"
    header "Tailing Manager logs ($ENV)"
    cd "$MGR_DIR"
    CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" bunx wrangler tail $env_flag --format pretty 2>&1 | eval "$TAIL_FILTER"
}

tail_all() {
    header "Tailing all workers ($ENV)"
    local env_flag=""
    [ "$ENV" = "staging" ] && env_flag="--env staging"

    echo ""
    echo -e "${CYAN}Tailing logs from:${NC}"
    echo "  Synchronizer, Manager"
    echo ""
    echo -e "${YELLOW}Press Ctrl+C to stop${NC}"
    echo ""

    trap 'kill $(jobs -p) 2>/dev/null; exit' INT TERM

    (cd "$SYNC_DIR" && CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" bunx wrangler tail $env_flag --format pretty 2>&1 | grep --line-buffered -v -i "alarm" | sed -l $'s/^/\033[0;36m[syq] \033[0m /') &
    (cd "$MGR_DIR" && CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" bunx wrangler tail $env_flag --format pretty 2>&1 | grep --line-buffered -v -i "alarm" | sed -l $'s/^/\033[1;33m[mgr] \033[0m /') &

    wait
}

# Main
main() {
    local cmd="${1:-all}"
    ENV="production"
    ACCOUNT_ID=$(config '.accountId')

    # Parse command
    case "$cmd" in
        staging)
            ENV="staging"
            cmd="all"
            ;;
        staging:tail|tail:staging)
            ENV="staging"
            check_deps
            tail_all
            exit 0
            ;;
        dev)
            check_deps
            run_dev_all
            exit 0
            ;;
        dev:sync)
            check_deps
            run_dev_sync
            exit 0
            ;;
        tail|tail:all)
            check_deps
            tail_all
            exit 0
            ;;
        tail:sync)
            check_deps
            tail_sync
            exit 0
            ;;
        tail:mgr)
            check_deps
            tail_mgr
            exit 0
            ;;
        sync|synchronizer)
            cmd="sync"
            ;;
        mgr|manager)
            cmd="mgr"
            ;;
        all|production)
            cmd="all"
            ;;
        *)
            echo "Usage: $0 [command]"
            echo ""
            echo "Deploy commands:"
            echo "  all, production  Deploy all workers to production"
            echo "  staging          Deploy all workers to staging"
            echo "  sync             Deploy synchronizer only"
            echo "  mgr              Deploy manager only"
            echo ""
            echo "Dev commands:"
            echo "  dev              Run all workers locally"
            echo "  dev:sync         Run synchronizer locally"
            echo ""
            echo "Tail commands:"
            echo "  tail, tail:all   Tail logs from all production workers"
            echo "  tail:sync        Tail synchronizer logs"
            echo "  tail:mgr         Tail manager logs"
            echo "  staging:tail     Tail logs from all staging workers"
            exit 1
            ;;
    esac

    header "Croquet Workers Deploy"
    echo "  Environment: $ENV"
    echo "  Account:     $ACCOUNT_ID"
    echo "  Command:     $cmd"

    check_deps

    if [ ! -f "$CONFIG_FILE" ]; then
        error "Config not found: $CONFIG_FILE"
    fi

    check_auth

    case "$cmd" in
        sync)
            deploy_sync
            ;;
        mgr)
            deploy_mgr
            ;;
        all)
            deploy_sync
            deploy_mgr
            ;;
    esac

    print_info
}

main "$@"
