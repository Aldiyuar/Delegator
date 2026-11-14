const puppeteer = require('puppeteer-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Dedicated loggers routing engine diagnostics to stderr to preserve clean stdout for consumers (CLI pipelines, etc.)
const log = (...args) => console.error(...args);
const logWarn = (...args) => console.error(...args);
const logError = (...args) => console.error(...args);

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  // Windows
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium'
];

function findChromePath() {
  for (const p of CHROME_PATHS) {
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error('Chrome/Edge executable not found. Please install Google Chrome.');
}

const PROFILE_DIR = process.env.ARGON_PROFILE_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Delegator', 'chrome-profile');
const DELEGATOR_CDP_URL = 'http://127.0.0.1:9239';
const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const ANONYMOUS_SESSION_KEY = '__anonymous_default__';

class AsyncMutex {
  constructor() {
    this._queue = [];
    this._locked = false;
  }

  async acquire(signal = null) {
    if (signal?.aborted) {
      throw new Error('[ArgonEngine] Request was aborted by client while waiting for in-process mutex.');
    }
    if (!this._locked) {
      this._locked = true;
      return () => this._release();
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve: null, onAbort: null };
      const wrappedResolve = (releaseFn) => {
        if (signal && entry.onAbort) {
          signal.removeEventListener('abort', entry.onAbort);
        }
        resolve(releaseFn);
      };
      entry.resolve = wrappedResolve;

      if (signal) {
        entry.onAbort = () => {
          const idx = this._queue.indexOf(entry);
          if (idx !== -1) {
            this._queue.splice(idx, 1);
          }
          reject(new Error('[ArgonEngine] Request was aborted by client while waiting for in-process mutex.'));
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }

      this._queue.push(entry);
    });
  }

  _release() {
    while (this._queue.length > 0) {
      const nextEntry = this._queue.shift();
      if (nextEntry && typeof nextEntry.resolve === 'function') {
        nextEntry.resolve(() => this._release());
        return;
      }
    }
    this._locked = false;
  }

  async runExclusive(fn, signal = null) {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // Process exists but lacks permission to signal
  }
}

class InterProcessLock {
  constructor(lockPath) {
    this.lockPath = lockPath;
    this.heartbeatTimer = null;
    this.lockToken = null;
    this._exitHandler = () => {
      try { this.release(); } catch (_) {}
    };
  }

