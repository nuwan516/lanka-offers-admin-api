import * as os from 'os';
import * as fs from 'fs';

export interface BrowserClientConfig {
  headless?: boolean | 'new';
  navigationTimeout?: number;
  waitForContentMs?: number;
  viewport?: { width: number; height: number };
  blockResourceTypes?: string[];
  userAgent?: string;
  launchArgs?: string[];
  executablePath?: string;
}

export interface BrowserExtractOptions {
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
  waitForSelector?: string;
  waitForSelectorTimeoutMs?: number;
  evaluateOnNewDocument?: () => void;
}

type BrowserInstance = {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
};

type BrowserPage = {
  setRequestInterception(enabled: boolean): Promise<void>;
  on(event: 'request', handler: (request: BrowserRequest) => void): void;
  setViewport(viewport: { width: number; height: number }): Promise<void>;
  setUserAgent(userAgent: string): Promise<void>;
  evaluateOnNewDocument(fn: () => void): Promise<void>;
  goto(url: string, options: { waitUntil: string; timeout: number }): Promise<unknown>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
  close(): Promise<void>;
};

type BrowserRequest = {
  resourceType(): string;
  abort(): void;
  continue(): void;
};

interface PuppeteerModule {
  launch(options: {
    headless: boolean | 'new';
    args: string[];
    executablePath?: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<BrowserInstance>;
}

// Crash-dump and profile dirs must be platform-correct: hardcoding
// /private/tmp (macOS) makes crashpad fail the whole launch on Linux.
const BROWSER_TMP = `${os.tmpdir()}/lanka-offers-browser`;

const DEFAULT_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--disable-gpu',
  '--no-first-run',
  '--disable-crash-reporter',
  // NOT --disable-crashpad/--disable-features=Crashpad: on Chrome 148+ that
  // combination spawns chrome_crashpad_handler without --database and the
  // whole launch dies ("--database is required").
  '--no-crashpad',
  // Reduces the odds of WAF/bot-detection challenges flagging us as
  // automated (matters most for Pan Asia's Cloudflare-style challenge).
  '--disable-blink-features=AutomationControlled',
];

export class MissingBrowserDependencyError extends Error {
  constructor() {
    super(
      'A browser runtime is required for this scraper. Install Chrome with: npm run browser:install ' +
      'or set CHROME_EXECUTABLE_PATH to a local Chrome/Chromium executable.',
    );
    this.name = 'MissingBrowserDependencyError';
  }
}

export class BrowserClient {
  private readonly config: Required<Omit<BrowserClientConfig, 'userAgent'>> & {
    userAgent?: string;
  };
  private browserPromise: Promise<BrowserInstance> | null = null;

