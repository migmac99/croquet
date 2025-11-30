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
#   ./deploy.sh reg          # Deploy only registry
#   ./deploy.sh mgr          # Deploy only manager
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/deploy.config.json"
SYNC_DIR="${SCRIPT_DIR}/synchronizer"
REG_DIR="${SCRIPT_DIR}/registry"
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
# Usage: setup_kv <namespace_name>
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

# Setup all KV namespaces for registry
setup_registry_kv() {
    local sessions_ns=$(config '.registry.kv.sessions.namespace')
    local apikeys_ns=$(config '.registry.kv.apikeys.namespace')

    SESSIONS_KV_ID=$(setup_kv_namespace "$sessions_ns")
    APIKEYS_KV_ID=$(setup_kv_namespace "$apikeys_ns")
}

# Generate synchronizer wrangler.toml from config
generate_sync_config() {
    local account_id=$(config '.accountId')
    local name=$(config '.synchronizer.name')
    local domain=$(config '.synchronizer.domain')
    local bucket=$(config '.synchronizer.r2.bucketName')

    # Get vars as JSON and convert to TOML
    local vars=$(config '.synchronizer.vars')
    local vars_toml=$(echo "$vars" | jq -r 'to_entries | .[] | "\(.key) = \"\(.value)\""')

    cat > "$SYNC_DIR/wrangler.toml" << EOF
# Auto-generated from deploy.config.json - do not edit manually
name = "$name"
main = "src/index.ts"
compatibility_date = "2024-11-01"
compatibility_flags = ["nodejs_compat"]
account_id = "$account_id"

[[migrations]]
tag = "v1"
new_classes = ["Synchronizer"]

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

[env.staging.vars]
$vars_toml
EOF

    success "Generated synchronizer wrangler.toml"
}

# Generate registry wrangler.toml from config
generate_reg_config() {
    local sessions_kv_id="$1"
    local apikeys_kv_id="$2"
    local account_id=$(config '.accountId')
    local name=$(config '.registry.name')
    local domain=$(config '.registry.domain')

    # Get vars as JSON
    local vars=$(config '.registry.vars')
    local vars_toml=$(echo "$vars" | jq -r 'to_entries | .[] | "\(.key) = \"\(.value)\""')

    cat > "$REG_DIR/wrangler.toml" << EOF
# Auto-generated from deploy.config.json - do not edit manually
name = "$name"
main = "src/index.ts"
compatibility_date = "2024-11-01"
compatibility_flags = ["nodejs_compat"]
account_id = "$account_id"

# Local dev bindings (wrangler creates local KV stores)
[[kv_namespaces]]
binding = "SESSIONS"
id = "$sessions_kv_id"

[[kv_namespaces]]
binding = "APIKEYS"
id = "$apikeys_kv_id"

[vars]
SYNCHRONIZER_URL = "ws://localhost:8787"
CLUSTER_LABEL = "local-dev"
SESSION_TTL_SECONDS = "3600"
REQUIRE_API_KEY = "false"

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

[env.production.vars]
$vars_toml

# ============================================================================
# Staging environment
# ============================================================================
[env.staging]
name = "${name}-staging"
routes = [
  { pattern = "${domain/synqreg/synqreg-staging}", custom_domain = true }
]

[env.staging.observability]
enabled = true

[[env.staging.kv_namespaces]]
binding = "SESSIONS"
id = "$sessions_kv_id"

[[env.staging.kv_namespaces]]
binding = "APIKEYS"
id = "$apikeys_kv_id"

[env.staging.vars]
$vars_toml
EOF

    success "Generated registry wrangler.toml"
}