  isLocked() {
    if (!fs.existsSync(this.lockPath)) return false;
    try {
      const data = JSON.parse(fs.readFileSync(this.lockPath, 'utf-8'));
      if (data.pid && !isPidAlive(data.pid)) return false;
      if (data.expiresAt && Date.now() > data.expiresAt) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  _writeLockFile(fdOrPath, token, ttlMs) {
    const now = Date.now();
    const lockData = JSON.stringify({
      pid: process.pid,
      token,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + ttlMs,
      time: new Date().toISOString()
    });
    if (typeof fdOrPath === 'number') {
      fs.writeFileSync(fdOrPath, lockData, 'utf-8');
    } else {
      const tmpPath = `${fdOrPath}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmpPath, lockData, 'utf-8');
        try {
          fs.renameSync(tmpPath, fdOrPath);
        } catch (err) {
          // Fallback for Windows EPERM / EBUSY / EACCES when replacing existing file
          if (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') {
            try {
              fs.writeFileSync(fdOrPath, lockData, 'utf-8');
            } catch (_) {}
          }
        }
      } finally {
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch (_) {}
      }
    }
  }

  _startHeartbeat(token, ttlMs = 60000) {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      try {
        if (!fs.existsSync(this.lockPath)) return;
        const current = JSON.parse(fs.readFileSync(this.lockPath, 'utf-8'));
        if (current.pid === process.pid && current.token === token) {
          this._writeLockFile(this.lockPath, token, ttlMs);
        }
      } catch (_) {}
    }, 15000);

    if (typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref();
    }
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async acquire(acquireTimeoutMs = 360000, retryIntervalMs = 250, signal = null) {
    const startTime = Date.now();
    const lockTtlMs = 60000; // 60s TTL, renewed every 15s by heartbeat while task runs
    const token = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const dir = path.dirname(this.lockPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    while (Date.now() - startTime < acquireTimeoutMs) {
      if (signal?.aborted) {
        throw new Error('[ArgonEngine] Request was aborted by client while waiting for IPC lock.');
      }
      try {
        // Atomic file creation with exclusive flag 'wx'
        const fd = fs.openSync(this.lockPath, 'wx');
        try {
          this._writeLockFile(fd, token, lockTtlMs);
        } finally {
          // Close descriptor immediately so Windows doesn't lock unlinkSync for other processes
          fs.closeSync(fd);
        }
        this.lockToken = token;
        this._startHeartbeat(token, lockTtlMs);
        try { process.once('exit', this._exitHandler); } catch (_) {}
        return () => this.release(token);
      } catch (err) {
        if (err.code === 'EEXIST') {
          // Lock file already exists. Check if it is stale or owned by a dead process
          try {
            const raw = fs.readFileSync(this.lockPath, 'utf-8');
            const data = JSON.parse(raw);
            const now = Date.now();
            const isStale = data.expiresAt ? (now > data.expiresAt) : ((now - (data.createdAt || 0)) > lockTtlMs);
            const isDead = data.pid && !isPidAlive(data.pid);

            if (isStale || isDead) {
              logWarn(`[ArgonEngine] Stale lock detected (PID ${data.pid}, isDead=${isDead}, isStale=${isStale}). Attempting atomic eviction...`);
              // Atomic rename prevents TOCTOU race where two processes delete each other's newly created lock
              const trashPath = `${this.lockPath}.stale.${process.pid}.${Date.now()}`;
              try {
                fs.renameSync(this.lockPath, trashPath);
                try { fs.unlinkSync(trashPath); } catch (_) {}
              } catch (_) {}
              continue;
            }
          } catch (_) {
            // Corrupt or half-written lock file: wait briefly once before evicting
            await new Promise(r => setTimeout(r, 150));
            try {
              JSON.parse(fs.readFileSync(this.lockPath, 'utf-8'));
            } catch (_) {
              const trashPath = `${this.lockPath}.corrupt.${process.pid}.${Date.now()}`;
              try {
                fs.renameSync(this.lockPath, trashPath);
                fs.unlinkSync(trashPath);
              } catch (_) {}
            }
            continue;
          }

          // Wait before retrying
          await new Promise(r => setTimeout(r, retryIntervalMs + Math.floor(Math.random() * 100)));
        } else {
          throw err;
        }
      }
    }

    throw new Error(`[ArgonEngine] Failed to acquire inter-process lock within ${acquireTimeoutMs / 1000}s. Another Argon session is active.`);
  }

  release(token = this.lockToken) {
    this._stopHeartbeat();
    try { process.removeListener('exit', this._exitHandler); } catch (_) {}
    const effectiveToken = token || this.lockToken;
    if (!effectiveToken) return;

    if (fs.existsSync(this.lockPath)) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (!fs.existsSync(this.lockPath)) break;
          const raw = fs.readFileSync(this.lockPath, 'utf-8');
          const data = JSON.parse(raw);
          // Only delete if it belongs to this process and token matches.
          // Atomic rename before unlink ensures we NEVER delete another process's lock.
          if (data.pid === process.pid && data.token === effectiveToken) {
            const releaseTrash = `${this.lockPath}.rel.${process.pid}.${Date.now()}`;
            try {
              fs.renameSync(this.lockPath, releaseTrash);
              try { fs.unlinkSync(releaseTrash); } catch (_) {}
              break;
            } catch (renameErr) {
              // On Windows EPERM / EBUSY, fallback to direct unlink if pid/token still match
              if (renameErr.code === 'EPERM' || renameErr.code === 'EBUSY') {
                try {
                  fs.unlinkSync(this.lockPath);
                  break;
                } catch (_) {}
              }
            }
          } else {
            break; // Lock owned by another process/token
          }
        } catch (_) {
          // Retry briefly on transient read locks
        }
        if (attempt < 2) {
          // Synchronous non-blocking sleep backoff on Windows: 50ms, 100ms
          try {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
          } catch (_) {}
        }
      }
    }
    this.lockToken = null;
  }

  async runExclusive(fn, acquireTimeoutMs = 360000, signal = null) {
    const release = await this.acquire(acquireTimeoutMs, 250, signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

class ArgonEngine {
  constructor(options = {}) {
    this.executablePath = options.executablePath || findChromePath();
    this.profileDir = options.profileDir || PROFILE_DIR;
    this.idleTimeoutMs = options.idleTimeoutMs || IDLE_TIMEOUT_MS;
    this.registryPath = path.join(__dirname, 'prompts_registry.json');
    this.wsEndpointPath = path.join(this.profileDir, 'argon_ws_endpoint.txt');
    this.lockPath = path.join(this.profileDir, 'argon_active.lock');
    this.ipcLock = new InterProcessLock(this.lockPath);
    
    this.browser = null;
    this.isExternalBrowser = false;
    this.idleTimer = null;
    this.activeRequests = 0;
    this.mutex = new AsyncMutex();
    this.sessions = new Map(); // session_id -> { page, createdAt, lastUsed }
  }

  _loadRegistry() {
    try {
      if (fs.existsSync(this.registryPath)) {
        return JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
      }
    } catch (e) {}
    return {};
  }

  _saveToRegistry(alias, promptId) {
    if (!alias || !promptId || alias === ANONYMOUS_SESSION_KEY) return;
    const tmpPath = `${this.registryPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      const reg = this._loadRegistry();
      reg[alias] = promptId;
      const jsonContent = JSON.stringify(reg, null, 2);
      try {
        fs.writeFileSync(tmpPath, jsonContent, 'utf-8');
        fs.renameSync(tmpPath, this.registryPath);
      } catch (err) {
        // Fallback on Windows EPERM / EBUSY
        fs.writeFileSync(this.registryPath, jsonContent, 'utf-8');
      }
      log(`[ArgonEngine] Registered project alias "${alias}" -> prompt "${promptId}"`);
    } catch (e) {
      logWarn('[ArgonEngine] Failed to save registry:', e.message);
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch (_) {}
    }
  }

  _removeFromRegistry(alias) {
    if (!alias || alias === ANONYMOUS_SESSION_KEY) return;
    const str = String(alias).trim();
    const tmpPath = `${this.registryPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      const reg = this._loadRegistry();
      let changed = false;
      if (str in reg) {
        delete reg[str];
        changed = true;
      }
      for (const [k, v] of Object.entries(reg)) {
        if (v === str) {
          delete reg[k];
          changed = true;
        }
      }
      if (changed) {
        const jsonContent = JSON.stringify(reg, null, 2);
        try {
          fs.writeFileSync(tmpPath, jsonContent, 'utf-8');
          fs.renameSync(tmpPath, this.registryPath);
        } catch (_) {
          fs.writeFileSync(this.registryPath, jsonContent, 'utf-8');
        }
        log(`[ArgonEngine] Removed alias "${str}" from prompts_registry.json`);
      }
    } catch (e) {
      logWarn('[ArgonEngine] Failed to update registry upon removal:', e.message);
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch (_) {}
    }
  }

  _resolvePromptId(idOrAlias) {
    if (!idOrAlias || idOrAlias === ANONYMOUS_SESSION_KEY) return null;
    const str = String(idOrAlias).trim();
    if (str.startsWith('http')) return str;
    // If exact prompt id from AI studio URL (typically 25+ characters)
    if (/^[a-zA-Z0-9_-]{25,}$/.test(str)) {
      return str;
    }
    const reg = this._loadRegistry();
    return reg[str] || null;
  }

  _pauseIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  _resetIdleTimer() {
    this._pauseIdleTimer();
    // Do not schedule idle shutdown if browser is closed or if there are requests currently running
    if (!this.browser || this.activeRequests > 0) {
      return;
    }

    this.idleTimer = setTimeout(() => {
      if (this.ipcLock.isLocked()) {
        this._resetIdleTimer();
        return;
      }
      log('[ArgonEngine] Idle timeout reached (15 min). Shutting down Chromium to save memory...');
      this.shutdown({ forceCloseHost: true }).catch(err => logError('[ArgonEngine] Shutdown error on idle:', err));
    }, this.idleTimeoutMs);

    // Ensure timer does not prevent process exit in CLI or tests
    if (this.idleTimer && typeof this.idleTimer.unref === 'function') {
      this.idleTimer.unref();
    }
  }

  async _ensureBrowser() {
    this._resetIdleTimer();

    // 1. Check if existing instance in this process is alive
    if (this.browser) {
      try {
        await this.browser.version();
        return this.browser;
      } catch (_) {
        this.browser = null;
      }
    }

    if (!fs.existsSync(this.profileDir)) {
      fs.mkdirSync(this.profileDir, { recursive: true });
    }

    // 1b. Connect to Delegator's shared background Chrome on port 9239 (spawning via ensure-web-bridge.ps1 if needed)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const verRes = await fetch(`${DELEGATOR_CDP_URL}/json/version`);
        if (verRes.ok) {
          const verJson = await verRes.json();
          if (verJson && verJson.webSocketDebuggerUrl) {
            const browser = await puppeteer.connect({
              browserWSEndpoint: verJson.webSocketDebuggerUrl,
              defaultViewport: { width: 1440, height: 900 }
            });
            await browser.version();
            this.browser = browser;
            this.isExternalBrowser = true;
            log('[ArgonEngine] Connected to Delegator shared Chrome on port 9239:', verJson.webSocketDebuggerUrl);
            this.browser.on('disconnected', () => {
              this.browser = null;
              this.sessions.clear();
            });
            return this.browser;
          }
        }
      } catch (_) {}
      if (attempt === 0) {
        const ensurePs1 = path.resolve(__dirname, '..', 'ensure-web-bridge.ps1');
        if (fs.existsSync(ensurePs1)) {
          try {
            const { execFileSync } = require('child_process');
            execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ensurePs1], { timeout: 12000, stdio: 'ignore' });
          } catch (_) {}
        }
      }
    }

    // 2. Check if another process (e.g. MCP Server) already runs Chromium
    if (fs.existsSync(this.wsEndpointPath)) {
      try {
        const wsEndpoint = fs.readFileSync(this.wsEndpointPath, 'utf-8').trim();
        if (wsEndpoint) {
          log('[ArgonEngine] Found existing Chromium WebSocket endpoint. Connecting...');
          const browser = await puppeteer.connect({
            browserWSEndpoint: wsEndpoint,
            defaultViewport: { width: 1440, height: 900 }
          });
          await browser.version();
          this.browser = browser;
          this.isExternalBrowser = true;
          log('[ArgonEngine] Connected to shared Chromium instance:', wsEndpoint);

          this.browser.on('disconnected', () => {
            log('[ArgonEngine] Shared Chromium disconnected');
            this.browser = null;
            this.sessions.clear();
          });

          return this.browser;
        }
      } catch (err) {
        logWarn('[ArgonEngine] Shared Chromium endpoint is stale or unreachable. Cleaning up...', err.message);
        try { fs.unlinkSync(this.wsEndpointPath); } catch (_) {}
      }
    }

    // 3. Clean up stale Chromium profile locks if no browser is running
    for (const lockFile of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      const p = path.join(this.profileDir, lockFile);
      try {
        if (!fs.existsSync(p)) continue;
        const stat = fs.lstatSync(p);
        if (lockFile === 'SingletonLock' && stat.isSymbolicLink()) {
          const target = fs.readlinkSync(p);
          const pidMatch = target.match(/-(\d+)$/);
          if (pidMatch && isPidAlive(Number(pidMatch[1]))) {
            throw new Error(`[ArgonEngine] Chromium profile is actively locked by running PID ${pidMatch[1]}.`);
          }
        }
        fs.unlinkSync(p);
      } catch (e) {
        if (e.message && e.message.includes('actively locked')) throw e;
      }
    }

    // Clean up any orphaned .tmp / .stale / .corrupt / .rel files in the profile directory and project root
    try {
      const dirsToClean = [this.profileDir, path.dirname(this.registryPath)];
      for (const d of dirsToClean) {
        if (!fs.existsSync(d)) continue;
        for (const file of fs.readdirSync(d)) {
          if (file.includes('.tmp') || file.includes('.stale.') || file.includes('.corrupt.') || file.includes('.rel.')) {
            try { fs.unlinkSync(path.join(d, file)); } catch (_) {}
          }
        }
      }
    } catch (_) {}

    log('[ArgonEngine] Launching host browser instance (offscreen mode)...');
    // Using headless: false with offscreen positioning (-2400,-2400)
    // to bypass Google AI Studio Botguard/WAA anti-headless checks while remaining 100% invisible.
    const existingExitListeners = new Set(process.listeners('exit'));
    this.browser = await puppeteer.launch({
      executablePath: this.executablePath,
      headless: false,
      userDataDir: this.profileDir,
      protocolTimeout: 600000,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      defaultViewport: { width: 1440, height: 900 },
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--window-position=-2400,-2400',
        '--window-size=1440,900',
        '--disable-blink-features=AutomationControlled',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
      ]
    });
    this._puppeteerExitListeners = process.listeners('exit').filter(fn => !existingExitListeners.has(fn));
    this.isExternalBrowser = false;

    // Save WebSocket endpoint for other processes (e.g. CLI)
    const tmpWs = `${this.wsEndpointPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      const ws = this.browser.wsEndpoint();
      try {
        fs.writeFileSync(tmpWs, ws, 'utf-8');
        fs.renameSync(tmpWs, this.wsEndpointPath);
      } catch (_) {
        fs.writeFileSync(this.wsEndpointPath, ws, 'utf-8');
      }
      log('[ArgonEngine] Shared WebSocket endpoint saved to:', this.wsEndpointPath);
    } catch (e) {
      logWarn('[ArgonEngine] Failed to save wsEndpoint:', e.message);
    } finally {
      try {
        if (fs.existsSync(tmpWs)) fs.unlinkSync(tmpWs);
      } catch (_) {}
    }

    this.browser.on('disconnected', () => {
      log('[ArgonEngine] Host browser disconnected');
      this.browser = null;
      this.sessions.clear();
      try {
        if (fs.existsSync(this.wsEndpointPath)) {
          fs.unlinkSync(this.wsEndpointPath);
        }
      } catch (_) {}
    });

    return this.browser;
  }

  async _getOrCreatePage(sessionId = null, promptId = null, retryCount = 0) {
    let newlyCreatedPage = null;
    try {
      const browser = await this._ensureBrowser();

      let resolvedTarget = null;
      if (promptId) {
        resolvedTarget = this._resolvePromptId(promptId);
      } else if (sessionId) {
        const reg = this._loadRegistry();
        resolvedTarget = reg[String(sessionId).trim()] || null;
      }

      const cacheKey = (sessionId && String(sessionId).trim()) || (promptId && String(promptId).trim()) || ANONYMOUS_SESSION_KEY;

      // Helper to bypass beforeunload confirmation dialogs so tab navigation/closing never hangs
      const attachDialogAutoDismiss = (targetPage) => {
        if (!targetPage || targetPage._argonDialogHandlerAttached) return;
        targetPage._argonDialogHandlerAttached = true;
        targetPage.on('dialog', async (dialog) => {
          try {
            logWarn(`[ArgonEngine] Auto-accepting browser dialog (${dialog.type()}): "${dialog.message()}"`);
            await dialog.accept();
          } catch (_) {}
        });
      };

      if (this.sessions.has(cacheKey)) {
        const session = this.sessions.get(cacheKey);
        if (session.page && !session.page.isClosed()) {
          attachDialogAutoDismiss(session.page);
          session.lastUsed = Date.now();
          if (cacheKey === ANONYMOUS_SESSION_KEY && !resolvedTarget) {
            await session.page.goto('https://aistudio.google.com/prompts/new_chat?model=gemini-4-hydrogen', {
              waitUntil: 'domcontentloaded',
              timeout: 45000
            });
            const curUrl = session.page.url();
            if (curUrl.includes('accounts.google.com')) {
              throw new Error('Google Account is not logged in. Please run `npm run login` to authenticate once.');
            }
            await session.page.waitForSelector('.model-selector-card, textarea, ms-chat-turn, ms-prompt-editor', { timeout: 30000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 600));
          }
          return session.page;
        }
        this.sessions.delete(cacheKey);
      }

      const pages = await browser.pages();

      // LRU Eviction: Keep max 5 active tabs in RAM to prevent memory leaks/bloat
      if (this.sessions.size >= 5 && !this.sessions.has(cacheKey)) {
        let oldestKey = null;
        let oldestTime = Infinity;
        for (const [key, session] of this.sessions.entries()) {
          if (key !== cacheKey && session.lastUsed < oldestTime) {
            oldestTime = session.lastUsed;
            oldestKey = key;
          }
        }
        if (oldestKey) {
          const oldSession = this.sessions.get(oldestKey);
          this.sessions.delete(oldestKey);
          log(`[ArgonEngine] LRU evicting inactive session tab "${oldestKey}" to conserve RAM.`);
          try {
            if (oldSession.page && !oldSession.page.isClosed()) {
              const currentUrl = oldSession.page.url();
              const promptMatch = currentUrl.match(/\/prompts\/([a-zA-Z0-9_-]+)/);
              if (promptMatch && promptMatch[1] && promptMatch[1] !== 'new_chat') {
                this._saveToRegistry(oldestKey, promptMatch[1]);
              }
              await oldSession.page.close({ runBeforeUnload: false }).catch(() => {});
            }
          } catch (_) {}
        }
      }

      // 1. If looking for a specific prompt ID, check if ANY open tab already has this prompt open
      if (resolvedTarget) {
        const targetSubstring = (resolvedTarget.startsWith('http') || resolvedTarget.startsWith('data:'))
          ? resolvedTarget
          : `/prompts/${resolvedTarget}`;
        const existingPage = pages.find(p => !p.isClosed() && p.url().includes(targetSubstring));
        if (existingPage) {
          attachDialogAutoDismiss(existingPage);
          log(`[ArgonEngine] Reusing already open tab for prompt "${resolvedTarget}" (URL: ${existingPage.url()})`);
          for (const [k, v] of this.sessions.entries()) {
            if (v.page === existingPage && k !== cacheKey) this.sessions.delete(k);
          }
          this.sessions.set(cacheKey, {
            page: existingPage,
            sharedTab: true,
            createdAt: Date.now(),
            lastUsed: Date.now()
          });
          return existingPage;
        }
      }

      // 2. Reuse pages[0] ONLY if it is an empty initial blank tab
      let page;
      const isBlankTab = (p) => {
        if (!p || p.isClosed()) return false;
        const u = p.url();
        return u === 'about:blank' || u === 'chrome://newtab/' || u === 'data:,' || u === '';
      };

      if (pages.length > 0 && isBlankTab(pages[0]) && !Array.from(this.sessions.values()).some(s => s.page === pages[0])) {
        page = pages[0];
      } else {
        page = await browser.newPage();
        newlyCreatedPage = page;
      }

      attachDialogAutoDismiss(page);

      let targetUrl = 'https://aistudio.google.com/prompts/new_chat?model=gemini-4-hydrogen';
      if (resolvedTarget) {
        if (resolvedTarget.startsWith('http') || resolvedTarget.startsWith('data:')) {
          targetUrl = resolvedTarget;
        } else {
          targetUrl = `https://aistudio.google.com/prompts/${resolvedTarget}`;
        }
      }

      log(`[ArgonEngine] Navigating to ${targetUrl} ...`);
      await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 45000
      });

      const url = page.url();
      if (url.includes('accounts.google.com')) {
        throw new Error('Google Account is not logged in. Please run `npm run login` to authenticate once.');
      }

      await page.waitForSelector('.model-selector-card, textarea, ms-chat-turn, ms-prompt-editor', { timeout: 30000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 600));

      await this._disableGrounding(page);

      for (const [k, v] of this.sessions.entries()) {
        if (v.page === page && k !== cacheKey) this.sessions.delete(k);
      }
      this.sessions.set(cacheKey, {
        page,
        createdAt: Date.now(),
        lastUsed: Date.now()
      });

      page.once('close', () => {
        for (const [k, v] of this.sessions.entries()) {
          if (v.page === page) {
            this.sessions.delete(k);
          }
        }
      });

      try {
        const client = await page.target().createCDPSession();
        await client.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      } catch (_) {}

      return page;
    } catch (err) {
      if (newlyCreatedPage && !newlyCreatedPage.isClosed()) {
        await newlyCreatedPage.close({ runBeforeUnload: false }).catch(() => {});
      }
      if (retryCount === 0 && (err.message.includes('Protocol error') || err.message.includes('Target.createTarget') || err.message.includes('disconnected') || err.message.includes('Session closed'))) {
        logWarn('[ArgonEngine] Browser protocol glitch detected. Re-launching clean browser instance and retrying...', err.message);
        await this.shutdown().catch(() => {});
        return await this._getOrCreatePage(sessionId, promptId, 1);
      }
      throw err;
    }
  }

  async _disableGrounding(page) {
    try {
      await page.evaluate(() => {
        // 1. Remove chip if present
        const closeBtns = Array.from(document.querySelectorAll(
          'button[aria-label*="Remove Grounding"], button[aria-label*="Remove Google Search"], button[aria-label*="Удалить Grounding"], .tool-chip-button ~ button, ms-tool-chip button, [aria-label*="Remove tool"], .mat-chip-remove'
        ));
        closeBtns.forEach(btn => {
          try { btn.click(); } catch (_) {}
        });

        // 2. Toggle off all switches / slide-toggles related to Grounding / Search
        const toggles = Array.from(document.querySelectorAll('mat-slide-toggle, button[role="switch"], .mat-mdc-slide-toggle, .mdc-switch'));
        for (const t of toggles) {
          const txt = (t.innerText || t.getAttribute('aria-label') || t.getAttribute('title') || '').toLowerCase();
          if (txt.includes('grounding') || txt.includes('search') || txt.includes('поиск') || txt.includes('заземлен')) {
            const isChecked = t.classList.contains('mdc-switch--selected') ||
                              t.classList.contains('mat-mdc-slide-toggle-checked') ||
                              t.getAttribute('aria-checked') === 'true' ||
                              !!t.querySelector('input:checked');
            if (isChecked) {
              try { t.click(); } catch (_) {}
            }
          }
        }
      });
      await new Promise(r => setTimeout(r, 400));
    } catch (_) {}
  }

  async _selectModel(page, targetModel = 'gemini-4-hydrogen') {
    log(`[ArgonEngine] Ensuring model "${targetModel}" is selected...`);

    await page.waitForSelector('.model-selector-card', { timeout: 4000 }).catch(() => {});

    const alreadySelected = await page.evaluate((target) => {
      const card = document.querySelector('.model-selector-card');
      if (!card) return false;
      const text = (card.innerText || '').toLowerCase();
      return text.includes('gemini 4 hydrogen') || text.includes('gemini-4-hydrogen') || text.includes('hydrogen') || text.includes('gemini 4 argon') || text.includes(target.toLowerCase());
    }, targetModel);

    if (alreadySelected) {
      log(`[ArgonEngine] Model "${targetModel}" is confirmed active in UI.`);
      return true;
    }

    const currentUrl = page.url() || '';
    if (currentUrl.includes('model=gemini-4-hydrogen') || currentUrl.includes('model=gemini-4-argon')) {
      const hasConflict = await page.evaluate(() => {
        const card = document.querySelector('.model-selector-card');
        if (!card) return false;
        const text = (card.innerText || '').toLowerCase();
        return text.length > 0 && !text.includes('hydrogen') && !text.includes('argon');
      });
      if (!hasConflict) {
        log(`[ArgonEngine] Model "${targetModel}" is active via URL parameter.`);
        return true;
      }
    }

    log('[ArgonEngine] Opening model selection dialog...');
    const cardClicked = await page.evaluate(() => {
      const card = document.querySelector('.model-selector-card');
      if (card) {
        card.click();
        return true;
      }
      return false;
    });

    if (!cardClicked) {
      logWarn('[ArgonEngine] .model-selector-card not found.');
      return false;
    }

    await page.waitForSelector('input[placeholder*="Search"], input[aria-label*="Search"]', { timeout: 10000 }).catch(() => {});

    await page.evaluate(() => {
      const input = document.querySelector('input[placeholder*="Search"], input[aria-label*="Search"]');
      if (input) {
        input.value = 'hydrogen';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    await page.waitForSelector('button.content-button', { timeout: 10000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 600));

    const selected = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button.content-button'));
      const target = buttons.find(b => {
        const t = (b.innerText || '').toLowerCase();
        return t.includes('gemini-4-hydrogen') || t.includes('gemini 4 hydrogen') || t.includes('hydrogen') || t.includes('gemini-4-argon');
      });
      if (target) {
        target.click();
        return true;
      }
      return false;
    });

    await new Promise(r => setTimeout(r, 1500));
    log('[ArgonEngine] Model selection result:', selected);
    return selected;
  }

  async _setThinkingLevel(page, level = 'high') {
    try {
      await page.evaluate(async (targetLevel) => {
        const selects = Array.from(document.querySelectorAll('mat-select[aria-label*="Thinking"], ms-thinking-level-setting mat-select, mat-select[aria-label*="мышлени"], [data-test-id*="thinking-level"] mat-select, ms-select[aria-label*="Thinking"]'));
        const select = selects[0];
        if (!select) return;
        const current = (select.innerText || '').toLowerCase();
        if (current.includes(targetLevel)) return;
        select.click();
        await new Promise(r => setTimeout(r, 300));
        const options = Array.from(document.querySelectorAll('mat-option, [role="option"]'));
        const opt = options.find(o => (o.innerText || '').toLowerCase().includes(targetLevel));
        if (opt) {
          opt.click();
        } else {
          document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        }
      }, level.toLowerCase());
    } catch (_) {}
  }

  async _setSystemInstructions(page, systemInstruction) {
    if (!systemInstruction || typeof systemInstruction !== 'string' || !systemInstruction.trim()) {
      return false;
    }
    const cleanText = systemInstruction.trim();
    try {
      const success = await page.evaluate(async (instruction) => {
        const container = document.querySelector('ms-system-instructions, .system-instructions, [data-test-id*="system-instruction"]');
        if (!container) return false;

        // If collapsed (e.g. expansion panel or details), open it
        const header = container.querySelector('mat-expansion-panel-header, button[aria-expanded="false"], .expansion-header');
        if (header && (header.getAttribute('aria-expanded') === 'false' || !container.classList.contains('mat-expanded'))) {
          try { header.click(); } catch (_) {}
          await new Promise(r => setTimeout(r, 250));
        }

        const ta = container.querySelector('textarea, [contenteditable="true"]');
        if (!ta) return false;

        if (ta.tagName === 'TEXTAREA') {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
          if (nativeSetter) {
            nativeSetter.call(ta, instruction);
          } else {
            ta.value = instruction;
          }
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          ta.innerText = instruction;
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      }, cleanText);

      if (success) {
        log(`[ArgonEngine] Set native system instructions (${cleanText.length} chars).`);
        return true;
      }
      return false;
    } catch (e) {
      logWarn('[ArgonEngine] Could not set native system instructions:', e.message);
      return false;
    }
  }

  async _insertPromptText(page, prompt) {
    log(`[ArgonEngine] Inserting prompt text (${prompt.length} chars)...`);
    const prioritySelectors = [
      'ms-prompt-input-wrapper textarea',
      'ms-chunk-input textarea',
      'ms-prompt-editor textarea',
      'footer textarea',
      'textarea[aria-label*="Type something"]',
      'textarea[aria-label*="Start typing"]',
      'textarea[placeholder*="Type"]',
      'textarea[placeholder*="Введите"]',
      'textarea.textarea:not([aria-label*="System"])',
      '[contenteditable="true"][role="textbox"]'
    ];

    const combinedSelector = prioritySelectors.join(', ');
    await page.waitForSelector(combinedSelector, { timeout: 15000 });

    const inserted = await page.evaluate((text, selectors) => {
      let el = null;
      for (const sel of selectors) {
        const candidate = document.querySelector(sel);
        if (candidate && !candidate.closest('ms-system-instructions, .system-instructions')) {
          el = candidate;
          break;
        }
      }
      if (!el) return false;

      el.focus();
      el.click();

      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
          || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(el, text || '');
        } else {
          el.value = text || '';
        }
      } else {
        el.innerText = text || '';
      }

      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, prompt, prioritySelectors);

    if (!inserted) {
      throw new Error('[ArgonEngine] Failed to locate main chat prompt textarea.');
    }

    await new Promise(r => setTimeout(r, 300));
  }

  async _waitForAttachmentsReady(page, timeoutMs = 90000) {
    const startTime = Date.now();
    log(`[ArgonEngine] Awaiting file upload and processing in AI Studio (timeout: ${timeoutMs / 1000}s)...`);

    // Mandatory initial delay to let upload progress bar attach to DOM and initiate tokenization
    await new Promise(r => setTimeout(r, 1500));

    let readyCount = 0;
    while (Date.now() - startTime < timeoutMs) {
      let isUploading = false;
      try {
        isUploading = await page.evaluate(() => {
          // 1. Check prompt box / input area for "Loading..." text or progress indicators
          const promptContainer = document.querySelector('ms-prompt-editor, .prompt-box, .chat-input-container, form, footer');
          const containerText = (promptContainer ? promptContainer.innerText : document.body.innerText).toLowerCase();

          const hasLoadingText = containerText.includes('loading...') ||
                                 containerText.includes('loading…') ||
                                 containerText.includes('загрузка...') ||
                                 containerText.includes('загрузка…');

          // 2. Check spinners scoped to prompt editor / attachments area
          const hasSpinners = !!(document.querySelector('mat-progress-spinner, mat-spinner, .loading-spinner, [role="progressbar"], .file-loading'));

          // 3. Check if Run button is disabled due to active file upload/tokenization
          const runButtons = Array.from(document.querySelectorAll('button')).filter(b => {
            const txt = (b.innerText || '').trim().toLowerCase();
            const label = (b.getAttribute('aria-label') || '').toLowerCase();
            return txt === 'run' || txt === 'запустить' || label.includes('run') || label.includes('execute');
          });
          const isRunDisabled = runButtons.some(b => b.disabled || b.getAttribute('aria-disabled') === 'true');

          return hasLoadingText || hasSpinners || (isRunDisabled && runButtons.length > 0);
        });
      } catch (err) {
        if (page.isClosed() || !this.browser || !this.browser.connected) {
          throw new Error(`[ArgonEngine] Browser or tab closed during attachment upload: ${err.message}`);
        }
        logWarn('[ArgonEngine] Transient CDP context glitch during attachment check, retrying...', err.message);
        readyCount = 0;
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      if (!isUploading) {
        readyCount++;
        // Ensure state is stable for at least 2 consecutive checks
        if (readyCount >= 2) {
          log('[ArgonEngine] All file attachments processed and ready (tokenization complete).');
          // Brief stabilization pause for AI Studio context updates
          await new Promise(r => setTimeout(r, 1000));
          return;
        }
      } else {
        readyCount = 0;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    logWarn('[ArgonEngine] File upload wait timeout reached. Proceeding with send.');
  }

  async _triggerSend(page, initialTurnsCount) {
    log('[ArgonEngine] Triggering generation...');
    await this._disableGrounding(page);

    // Try clicking Run up to 3 times (with 1s pause) in case UI was briefly busy finishing upload/tokenization
    for (let attempt = 0; attempt < 3; attempt++) {
      const clickedRun = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const runBtn = buttons.find(b => {
          const txt = (b.innerText || '').trim().toLowerCase();
          const label = (b.getAttribute('aria-label') || '').toLowerCase();
          const cls = (b.className || '').toLowerCase();

          // Exclude stop, rerun, close buttons
          if (txt.includes('stop') || txt.includes('останов') || label.includes('stop') || cls.includes('stop')) return false;
          if (cls.includes('rerun') || label.includes('rerun') || txt.includes('rerun')) return false;
          if (cls.includes('close') || label.includes('close') || txt.includes('close')) return false;
          if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;

          // Match primary submit button (supports Angular ctrl-enter-submits & multi-line Run text)
          return (
            cls.includes('ctrl-enter-submits') ||
            (cls.includes('ms-button-primary') && (txt.startsWith('run') || txt.startsWith('запустить'))) ||
            txt.startsWith('run\n') ||
            txt === 'run' ||
            txt === 'запустить' ||
            (label && (label.startsWith('run') || label.startsWith('запустить') || label.includes('execute')))
          );
        });
        if (runBtn) {
          runBtn.click();
          return true;
        }
        return false;
      });

      if (clickedRun) {
        await new Promise(r => setTimeout(r, 1000));
        const started = await page.evaluate((initCount) => {
          const turns = document.querySelectorAll('ms-chat-turn, .chat-turn').length;
          const hasStop = !!document.querySelector('button[aria-label*="Stop"], button[aria-label*="Остановить"], [data-test-id*="stop-button"], .stop-button');
          return turns > initCount || hasStop;
        }, initialTurnsCount);

        if (started) return;
      }

      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 800));
      }
    }

    // 2. Fallback: Puppeteer native Ctrl+Enter ONLY if Run button click didn't start generation
    log('[ArgonEngine] Run button did not trigger start yet, sending fallback Ctrl+Enter...');
    const textarea = await page.$('textarea.textarea, textarea, [contenteditable="true"][role="textbox"]');
    if (textarea) {
      await textarea.focus();
      await page.keyboard.down('Control');
      try {
        await page.keyboard.press('Enter');
      } finally {
        await page.keyboard.up('Control').catch(() => {});
      }
    }
  }