  constructor(config: BrowserClientConfig = {}) {
    // Each instance gets its own Chrome profile directory. A shared fixed
    // path meant two banks scraping concurrently (or a retried launch whose
    // prior Chrome process hadn't fully exited) would collide on Puppeteer's
    // own userDataDir lock: "The browser is already running for <dir>" —
    // which silently produced a 0-offer run with no error surfaced above it.
    const instanceProfileDir = `${BROWSER_TMP}-profile-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

    this.config = {
      headless: config.headless ?? 'new',
      navigationTimeout: config.navigationTimeout ?? 60_000,
      waitForContentMs: config.waitForContentMs ?? 3_000,
      viewport: config.viewport ?? { width: 1920, height: 1080 },
      blockResourceTypes: config.blockResourceTypes ?? ['font', 'media'],
      userAgent: config.userAgent,
      launchArgs: mergeLaunchArgs([`--user-data-dir=${instanceProfileDir}`, ...(config.launchArgs ?? [])]),
      executablePath: config.executablePath ?? process.env.CHROME_EXECUTABLE_PATH ?? findBrowserExecutable() ?? '',
    };
  }

  static isAvailable(): boolean {
    const runtime = loadPuppeteerRuntime();
    if (!runtime) return false;
    return runtime.kind === 'bundled' || findBrowserExecutable() !== null || Boolean(process.env.CHROME_EXECUTABLE_PATH);
  }

  async extract<T>(
    url: string,
    extractor: () => T,
    options: BrowserExtractOptions = {},
  ): Promise<T> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      await this.preparePage(page, options);
      await page.goto(url, {
        waitUntil: options.waitUntil ?? 'networkidle2',
        timeout: this.config.navigationTimeout,
      });

      if (options.waitForSelector) {
        await page.waitForSelector(options.waitForSelector, {
          timeout: options.waitForSelectorTimeoutMs ?? 15_000,
        });
      }

      if (this.config.waitForContentMs > 0) {
        await sleep(this.config.waitForContentMs);
      }

      return await page.evaluate(extractor);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (!this.browserPromise) return;

    const browser = await this.browserPromise.catch(() => null);
    this.browserPromise = null;
    await browser?.close().catch(() => undefined);
    this.cleanupProfileDir();
  }

  /** Best-effort cleanup of this instance's scratch profile dir. Failures are
   * swallowed — a leftover temp folder under os.tmpdir() is harmless, unlike
   * the launch collision this per-instance directory scheme exists to avoid. */
  private cleanupProfileDir(): void {
    const arg = this.config.launchArgs.find((a) => a.startsWith('--user-data-dir='));
    if (!arg) return;
    try {
      fs.rmSync(arg.slice('--user-data-dir='.length), { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // ignore
    }
  }

  private getBrowser(): Promise<BrowserInstance> {
    if (this.browserPromise) return this.browserPromise;

    const runtime = loadPuppeteerRuntime();
    if (!runtime) throw new MissingBrowserDependencyError();

    const executablePath = this.config.executablePath || undefined;
    if (runtime.kind === 'core' && !executablePath) {
      throw new MissingBrowserDependencyError();
    }

    this.browserPromise = runtime.puppeteer.launch({
      headless: this.config.headless,
      args: this.config.launchArgs,
      executablePath,
      // Platform-correct sandbox dirs — hardcoded /private/tmp (macOS) makes
      // Chrome's runtime dirs unwritable on Linux and kills the launch.
      env: {
        ...process.env,
        HOME: `${BROWSER_TMP}-home`,
        TMPDIR: os.tmpdir(),
        XDG_CACHE_HOME: `${BROWSER_TMP}-home/cache`,
        XDG_CONFIG_HOME: `${BROWSER_TMP}-home/config`,
      },
    });

    return this.browserPromise;
  }

  private async preparePage(page: BrowserPage, options: BrowserExtractOptions): Promise<void> {
    await page.setViewport(this.config.viewport);

    if (this.config.userAgent) {
      await page.setUserAgent(this.config.userAgent);
    }

    if (options.evaluateOnNewDocument) {
      await page.evaluateOnNewDocument(options.evaluateOnNewDocument);
    }

    if (this.config.blockResourceTypes.length > 0) {
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        if (this.config.blockResourceTypes.includes(request.resourceType())) {
          request.abort();
          return;
        }
        request.continue();
      });
    }
  }
}

type PuppeteerRuntime = {
  kind: 'bundled' | 'core';
  puppeteer: PuppeteerModule;
};

function loadPuppeteerRuntime(): PuppeteerRuntime | null {
  try {
    // Optional runtime dependency; keep static type-check independent of Puppeteer.
    const req = eval('require') as NodeRequire;
    return { kind: 'bundled', puppeteer: req('puppeteer') as PuppeteerModule };
  } catch {
    try {
      const req = eval('require') as NodeRequire;
      return { kind: 'core', puppeteer: req('puppeteer-core') as PuppeteerModule };
    } catch {
      return null;
    }
  }
}

function findBrowserExecutable(): string | null {
  const candidates = [
    process.env.CHROME_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    ...findCachedPuppeteerBrowsers(),
  ];

  return candidates.find((candidate): candidate is string => Boolean(candidate && fileExists(candidate))) ?? null;
}

function findCachedPuppeteerBrowsers(): string[] {
  const home = process.env.HOME;
  if (!home) return [];

  const roots = [
    `${home}/.cache/puppeteer/chrome`,
    `${home}/.cache/puppeteer/chrome-headless-shell`,
  ];

  const executables: string[] = [];
  for (const root of roots) {
    collectBrowserExecutables(root, executables, 0);
  }
  return executables;
}

function collectBrowserExecutables(dir: string, executables: string[], depth: number): void {
  if (depth > 5 || !directoryExists(dir)) return;

  const fs = eval('require')('fs') as typeof import('fs');
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = `${dir}/${entry.name}`;
    if (entry.isFile() && (entry.name === 'chrome' || entry.name === 'chrome-headless-shell')) {
      executables.push(fullPath);
      continue;
    }
    if (entry.isDirectory()) {
      collectBrowserExecutables(fullPath, executables, depth + 1);
    }
  }
}

function fileExists(filePath: string): boolean {
  try {
    const fs = eval('require')('fs') as typeof import('fs');
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function directoryExists(dirPath: string): boolean {
  try {
    const fs = eval('require')('fs') as typeof import('fs');
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeLaunchArgs(extraArgs: string[] = []): string[] {
  return [...new Set([...DEFAULT_LAUNCH_ARGS, ...extraArgs])];
}