# Deploy synchronizer
deploy_sync() {
    header "Deploying Synchronizer"

    generate_sync_config
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

# Deploy registry
deploy_reg() {
    header "Deploying Registry"

    setup_registry_kv
    generate_reg_config "$SESSIONS_KV_ID" "$APIKEYS_KV_ID"

    cd "$REG_DIR"
    install_deps "$REG_DIR"

    log "Deploying registry..."
    if [ "$ENV" = "production" ]; then
        CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" bunx wrangler deploy --env production
    elif [ "$ENV" = "staging" ]; then
        CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" bunx wrangler deploy --env staging
    else
        CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" bunx wrangler deploy
    fi
    success "Registry deployed!"
}

# Generate manager wrangler.toml from config
generate_mgr_config() {
    local sessions_kv_id="$1"
    local apikeys_kv_id="$2"
    local account_id=$(config '.accountId')
    local name=$(config '.manager.name')
    local domain=$(config '.manager.domain')

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

# Local dev bindings (wrangler creates local KV stores)
[[kv_namespaces]]
binding = "SESSIONS"
id = "$sessions_kv_id"

[[kv_namespaces]]
binding = "APIKEYS"
id = "$apikeys_kv_id"

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

    # Reuse the same KV namespaces as registry
    setup_registry_kv
    generate_mgr_config "$SESSIONS_KV_ID" "$APIKEYS_KV_ID"

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
    generate_sync_config
    cd "$SYNC_DIR"
    install_deps "$SYNC_DIR"
    CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" bunx wrangler dev --port 8787 2>&1 | sed -l 's/\[wrangler:info\] //g; s/\[wrangler:err\] //g; s/\[wrangler:warn\] //g'
}

# Run all workers locally in parallel
run_dev_all() {
    header "Starting Full Stack (dev)"

    # Generate configs
    setup_registry_kv
    generate_sync_config
    generate_reg_config "$SESSIONS_KV_ID" "$APIKEYS_KV_ID"
    generate_mgr_config "$SESSIONS_KV_ID" "$APIKEYS_KV_ID"

    # Install deps
    install_deps "$SYNC_DIR"
    install_deps "$REG_DIR"
    install_deps "$MGR_DIR"

    echo ""
    echo -e "${CYAN}Starting workers on:${NC}"
    echo "  Synchronizer: http://localhost:8787"
    echo "  Registry:     http://localhost:8788"
    echo "  Manager:      http://localhost:8789"
    echo ""
    echo -e "${YELLOW}Press Ctrl+C to stop all workers${NC}"
    echo ""

    # Trap to kill all background processes on exit
    trap 'kill $(jobs -p) 2>/dev/null; exit' INT TERM

    # Start all workers in background with colored prefixes
    # FORCE_COLOR=1 makes wrangler output colors even when piped
    # Strip [wrangler:*] prefix and add our own colored prefixes
    (cd "$SYNC_DIR" && FORCE_COLOR=1 CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" bunx wrangler dev --port 8787 --inspector-port 9229 2>&1 | sed -l 's/\[wrangler:info\] //g; s/\[wrangler:err\] //g; s/\[wrangler:warn\] //g' | sed -l $'s/^/\033[0;36m[syq] \033[0m /') &
    (cd "$REG_DIR" && FORCE_COLOR=1 CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" bunx wrangler dev --port 8788 --inspector-port 9230 2>&1 | sed -l 's/\[wrangler:info\] //g; s/\[wrangler:err\] //g; s/\[wrangler:warn\] //g' | sed -l $'s/^/\033[0;32m[reg] \033[0m /') &
    (cd "$MGR_DIR" && FORCE_COLOR=1 CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" bunx wrangler dev --port 8789 --inspector-port 9231 2>&1 | sed -l 's/\[wrangler:info\] //g; s/\[wrangler:err\] //g; s/\[wrangler:warn\] //g' | sed -l $'s/^/\033[1;33m[mgr] \033[0m /') &

    # Wait for all background jobs
    wait
}

# Print deployment info
print_info() {
    local sync_domain=$(config '.synchronizer.domain')
    local reg_domain=$(config '.registry.domain')
    local mgr_domain=$(config '.manager.domain')

    echo ""
    echo -e "${GREEN}════════════════════════════════════════${NC}"
    echo -e "${GREEN}         Deployment Complete!           ${NC}"
    echo -e "${GREEN}════════════════════════════════════════${NC}"
    echo ""
    echo "  Synchronizer: wss://$sync_domain"
    echo "  Registry:     https://$reg_domain"
    echo "  Manager:      https://$mgr_domain"
    echo ""
    echo "  Test dispatch:"
    echo "    curl https://$reg_domain/dispatch?session=test123"
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
        sync|synchronizer)
            cmd="sync"
            ;;
        reg|registry)
            cmd="reg"
            ;;
        mgr|manager)
            cmd="mgr"
            ;;
        all|production)
            cmd="all"
            ;;
        *)
            echo "Usage: $0 [all|staging|dev|sync|reg|mgr]"
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
        reg)
            deploy_reg
            ;;
        mgr)
            deploy_mgr
            ;;
        all)
            deploy_sync
            deploy_reg
            deploy_mgr
            ;;
    esac

    print_info
}

main "$@"
