const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 5173);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.SLIDE_STUDIO_DATA_DIR || path.join(ROOT, '.local-data'));
const JSON_DB_FILE = path.join(DATA_DIR, 'db.json');
const DB_FILE = path.join(DATA_DIR, 'slide-studio.sqlite');
const GENERATED_DIR = path.join(DATA_DIR, 'generated');
const FRONTEND_SLIDES_DIR = process.env.FRONTEND_SLIDES_DIR || '/Users/lll/.codex/skills/frontend-slides';
const TEMPLATE_DIR = path.join(FRONTEND_SLIDES_DIR, 'beautiful-html-templates', 'templates');
const isProduction = process.env.NODE_ENV === 'production';
const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium'
].filter(Boolean);
let sqliteDb = null;
let isMigratingLegacyDb = false;

function ensureDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  const db = getSqliteDb();
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_configs (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT,
      output TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS decks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      template_id TEXT,
      template_slug TEXT,
      title TEXT NOT NULL,
      deck_path TEXT,
      file_path TEXT,
      original_html_path TEXT,
      status TEXT NOT NULL,
      current_page INTEGER DEFAULT 1,
      target_context TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      completed_at TEXT,
      last_applied_at TEXT
    );

    CREATE TABLE IF NOT EXISTS deck_messages (
      id TEXT PRIMARY KEY,
      deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      page INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deck_comments (
      id TEXT PRIMARY KEY,
      deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
      page INTEGER NOT NULL,
      note TEXT NOT NULL,
      x REAL DEFAULT 0,
      y REAL DEFAULT 0,
      selector TEXT,
      element_text TEXT,
      element_tag TEXT,
      element_rect_json TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS deck_versions (
      id TEXT PRIMARY KEY,
      deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
      label TEXT,
      file_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS template_selections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      deck_id TEXT REFERENCES decks(id) ON DELETE SET NULL,
      template_id TEXT NOT NULL,
      template_slug TEXT,
      selected_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS logs (
      id TEXT PRIMARY KEY,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      meta_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
  const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (!isMigratingLegacyDb && userCount === 0 && fs.existsSync(JSON_DB_FILE)) {
    try {
      isMigratingLegacyDb = true;
      const legacy = JSON.parse(fs.readFileSync(JSON_DB_FILE, 'utf8'));
      writeDb(normalizeDbShape(legacy));
    } catch (error) {
      console.error('[error] Failed to migrate legacy JSON database', error);
    } finally {
      isMigratingLegacyDb = false;
    }
  }
}

function getSqliteDb() {
  if (!sqliteDb) sqliteDb = new DatabaseSync(DB_FILE);
  return sqliteDb;
}

function normalizeDbShape(db = {}) {
  return {
    users: Array.isArray(db.users) ? db.users : [],
    sessions: db.sessions && typeof db.sessions === 'object' ? db.sessions : {},
    decks: Array.isArray(db.decks) ? db.decks : [],
    logs: Array.isArray(db.logs) ? db.logs : []
  };
}

function readDb() {
  ensureDb();
  const db = getSqliteDb();
  const modelRows = db.prepare('SELECT * FROM model_configs').all();
  const modelByUser = new Map(modelRows.map((row) => [row.user_id, row]));
  const users = db.prepare('SELECT * FROM users ORDER BY created_at ASC').all().map((row) => {
    const modelConfig = modelByUser.get(row.id);
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      passwordHash: row.password_hash,
      createdAt: row.created_at,
      modelConfig: modelConfig ? {
        provider: modelConfig.provider,
        model: modelConfig.model,
        baseUrl: modelConfig.base_url,
        apiKey: modelConfig.api_key || '',
        output: modelConfig.output
      } : undefined
    };
  });
  const sessions = Object.fromEntries(db.prepare('SELECT * FROM sessions').all().map((row) => [
    row.token,
    { userId: row.user_id, createdAt: row.created_at }
  ]));
  const decks = db.prepare('SELECT * FROM decks ORDER BY datetime(created_at) DESC').all().map((row) => ({
    id: row.id,
    userId: row.user_id,
    prompt: row.prompt,
    templateId: row.template_id,
    templateSlug: row.template_slug,
    title: row.title,
    deckPath: row.deck_path,
    filePath: row.file_path,
    originalHtmlPath: row.original_html_path,
    status: row.status,
    currentPage: row.current_page || 1,
    targetContext: row.target_context || '',
    error: row.error || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    lastAppliedAt: row.last_applied_at,
    messages: [],
    comments: [],
    versions: []
  }));
  const decksById = new Map(decks.map((deck) => [deck.id, deck]));
  db.prepare('SELECT * FROM deck_messages ORDER BY datetime(created_at) ASC').all().forEach((row) => {
    const deck = decksById.get(row.deck_id);
    if (!deck) return;
    deck.messages.push({ id: row.id, role: row.role, text: row.text, page: row.page, createdAt: row.created_at });
  });
  db.prepare('SELECT * FROM deck_comments ORDER BY datetime(created_at) ASC').all().forEach((row) => {
    const deck = decksById.get(row.deck_id);
    if (!deck) return;
    deck.comments.push({
      id: row.id,
      page: row.page,
      note: row.note,
      x: row.x,
      y: row.y,
      selector: row.selector || '',
      elementText: row.element_text || '',
      elementTag: row.element_tag || '',
      elementRect: row.element_rect_json ? JSON.parse(row.element_rect_json) : null,
      status: row.status,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at
    });
  });
  db.prepare('SELECT * FROM deck_versions ORDER BY datetime(created_at) ASC').all().forEach((row) => {
    const deck = decksById.get(row.deck_id);
    if (!deck) return;
    deck.versions.push({ id: row.id, label: row.label, filePath: row.file_path, createdAt: row.created_at });
  });
  const logs = db.prepare('SELECT * FROM logs ORDER BY datetime(created_at) DESC LIMIT 200').all().map((row) => ({
    id: row.id,
    level: row.level,
    message: row.message,
    meta: row.meta_json ? JSON.parse(row.meta_json) : {},
    createdAt: row.created_at
  }));
  return { users, sessions, decks, logs };
}

function writeDb(db) {
  ensureDb();
  const data = normalizeDbShape(db);
  const sqlite = getSqliteDb();
  try {
    sqlite.exec('BEGIN');
    sqlite.exec(`
      DELETE FROM logs;
      DELETE FROM template_selections;
      DELETE FROM deck_versions;
      DELETE FROM deck_comments;
      DELETE FROM deck_messages;
      DELETE FROM decks;
      DELETE FROM model_configs;
      DELETE FROM sessions;
      DELETE FROM users;
    `);
    const insertUser = sqlite.prepare('INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)');
    const insertModel = sqlite.prepare('INSERT INTO model_configs (user_id, provider, model, base_url, api_key, output, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insertSession = sqlite.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)');
    const insertDeck = sqlite.prepare(`INSERT INTO decks (
      id, user_id, prompt, template_id, template_slug, title, deck_path, file_path, original_html_path, status,
      current_page, target_context, error, created_at, updated_at, completed_at, last_applied_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertMessage = sqlite.prepare('INSERT INTO deck_messages (id, deck_id, role, text, page, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    const insertComment = sqlite.prepare(`INSERT INTO deck_comments (
      id, deck_id, page, note, x, y, selector, element_text, element_tag, element_rect_json, status, created_at, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertVersion = sqlite.prepare('INSERT INTO deck_versions (id, deck_id, label, file_path, created_at) VALUES (?, ?, ?, ?, ?)');
    const insertTemplateSelection = sqlite.prepare('INSERT INTO template_selections (id, user_id, deck_id, template_id, template_slug, selected_at) VALUES (?, ?, ?, ?, ?, ?)');
    const insertLog = sqlite.prepare('INSERT INTO logs (id, level, message, meta_json, created_at) VALUES (?, ?, ?, ?, ?)');

    for (const user of data.users) {
      insertUser.run(user.id, user.name, user.email, user.passwordHash, user.createdAt || new Date().toISOString());
      const modelConfig = normalizeProviderConfig(user.modelConfig || {});
      insertModel.run(user.id, modelConfig.provider, modelConfig.model, modelConfig.baseUrl, modelConfig.apiKey || '', modelConfig.output, new Date().toISOString());
    }
    for (const [token, session] of Object.entries(data.sessions)) {
      if (data.users.some((user) => user.id === session.userId)) insertSession.run(token, session.userId, session.createdAt || new Date().toISOString());
    }
    for (const deck of data.decks) {
      insertDeck.run(
        deck.id,
        deck.userId,
        deck.prompt || '',
        deck.templateId || '',
        deck.templateSlug || '',
        deck.title || 'Untitled deck',
        deck.deckPath || '',
        deck.filePath || '',
        deck.originalHtmlPath || '',
        deck.status || 'draft',
        Number(deck.currentPage || 1),
        deck.targetContext || '',
        deck.error || '',
        deck.createdAt || new Date().toISOString(),
        deck.updatedAt || deck.createdAt || new Date().toISOString(),
        deck.completedAt || '',
        deck.lastAppliedAt || ''
      );
      if (deck.templateId) {
        insertTemplateSelection.run(
          crypto.randomUUID(),
          deck.userId,
          deck.id,
          deck.templateId,
          deck.templateSlug || '',
          deck.createdAt || new Date().toISOString()
        );
      }
      for (const message of deck.messages || []) {
        insertMessage.run(message.id || crypto.randomUUID(), deck.id, message.role || 'assistant', message.text || '', message.page || null, message.createdAt || new Date().toISOString());
      }
      for (const comment of deck.comments || []) {
        insertComment.run(
          comment.id || crypto.randomUUID(),
          deck.id,
          Number(comment.page || 1),
          comment.note || '',
          Number(comment.x || 0),
          Number(comment.y || 0),
          comment.selector || '',
          comment.elementText || '',
          comment.elementTag || '',
          comment.elementRect ? JSON.stringify(comment.elementRect) : '',
          comment.status || 'open',
          comment.createdAt || new Date().toISOString(),
          comment.resolvedAt || ''
        );
      }
      for (const version of deck.versions || []) {
        insertVersion.run(version.id || crypto.randomUUID(), deck.id, version.label || '', version.filePath || '', version.createdAt || new Date().toISOString());
      }
    }
    for (const entry of data.logs.slice(0, 200)) {
      insertLog.run(entry.id || crypto.randomUUID(), entry.level || 'info', entry.message || 'Event', JSON.stringify(entry.meta || {}), entry.createdAt || new Date().toISOString());
    }
    sqlite.exec('COMMIT');
  } catch (error) {
    try {
      sqlite.exec('ROLLBACK');
    } catch (_rollbackError) {}
    throw error;
  }
}

function logEvent(level, message, meta = {}) {
  const entry = {
    id: crypto.randomUUID(),
    level,
    message: String(message || 'Unknown event'),
    meta,
    createdAt: new Date().toISOString()
  };
  console[level === 'error' ? 'error' : 'log'](`[${level}] ${entry.message}`, meta);
  try {
    const db = readDb();
    db.logs.unshift(entry);
    db.logs = db.logs.slice(0, 200);
    writeDb(db);
  } catch (error) {
    console.error('[error] Failed to persist log', error);
  }
  return entry;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const storedHash = Buffer.from(hash, 'hex');
  const test = crypto.scryptSync(password, salt, storedHash.length);
  return storedHash.length === test.length && crypto.timingSafeEqual(storedHash, test);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(header.split(';').filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    if (index === -1) return [part.trim(), ''];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
}

function getUser(req, db) {
  const token = parseCookies(req).session;
  if (!token || !db.sessions[token]) return null;
  return db.users.find((user) => user.id === db.sessions[token].userId) || null;
}

function publicUser(user) {
  if (!user) return null;
  const modelConfig = user.modelConfig || {};
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    modelConfig: {
      provider: modelConfig.provider || 'OpenAI',
      model: modelConfig.model || 'gpt-4.1',
      baseUrl: modelConfig.baseUrl || 'https://api.openai.com/v1',
      apiKeyHint: modelConfig.apiKey ? `saved-${String(modelConfig.apiKey).slice(-4)}` : modelConfig.apiKeyHint || '',
      hasApiKey: Boolean(modelConfig.apiKey),
      output: modelConfig.output || 'Frontend (HTML)'
    }
  };
}

function publicDeck(deck) {
  if (!deck) return null;
  const { filePath, originalHtmlPath, targetContext, ...safeDeck } = deck;
  safeDeck.messages ||= [];
  safeDeck.comments ||= [];
  safeDeck.versions = (safeDeck.versions || []).map(({ filePath: _filePath, ...version }) => version);
  return safeDeck;
}

function sanitizeFileName(name, fallback = 'slide-deck') {
  return String(name || fallback)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80) || fallback;
}

function findChromeExecutable() {
  return CHROME_PATHS.find((candidate) => fs.existsSync(candidate)) || '';
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function getAuthorizedDeck(req, res, db = readDb()) {
  const user = getUser(req, db);
  if (!user) {
    res.status(401).json({ error: 'Login required.' });
    return {};
  }
  const deck = db.decks.find((item) => item.id === req.params.deckId && item.userId === user.id);
  if (!deck) {
    res.status(404).json({ error: 'Deck not found.' });
    return { user };
  }
  if (!deck.filePath || !fs.existsSync(deck.filePath)) {
    res.status(404).json({ error: 'Deck HTML file is missing.' });
    return { user, deck };
  }
  const resolvedPath = path.resolve(deck.filePath);
  if (!resolvedPath.startsWith(path.resolve(GENERATED_DIR))) {
    res.status(403).json({ error: 'Forbidden.' });
    return { user, deck };
  }
  return { user, deck, resolvedPath };
}

function buildPrintableHtml(html) {
  const printCss = `
<style id="slide-studio-export-css">
@page { size: 1920px 1080px; margin: 0; }
@media print {
  html, body { width: 1920px !important; height: auto !important; margin: 0 !important; overflow: visible !important; background: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .deck-viewport { position: static !important; width: 1920px !important; height: auto !important; overflow: visible !important; background: #fff !important; }
  .deck-stage { position: static !important; width: 1920px !important; height: auto !important; transform: none !important; background: none !important; }
  .slide { position: relative !important; display: block !important; visibility: visible !important; opacity: 1 !important; pointer-events: auto !important; width: 1920px !important; height: 1080px !important; break-after: page; page-break-after: always; transform: none !important; }
  .slide:last-child { break-after: auto; page-break-after: auto; }
  .deck-controls, .edit-toggle, .export-button, .edit-hotzone { display: none !important; }
}
</style>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${printCss}\n</head>`);
  return `${printCss}\n${html}`;
}

function setSessionCookie(res, token, maxAge) {
  const parts = [`session=${token || ''}`, 'HttpOnly', 'SameSite=Lax', 'Path=/'];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  res.setHeader('Set-Cookie', parts.join('; '));
}

const templates = [
  { id: 'sakura-chroma', slug: 'sakura-chroma', name: 'Sakura Chroma', category: 'Design & creative', accent: '#E54489', uses: 2150, deckPath: '/ai-creation-sakura-chroma.html' },
  { id: 'soft-editorial', slug: 'soft-editorial', name: 'Soft Editorial', category: 'General', accent: '#D7DE62', uses: 9602, deckPath: '/ai-notes-launch.html' },
  { id: 'blue-professional', slug: 'blue-professional', name: 'Blue Professional', category: 'Go-to-market', accent: '#3F8BC4', uses: 1888, deckPath: '/ai-creation-sakura-chroma.html' },
  { id: 'creative-mode', slug: 'creative-mode', name: 'Creative Mode', category: 'Design & creative', accent: '#F09131', uses: 1470, deckPath: '/ai-creation-sakura-chroma.html' },
  { id: 'long-table', slug: 'long-table', name: 'Long Table', category: 'Product research', accent: '#3D9F47', uses: 843, deckPath: '/ai-notes-launch.html' },
  { id: 'job-candidate', slug: 'sakura-chroma', name: 'Job Case Study', category: 'Job & career', accent: '#E5392A', uses: 522, deckPath: '/ai-creation-sakura-chroma.html' }
];

const FALLBACK_VIEWPORT_BASE = `
html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: var(--stage-bg, #000); }
.deck-viewport { position: fixed; inset: 0; overflow: hidden; background: var(--stage-bg, #000); }
.deck-stage { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; overflow: hidden; transform-origin: 0 0; background: var(--slide-bg, #fff); }
.slide { position: absolute; inset: 0; width: 1920px; height: 1080px; overflow: hidden; display: block; visibility: hidden; opacity: 0; pointer-events: none; background: var(--slide-bg, #fff); }
.slide.active, .slide.visible { visibility: visible; opacity: 1; pointer-events: auto; z-index: 1; }
@media print { html, body { width: 1920px; height: auto; overflow: visible; background: #fff; } .deck-viewport, .deck-stage { position: static; transform: none !important; overflow: visible; } .slide { position: relative; display: block !important; visibility: visible !important; opacity: 1 !important; width: 1920px; height: 1080px; break-after: page; } .deck-controls { display: none !important; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.2s !important; } }
`;

const FALLBACK_HTML_TEMPLATE = `
Use a complete HTML document with .deck-viewport, #deckStage.deck-stage, multiple <section class="slide"> elements, fixed 1920x1080 slide layout, inline CSS, and inline JavaScript that scales #deckStage to the viewport and supports keyboard navigation.
`;

const FALLBACK_ANIMATION_PATTERNS = `
Use restrained reveal animations only on the active slide, with reduced-motion support. Keep content legible and avoid layout shifts.
`;

const FALLBACK_DESIGN_MD = `
Design direction: premium productivity tool, editorial but practical. Use crisp typography, clear hierarchy, generous whitespace, visible data/storytelling blocks, and a balanced palette that is not dominated by a single hue. The deck should feel finished enough for a portfolio demo.
`;

function readTextFile(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    logEvent('error', 'Failed to read generation context file', { filePath, message: error.message });
    return fallback;
  }
}

function normalizeBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  return trimmed || 'https://api.openai.com/v1';
}

function normalizeProviderConfig(config = {}) {
  const provider = String(config.provider || 'OpenAI').trim() || 'OpenAI';
  const lower = provider.toLowerCase();
  const qwenBase = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const defaultBaseUrl = lower.includes('qwen') || lower.includes('千问') || lower.includes('dashscope')
    ? qwenBase
    : 'https://api.openai.com/v1';
  return {
    provider,
    model: String(config.model || (defaultBaseUrl === qwenBase ? 'qwen-plus' : 'gpt-4.1')).trim(),
    baseUrl: normalizeBaseUrl(config.baseUrl || defaultBaseUrl),
    apiKey: String(config.apiKey || '').trim(),
    output: String(config.output || 'Frontend (HTML)')
  };
}

function buildGenerationPrompt({ prompt, template, viewportBase, htmlTemplate, animationPatterns, designMd }) {
  const safeDesign = designMd.length > 30000 ? `${designMd.slice(0, 30000)}\n\n[design.md truncated for context size]` : designMd;
  return {
    system: `You are Slide Studio's HTML slide generation engine. Generate production-quality, single-file HTML slide decks only.

Non-negotiable rules:
- Output only one complete HTML document. No markdown fences, no commentary.
- Single self-contained HTML file with inline CSS and JS. External font links are allowed.
- Fixed 1920x1080 stage. The whole deck-stage scales uniformly to the viewport. Do not use responsive slide reflow.
- Include the full viewport-base.css rules in the style block.
- Every slide must be <section class="slide">. Use .active/.visible for visibility; never use display:none for slide switching.
- Keep text inside bounds: no overflow, no overlapping panels, no tiny unreadable text.
- Include keyboard navigation, touch navigation, mouse wheel navigation, and a small page counter outside the slide stage.
- Include prefers-reduced-motion support.
- Use the selected template design recipe. Do not copy demo content from the template.
- Use 6 to 10 slides unless the user's prompt clearly asks for a different length.
- This is for a user-facing AI slide maker. The deck must look finished, not like a diagnostic sample.`,
    user: `User prompt:
${prompt}

Selected template:
${template.name} (${template.slug})

Template design.md:
${safeDesign}

Mandatory viewport-base.css to include in full:
${viewportBase}

HTML architecture reference:
${htmlTemplate.slice(0, 9000)}

Animation reference:
${animationPatterns.slice(0, 6000)}

Generate the final deck now as one complete HTML file.`
  };
}

async function callChatCompletions({ modelConfig, messages }) {
  if (!modelConfig.apiKey) {
    throw new Error('API key required. Open Model settings and save an OpenAI-compatible API key first.');
  }
  const endpoint = `${normalizeBaseUrl(modelConfig.baseUrl)}/chat/completions`;
  const body = {
    model: modelConfig.model,
    messages
  };
  if (/^gpt-5/i.test(modelConfig.model)) {
    body.max_completion_tokens = 14000;
  } else {
    body.temperature = 0.72;
    body.max_tokens = 14000;
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${modelConfig.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    data = { error: { message: text } };
  }
  if (!response.ok) {
    throw new Error(data.error?.message || `AI API request failed (${response.status})`);
  }
  const content = data.choices?.[0]?.message?.content || data.output_text || '';
  if (!content) throw new Error('AI API returned an empty response.');
  return content;
}

function extractHtml(raw) {
  let html = String(raw || '').trim();
  const fenced = html.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fenced) html = fenced[1].trim();
  const start = html.search(/<!doctype html|<html[\s>]/i);
  if (start > 0) html = html.slice(start);
  if (!/<html[\s>]/i.test(html) || !/<\/html>/i.test(html)) {
    throw new Error('Generated output was not a complete HTML document.');
  }
  if (!/deck-stage/i.test(html) || !/class=["'][^"']*\bslide\b/i.test(html)) {
    throw new Error('Generated HTML is missing the fixed-stage slide structure.');
  }
  return html;
}

function buildEditPrompt({ deck, currentHtml, instruction, currentPage, targetContext = '' }) {
  const compactHtml = currentHtml.length > 90000 ? currentHtml.slice(0, 90000) : currentHtml;
  const recentMessages = (deck.messages || []).slice(-10).map((message) => `${message.role}: ${message.text}`).join('\n');
  const comments = (deck.comments || []).slice(-10).map((comment) => {
    const status = comment.status || 'open';
    const selector = comment.selector ? ` selector=${comment.selector}` : '';
    const text = comment.elementText ? ` elementText="${comment.elementText.slice(0, 160)}"` : '';
    return `Slide ${comment.page} [${status}]${selector}${text}: ${comment.note}`;
  }).join('\n');
  return {
    system: `You are Slide Studio's HTML slide editing engine. Return only one complete updated HTML document.

Rules:
- Preserve the existing fixed 1920x1080 deck-stage architecture.
- Preserve the current visual template unless the user explicitly asks for a style change.
- Apply the requested change directly to the HTML.
- If the user asks for a local/current-slide change, primarily edit slide ${currentPage || 1}.
- Keep all CSS/JS inline and keep every slide as <section class="slide">.
- Do not remove keyboard/touch navigation or the page counter.
- No markdown fences or commentary.`,
    user: `Current user instruction:
${instruction}

Current page: ${currentPage || 1}

Target context:
${targetContext || 'None'}

Recent chat:
${recentMessages || 'None'}

Annotations:
${comments || 'None'}

Current HTML:
${compactHtml}

Return the complete updated HTML file.`
  };
}

function buildPatchPrompt({ deck, currentHtml, instruction, currentPage, targetContext = '' }) {
  const slideRegex = new RegExp(`<section\\b[^>]*class=["'][^"']*\\bslide\\b[^"']*["'][^>]*>[\\s\\S]*?<\\/section>`, 'gi');
  const slides = currentHtml.match(slideRegex) || [];
  const slideHtml = slides[Math.max(0, Math.min(slides.length - 1, (Number(currentPage) || 1) - 1))] || currentHtml.slice(0, 35000);
  const recentMessages = (deck.messages || []).slice(-8).map((message) => `${message.role}: ${message.text}`).join('\n');
  return {
    system: `You are Slide Studio's precise HTML patch engine.

Return ONLY valid JSON. No markdown fences, no explanation.

JSON schema:
{
  "summary": "short user-facing summary",
  "edits": [
    { "search": "exact substring copied from CURRENT HTML", "replace": "replacement substring" }
  ]
}

Rules:
- Prefer 1-4 exact search/replace edits.
- The search string must be copied exactly from the current HTML below.
- Replace enough surrounding HTML to make the change reliable.
- For text-only requests, search and replace the smallest exact text/HTML span.
- For layout/style requests, edit the current slide section and/or inline CSS with exact search/replace.
- Preserve fixed 1920x1080 stage rules and every <section class="slide">.
- Do not return a complete HTML document unless JSON patching is impossible.`,
    user: `Instruction:
${instruction}

Current page: ${currentPage || 1}

Target context:
${targetContext || 'None'}

Recent chat:
${recentMessages || 'None'}

CURRENT SLIDE HTML:
${slideHtml}

If CSS changes are needed, use exact search/replace against snippets visible in the slide or obvious reusable class names. Return JSON only.`
  };
}

function parseJsonObject(raw) {
  let text = String(raw || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('AI did not return JSON patch instructions.');
  return JSON.parse(text.slice(start, end + 1));
}

function applySearchReplaceEdits(currentHtml, patch) {
  if (!patch || !Array.isArray(patch.edits) || !patch.edits.length) {
    throw new Error('AI returned an empty patch.');
  }
  let html = currentHtml;
  const applied = [];
  for (const edit of patch.edits) {
    const search = String(edit.search || '');
    const replace = String(edit.replace || '');
    if (!search) throw new Error('AI patch contained an empty search string.');
    const index = html.indexOf(search);
    if (index === -1) {
      throw new Error(`AI patch search text was not found: ${search.slice(0, 120)}`);
    }
    html = `${html.slice(0, index)}${replace}${html.slice(index + search.length)}`;
    applied.push({ searchLength: search.length, replaceLength: replace.length });
  }
  extractHtml(html);
  return { html, summary: patch.summary || 'Applied the requested edit.', applied };
}

async function generateDeckHtml({ prompt, template, modelConfig }) {
  const viewportBase = readTextFile(path.join(FRONTEND_SLIDES_DIR, 'viewport-base.css'), FALLBACK_VIEWPORT_BASE);
  const htmlTemplate = readTextFile(path.join(FRONTEND_SLIDES_DIR, 'html-template.md'), FALLBACK_HTML_TEMPLATE);
  const animationPatterns = readTextFile(path.join(FRONTEND_SLIDES_DIR, 'animation-patterns.md'), FALLBACK_ANIMATION_PATTERNS);
  const designMd = readTextFile(path.join(TEMPLATE_DIR, template.slug, 'design.md'), FALLBACK_DESIGN_MD);
  const generationPrompt = buildGenerationPrompt({ prompt, template, viewportBase, htmlTemplate, animationPatterns, designMd });
  const raw = await callChatCompletions({
    modelConfig,
    messages: [
      { role: 'system', content: generationPrompt.system },
      { role: 'user', content: generationPrompt.user }
    ]
  });
  return extractHtml(raw);
}

async function editDeckHtml({ deck, instruction, currentPage, modelConfig }) {
  if (!deck.filePath || !fs.existsSync(deck.filePath)) {
    throw new Error('Generated HTML file is missing. Regenerate this deck first.');
  }
  const currentHtml = fs.readFileSync(deck.filePath, 'utf8');
  const patchPrompt = buildPatchPrompt({ deck, currentHtml, instruction, currentPage, targetContext: deck.targetContext || '' });
  try {
    const rawPatch = await callChatCompletions({
      modelConfig,
      messages: [
        { role: 'system', content: patchPrompt.system },
        { role: 'user', content: patchPrompt.user }
      ]
    });
    const patch = parseJsonObject(rawPatch);
    return applySearchReplaceEdits(currentHtml, patch).html;
  } catch (patchError) {
    logEvent('error', 'Patch edit failed; falling back to full HTML edit', { deckId: deck.id, message: patchError.message });
    const editPrompt = buildEditPrompt({ deck, currentHtml, instruction, currentPage, targetContext: deck.targetContext || '' });
    try {
      const raw = await callChatCompletions({
        modelConfig,
        messages: [
          { role: 'system', content: editPrompt.system },
          { role: 'user', content: editPrompt.user }
        ]
      });
      return extractHtml(raw);
    } catch (fullError) {
      throw new Error(`AI edit failed. Patch path: ${patchError.message}. Full HTML path: ${fullError.message}`);
    }
  }
}

function saveDeckVersion(deck, label = 'Before edit') {
  if (!deck.filePath || !fs.existsSync(deck.filePath)) return null;
  const versionId = crypto.randomUUID();
  const versionDir = path.join(path.dirname(deck.filePath), `${deck.id}-versions`);
  fs.mkdirSync(versionDir, { recursive: true });
  const versionPath = path.join(versionDir, `${versionId}.html`);
  fs.copyFileSync(deck.filePath, versionPath);
  deck.versions ||= [];
  const version = {
    id: versionId,
    label,
    filePath: versionPath,
    createdAt: new Date().toISOString()
  };
  deck.versions.push(version);
  deck.versions = deck.versions.slice(-20);
  return version;
}

function seedDemoData() {
  if (String(process.env.SEED_DEMO || 'true').toLowerCase() === 'false') return;
  const demoEmail = String(process.env.DEMO_EMAIL || 'demo@slidestudio.local').trim().toLowerCase();
  const demoPassword = String(process.env.DEMO_PASSWORD || 'demo1234');
  const now = new Date().toISOString();
  const db = readDb();
  let changed = false;
  let demoUser = db.users.find((user) => user.email === demoEmail);
  if (!demoUser) {
    demoUser = {
      id: 'demo-user',
      name: 'Demo User',
      email: demoEmail,
      passwordHash: hashPassword(demoPassword),
      createdAt: now,
      modelConfig: {
        provider: 'OpenAI',
        model: process.env.OPENAI_MODEL || 'gpt-4.1',
        baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
        apiKey: process.env.OPENAI_API_KEY || '',
        output: 'Frontend (HTML)'
      }
    };
    db.users.push(demoUser);
    changed = true;
  } else {
    demoUser.name ||= 'Demo User';
    demoUser.passwordHash ||= hashPassword(demoPassword);
    demoUser.modelConfig ||= {};
    demoUser.modelConfig.provider ||= 'OpenAI';
    demoUser.modelConfig.model ||= process.env.OPENAI_MODEL || 'gpt-4.1';
    demoUser.modelConfig.baseUrl ||= process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    demoUser.modelConfig.output ||= 'Frontend (HTML)';
    if (process.env.OPENAI_API_KEY && !demoUser.modelConfig.apiKey) demoUser.modelConfig.apiKey = process.env.OPENAI_API_KEY;
    changed = true;
  }

  const sampleDecks = [
    {
      id: 'demo-ai-creation-tool',
      title: 'AI Creation Tool Launch',
      prompt: 'Create a product launch deck for an AI creation tool.',
      templateId: 'sakura-chroma',
      templateSlug: 'sakura-chroma',
      source: path.join(ROOT, 'ai-creation-sakura-chroma.html'),
      message: 'Demo deck seeded for portfolio reviewers.'
    },
    {
      id: 'demo-ai-notes-launch',
      title: 'AI Notes Product Narrative',
      prompt: 'Create a polished deck for an AI notes product launch.',
      templateId: 'soft-editorial',
      templateSlug: 'soft-editorial',
      source: path.join(ROOT, 'ai-notes-launch.html'),
      message: 'Second sample project showing another visual direction.'
    }
  ];
  const userDir = path.join(GENERATED_DIR, demoUser.id);
  fs.mkdirSync(userDir, { recursive: true });
  for (const sample of sampleDecks) {
    if (!fs.existsSync(sample.source)) continue;
    const filePath = path.join(userDir, `${sample.id}.html`);
    if (!fs.existsSync(filePath)) fs.copyFileSync(sample.source, filePath);
    let deck = db.decks.find((item) => item.id === sample.id);
    if (!deck) {
      deck = {
        id: sample.id,
        userId: demoUser.id,
        prompt: sample.prompt,
        templateId: sample.templateId,
        templateSlug: sample.templateSlug,
        title: sample.title,
        deckPath: `/generated/${sample.id}.html`,
        filePath,
        originalHtmlPath: filePath,
        status: 'complete',
        currentPage: 1,
        targetContext: '',
        error: '',
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        messages: [
          { id: `${sample.id}-msg-user`, role: 'user', text: sample.prompt, createdAt: now },
          { id: `${sample.id}-msg-assistant`, role: 'assistant', text: sample.message, createdAt: now }
        ],
        comments: [],
        versions: [
          { id: `${sample.id}-v1`, label: 'Initial demo version', filePath, createdAt: now }
        ]
      };
      db.decks.unshift(deck);
      changed = true;
    } else {
      deck.userId = demoUser.id;
      deck.deckPath = `/generated/${sample.id}.html`;
      deck.filePath = filePath;
      deck.status = 'complete';
      deck.messages ||= [];
      deck.comments ||= [];
      deck.versions ||= [];
      if (!deck.versions.length) deck.versions.push({ id: `${sample.id}-v1`, label: 'Initial demo version', filePath, createdAt: now });
      changed = true;
    }
  }
  if (changed) writeDb(db);
}

async function runDeckGeneration({ db, user, deck, template }) {
  const modelConfig = normalizeProviderConfig(user.modelConfig);
  const html = await generateDeckHtml({ prompt: deck.prompt, template, modelConfig });
  const userDir = path.join(GENERATED_DIR, user.id);
  fs.mkdirSync(userDir, { recursive: true });
  const filePath = path.join(userDir, `${deck.id}.html`);
  fs.writeFileSync(filePath, html);
  deck.status = 'complete';
  deck.deckPath = `/generated/${deck.id}.html`;
  deck.filePath = filePath;
  deck.completedAt = new Date().toISOString();
  deck.updatedAt = new Date().toISOString();
  deck.error = '';
  deck.messages ||= [];
  deck.comments ||= [];
  deck.versions ||= [];
  if (!deck.originalHtmlPath) {
    const originalPath = path.join(userDir, `${deck.id}.original.html`);
    fs.copyFileSync(filePath, originalPath);
    deck.originalHtmlPath = originalPath;
  }
  if (!deck.messages.length) {
    deck.messages.push(
      { id: crypto.randomUUID(), role: 'user', text: deck.prompt, createdAt: deck.createdAt },
      { id: crypto.randomUUID(), role: 'assistant', text: `Generated a real HTML deck with ${template.name}.`, createdAt: deck.updatedAt }
    );
  }
  writeDb(db);
  return deck;
}

function createApiRouter() {
  const router = express.Router();

  router.use(express.json({ limit: '1mb' }));

  router.get('/health', (req, res) => {
    res.json({ ok: true, app: 'Slide Studio', time: new Date().toISOString() });
  });

  router.get('/templates', (req, res) => {
    res.json({ templates });
  });

  router.get('/me', (req, res) => {
    const db = readDb();
    res.json({ user: publicUser(getUser(req, db)) });
  });

  router.post('/signup', (req, res) => {
    const db = readDb();
    const email = String(req.body.email || '').trim().toLowerCase();
    const name = String(req.body.name || '').trim() || email.split('@')[0];
    const password = String(req.body.password || '');
    if (!email || password.length < 6) return res.status(400).json({ error: 'Email and 6+ character password required.' });
    if (db.users.some((item) => item.email === email)) return res.status(409).json({ error: 'Email already exists.' });

    const newUser = {
      id: crypto.randomUUID(),
      name,
      email,
      passwordHash: hashPassword(password),
      modelConfig: { provider: 'OpenAI', model: 'gpt-4.1', baseUrl: 'https://api.openai.com/v1', output: 'Frontend (HTML)' }
    };
    db.users.push(newUser);
    const token = crypto.randomBytes(32).toString('hex');
    db.sessions[token] = { userId: newUser.id, createdAt: new Date().toISOString() };
    writeDb(db);
    setSessionCookie(res, token);
    logEvent('info', 'User signed up', { email });
    res.json({ user: publicUser(newUser) });
  });

  router.post('/login', (req, res) => {
    const db = readDb();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const found = db.users.find((item) => item.email === email);
    if (!found || !verifyPassword(password, found.passwordHash)) {
      logEvent('error', 'Login failed', { email });
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    db.sessions[token] = { userId: found.id, createdAt: new Date().toISOString() };
    writeDb(db);
    setSessionCookie(res, token);
    logEvent('info', 'User logged in', { email });
    res.json({ user: publicUser(found) });
  });

  router.post('/logout', (req, res) => {
    const db = readDb();
    const token = parseCookies(req).session;
    if (token) delete db.sessions[token];
    writeDb(db);
    setSessionCookie(res, '', 0);
    res.json({ ok: true });
  });

  router.post('/model-config', (req, res) => {
    const db = readDb();
    const user = getUser(req, db);
    if (!user) return res.status(401).json({ error: 'Login required.' });
    const incoming = normalizeProviderConfig({
      provider: req.body.provider,
      model: req.body.model,
      baseUrl: req.body.baseUrl,
      apiKey: req.body.apiKey || user.modelConfig?.apiKey,
      output: req.body.output
    });
    user.modelConfig = incoming;
    writeDb(db);
    logEvent('info', 'Model settings saved', { userId: user.id, provider: user.modelConfig.provider, model: user.modelConfig.model });
    res.json({ user: publicUser(user) });
  });

  router.post('/generate', async (req, res) => {
    const db = readDb();
    const user = getUser(req, db);
    if (!user) return res.status(401).json({ error: 'Login required.' });
    const template = templates.find((item) => item.id === req.body.templateId) || templates[0];
    const prompt = String(req.body.prompt || '').trim();
    if (!prompt) {
      logEvent('error', 'Generate failed: empty prompt', { userId: user.id });
      return res.status(400).json({ error: 'Prompt is required.' });
    }

    const deck = {
      id: crypto.randomUUID(),
      userId: user.id,
      prompt,
      templateId: template.id,
      templateSlug: template.slug,
      title: prompt.slice(0, 56),
      deckPath: '',
      status: 'generating',
      createdAt: new Date().toISOString(),
      completedAt: '',
      error: '',
      comments: []
    };
    db.decks.unshift(deck);
    writeDb(db);
    logEvent('info', 'Deck generation started', { userId: user.id, templateId: template.id, deckId: deck.id });
    try {
      await runDeckGeneration({ db, user, deck, template });
      logEvent('info', 'Deck generated', { userId: user.id, templateId: template.id, deckId: deck.id });
      return res.json({ deck: publicDeck(deck) });
    } catch (error) {
      deck.status = 'failed';
      deck.error = error.message || 'Generation failed.';
      deck.completedAt = new Date().toISOString();
      writeDb(db);
      logEvent('error', 'Deck generation failed', { userId: user.id, templateId: template.id, deckId: deck.id, message: deck.error });
      return res.status(500).json({ error: deck.error, deck: publicDeck(deck) });
    }
  });

  router.post('/generate/:deckId/retry', async (req, res) => {
    const db = readDb();
    const user = getUser(req, db);
    if (!user) return res.status(401).json({ error: 'Login required.' });
    const deck = db.decks.find((item) => item.id === req.params.deckId && item.userId === user.id);
    if (!deck) return res.status(404).json({ error: 'Deck not found.' });
    const template = templates.find((item) => item.id === deck.templateId) || templates[0];
    deck.status = 'generating';
    deck.error = '';
    deck.completedAt = '';
    writeDb(db);
    logEvent('info', 'Deck retry started', { userId: user.id, templateId: template.id, deckId: deck.id });
    try {
      await runDeckGeneration({ db, user, deck, template });
      logEvent('info', 'Deck retry generated', { userId: user.id, templateId: template.id, deckId: deck.id });
      return res.json({ deck: publicDeck(deck) });
    } catch (error) {
      deck.status = 'failed';
      deck.error = error.message || 'Generation failed.';
      deck.completedAt = new Date().toISOString();
      writeDb(db);
      logEvent('error', 'Deck retry failed', { userId: user.id, templateId: template.id, deckId: deck.id, message: deck.error });
      return res.status(500).json({ error: deck.error, deck: publicDeck(deck) });
    }
  });

  router.get('/decks', (req, res) => {
    const db = readDb();
    const user = getUser(req, db);
    if (!user) return res.status(401).json({ error: 'Login required.' });
    res.json({ decks: db.decks.filter((deck) => deck.userId === user.id).map(publicDeck) });
  });

  router.get('/decks/:deckId', (req, res) => {
    const db = readDb();
    const user = getUser(req, db);
    if (!user) return res.status(401).json({ error: 'Login required.' });
    const deck = db.decks.find((item) => item.id === req.params.deckId && item.userId === user.id);
    if (!deck) return res.status(404).json({ error: 'Deck not found.' });
    res.json({ deck: publicDeck(deck) });
  });

  router.get('/decks/:deckId/download/html', (req, res) => {
    const { deck, resolvedPath } = getAuthorizedDeck(req, res);
    if (!deck || !resolvedPath || res.headersSent) return;
    const filename = `${sanitizeFileName(deck.title)}.html`;
    logEvent('info', 'Deck HTML download started', { deckId: deck.id });
    res.download(resolvedPath, filename);
  });

  router.get('/decks/:deckId/export/pdf', async (req, res) => {
    const { deck, resolvedPath } = getAuthorizedDeck(req, res);
    if (!deck || !resolvedPath || res.headersSent) return;
    const chromePath = findChromeExecutable();
    if (!chromePath) {
      return res.status(500).json({ error: 'Chrome was not found on this machine, so PDF export is unavailable.' });
    }

    const exportId = crypto.randomUUID();
    const exportDir = path.join(os.tmpdir(), 'slide-studio-exports', exportId);
    fs.mkdirSync(exportDir, { recursive: true });
    const printablePath = path.join(exportDir, 'printable.html');
    const pdfPath = path.join(exportDir, `${sanitizeFileName(deck.title)}.pdf`);
    fs.writeFileSync(printablePath, buildPrintableHtml(fs.readFileSync(resolvedPath, 'utf8')));

    try {
      await execFileAsync(chromePath, [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--hide-scrollbars',
        '--run-all-compositor-stages-before-draw',
        '--no-pdf-header-footer',
        `--user-data-dir=${path.join(exportDir, 'chrome-profile')}`,
        `--print-to-pdf=${pdfPath}`,
        `file://${printablePath}`
      ], { timeout: 60000 });
      if (!fs.existsSync(pdfPath)) throw new Error('Chrome did not create a PDF file.');
      logEvent('info', 'Deck PDF exported', { deckId: deck.id });
      res.download(pdfPath, `${sanitizeFileName(deck.title)}.pdf`, (error) => {
        fs.rm(exportDir, { recursive: true, force: true }, () => {});
        if (error) logEvent('error', 'PDF download failed', { deckId: deck.id, message: error.message });
      });
    } catch (error) {
      fs.rm(exportDir, { recursive: true, force: true }, () => {});
      logEvent('error', 'Deck PDF export failed', { deckId: deck.id, message: error.message, stderr: error.stderr });
      res.status(500).json({ error: `PDF export failed: ${error.message}` });
    }
  });

  router.post('/decks/:deckId/messages', async (req, res) => {
    const db = readDb();
    const user = getUser(req, db);
    if (!user) return res.status(401).json({ error: 'Login required.' });
    const deck = db.decks.find((item) => item.id === req.params.deckId && item.userId === user.id);
    if (!deck) return res.status(404).json({ error: 'Deck not found.' });
    const instruction = String(req.body.text || '').trim();
    const currentPage = Number(req.body.currentPage || deck.currentPage || 1);
    if (!instruction) return res.status(400).json({ error: 'Message text is required.' });

    deck.messages ||= [];
    deck.messages.push({ id: crypto.randomUUID(), role: 'user', text: instruction, page: currentPage, createdAt: new Date().toISOString() });
    deck.status = 'editing';
    deck.currentPage = currentPage;
    saveDeckVersion(deck, `Before chat edit: ${instruction.slice(0, 48)}`);
    writeDb(db);

    try {
      const updatedHtml = await editDeckHtml({
        deck,
        instruction,
        currentPage,
        modelConfig: normalizeProviderConfig(user.modelConfig)
      });
      fs.writeFileSync(deck.filePath, updatedHtml);
      deck.status = 'complete';
      deck.updatedAt = new Date().toISOString();
      deck.error = '';
      deck.lastAppliedAt = deck.updatedAt;
      deck.messages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        text: `Applied the requested edit on slide ${currentPage}.`,
        page: currentPage,
        createdAt: deck.updatedAt
      });
      writeDb(db);
      logEvent('info', 'Deck edited from chat', { userId: user.id, deckId: deck.id, currentPage });
      return res.json({ deck: publicDeck(deck) });
    } catch (error) {
      deck.status = 'complete';
      deck.error = error.message || 'Edit failed.';
      deck.messages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        text: `Edit failed: ${deck.error}`,
        page: currentPage,
        createdAt: new Date().toISOString()
      });
      writeDb(db);
      logEvent('error', 'Deck edit failed', { userId: user.id, deckId: deck.id, message: deck.error });
      return res.status(500).json({ error: deck.error, deck: publicDeck(deck) });
    }
  });

  router.post('/decks/:deckId/undo', (req, res) => {
    const db = readDb();
    const user = getUser(req, db);
    if (!user) return res.status(401).json({ error: 'Login required.' });
    const deck = db.decks.find((item) => item.id === req.params.deckId && item.userId === user.id);
    if (!deck) return res.status(404).json({ error: 'Deck not found.' });
    if (!deck.filePath || !fs.existsSync(deck.filePath)) return res.status(404).json({ error: 'Current HTML file is missing.' });
    deck.versions ||= [];
    const version = deck.versions.pop();
    if (!version || !version.filePath || !fs.existsSync(version.filePath)) {
      return res.status(400).json({ error: 'No previous version available.' });
    }
    fs.copyFileSync(version.filePath, deck.filePath);
    deck.updatedAt = new Date().toISOString();
    deck.status = 'complete';
    deck.error = '';
    deck.messages ||= [];
    deck.messages.push({
      id: crypto.randomUUID(),
      role: 'assistant',
      text: `Undid: ${version.label || 'previous edit'}.`,
      createdAt: deck.updatedAt
    });
    writeDb(db);
    logEvent('info', 'Deck undo applied', { userId: user.id, deckId: deck.id, versionId: version.id });
    res.json({ deck: publicDeck(deck) });
  });

  router.post('/comment', (req, res) => {
    const db = readDb();
    const user = getUser(req, db);
    if (!user) return res.status(401).json({ error: 'Login required.' });
    const deck = db.decks.find((item) => item.id === req.body.deckId && item.userId === user.id);
    if (!deck) return res.status(404).json({ error: 'Deck not found.' });
    const comment = {
      id: crypto.randomUUID(),
      page: Number(req.body.page || 1),
      note: String(req.body.note || ''),
      x: Number(req.body.x || 0),
      y: Number(req.body.y || 0),
      selector: String(req.body.selector || ''),
      elementText: String(req.body.elementText || ''),
      elementTag: String(req.body.elementTag || ''),
      elementRect: req.body.elementRect || null,
      status: 'open',
      createdAt: new Date().toISOString()
    };
    deck.comments.push(comment);
    deck.messages ||= [];
    deck.messages.push({ id: crypto.randomUUID(), role: 'user', text: `Annotation on slide ${comment.page}: ${comment.note}`, page: comment.page, createdAt: comment.createdAt });
    deck.messages.push({ id: crypto.randomUUID(), role: 'assistant', text: 'Annotation saved. Applying it to the deck now.', page: comment.page, createdAt: new Date().toISOString() });
    writeDb(db);
    logEvent('info', 'Annotation added', { userId: user.id, deckId: deck.id });
    res.json({ deck: publicDeck(deck) });
  });

  router.post('/decks/:deckId/comments/:commentId/apply', async (req, res) => {
    const db = readDb();
    const user = getUser(req, db);
    if (!user) return res.status(401).json({ error: 'Login required.' });
    const deck = db.decks.find((item) => item.id === req.params.deckId && item.userId === user.id);
    if (!deck) return res.status(404).json({ error: 'Deck not found.' });
    const comment = (deck.comments || []).find((item) => item.id === req.params.commentId);
    if (!comment) return res.status(404).json({ error: 'Annotation not found.' });
    const instruction = String(req.body.text || comment.note || '').trim();
    if (!instruction) return res.status(400).json({ error: 'Annotation text is required.' });
    const currentPage = Number(comment.page || deck.currentPage || 1);
    const targetContext = [
      `Annotation id: ${comment.id}`,
      `Slide: ${currentPage}`,
      comment.selector ? `DOM selector: ${comment.selector}` : '',
      comment.elementTag ? `Element tag: ${comment.elementTag}` : '',
      comment.elementText ? `Element visible text: ${comment.elementText}` : '',
      comment.elementRect ? `Element rect: ${JSON.stringify(comment.elementRect)}` : '',
      `Annotation coordinates: ${comment.x}, ${comment.y}`,
      `Requested change: ${instruction}`
    ].filter(Boolean).join('\n');

    deck.messages ||= [];
    deck.messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      text: `Apply annotation on slide ${currentPage}: ${instruction}`,
      page: currentPage,
      createdAt: new Date().toISOString()
    });
    deck.status = 'editing';
    deck.currentPage = currentPage;
    deck.targetContext = targetContext;
    saveDeckVersion(deck, `Before annotation: ${instruction.slice(0, 48)}`);
    writeDb(db);

    try {
      const updatedHtml = await editDeckHtml({
        deck,
        instruction: `Apply this annotation precisely: ${instruction}`,
        currentPage,
        modelConfig: normalizeProviderConfig(user.modelConfig)
      });
      fs.writeFileSync(deck.filePath, updatedHtml);
      comment.status = 'resolved';
      comment.resolvedAt = new Date().toISOString();
      deck.targetContext = '';
      deck.status = 'complete';
      deck.updatedAt = new Date().toISOString();
      deck.error = '';
      deck.messages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        text: `Resolved annotation on slide ${currentPage}.`,
        page: currentPage,
        createdAt: deck.updatedAt
      });
      writeDb(db);
      logEvent('info', 'Annotation applied', { userId: user.id, deckId: deck.id, commentId: comment.id });
      return res.json({ deck: publicDeck(deck) });
    } catch (error) {
      deck.targetContext = '';
      deck.status = 'complete';
      deck.error = error.message || 'Annotation edit failed.';
      deck.messages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        text: `Annotation edit failed: ${deck.error}`,
        page: currentPage,
        createdAt: new Date().toISOString()
      });
      writeDb(db);
      logEvent('error', 'Annotation apply failed', { userId: user.id, deckId: deck.id, commentId: comment.id, message: deck.error });
      return res.status(500).json({ error: deck.error, deck: publicDeck(deck) });
    }
  });

  router.post('/logs', (req, res) => {
    const entry = logEvent(String(req.body.level || 'info'), String(req.body.message || 'Client event'), req.body.meta || {});
    res.json({ ok: true, entry });
  });

  router.use((err, req, res, next) => {
    logEvent('error', 'API error', { path: req.path, message: err.message });
    res.status(500).json({ error: 'Server error.' });
  });

  return router;
}

