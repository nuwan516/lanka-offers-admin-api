import { Request, Response, NextFunction } from 'express';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/**
 * Admin Network Isolation Guard (Batch D & Batch F)
 *
 * Restricts state-mutating operations on Port 3002 to trusted local loopback
 * connections (or authorized SSH tunnels / VPNs) without introducing a login UI.
 *
 * Reverse Proxy & Header Spoofing Protection (Batch F2):
 * - A client-supplied X-Forwarded-For header is NEVER trusted unless the direct
 *   socket connection originates from an explicitly configured TRUSTED_PROXIES list.
 * - Direct external connections sending fake X-Forwarded-For headers are strictly evaluated
 *   against their actual TCP socket remote address.
 */
export function adminNetworkGuard(req: Request, res: Response, next: NextFunction): void {
  // Read-only requests (GET, HEAD, OPTIONS) pass through
  if (!MUTATION_METHODS.has(req.method)) {
    return next();
  }

  const socketIp = req.socket?.remoteAddress || req.ip || '';
  const isDirectLoopback =
    socketIp === '127.0.0.1' ||
    socketIp === '::1' ||
    socketIp === '::ffff:127.0.0.1' ||
    socketIp.startsWith('127.');

  const trustedProxies = (process.env.TRUSTED_PROXIES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let effectiveIp = socketIp;

  if (isDirectLoopback) {
    effectiveIp = socketIp;
  } else if (trustedProxies.includes(socketIp)) {
    // Only trust forwarded headers if the upstream connection is from an explicitly trusted proxy
    effectiveIp = req.ip || socketIp;
  } else {
    // Untrusted direct connection: strictly use socket address, completely ignoring X-Forwarded-For
    effectiveIp = socketIp;
  }

  const isAuthorized =
    effectiveIp === '127.0.0.1' ||
    effectiveIp === '::1' ||
    effectiveIp === '::ffff:127.0.0.1' ||
    effectiveIp.startsWith('127.');

  if (!isAuthorized && process.env.ALLOW_REMOTE_ADMIN_MUTATIONS !== 'true') {
    res.status(403).json({
      error: 'FORBIDDEN_NETWORK_BOUNDARY',
      message: `Admin mutation operations (${req.method} ${req.path}) are restricted to local loopback (SSH tunnel / VPN). Direct access from ${effectiveIp} is rejected.`,
    });
    return;
  }

  next();
}
