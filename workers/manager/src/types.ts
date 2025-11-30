export interface Env {
  // KV Namespaces
  SESSIONS: KVNamespace;
  APIKEYS: KVNamespace;

  // Cloudflare Access config
  ACCESS_AUD: string; // Application Audience (AUD) tag from Access

  // Config
  SYNCHRONIZER_URL: string;
  CLUSTER_LABEL: string;
}

/**
 * Cloudflare Access JWT payload
 */
export interface AccessJWTPayload {
  aud: string[];
  email: string;
  exp: number;
  iat: number;
  iss: string;
  sub: string;
  type: string;
  identity_nonce?: string;
  country?: string;
}

/**
 * API Key record stored in KV
 * Key format: `key:{apiKey}` or `id:{keyId}`
 */
export interface ApiKeyRecord {
  /** Unique identifier for the key */
  id: string;

  /** The actual API key (hashed for lookup-by-id) */
  key: string;

  /** Human-readable name */
  name: string;

  /** Allowed origin domains (glob patterns supported) */
  allowedDomains: string[];

  /** Optional: restrict to specific app IDs */
  allowedApps?: string[];

  /** Tier for rate limiting / quotas */
  tier: 'free' | 'pro' | 'enterprise' | 'unlimited';

  /** Is the key active? */
  active: boolean;

  /** Creation timestamp */
  createdAt: number;

  /** Last used timestamp */
  lastUsed?: number;

  /** Usage stats */
  stats?: {
    totalRequests: number;
    totalSessions: number;
  };

  /** Optional metadata */
  metadata?: Record<string, string>;
}

/**
 * Session record stored in KV
 */
export interface SessionRecord {
  sessionId: string;
  synchronizerUrl: string;
  createdAt: number;
  lastSeen: number;
  clientCount: number;
  appId?: string;
  apiKeyId?: string;
}

/**
 * Request to create a new API key
 */
export interface CreateApiKeyRequest {
  name: string;
  allowedDomains: string[];
  allowedApps?: string[];
  tier?: ApiKeyRecord['tier'];
  metadata?: Record<string, string>;
}

/**
 * Request to update an API key
 */
export interface UpdateApiKeyRequest {
  name?: string;
  allowedDomains?: string[];
  allowedApps?: string[];
  tier?: ApiKeyRecord['tier'];
  active?: boolean;
  metadata?: Record<string, string>;
}

/**
 * Response when creating an API key
 */
export interface CreateApiKeyResponse {
  id: string;
  key: string; // Only returned on creation!
  name: string;
  allowedDomains: string[];
  tier: string;
  createdAt: number;
}

/**
 * Authenticated user from Cloudflare Access
 */
export interface AuthenticatedUser {
  email: string;
  sub: string;
}
