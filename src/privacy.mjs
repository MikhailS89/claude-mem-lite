// Privacy filters. Every string that ends up in the database passes through
// `sanitize()`, and every file path passes through `isSensitivePath()`.
//
// Note that the plugin never stores file *contents* in the first place: only
// paths, command lines, user prompts and short assistant summaries. These
// filters exist for the cases where a secret leaks into one of those.

import { basename } from 'node:path';

/** Text wrapped in <private>...</private> is dropped before anything is stored. */
const PRIVATE_BLOCK = /<private>[\s\S]*?<\/private>/gi;
const PRIVATE_OPEN_UNCLOSED = /<private>[\s\S]*$/i;

export function stripPrivate(text) {
  if (!text) return '';
  return text.replace(PRIVATE_BLOCK, '[private]').replace(PRIVATE_OPEN_UNCLOSED, '[private]');
}

/**
 * Patterns for files whose contents are secrets. Matched against the basename
 * (glob-like, `*` = any run of characters) or against directory segments.
 * Tool calls touching these files are recorded as "[sensitive file]" only.
 */
export const SENSITIVE_BASENAMES = [
  '.env', '.env.*', '*.env',
  '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore', '*.asc', '*.gpg',
  'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*',
  '*.secret', '*.secrets', 'secrets.*', 'secret.*',
  'credentials', 'credentials.*', '.credentials.*', '*credentials.json',
  '.npmrc', '.pypirc', '.netrc', '_netrc', '.htpasswd', '.git-credentials',
  'kubeconfig', '*.kubeconfig', '.dockercfg', 'config.json',
  'token', 'token.*', '*.token', '.wakatime.cfg',
  'authorized_keys', 'known_hosts',
];

export const SENSITIVE_DIRS = ['.ssh', '.gnupg', '.aws', '.azure', '.gcloud', '.kube', '.docker', '.password-store'];

const sensitiveBasenameRes = SENSITIVE_BASENAMES.map(
  (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i'),
);

/** Templates that document the shape of a secrets file without holding secrets. */
const TEMPLATE_SUFFIX = /\.(example|sample|template|dist|default|schema)$/i;

export function isSensitivePath(filePath) {
  if (!filePath) return false;
  const norm = String(filePath).replace(/\\/g, '/');
  const base = basename(norm);
  if (TEMPLATE_SUFFIX.test(base)) return false;
  if (sensitiveBasenameRes.some((re) => re.test(base))) {
    // `config.json` is only sensitive inside .docker/ etc.; keep plain ones.
    if (/^config\.json$/i.test(base) && !SENSITIVE_DIRS.some((d) => norm.includes(`/${d}/`))) return false;
    return true;
  }
  const segments = norm.split('/');
  return segments.some((s) => SENSITIVE_DIRS.includes(s.toLowerCase()));
}

/**
 * Content-based redaction of common credential formats. Ordered from most
 * specific to least so that e.g. a private key block is replaced as a whole.
 */
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g, '[REDACTED PRIVATE KEY]'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED]'], // Anthropic
  [/\bsk-(?:proj-|live_|test_)?[A-Za-z0-9_-]{20,}/g, '[REDACTED]'], // OpenAI, Stripe
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[REDACTED]'], // GitHub
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, '[REDACTED]'], // GitLab
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]'], // Slack
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'], // AWS access key id
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED]'], // Google API key
  [/\bnpm_[A-Za-z0-9]{36}\b/g, '[REDACTED]'], // npm
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED JWT]'],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [REDACTED]'],
  // URLs with embedded credentials: https://user:pass@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s@/]+@/gi, '$1[REDACTED]@'],
  // key=value / key: value / "key": "value" with a secret-looking key name
  [
    /\b((?:api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|api[_-]?token|secret|token|password|passwd|pwd)\b["']?\s*[=:]\s*["']?)([^\s"'&,;]{6,})/gi,
    '$1[REDACTED]',
  ],
];

export function redactSecrets(text) {
  if (!text) return '';
  let out = String(text);
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Full pipeline for any free text destined for storage. */
export function sanitize(text) {
  return redactSecrets(stripPrivate(text));
}

/** Cut a string to `max` characters, collapsing whitespace. */
export function truncate(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, Math.max(0, max - 1)).trimEnd() + '…' : s;
}
