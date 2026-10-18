/**
 * Lanka Offers — Production Scraper Failure Classification Engine (Batch E4 & C4)
 *
 * Systematically categorizes scrape failures and anomalies into actionable operational states:
 * - NETWORK_ERROR
 * - SOURCE_CHANGED
 * - RATE_LIMITED
 * - BROWSER_FAILURE
 * - PARSER_FAILURE
 * - VALIDATION_FAILURE
 * - DATABASE_FAILURE
 * - TIMEOUT
 * - CANCELLED
 * - NO_OFFERS_FOUND
 */

export type FailureClassification =
  | 'NETWORK_ERROR'
  | 'SOURCE_CHANGED'
  | 'RATE_LIMITED'
  | 'BROWSER_FAILURE'
  | 'PARSER_FAILURE'
  | 'VALIDATION_FAILURE'
  | 'DATABASE_FAILURE'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'NO_OFFERS_FOUND';

export interface FailureAnalysis {
  classification: FailureClassification;
  isRetryable: boolean;
  isSourceOutage: boolean;
  alertSeverity: 'INFO' | 'WARNING' | 'CRITICAL';
  diagnosticSummary: string;
}

export interface ClassificationContext {
  bank?: string;
  offersFound?: number;
  prevFound?: number | null;
  ruleErrors?: number;
  httpStatus?: number;
}

export function classifyScraperFailure(
  rawError: unknown,
  context: ClassificationContext = {}
): FailureAnalysis {
  const errMsg = rawError instanceof Error ? rawError.message : String(rawError ?? '');
  const errLower = errMsg.toLowerCase();

  // 1. Operator cancellation
  if (
    errLower.includes('cancelled') ||
    errLower.includes('aborted') ||
    errLower.includes('sigterm') ||
    errLower.includes('operator cancel')
  ) {
    return {
      classification: 'CANCELLED',
      isRetryable: false,
      isSourceOutage: false,
      alertSeverity: 'INFO',
      diagnosticSummary: 'Execution cancelled by operator or supervisory shutdown.',
    };
  }

  // 2. Timeout watchdog or connection timeout
  if (
    errLower.includes('timeout') ||
    errLower.includes('timed out') ||
    errLower.includes('etimedout') ||
    errLower.includes('timeout-watchdog')
  ) {
    return {
      classification: 'TIMEOUT',
      isRetryable: true,
      isSourceOutage: false,
      alertSeverity: 'WARNING',
      diagnosticSummary: 'Scraper exceeded execution timeout ceiling. May indicate slow source, large payload, or hanging navigation.',
    };
  }

  // 3. Rate limiting / Anti-bot / WAF block
  if (
    context.httpStatus === 429 ||
    errLower.includes('rate limit') ||
    errLower.includes('too many requests') ||
    errLower.includes('cloudflare') ||
    errLower.includes('waf') ||
    errLower.includes('captcha') ||
    errLower.includes('403 forbidden')
  ) {
    return {
      classification: 'RATE_LIMITED',
      isRetryable: true,
      isSourceOutage: true,
      alertSeverity: 'CRITICAL',
      diagnosticSummary: 'Source access restricted by anti-bot, WAF, or rate limiting. Backoff required to respect site policy.',
    };
  }

  // 4. Headless browser / Puppeteer infrastructure failure
  if (
    errLower.includes('puppeteer') ||
    errLower.includes('chromium') ||
    errLower.includes('browser process closed') ||
    errLower.includes('browser disconnected') ||
    errLower.includes('target closed') ||
    errLower.includes('session closed') ||
    errLower.includes('failed to launch the browser process')
  ) {
    return {
      classification: 'BROWSER_FAILURE',
      isRetryable: true,
      isSourceOutage: false,
      alertSeverity: 'WARNING',
      diagnosticSummary: 'Headless browser crash or initialization failure. May indicate system memory pressure or missing dependencies.',
    };
  }

  // 5. Network / DNS / Connection drops
  if (
    errLower.includes('econnreset') ||
    errLower.includes('econnrefused') ||
    errLower.includes('enotfound') ||
    errLower.includes('ehostunreach') ||
    errLower.includes('fetch failed') ||
    errLower.includes('socket hang up') ||
    errLower.includes('network error')
  ) {
    return {
      classification: 'NETWORK_ERROR',
      isRetryable: true,
      isSourceOutage: true,
      alertSeverity: 'WARNING',
      diagnosticSummary: 'Network layer disruption or DNS resolution failure reaching bank endpoint.',
    };
  }

  // 6. Database / Postgres connection failure
  if (
    errLower.includes('connection to server') ||
    errLower.includes('deadlock detected') ||
    errLower.includes('duplicate key') ||
    errLower.includes('invalid input syntax') ||
    errLower.includes('postgres') ||
    errLower.includes('neondb')
  ) {
    return {
      classification: 'DATABASE_FAILURE',
      isRetryable: false,
      isSourceOutage: false,
      alertSeverity: 'CRITICAL',
      diagnosticSummary: 'Database storage error or constraint violation during staging/persistence.',
    };
  }

  // 7. Validation failure / high error rate
  if (context.ruleErrors && context.ruleErrors > 0 && context.offersFound && context.ruleErrors >= context.offersFound * 0.5) {
    return {
      classification: 'VALIDATION_FAILURE',
      isRetryable: false,
      isSourceOutage: false,
      alertSeverity: 'WARNING',
      diagnosticSummary: `High deterministic validation failure rate (${context.ruleErrors}/${context.offersFound} offers failed rules).`,
    };
  }

  // 8. Source structure change vs No offers found
  if (context.offersFound === 0) {
    if (context.prevFound && context.prevFound >= 10) {
      return {
        classification: 'SOURCE_CHANGED',
        isRetryable: false,
        isSourceOutage: true,
        alertSeverity: 'CRITICAL',
        diagnosticSummary: `Source layout anomaly: 0 offers extracted while previous scrape found ${context.prevFound}. Possible website redesign or selector change.`,
      };
    }
    return {
      classification: 'NO_OFFERS_FOUND',
      isRetryable: false,
      isSourceOutage: false,
      alertSeverity: 'INFO',
      diagnosticSummary: 'Bank feed returned 0 promotions under normal operating parameters (no campaign active).',
    };
  }

  // 9. Parser / Selector syntax or runtime error
  if (
    errLower.includes('cannot read propert') ||
    errLower.includes('evaluating selector') ||
    errLower.includes('syntax error') ||
    errLower.includes('unexpected token')
  ) {
    return {
      classification: 'PARSER_FAILURE',
      isRetryable: false,
      isSourceOutage: true,
      alertSeverity: 'WARNING',
      diagnosticSummary: 'DOM parser or selector expression failure while evaluating bank promotion markup.',
    };
  }

  // Default fallback
  return {
    classification: 'PARSER_FAILURE',
    isRetryable: false,
    isSourceOutage: false,
    alertSeverity: 'WARNING',
    diagnosticSummary: errMsg || 'Unclassified scraper error.',
  };
}