  async _handleSaveDialog(page) {
    try {
      await page.evaluate(() => {
        const dialog = document.querySelector('mat-dialog-container, .dialog-container, [role="dialog"]');
        if (dialog) {
          const buttons = Array.from(dialog.querySelectorAll('button'));
          const confirmBtn = buttons.find(b => {
            const txt = (b.innerText || '').trim().toLowerCase();
            return txt === 'save' || txt === 'сохранить' || txt === 'confirm' || txt === 'ok';
          });
          if (confirmBtn) confirmBtn.click();
        }
      });
      await page.keyboard.press('Escape');
    } catch (_) {}
  }

  async _waitForResponse(page, initialTurnsCount, timeoutMs = 360000, options = null) {
    const onProgress = typeof options === 'function' ? options : options?.onProgress;
    const signal = typeof options === 'object' ? options?.signal : null;

    log('[ArgonEngine] Waiting for generation to finish...');
    const startTime = Date.now();

    // Small delay to let generation start
    await new Promise(r => setTimeout(r, 1500));

    let stableCount = 0;
    let lastSignature = '';
    let retryAttempt = 0;
    const maxRetries = 2;

    while (Date.now() - startTime < timeoutMs) {
      if (signal?.aborted) {
        logWarn('[ArgonEngine] Request was aborted by client. Attempting to click Stop button in UI...');
        await page.evaluate(() => {
          const stopBtn = document.querySelector('button[aria-label*="Stop"], button[aria-label*="Остановить"], [data-test-id*="stop-button"], .stop-button');
          if (stopBtn) stopBtn.click();
        }).catch(() => {});
        throw new Error('[ArgonEngine] Request was aborted by client.');
      }

      let status;
      try {
        status = await page.evaluate((initCount) => {
          const turns = Array.from(document.querySelectorAll('ms-chat-turn, .chat-turn'));
          const hasNewTurns = turns.length > initCount;
          const lastTurn = hasNewTurns ? turns[turns.length - 1] : null;

          // 0. Check for blocking modals (Captcha, Quota limit, Unsaved prompt, Safety/ToS dialogs)
          const dialogs = Array.from(document.querySelectorAll('mat-dialog-container, .dialog-container, [role="dialog"], [role="alertdialog"]'));
          for (const dlg of dialogs) {
            const isVisible = !!(dlg.offsetWidth || dlg.offsetHeight || (dlg.getClientRects && dlg.getClientRects().length > 0));
            if (!isVisible) continue;
            const dlgText = (dlg.innerText || '').trim();
            const lowerDlg = dlgText.toLowerCase();

            // Auto-dismiss harmless "Save prompt" / "Unsaved changes" / "Got it" dialogs
            const buttons = Array.from(dlg.querySelectorAll('button'));
            const dismissBtn = buttons.find(b => {
              const t = (b.innerText || '').trim().toLowerCase();
              return t === 'got it' || t === 'понятно' || t === 'dismiss' || t === 'close' || t === 'закрыть' || t === 'continue' || t === 'продолжить';
            });
            if (dismissBtn && !lowerDlg.includes('quota') && !lowerDlg.includes('limit') && !lowerDlg.includes('captcha')) {
              try { dismissBtn.click(); } catch (_) {}
              continue;
            }

            if (lowerDlg.includes('quota') || lowerDlg.includes('rate limit') || lowerDlg.includes('resource exhausted') || lowerDlg.includes('превышен лимит') || lowerDlg.includes('квот')) {
              return {
                errorText: `AI Studio Quota/Rate Limit modal: ${dlgText.replace(/\s+/g, ' ').slice(0, 300)}`,
                isRunning: false,
                isNewModelTurn: false,
                turnsCount: turns.length,
                isStillThinking: false,
                rawLength: 0,
                thoughtsLength: 0,
                signature: 'modal_error'
              };
            }
          }

          const hasCaptcha = !!document.querySelector('iframe[src*="recaptcha"], iframe[title*="reCAPTCHA"], .g-recaptcha');
          if (hasCaptcha) {
            return {
              errorText: 'Google AI Studio requested interactive reCAPTCHA verification. Run `npm run login` to pass verification.',
              isRunning: false,
              isNewModelTurn: false,
              turnsCount: turns.length,
              isStillThinking: false,
              rawLength: 0,
              thoughtsLength: 0,
              signature: 'captcha_error'
            };
          }

          // 1. Check for visible runtime errors
          let errorText = '';
          const lastTurnErrors = lastTurn ? Array.from(lastTurn.querySelectorAll(
            '.model-error, .error-message, ms-chat-turn-error, [data-test-id*="model-error"], .blocked-response, .safety-error'
          )) : [];
          const globalErrors = Array.from(document.querySelectorAll(
            '.banner-error, mat-snack-bar-container, .global-error, [data-test-id*="global-error"]'
          ));
          const errorEls = [...lastTurnErrors, ...globalErrors];
          for (const el of errorEls) {
            const isVisible = !!(el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length > 0));
            if (isVisible) {
              const txt = (el.innerText || '').trim();
              if (txt && !txt.toLowerCase().includes('thinking') && !txt.toLowerCase().includes('размышления')) {
                errorText = txt;
                break;
              }
            }
          }

          // 2. Check for stop button or active generation state
          const stopButtons = Array.from(document.querySelectorAll(
            'button[aria-label*="Stop"], button[aria-label*="Остановить"], [data-test-id*="stop-button"], .stop-button, button.Stop, ms-run-button button, button.run-button'
          ));
          const hasVisibleStopBtn = stopButtons.some(b => {
            const isVisible = !!(b.offsetWidth || b.offsetHeight || (b.getClientRects && b.getClientRects().length > 0));
            if (!isVisible || b.disabled) return false;
            if (b.matches('[data-test-id*="stop-button"], .stop-button, .running')) return true;
            const txt = (b.innerText || b.getAttribute('aria-label') || b.getAttribute('mattooltip') || '').toLowerCase();
            return txt.includes('stop') || txt.includes('останов') || txt.includes('cancel');
          });

          const hasActiveTurnSpinner = lastTurn
            ? !!lastTurn.querySelector('mat-progress-spinner, mat-spinner, .loading-spinner, .thinking-indicator, .generating-indicator, [aria-busy="true"]')
            : false;

          const isRunning = hasVisibleStopBtn || hasActiveTurnSpinner;

          let isNewModelTurn = false;
          let rawLength = 0;
          let thoughtsLength = 0;
          let tailPreview = '';
          let isStillThinking = true;

          if (lastTurn) {
            const isUser = lastTurn.matches('.user-turn, [data-turn-role="user"]') ||
                           !!lastTurn.querySelector('.user-heading, .user-avatar, [aria-label*="User"]');
            const hasModelIndicators = lastTurn.matches('.model-turn, [data-turn-role="model"], .model-prompt-container') ||
                                      !!lastTurn.querySelector('.model-heading, .model-avatar, [aria-label*="Model"], ms-cmark-node, ms-thought-chunk, .rendered-markdown');

            if (!isUser && (turns.length >= initCount + 2 || hasModelIndicators)) {
              isNewModelTurn = true;

              if (isRunning) {
                return {
                  errorText,
                  isRunning: true,
                  isNewModelTurn: true,
                  turnsCount: turns.length,
                  isStillThinking: false,
                  rawLength: 0,
                  thoughtsLength: 0,
                  signature: 'streaming'
                };
              }

              const clone = lastTurn.cloneNode(true);
              const thoughtEls = clone.querySelectorAll(
                'ms-thought-chunk, .thought-chunk, ms-thought-accordion, .thinking-content, .thought-container, details.thought-details, [data-test-id*="thought"], .thoughts-content, .thought-text, ms-thought'
              );
              let extractedThoughtChars = 0;
              thoughtEls.forEach(el => {
                extractedThoughtChars += (el.innerText || el.textContent || '').trim().length;
                el.remove();
              });
              thoughtsLength = extractedThoughtChars;

              const uiChromeEls = clone.querySelectorAll(
                'mat-expansion-panel-header, .mat-expansion-panel-header, .turn-header, .model-heading, .user-heading, .author-label, .turn-footer, button'
              );
              uiChromeEls.forEach(el => el.remove());

              const contentEl = clone.querySelector('.markdown, .rendered-markdown, .turn-content, ms-cmark-node, .message-content') || clone;
              let cleanText = (contentEl.innerText || '').trim();
              cleanText = cleanText
                .replace(/^(?:Model|User|Модель|Пользователь|Gemini\s*4\s*Argon|Gemini\s*4\s*Hydrogen)\s*(?:\d{1,2}:\d{2}\s*(?:AM|PM)?)?\s*\n?/i, '')
                .replace(/^(?:Thoughts\s*\(experimental\)|Expand to view model thoughts|Мысли\s*\(экспериментально\))\s*\n?/ig, '')
                .trim();

              const norm = cleanText.toLowerCase().replace(/[^a-zа-я]/g, '');
              const isShortStatus = cleanText.length < 90;
              isStillThinking =
                (cleanText.length === 0 && thoughtsLength === 0) ||
                (isShortStatus && (
                  /^(thinking|размышления)(\s+for\s+\d+.*|\.+)?$/i.test(cleanText) ||
                  norm.startsWith('thoughtsexperimental') ||
                  norm === 'thinking' ||
                  norm === 'размышления'
                ));
              rawLength = cleanText.length;
              tailPreview = cleanText.slice(-80) || `thoughts_only:${thoughtsLength}`;
            }
          }

          return {
            errorText,
            isRunning,
            isNewModelTurn,
            turnsCount: turns.length,
            isStillThinking,
            rawLength,
            thoughtsLength,
            signature: `${rawLength}:${thoughtsLength}:${tailPreview}`
          };
        }, initialTurnsCount);
      } catch (err) {
        if (page.isClosed() || !this.browser || !this.browser.connected) {
          throw new Error(`[ArgonEngine] Target tab or browser closed while waiting for response: ${err.message}`);
        }
        logWarn('[ArgonEngine] Transient execution context error during polling, waiting for context to settle...', err.message);
        stableCount = 0;
        await new Promise(r => setTimeout(r, 1200));
        continue;
      }

      if (!status.isRunning && status.errorText) {
        // Auto-retry transient backend glitches (e.g. "An internal error has occurred")
        const isTransient = /internal error|temporar|try again|service unavailable/i.test(status.errorText);
        if (isTransient && retryAttempt < maxRetries) {
          retryAttempt++;
          stableCount = 0;
          lastSignature = '';
          logWarn(`[ArgonEngine] Transient AI Studio error detected ("${status.errorText}"). Attempting auto-retry (${retryAttempt}/${maxRetries})...`);
          await new Promise(r => setTimeout(r, 2000));
          const clickedRetry = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const retryBtn = buttons.find(b => {
              const txt = (b.innerText || '').toLowerCase();
              const label = (b.getAttribute('aria-label') || '').toLowerCase();
              const tooltip = (b.getAttribute('mattooltip') || '').toLowerCase();
              return (
                txt.includes('retry') || txt.includes('повтор') || txt.includes('rerun') ||
                label.includes('retry') || label.includes('повтор') || label.includes('rerun') ||
                tooltip.includes('retry') || tooltip.includes('rerun')
              );
            });
            if (retryBtn && !retryBtn.disabled && retryBtn.getAttribute('aria-disabled') !== 'true') {
              retryBtn.click();
              return true;
            }
            return false;
          });
          if (!clickedRetry) {
            throw new Error(`[ArgonEngine] Transient AI Studio error ("${status.errorText}") occurred, but no active Retry/Rerun button was found in UI.`);
          }
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        throw new Error(`[ArgonEngine] AI Studio error: ${status.errorText}`);
      }

