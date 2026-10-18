import { Request, Response, NextFunction } from 'express';
import { adminNetworkGuard } from '@/api/middleware/admin-network-guard';

describe('Admin Network Isolation Guard (Batch D)', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let nextFn: NextFunction;
  let statusMock: jest.Mock;
  let jsonMock: jest.Mock;

  beforeEach(() => {
    delete process.env.ALLOW_REMOTE_ADMIN_MUTATIONS;
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });
    mockRes = {
      status: statusMock,
      json: jsonMock,
    };
    nextFn = jest.fn();
  });

  it('allows read-only requests (GET, HEAD, OPTIONS) from any client IP', () => {
    mockReq = {
      method: 'GET',
      path: '/api/health',
      ip: '198.51.100.25', // External IP
    };

    adminNetworkGuard(mockReq as Request, mockRes as Response, nextFn);

    expect(nextFn).toHaveBeenCalled();
    expect(statusMock).not.toHaveBeenCalled();
  });

  it('allows state-mutating requests (POST, PUT, DELETE) from local loopback (127.0.0.1)', () => {
    mockReq = {
      method: 'POST',
      path: '/api/schedule/toggle-global',
      ip: '127.0.0.1',
    };

    adminNetworkGuard(mockReq as Request, mockRes as Response, nextFn);

    expect(nextFn).toHaveBeenCalled();
    expect(statusMock).not.toHaveBeenCalled();
  });

  it('allows state-mutating requests from IPv6 loopback (::1 or ::ffff:127.0.0.1)', () => {
    mockReq = {
      method: 'POST',
      path: '/api/schedule/SCH-HNB/run-now',
      ip: '::ffff:127.0.0.1',
    };

    adminNetworkGuard(mockReq as Request, mockRes as Response, nextFn);

    expect(nextFn).toHaveBeenCalled();
    expect(statusMock).not.toHaveBeenCalled();
  });

  it('blocks state-mutating requests from external public IP with 403 Forbidden', () => {
    mockReq = {
      method: 'POST',
      path: '/api/schedule/toggle-global',
      ip: '203.0.113.42', // Untrusted external IP
    };

    adminNetworkGuard(mockReq as Request, mockRes as Response, nextFn);

    expect(nextFn).not.toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalledWith(403);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'FORBIDDEN_NETWORK_BOUNDARY',
        message: expect.stringContaining('Admin mutation operations'),
      })
    );
  });

  it('allows remote mutations only when ALLOW_REMOTE_ADMIN_MUTATIONS=true is explicitly set', () => {
    process.env.ALLOW_REMOTE_ADMIN_MUTATIONS = 'true';
    mockReq = {
      method: 'POST',
      path: '/api/schedule/SCH-HNB/toggle',
      ip: '192.168.1.50',
    };

    adminNetworkGuard(mockReq as Request, mockRes as Response, nextFn);

    expect(nextFn).toHaveBeenCalled();
    expect(statusMock).not.toHaveBeenCalled();
  });

  it('rejects client-spoofed X-Forwarded-For headers from untrusted external sockets (Batch F2)', () => {
    mockReq = {
      method: 'POST',
      path: '/api/schedule/toggle-global',
      // Attacker spoofing 127.0.0.1 via X-Forwarded-For:
      ip: '127.0.0.1',
      // But actual TCP socket connection is from an external IP:
      socket: { remoteAddress: '198.51.100.99' } as any,
    };

    adminNetworkGuard(mockReq as Request, mockRes as Response, nextFn);

    expect(nextFn).not.toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalledWith(403);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'FORBIDDEN_NETWORK_BOUNDARY',
        message: expect.stringContaining('198.51.100.99'),
      })
    );
  });

  it('honors forwarded IP when connection originates from an explicitly trusted proxy (Batch F2)', () => {
    process.env.TRUSTED_PROXIES = '10.0.0.10,10.0.0.11';

    mockReq = {
      method: 'POST',
      path: '/api/schedule/SCH-HNB/toggle',
      ip: '127.0.0.1', // Forwarded from trusted local SSH tunnel / internal proxy
      socket: { remoteAddress: '10.0.0.10' } as any, // Verified upstream trusted proxy
    };

    adminNetworkGuard(mockReq as Request, mockRes as Response, nextFn);

    expect(nextFn).toHaveBeenCalled();
    expect(statusMock).not.toHaveBeenCalled();
  });
});
