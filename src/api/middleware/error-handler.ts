import { Request, Response, NextFunction } from 'express';
import { WorkflowError } from '@/infrastructure/db/offer-workflow-repository';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode = 400, code = 'BAD_REQUEST') {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = req.requestId || 'unknown';

  if (err instanceof WorkflowError) {
    res.status(400).json({
      error: {
        code: 'WORKFLOW_ERROR',
        message: err.message,
        requestId,
      },
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        requestId,
      },
    });
    return;
  }

  const message = err instanceof Error ? err.message : String(err);

  // Sanitize out sensitive credentials or connection strings
  const sanitized = message
    .replace(/postgres:\/\/[^@]+@/gi, 'postgres://***:***@')
    .replace(/password=[^\s;]+/gi, 'password=***');

  // Check for common Postgres conflict errors
  if (message.includes('duplicate key value') || message.includes('already exists')) {
    res.status(409).json({
      error: {
        code: 'CONFLICT',
        message: 'Resource already exists or constraint violation.',
        requestId,
      },
    });
    return;
  }

  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: process.env.NODE_ENV === 'production' ? 'An unexpected server error occurred.' : sanitized,
      requestId,
    },
  });
}