      // Allow completion if either final response text OR thoughts-only output has stabilized after generation stopped
      if (!status.isRunning && status.isNewModelTurn && !status.isStillThinking && (status.rawLength > 0 || status.thoughtsLength > 0)) {
        if (status.signature === lastSignature) {
          stableCount++;
          // If only thoughts exist without body text yet, wait 5 ticks (6.0s) to ensure body stream isn't just delayed
          const requiredTicks = status.rawLength > 0 ? 3 : 5;
          if (stableCount >= requiredTicks) {
            log(`[ArgonEngine] Generation complete! Raw length: ${status.rawLength} chars (thoughts: ${status.thoughtsLength} chars).`);
            break;
          }
        } else {
          stableCount = 0;
          lastSignature = status.signature;
        }
      } else {
        stableCount = 0;
      }

      if (typeof onProgress === 'function') {
        const elapsedSec = Math.round((Date.now() - startTime) / 1000);
        const maxSec = Math.round(timeoutMs / 1000);
        const progressMsg = status.isStillThinking
          ? `Thinking (${elapsedSec}s elapsed)...`
          : `Streaming response (${status.rawLength} chars)...`;
        try {
          onProgress(progressMsg, Math.min(95, Math.round((elapsedSec / maxSec) * 100)), 100);
        } catch (_) {}
      }