async function start() {
  ensureDb();
  seedDemoData();
  const app = express();

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', createApiRouter());
  app.get('/generated/:deckId.html', (req, res) => {
    const db = readDb();
    const user = getUser(req, db);
    if (!user) return res.status(401).send('Login required.');
    const deck = db.decks.find((item) => item.id === req.params.deckId && item.userId === user.id);
    if (!deck || deck.status !== 'complete' || !deck.filePath) return res.status(404).send('Deck not found.');
    const resolvedPath = path.resolve(deck.filePath);
    if (!resolvedPath.startsWith(path.resolve(GENERATED_DIR))) return res.status(403).send('Forbidden.');
    res.sendFile(resolvedPath);
  });
  app.get('/ai-creation-sakura-chroma.html', (req, res) => res.sendFile(path.join(ROOT, 'ai-creation-sakura-chroma.html')));
  app.get('/ai-creation-sakura-chroma-edited.html', (req, res) => res.sendFile(path.join(ROOT, 'ai-creation-sakura-chroma-edited.html')));
  app.get('/ai-notes-launch.html', (req, res) => res.sendFile(path.join(ROOT, 'ai-notes-launch.html')));
  app.get('/product.html', (req, res) => res.sendFile(path.join(PUBLIC, 'product.html')));

  if (isProduction) {
    const DIST = path.join(ROOT, 'dist');
    app.use(express.static(DIST));
    app.get('*', (req, res) => res.sendFile(path.join(DIST, 'index.html')));
  } else {
    const { createServer } = await import('vite');
    const vite = await createServer({
      root: PUBLIC,
      appType: 'spa',
      server: { middlewareMode: true }
    });
    app.use(vite.middlewares);
  }

  app.use((err, req, res, next) => {
    logEvent('error', 'Server error', { path: req.path, message: err.message });
    res.status(500).json({ error: 'Server error.' });
  });

  app.listen(PORT, () => {
    console.log(`Slide Studio running at http://127.0.0.1:${PORT}`);
  });
}

start().catch((error) => {
  logEvent('error', 'Failed to start server', { message: error.message, stack: error.stack });
  process.exit(1);
});
