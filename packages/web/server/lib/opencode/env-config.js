import { isIP } from 'node:net';

const MAX_HOSTNAME_LENGTH = 253;
const HOSTNAME_LABEL_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
// All-numeric dotted values must be a real IPv4 address; otherwise typo'd IPs
// like "0.0.0.0.0" would slip through as (technically valid) hostnames.
const ALL_NUMERIC_DOTTED_RE = /^\d+(?:\.\d+)*$/;

// Valid bind hostnames for the managed OpenCode server: IPv4, IPv6 (with or
// without brackets), or a DNS-style hostname. Everything else (URLs, ports,
// paths, whitespace, underscores) is rejected.
export const isValidOpenCodeHostname = (value) => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_HOSTNAME_LENGTH) return false;
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return isIP(trimmed.slice(1, -1)) === 6;
  }
  if (isIP(trimmed) !== 0) return true;
  if (ALL_NUMERIC_DOTTED_RE.test(trimmed)) return false;
  return trimmed.split('.').every((label) => HOSTNAME_LABEL_RE.test(label));
};

// Node socket timers accept delays up to a signed 32-bit integer; larger
// values overflow to 1 ms. Zero disables the proxy deadline.
export const resolveProxyRequestTimeoutMs = (env = {}, logger = null) => {
  const raw = typeof env.OPENCHAMBER_PROXY_TIMEOUT_MS === 'string' ? env.OPENCHAMBER_PROXY_TIMEOUT_MS.trim() : '';
  if (!raw) return 4 * 60 * 1000;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 2147483647) return parsed;
  if (logger) {
    logger.warn(
      `[config] Ignoring OPENCHAMBER_PROXY_TIMEOUT_MS=${JSON.stringify(raw)}: `
      + 'must be an integer from 0 to 2147483647 milliseconds (0 removes the deadline); '
      + 'keeping the 4-minute default',
    );
  }
  return 4 * 60 * 1000;
};

/**
 * Where the agent service listens. It is OpenChamber's own in-process server,
 * so only OpenChamber's variables apply. `OPENCODE_PORT` and `OPENCODE_HOST`
 * belong to an OpenCode the user may run for other tools and are not read:
 * binding the service to that port, or attaching to that server, would break
 * both.
 */
export const resolveOpenCodeEnvConfig = (options = {}) => {
  const env = options.env && typeof options.env === 'object' ? options.env : {};
  const logger = options.logger ?? console;

  const configuredOpenCodePort = (() => {
    const raw = env.OPENCHAMBER_OPENCODE_PORT || env.OPENCHAMBER_INTERNAL_PORT;
    if (!raw) {
      return null;
    }
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  })();

  const effectivePort = configuredOpenCodePort;

  const configuredOpenCodeHostname = (() => {
    const raw = env.OPENCHAMBER_OPENCODE_HOSTNAME;
    if (typeof raw !== 'string') {
      return '127.0.0.1';
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      logger.warn(
        `[config] Ignoring OPENCHAMBER_OPENCODE_HOSTNAME=${JSON.stringify(raw)}: empty after trimming`,
      );
      return '127.0.0.1';
    }
    if (!isValidOpenCodeHostname(trimmed)) {
      logger.error(
        `[config] Rejecting OPENCHAMBER_OPENCODE_HOSTNAME=${JSON.stringify(raw)}: `
        + 'must be a valid hostname or IP address (for example 127.0.0.1, 0.0.0.0, localhost, [::1]); '
        + 'falling back to 127.0.0.1 (loopback only)',
      );
      return '127.0.0.1';
    }
    return trimmed;
  })();

  return {
    configuredOpenCodePort,
    configuredOpenCodeHost: null,
    effectivePort,
    configuredOpenCodeHostname,
  };
};