      await new Promise(r => setTimeout(r, 1200));
    }

    const isTimedOut = Date.now() - startTime >= timeoutMs;
    if (isTimedOut) {
      logWarn('[ArgonEngine] Response wait timeout reached. Extracting available output.');
    }

    // 1. Expand thought accordions / details panels if collapsed and let Angular render DOM
    await page.evaluate((initCount) => {
      const turns = Array.from(document.querySelectorAll('ms-chat-turn, .chat-turn'));
      if (turns.length <= initCount) return;
      const lastTurn = turns[turns.length - 1];

      const thoughtPanels = lastTurn.querySelectorAll(
        'details.thought-details, details, mat-expansion-panel, ms-thought-accordion, [data-test-id*="thought"]'
      );
      thoughtPanels.forEach(p => {
        if (p.tagName === 'DETAILS') {
          p.open = true;
        } else {
          const header = p.querySelector('mat-expansion-panel-header[aria-expanded="false"], button[aria-expanded="false"]');
          if (header) {
            try { header.click(); } catch (_) {}
          }
        }
      });
    }, initialTurnsCount);

    // Allow Angular ChangeDetection and expansion animation to finish
    await new Promise(r => setTimeout(r, 300));

    // 2. Perform full DOM clone and Markdown formatting after generation stabilizes
    const extracted = await page.evaluate((initCount) => {
      const turns = Array.from(document.querySelectorAll('ms-chat-turn, .chat-turn'));
      if (turns.length <= initCount) return { thoughts: '', response: '' };

      const lastTurn = turns[turns.length - 1];

      // 1. Extract thoughts before cleaning
      const thoughtSelectors = [
        'ms-thought-chunk',
        '.thought-chunk',
        'ms-thought-accordion',
        '.thinking-content',
        '.thought-container',
        'details.thought-details',
        '[data-test-id*="thought"]',
        '.thoughts-content',
        '.thought-text',
        'ms-thought'
      ];
      const allThoughtElements = Array.from(lastTurn.querySelectorAll(thoughtSelectors.join(', ')));
      // Filter out descendant thought elements whose parent/ancestor is already in the list to avoid duplicate text
      const thoughtElements = allThoughtElements.filter(
        el => !allThoughtElements.some(other => other !== el && other.contains(el))
      );
      // Helper for normalizing code blocks and KaTeX math formulas before innerText
      const normalizeRichNodes = (rootEl) => {
        // 1. Restore LaTeX from KaTeX / MathML before innerText
        const mathNodes = Array.from(rootEl.querySelectorAll('ms-katex, .katex-display, .katex, math'));
        for (const node of mathNodes) {
          if (!rootEl.contains(node)) continue;
          const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
          const texAttr = node.getAttribute('data-tex') || node.getAttribute('tex');
          const rawTex = (annotation ? annotation.textContent : texAttr) || '';
          if (rawTex.trim()) {
            const isBlock = node.classList.contains('katex-display') ||
                            (node.tagName === 'MS-KATEX' && node.hasAttribute('display')) ||
                            node.getAttribute('display') === 'block' ||
                            !!node.closest('.katex-display');
            const wrapped = isBlock ? `\n$$\n${rawTex.trim()}\n$$\n` : `$${rawTex.trim()}$`;
            const targetToReplace = node.closest('.katex-display') || node.closest('ms-katex') || node;
            targetToReplace.replaceWith(document.createTextNode(wrapped));
          }
        }

        // 2. Transform ms-code-block into clean Markdown
        const codeBlocks = Array.from(rootEl.querySelectorAll('ms-code-block'));
        for (const block of codeBlocks) {
          let lang = (block.getAttribute('data-test-language') || block.getAttribute('data-language') || '').toLowerCase();
          if (!lang) {
            const header = block.querySelector('.code-block-header, mat-expansion-panel-header, .header');
            if (header) {
              const cleanedHeader = (header.innerText || '')
                .replace(/content_copy|download|wrap_text|check|expand_more|expand_less/gi, '')
                .trim()
                .toLowerCase();
              lang = (cleanedHeader.split(/\s+/)[0] || '').replace(/[^a-z0-9+#_-]/g, '');
            }
          }
          const codeEl = block.querySelector('code') || block.querySelector('pre') || block;
          const rawCode = codeEl.textContent || '';
          const codeText = rawCode.replace(/^\r?\n+|\r?\n+$/g, '');
          const mdNode = document.createTextNode(`\n\`\`\`${lang}\n${codeText}\n\`\`\`\n`);
          block.replaceWith(mdNode);
        }
      };

      let thoughtsText = '';
      if (thoughtElements && thoughtElements.length > 0) {
        thoughtsText = thoughtElements
          .map(el => {
            const thoughtClone = el.cloneNode(true);
            normalizeRichNodes(thoughtClone);
            // Strip UI noise inside thoughts
            const noise = thoughtClone.querySelectorAll('mat-icon, .material-icons, .material-symbols-outlined, button, .code-block-header, ms-code-block-header, .copy-code-button, svg');
            noise.forEach(n => n.remove());
            return (thoughtClone.innerText || thoughtClone.textContent || '').trim();
          })
          .filter(t => t.length > 0 && t.toLowerCase() !== 'thinking' && t.toLowerCase() !== 'размышления')
          .join('\n\n')
          .trim();
      }

      // 2. Clone turn for response extraction
      const clone = lastTurn.cloneNode(true);

      // Remove thought elements and grounding/citation artifacts FIRST before structural Markdown conversion
      const unwantedSelectors = [
        ...thoughtSelectors,
        'ms-grounding-sources',
        'ms-search-entry-point',
        '.grounding-chunks',
        '.grounding-sources',
        '.citation-chip',
        'ms-citation-chip',
        'sup.citation',
        '.footnote-index',
        'mat-icon',
        '.material-icons',
        '.material-symbols-outlined',
        'ms-code-block-header',
        '.code-block-header',
        '.code-block-actions',
        '.copy-code-button',
        'button',
        '.action-buttons',
        '.turn-footer',
        '.turn-header',
        '.user-heading',
        '.model-heading',
        '.chat-turn-header',
        '.author-label',
        'svg',
        'mat-divider',
        '.feedback-container'
      ];
      clone.querySelectorAll(unwantedSelectors.join(', ')).forEach(t => t.remove());

      normalizeRichNodes(clone);

      // Fallback for any standalone <pre> not wrapped in <ms-code-block>
      const orphanPres = Array.from(clone.querySelectorAll('pre'));
      for (const pre of orphanPres) {
        const codeEl = pre.querySelector('code') || pre;
        const rawCode = codeEl.textContent || '';
        const codeText = rawCode.replace(/^\r?\n+|\r?\n+$/g, '');
        const mdNode = document.createTextNode(`\n\`\`\`\n${codeText}\n\`\`\`\n`);
        pre.replaceWith(mdNode);
      }

      // Preserve inline `code` (including inside table cells and lists)
      clone.querySelectorAll('code, [class*="inline-code"]').forEach(codeEl => {
        if (!codeEl.closest('pre, ms-code-block')) {
          const txt = (codeEl.textContent || '').trim();
          if (txt && !txt.startsWith('`')) {
            codeEl.replaceWith(document.createTextNode(`\`${txt}\``));
          }
        }
      });

      // Preserve Markdown tables BEFORE list newline injection so lists inside cells don't break table rows
      clone.querySelectorAll('table').forEach(tbl => {
        const rows = Array.from(tbl.querySelectorAll('tr')).filter(tr => tr.closest('table') === tbl);
        if (rows.length === 0) return;
        const mdRows = [];
        let headerRow = true;
        for (const tr of rows) {
          const cells = Array.from(tr.querySelectorAll('th, td'))
            .filter(c => c.closest('tr') === tr)
            .map(c => {
              // Convert multi-line or list items inside table cells to <br> to keep GFM table valid
              c.querySelectorAll('li').forEach((li, i) => {
                li.prepend(document.createTextNode(i > 0 ? '<br>• ' : '• '));
              });
              c.querySelectorAll('br, p, div').forEach((block, i) => {
                if (block.tagName === 'BR') {
                  block.replaceWith(document.createTextNode('<br>'));
                } else if (i > 0) {
                  block.prepend(document.createTextNode('<br>'));
                }
              });
              return (c.textContent || '')
                .trim()
                .replace(/\r?\n+/g, '<br>')
                .replace(/(?:<br>\s*){2,}/g, '<br>')
                .replace(/\|/g, '\\|');
            });
          if (cells.length === 0) continue;
          mdRows.push(`| ${cells.join(' | ')} |`);
          if (headerRow) {
            mdRows.push(`| ${cells.map(() => '---').join(' | ')} |`);
            headerRow = false;
          }
        }
        if (mdRows.length > 0) {
          tbl.replaceWith(document.createTextNode(`\n\n${mdRows.join('\n')}\n\n`));
        }
      });

      // Preserve Markdown headings with proper newlines
      clone.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
        const level = Number(h.tagName[1]) || 2;
        h.prepend(document.createTextNode(`\n\n${'#'.repeat(level)} `));
        h.append(document.createTextNode('\n\n'));
      });

      // Preserve unordered and ordered lists with proper per-list numbering and nesting indentation
      clone.querySelectorAll('ul, ol').forEach(listEl => {
        let depth = 0;
        let parent = listEl.parentElement;
        while (parent && parent !== clone) {
          if (parent.tagName === 'UL' || parent.tagName === 'OL') depth++;
          parent = parent.parentElement;
        }
        const indent = '  '.repeat(depth);
        const isOrdered = listEl.tagName === 'OL';
        const startNum = Number(listEl.getAttribute('start')) || 1;
        const directItems = Array.from(listEl.children).filter(ch => ch.tagName === 'LI');
        directItems.forEach((li, idx) => {
          const prefix = isOrdered ? `${startNum + idx}. ` : '- ';
          li.prepend(document.createTextNode(`\n${indent}${prefix}`));
        });
      });

      const contentEl = clone.querySelector('.markdown, .rendered-markdown, .turn-content, ms-cmark-node, .message-content');
      let text = (contentEl ? contentEl.innerText : clone.innerText) || '';

      // Safe strip of author/time prefix and normalize Windows CRLF / excessive blank lines
      text = text
        .replace(/\r\n/g, '\n')
        .replace(/^(?:Model|User)\s*\d{1,2}:\d{2}\s*(?:AM|PM)?\s*\n?/i, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      return {
        thoughts: thoughtsText,
        response: text
      };
    }, initialTurnsCount);

    if (isTimedOut && extracted?.response) {
      extracted.response += '\n\n[WARNING: RESPONSE TRUNCATED DUE TO TIMEOUT]';
    }

    return extracted;
  }

  _safeSliceUtf16(str, start, end) {
    const sliced = str.slice(start, end);
    if (typeof sliced.toWellFormed === 'function') {
      return sliced.toWellFormed();
    }
    return sliced.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  }

  _writeTempFileWithRetry(filePath, content, maxAttempts = 4) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        fs.writeFileSync(filePath, content, 'utf-8');
        return;
      } catch (err) {
        if ((err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') && attempt < maxAttempts - 1) {
          try {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60 * (attempt + 1));
          } catch (_) {}
          continue;
        }
        throw err;
      }
    }
  }

  _unlinkTempFileWithRetry(filePath, maxAttempts = 5) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        if (!fs.existsSync(filePath)) return;
        fs.unlinkSync(filePath);
        return;
      } catch (err) {
        if ((err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') && attempt < maxAttempts - 1) {
          try {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80 * (attempt + 1));
          } catch (_) {}
          continue;
        }
      }
    }
  }

  async askArgon({ prompt, systemInstruction = null, sessionId = null, promptId = null, images = [], timeoutMs = 360000, signal = null, onProgress = null }) {
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('Prompt cannot be empty');
    }

    if (signal?.aborted) {
      throw new Error('[ArgonEngine] Request was aborted by client.');
    }

    const requestStartTime = Date.now();
    this.activeRequests++;
    this._pauseIdleTimer();

    try {
      return await this.mutex.runExclusive(async () => {
        if (signal?.aborted) {
          throw new Error('[ArgonEngine] Request was aborted by client.');
        }
        const mutexElapsed = Date.now() - requestStartTime;
        const ipcAcquireBudget = Math.max(1000, timeoutMs - mutexElapsed);

        return await this.ipcLock.runExclusive(async () => {
          if (signal?.aborted) {
            throw new Error('[ArgonEngine] Request was aborted by client.');
          }
          const lockWaitElapsed = Date.now() - requestStartTime;
          const remainingTimeout = timeoutMs - lockWaitElapsed;
          if (remainingTimeout <= 0) {
            throw new Error(`[ArgonEngine] Request timed out waiting in queue for IPC lock. Waited ${(lockWaitElapsed / 1000).toFixed(1)}s, total budget ${timeoutMs / 1000}s.`);
          }

          const page = await this._getOrCreatePage(sessionId, promptId);

          // 1. Ensure Hydrogen model is selected
          await this._selectModel(page, 'gemini-4-hydrogen');
          await this._setThinkingLevel(page, 'high');

          // 2. Ensure Grounding with Google Search is disabled to prevent API key / permission errors
          await this._disableGrounding(page);

          // 3. Native System Instructions (if provided)
          let finalPrompt = prompt;
          if (systemInstruction && typeof systemInstruction === 'string' && systemInstruction.trim()) {
            const setNatively = await this._setSystemInstructions(page, systemInstruction);
            if (!setNatively) {
              finalPrompt = `[SYSTEM INSTRUCTIONS]:\n${systemInstruction.trim()}\n\n[USER TASK]:\n${prompt}`;
            }
          }

          // 4. Prepare attachments
          const validFiles = [];
          const tempFilesToCleanup = [];

          // 5. Handle massive prompts (>120,000 chars) via auto-offload, otherwise ultra-fast DOM native setter
          const MAX_INLINE_PROMPT_LEN = 120000;
          if (finalPrompt.length > MAX_INLINE_PROMPT_LEN) {
            const promptFileUid = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const tmpPromptPath = path.join(os.tmpdir(), `00_MAIN_PROMPT_${promptFileUid}.txt`);
            this._writeTempFileWithRetry(tmpPromptPath, finalPrompt);
            validFiles.push(tmpPromptPath);
            tempFilesToCleanup.push(tmpPromptPath);
            log(`[ArgonEngine] Prompt exceeds ${MAX_INLINE_PROMPT_LEN} chars (${finalPrompt.length}). Offloaded to ${path.basename(tmpPromptPath)}`);

            const head = this._safeSliceUtf16(finalPrompt, 0, 1500);
            const tail = this._safeSliceUtf16(finalPrompt, -2500);
            const inlineSummary = [
              `[SYSTEM NOTE: The full prompt instructions are ${finalPrompt.length} characters and attached as "${path.basename(tmpPromptPath)}". Read it completely.]`,
              `\n--- PROMPT HEAD ---\n${head}\n...\n--- PROMPT TAIL (DELIVERABLES / REQUIREMENTS) ---\n${tail}`
            ].join('\n');

            await this._insertPromptText(page, inlineSummary);
          } else {
            // Ultra-fast DOM native setter (handles up to 120,000 chars in ~15ms without UI freeze)
            await this._insertPromptText(page, finalPrompt);
          }

          // 6. Attach images/files if provided
          const imgList = Array.isArray(images) ? images : (images ? [images] : []);
          const nativeAllowedExts = new Set([
            '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.txt', '.md', '.csv', '.html', '.js', '.py'
          ]);

          for (let i = 0; i < imgList.length; i++) {
            const imgPath = imgList[i];
            const resolvedPath = path.resolve(imgPath);
            if (!fs.existsSync(resolvedPath)) {
              throw new Error(`[ArgonEngine] Attached file not found on disk: "${resolvedPath}"`);
            }

            const ext = path.extname(resolvedPath).toLowerCase();
            const stat = fs.statSync(resolvedPath);
            if (!stat.isFile()) {
              throw new Error(`[ArgonEngine] Attached path is not a regular file: "${resolvedPath}"`);
            }

            if (nativeAllowedExts.has(ext)) {
              validFiles.push(resolvedPath);
            } else {
              // Auto-wrap code files (.ts, .tsx, .rs, .go, .cpp, .c, .h, .json, .toml, etc.) into .txt for AI Studio compatibility
              // Safe length to respect Windows MAX_PATH limits
              const rawBase = path.basename(resolvedPath).replace(/[^a-zA-Z0-9._-]/g, '_');
              const baseName = rawBase.length > 80 ? rawBase.slice(-80) : rawBase;
              const fileUid = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${i}`;
              const tmpCopyPath = path.join(os.tmpdir(), `argon_${fileUid}_${baseName}.txt`);
              try {
                const content = fs.readFileSync(resolvedPath, 'utf-8');
                const wrappedContent = `// File: ${resolvedPath}\n\n${content}`;
                this._writeTempFileWithRetry(tmpCopyPath, wrappedContent);
                validFiles.push(tmpCopyPath);
                tempFilesToCleanup.push(tmpCopyPath);
                log(`[ArgonEngine] Auto-wrapped ${baseName} (${ext}) -> ${path.basename(tmpCopyPath)} for AI Studio upload.`);
              } catch (e) {
                logWarn(`[ArgonEngine] Failed to wrap file ${resolvedPath}:`, e.message);
                validFiles.push(resolvedPath);
              }
            }
          }

          let answer;
          let generationSucceeded = false;
          try {
            if (validFiles.length > 0) {
              log(`[ArgonEngine] Attaching ${validFiles.length} file(s)...`);
              let fileInput = await page.$('input[type="file"].file-input, input[type="file"]');
              if (!fileInput) {
                log('[ArgonEngine] File input not in DOM, clicking Insert/Add (+) button to mount it...');
                await page.evaluate(() => {
                  const addBtn = document.querySelector(
                    'ms-add-chunk-menu button, button[aria-label*="Insert"], button[aria-label*="Add"], button[aria-label*="Добавить"], button[iconname="add_circle"], button[iconname="add"]'
                  );
                  if (addBtn) addBtn.click();
                });
                await new Promise(r => setTimeout(r, 400));
                fileInput = await page.waitForSelector('input[type="file"].file-input, input[type="file"]', { timeout: 15000 });
                await page.keyboard.press('Escape').catch(() => {});
              }
              // Clear existing input value first and ensure multiple attribute is present so all files attach
              await page.evaluate(el => {
                el.value = '';
                el.setAttribute('multiple', 'multiple');
              }, fileInput);
              await fileInput.uploadFile(...validFiles);
              log(`[ArgonEngine] Uploaded files: ${validFiles.join(', ')}`);
              const attachmentWaitTimeout = Math.min(90000, Math.max(30000, Math.floor(remainingTimeout * 0.4)));
              await this._waitForAttachmentsReady(page, attachmentWaitTimeout);
            }

            // Record initial turns count right before triggering send to prevent race conditions from DOM resets
            const initialTurnsCount = await page.evaluate(() => {
              return document.querySelectorAll('ms-chat-turn, .chat-turn').length;
            });

            // 7. Trigger generation with Run fallback
            await this._triggerSend(page, initialTurnsCount);

            // 8. Await generation and parse response with remaining timeout budget
            const elapsed = Date.now() - requestStartTime;
            const remainingResponseTimeout = timeoutMs - elapsed;
            if (remainingResponseTimeout <= 0) {
              throw new Error(`[ArgonEngine] Timeout budget (${timeoutMs / 1000}s) exhausted before model generation completed.`);
            }
            answer = await this._waitForResponse(page, initialTurnsCount, remainingResponseTimeout, { onProgress, signal });
            generationSucceeded = true;
          } catch (err) {
            // If aborted or failed mid-flight before saving, evict dirty anonymous tab so next call starts clean
            const cacheKey = (sessionId && String(sessionId).trim()) || (promptId && String(promptId).trim()) || ANONYMOUS_SESSION_KEY;
            if (cacheKey === ANONYMOUS_SESSION_KEY && page && !page.isClosed()) {
              this.sessions.delete(ANONYMOUS_SESSION_KEY);
              await page.close({ runBeforeUnload: false }).catch(() => {});
            }
            throw err;
          } finally {
            // Clean up temporary auto-wrapped text files and prompt payloads with Windows Defender EBUSY retry
            for (const tmpFile of tempFilesToCleanup) {
              this._unlinkTempFileWithRetry(tmpFile);
            }
          }

          if (!generationSucceeded || !this.browser || !this.browser.connected || page.isClosed()) {
            throw new Error('[ArgonEngine] Browser or tab was closed before response could be finalized.');
          }

          // If this was a new chat, ensure Google AI Studio cloud auto-save persists to Google Drive
          let currentUrl = page.url();
          let match = currentUrl.match(/prompts\/([a-zA-Z0-9_-]+)/);
          let savedPromptId = (match && match[1] !== 'new_chat') ? match[1] : null;

          if (!savedPromptId) {
            log('[ArgonEngine] New chat detected. Awaiting cloud auto-save...');
            const saveStart = Date.now();
            const maxSaveWaitMs = 35000;
            let triggeredManualSave = false;

            while (Date.now() - saveStart < maxSaveWaitMs) {
              if (signal?.aborted || !this.browser || !this.browser.connected || page.isClosed()) {
                break;
              }
              await new Promise(r => setTimeout(r, 1500));
              if (!this.browser || !this.browser.connected || page.isClosed()) {
                break;
              }
              currentUrl = page.url();
              match = currentUrl.match(/prompts\/([a-zA-Z0-9_-]+)/);
              if (match && match[1] !== 'new_chat') {
                savedPromptId = match[1];
                log(`[ArgonEngine] Prompt successfully persisted to Google Drive! Prompt ID: ${savedPromptId}`);
                break;
              }

              // Only trigger manual UI save once if cloud auto-save hasn't kicked in after 6 seconds
              if (!triggeredManualSave && Date.now() - saveStart > 6000) {
                triggeredManualSave = true;
                try {
                  const saveBtnClicked = await page.evaluate(() => {
                    const btn = document.querySelector('button[aria-label*="Save"], button[aria-label*="Сохранить"]');
                    if (btn && !btn.disabled) {
                      btn.click();
                      return true;
                    }
                    return false;
                  });
                  if (saveBtnClicked) {
                    await new Promise(r => setTimeout(r, 500));
                    await this._handleSaveDialog(page);
                  }
                } catch (_) {}
              }
            }
            if (!savedPromptId) {
              logWarn('[ArgonEngine] Cloud auto-save did not assign prompt ID within wait window.');
            }
          }

          if (savedPromptId && sessionId) {
            this._saveToRegistry(sessionId, savedPromptId);
            log(`[ArgonEngine] Registered project "${sessionId}" -> "${savedPromptId}" in prompts_registry.json`);
          }

          const resultObj = {
            thoughts: answer?.thoughts || '',
            response: answer?.response || '',
            promptId: savedPromptId,
            promptUrl: currentUrl,
            toString() {
              return this.response;
            }
          };

          return resultObj;
        }, ipcAcquireBudget, signal);
      }, signal);
    } finally {
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      this._resetIdleTimer();
    }
  }

  async resetSession(sessionId = null) {
    this.activeRequests++;
    this._pauseIdleTimer();
    try {
      return await this.mutex.runExclusive(async () => {
        return await this.ipcLock.runExclusive(async () => {
          if (sessionId) {
            const cleanId = String(sessionId).trim();
            const resolvedId = this._resolvePromptId(cleanId);
            let closed = false;

            for (const [key, session] of Array.from(this.sessions.entries())) {
              if (key === cleanId || (resolvedId && key === resolvedId)) {
                if (session.page && !session.page.isClosed()) {
                  await session.page.close({ runBeforeUnload: false }).catch(() => {});
                }
                this.sessions.delete(key);
                closed = true;
              }
            }

            if (resolvedId && this.browser && this.browser.connected) {
              try {
                const targetSubstring = (resolvedId.startsWith('http') || resolvedId.startsWith('data:'))
                  ? resolvedId
                  : `/prompts/${resolvedId}`;
                const pages = await this.browser.pages();
                for (const p of pages) {
                  if (!p.isClosed() && p.url().includes(targetSubstring)) {
                    for (const [k, v] of Array.from(this.sessions.entries())) {
                      if (v.page === p) this.sessions.delete(k);
                    }
                    await p.close({ runBeforeUnload: false }).catch(() => {});
                    closed = true;
                  }
                }
              } catch (_) {}
            }

            this._removeFromRegistry(cleanId);

            return {
              ok: true,
              message: closed ? `Session "${cleanId}" reset, unregistered, and closed.` : `Session "${cleanId}" unregistered.`
            };
          } else {
            for (const [, session] of this.sessions.entries()) {
              if (session.page && !session.page.isClosed()) {
                await session.page.close({ runBeforeUnload: false }).catch(() => {});
              }
            }
            this.sessions.clear();

            if (this.browser && this.browser.connected) {
              try {
                const pages = await this.browser.pages();
                for (let i = 1; i < pages.length; i++) {
                  if (!pages[i].isClosed()) {
                    await pages[i].close({ runBeforeUnload: false }).catch(() => {});
                  }
                }
                if (pages.length > 0 && !pages[0].isClosed()) {
                  await pages[0].goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
                }
              } catch (_) {}
            }
            return { ok: true, message: 'All sessions reset and closed.' };
          }
        }, 120000);
      });
    } finally {
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      this._resetIdleTimer();
    }
  }

  async getStatus() {
    const isRunning = !!this.browser && this.browser.connected;
    return {
      browserRunning: isRunning,
      isExternalBrowser: this.isExternalBrowser,
      activeSessions: this.sessions.size,
      profileDir: this.profileDir,
      idleTimeoutMinutes: this.idleTimeoutMs / 60000,
      wsEndpointFileExists: fs.existsSync(this.wsEndpointPath),
      isLocked: this.ipcLock.isLocked(),
      registeredProjects: this._loadRegistry()
    };
  }

  async shutdown({ keepHostAlive = false, forceCloseHost = false } = {}) {
    this._pauseIdleTimer();
    if (this.browser) {
      const b = this.browser;
      const isExt = this.isExternalBrowser;
      this.browser = null;
      this.isExternalBrowser = false;

      if ((isExt || keepHostAlive) && !forceCloseHost) {
        try {
          const allPages = await b.pages().catch(() => []);
          let openCount = allPages.length;
          for (const [key, session] of this.sessions.entries()) {
            if (session.sharedTab || key !== ANONYMOUS_SESSION_KEY) continue;
            try {
              if (session.page && !session.page.isClosed() && openCount > 1) {
                await session.page.close({ runBeforeUnload: false }).catch(() => {});
                openCount--;
              }
            } catch (_) {}
          }
        } catch (_) {}
      }
      this.sessions.clear();

      if ((isExt || keepHostAlive) && !forceCloseHost) {
        if (!isExt && b.process && typeof b.process === 'function') {
          const proc = b.process();
          if (proc && typeof proc.unref === 'function') {
            try { proc.unref(); } catch (_) {}
          }
        }
        if (Array.isArray(this._puppeteerExitListeners)) {
          for (const fn of this._puppeteerExitListeners) {
            try { process.removeListener('exit', fn); } catch (_) {}
          }
          this._puppeteerExitListeners = null;
        }
        for (const fn of process.listeners('exit')) {
          if (fn.toString().includes('processListeners')) {
            try { process.removeListener('exit', fn); } catch (_) {}
          }
        }
        b.disconnect();
        log('[ArgonEngine] Disconnected from Chromium instance (browser kept alive).');
      } else {
        try {
          if (fs.existsSync(this.wsEndpointPath)) {
            fs.unlinkSync(this.wsEndpointPath);
          }
        } catch (_) {}

        const browserProc = (!isExt && typeof b.process === 'function') ? b.process() : null;
        const browserPid = browserProc?.pid;

        await b.close().catch(() => {});

        // Ensure complete Win32 process tree termination if Chrome child processes linger
        if (browserPid && isPidAlive(browserPid)) {
          try {
            const { execFileSync } = require('child_process');
            execFileSync('taskkill', ['/pid', String(browserPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          } catch (_) {}
        }

        log('[ArgonEngine] Host Chromium closed successfully.');
      }
    }
  }
}

module.exports = {
  ArgonEngine,
  findChromePath,
  PROFILE_DIR
};
