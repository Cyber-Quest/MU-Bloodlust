const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const sanitizeHtml = require('sanitize-html');
const fs = require('fs');
const path = require('path');
const net = require('net');

const app = express();

const {
  DB_HOST = 'mysql',
  DB_PORT = '3306',
  DB_USER = 'admin',
  DB_PASS = 'asd123',
  DB_NAME = 'MuOnline97',
  WEB_PORT = '8080',
  SESSION_SECRET = 'change-me',
  TURNSTILE_SITE_KEY = '',
  TURNSTILE_SECRET_KEY = '',
  ADMIN_USER = 'admin',
  ADMIN_PASS = '123456',
  TRUST_PROXY = '0',
  TIMEZONE = '',
  ASSET_VERSION = '',
  EDITOR_ENABLED = '0',
  EDITOR_API_URL = 'http://mu-editor:8090',
  EDITOR_MAX_BACKUPS = '5',
  EDITOR_MAX_SNAPSHOTS = '5',
  DOWNLOADS_CONFIG_PATH = ''
} = process.env;

const trustProxyEnabled = String(TRUST_PROXY).toLowerCase() === '1' || String(TRUST_PROXY).toLowerCase() === 'true';
const resolvedTimeZone = TIMEZONE || process.env.TZ || '';
if (resolvedTimeZone) {
  process.env.TZ = resolvedTimeZone;
}
const resolvedAssetVersion = ASSET_VERSION || String(Date.now());
const editorEnabled = String(EDITOR_ENABLED).toLowerCase() === '1' || String(EDITOR_ENABLED).toLowerCase() === 'true';
const editorMaxBackups = Number.parseInt(EDITOR_MAX_BACKUPS, 10) || 5;
const editorMaxSnapshots = Number.parseInt(EDITOR_MAX_SNAPSHOTS, 10) || 5;
const downloadsConfigPath = DOWNLOADS_CONFIG_PATH
  ? path.resolve(DOWNLOADS_CONFIG_PATH)
  : path.join(__dirname, 'config', 'downloads.json');

const pool = mysql.createPool({
  host: DB_HOST,
  port: Number(DB_PORT),
  user: DB_USER,
  password: DB_PASS,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const sessionStore = new MySQLStore({}, pool);

app.use(helmet({
  contentSecurityPolicy: false
}));
app.set('trust proxy', trustProxyEnabled ? 1 : false);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static('public'));
app.set('view engine', 'ejs');

app.use((req, res, next) => {
  res.locals.editorEnabled = editorEnabled;
  res.locals.editorApiUrl = EDITOR_API_URL;
  res.locals.editorMaxBackups = editorMaxBackups;
  res.locals.editorMaxSnapshots = editorMaxSnapshots;
  next();
});

app.use(session({
  key: 'mu_web_session',
  secret: SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 6
  }
}));

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
});

function requireUser(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.session.admin) return res.redirect('/admin/login');
  return next();
}

function requireAdminPasswordChange(req, res, next) {
  if (req.session.admin?.mustChange) return res.redirect('/admin/password');
  return next();
}

function randomDigits(len) {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += Math.floor(Math.random() * 10);
  }
  return out;
}

const CLASS_NAMES = {
  0: 'Dark Wizard',
  1: 'Soul Master',
  2: 'Grand Master',
  16: 'Dark Knight',
  17: 'Blade Knight',
  18: 'Blade Master',
  32: 'Fairy Elf',
  33: 'Muse Elf',
  34: 'High Elf',
  48: 'Magic Gladiator',
  49: 'Duel Master',
  64: 'Dark Lord',
  65: 'Lord Emperor',
  80: 'Summoner',
  81: 'Bloody Summoner',
  82: 'Dimension Master',
  96: 'Rage Fighter',
  97: 'Fist Master'
};

const CLASS_ICONS = {
  0: 'dw',
  1: 'dw',
  2: 'dw',
  16: 'dk',
  17: 'dk',
  18: 'dk',
  32: 'elf',
  33: 'elf',
  34: 'elf',
  48: 'mg',
  49: 'mg'
};

const ACTIVE_CLASSES = [0, 1, 16, 17, 32, 33, 48];

const MAP_NAMES = {
  0: 'Lorencia',
  1: 'Dungeon',
  2: 'Devias',
  3: 'Noria',
  4: 'Lost Tower',
  5: 'Exile',
  6: 'Arena',
  7: 'Atlans',
  8: 'Tarkan',
  9: 'Devil Square 1',
  10: 'Icarus',
  11: 'Blood Castle 1',
  12: 'Blood Castle 2',
  13: 'Blood Castle 3',
  14: 'Blood Castle 4',
  15: 'Blood Castle 5',
  16: 'Blood Castle 6'
};

function getClassName(value) {
  const id = Number(value);
  if (Number.isNaN(id)) return 'Desconhecida';
  return CLASS_NAMES[id] || `Classe ${id}`;
}

function getClassIcon(value) {
  const id = Number(value);
  const key = CLASS_ICONS[id] || 'unknown';
  return `/assets/images/classes/${key}.svg`;
}

function getMapName(value) {
  const id = Number(value);
  if (Number.isNaN(id)) return 'Desconhecido';
  return MAP_NAMES[id] || `Mapa ${id}`;
}

function makeExcerpt(text, maxLen = 220) {
  const clean = stripHtml(text || '').replace(/\r?\n/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen)}...`;
}

function extractFirstImage(html) {
  const match = String(html || '').match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? match[1] : '';
}

async function editorRequest(method, endpoint, payload) {
  if (!editorEnabled) {
    const error = new Error('Editor disabled');
    error.status = 503;
    throw error;
  }

  const url = `${EDITOR_API_URL}${endpoint}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json'
    }
  };

  if (payload) {
    options.body = JSON.stringify(payload);
  }

  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Editor API error');
    error.status = response.status;
    throw error;
  }
  return data;
}

function loadEventConfig() {
  try {
    const configPath = path.join(__dirname, 'config', 'events.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.events)) return { events: [] };
    return parsed;
  } catch {
    return { events: [] };
  }
}

const DEFAULT_DOWNLOADS_CONFIG = {
  clientUrl: '',
  clientSubtitle: '',
  launcherUrl: '',
  launcherSubtitle: '',
  patchUrl: '',
  patchSubtitle: ''
};

function sanitizeDownloadUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/')) return raw;
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  return '';
}

function sanitizeDownloadText(value, maxLen = 160) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

function loadDownloadsConfig() {
  try {
    const raw = fs.readFileSync(downloadsConfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      clientUrl: sanitizeDownloadUrl(parsed?.clientUrl),
      clientSubtitle: sanitizeDownloadText(parsed?.clientSubtitle),
      launcherUrl: sanitizeDownloadUrl(parsed?.launcherUrl),
      launcherSubtitle: sanitizeDownloadText(parsed?.launcherSubtitle),
      patchUrl: sanitizeDownloadUrl(parsed?.patchUrl),
      patchSubtitle: sanitizeDownloadText(parsed?.patchSubtitle)
    };
  } catch {
    return { ...DEFAULT_DOWNLOADS_CONFIG };
  }
}

function saveDownloadsConfig(config) {
  const payload = {
    clientUrl: sanitizeDownloadUrl(config.clientUrl),
    clientSubtitle: sanitizeDownloadText(config.clientSubtitle),
    launcherUrl: sanitizeDownloadUrl(config.launcherUrl),
    launcherSubtitle: sanitizeDownloadText(config.launcherSubtitle),
    patchUrl: sanitizeDownloadUrl(config.patchUrl),
    patchSubtitle: sanitizeDownloadText(config.patchSubtitle)
  };
  fs.mkdirSync(path.dirname(downloadsConfigPath), { recursive: true });
  fs.writeFileSync(downloadsConfigPath, JSON.stringify(payload, null, 2));
  return payload;
}

function listDownloadFiles() {
  const downloadsDir = path.join(__dirname, 'public', 'downloads');

  const readDir = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const filePath = path.join(dir, entry.name);
          const stat = fs.statSync(filePath);
          const sizeMb = stat.size / (1024 * 1024);
          return {
            name: entry.name,
            size: stat.size,
            sizeLabel: `${sizeMb >= 1 ? sizeMb.toFixed(2) : (stat.size / 1024).toFixed(1)} ${sizeMb >= 1 ? 'MB' : 'KB'}`
          };
        });
    } catch {
      return [];
    }
  };

  return {
    downloads: readDir(downloadsDir)
  };
}

function parseTimeString(value) {
  const parts = String(value || '').split(':').map((v) => Number(v));
  if (parts.length !== 2 || parts.some((v) => Number.isNaN(v))) return null;
  const [hour, minute] = parts;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function getNextEventTime(times, now) {
  const validTimes = (times || []).map(parseTimeString).filter(Boolean);
  if (validTimes.length === 0) return null;

  const base = new Date(now);
  let next = null;

  for (const t of validTimes) {
    const candidate = new Date(base);
    candidate.setHours(t.hour, t.minute, 0, 0);
    if (candidate <= now) {
      candidate.setDate(candidate.getDate() + 1);
    }
    if (!next || candidate < next) {
      next = candidate;
    }
  }

  return next;
}

function stripHtml(input) {
  return sanitizeHtml(input || '', { allowedTags: [], allowedAttributes: {} });
}

function sanitizeNewsBody(body, allowHtml) {
  const raw = (body || '').trim();
  if (!allowHtml) {
    const escaped = sanitizeHtml(raw, { allowedTags: [], allowedAttributes: {} });
    return escaped.replace(/\r?\n/g, '<br>');
  }

  return sanitizeHtml(raw, {
    allowedTags: [
      'p', 'br', 'strong', 'em', 'u', 's',
      'ul', 'ol', 'li', 'blockquote', 'hr',
      'a', 'img',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'iframe'
    ],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel', 'class'],
      p: ['class', 'style'],
      div: ['class'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'class', 'style'],
      iframe: ['src', 'width', 'height', 'frameborder', 'allow', 'allowfullscreen', 'class']
    },
    allowedStyles: {
      p: {
        'text-align': [/^left$/, /^right$/, /^center$/, /^justify$/]
      },
      img: {
        display: [/^block$/, /^inline-block$/],
        margin: [/^0?\s*auto$/],
        'max-width': [/^\d+(%|px)$/],
        width: [/^\d+(%|px)$/],
        height: [/^\d+(%|px)$|^auto$/]
      }
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: {
      img: ['http', 'https'],
      iframe: ['http', 'https']
    },
    allowedIframeHostnames: ['www.youtube.com', 'youtube.com', 'youtu.be', 'player.vimeo.com'],
    transformTags: {
      a: (tagName, attribs) => ({
        tagName: 'a',
        attribs: {
          ...attribs,
          rel: 'noopener noreferrer',
          target: '_blank'
        }
      })
    }
  });
}

function validateAccountId(value) {
  return /^[A-Za-z0-9_]{4,10}$/.test(value);
}

function validatePassword(value) {
  return /^(.|\s){4,10}$/.test(value);
}

function validateCode(value) {
  return /^[0-9]{18}$/.test(value);
}

function validateName(value) {
  return /^[A-Za-z0-9_]{4,10}$/.test(value);
}

function validateEmail(value) {
  if (!value) return true;
  return value.length <= 50;
}

function formatDateTimeLocal(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseDateTimeInput(raw) {
  const value = String(raw || '').trim();
  if (!value) return { ok: true, value: null };
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/);
  if (!match) return { ok: false, value: null };
  const [, datePart, timePart, seconds] = match;
  return { ok: true, value: `${datePart} ${timePart}:${seconds || '00'}` };
}

function parseIntField(raw, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (raw === null || raw === undefined || raw === '') return { ok: false, value: null };
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return { ok: false, value: null };
  if (value < min || value > max) return { ok: false, value: null };
  return { ok: true, value };
}

function normalizeHexInput(raw, expectedBytes) {
  let value = String(raw || '').trim();
  if (!value) {
    return { ok: true, buffer: Buffer.alloc(expectedBytes, 0xff) };
  }
  if (value.startsWith('0x') || value.startsWith('0X')) {
    value = value.slice(2);
  }
  value = value.replace(/\s+/g, '');
  if (!/^[0-9a-fA-F]*$/.test(value)) {
    return { ok: false, buffer: null, error: 'Hex inválido: somente 0-9 e A-F.' };
  }
  if (value.length % 2 !== 0) {
    return { ok: false, buffer: null, error: 'Hex inválido: comprimento ímpar.' };
  }
  const maxLen = expectedBytes * 2;
  if (value.length > maxLen) {
    return { ok: false, buffer: null, error: `Hex inválido: máximo ${maxLen} caracteres.` };
  }
  if (value.length < maxLen) {
    value = value.padEnd(maxLen, 'F');
  }
  const buffer = Buffer.from(value, 'hex');
  if (buffer.length !== expectedBytes) {
    const padded = Buffer.alloc(expectedBytes, 0xff);
    buffer.copy(padded);
    return { ok: true, buffer: padded };
  }
  return { ok: true, buffer };
}

function bufferToHex(buffer, expectedBytes) {
  if (!buffer) return '';
  const hex = Buffer.from(buffer).toString('hex').toUpperCase();
  if (!expectedBytes) return hex;
  const targetLen = expectedBytes * 2;
  if (hex.length >= targetLen) return hex.slice(0, targetLen);
  return hex.padEnd(targetLen, 'F');
}

function buildOptionsFromMap(map) {
  return Object.entries(map)
    .map(([value, label]) => ({ value: Number(value), label }))
    .sort((a, b) => a.value - b.value);
}

let cachedItemDefs = null;
let cachedItemDefsMap = null;

function parseItemTxt(content) {
  const defs = [];
  let section = null;
  const lines = String(content || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.toLowerCase() === 'end') {
      section = null;
      continue;
    }
    if (section === null && /^[0-9]+$/.test(line)) {
      section = Number(line);
      continue;
    }
    if (section === null) continue;
    const tokens = line.match(/"[^"]*"|\S+/g);
    if (!tokens || tokens.length < 9) continue;
    const index = Number(tokens[0]);
    const slot = Number(tokens[1]);
    const skillCol = Number(tokens[2]);
    const width = Number(tokens[3]);
    const height = Number(tokens[4]);
    const haveSerial = Number(tokens[5]);
    const name = String(tokens[8] || '').replace(/(^")|("$)/g, '');
    if (Number.isNaN(index) || Number.isNaN(width) || Number.isNaN(height)) continue;
    defs.push({
      section,
      index,
      slot: Number.isNaN(slot) ? -1 : slot,
      skill: Number.isNaN(skillCol) ? 0 : (skillCol > 0 ? 1 : 0),
      width: width || 1,
      height: height || 1,
      haveSerial: Number.isNaN(haveSerial) ? 0 : haveSerial,
      name
    });
  }
  return defs;
}

function getItemDefs() {
  if (cachedItemDefs && cachedItemDefsMap) return { defs: cachedItemDefs, map: cachedItemDefsMap };
  const defaultPath = path.join(__dirname, 'data', 'item.txt');
  const itemPath = process.env.ITEM_TXT_PATH || defaultPath;
  let raw = '';
  try {
    raw = fs.readFileSync(itemPath, 'utf8');
  } catch {
    raw = '';
  }
  const defs = parseItemTxt(raw);
  const map = new Map();
  for (const def of defs) {
    map.set(`${def.section}:${def.index}`, def);
  }
  cachedItemDefs = defs;
  cachedItemDefsMap = map;
  return { defs, map };
}

function parseMapManager(content) {
  const lines = String(content || '').split(/\r?\n/);
  const maps = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//') || line.toLowerCase() === 'end') continue;
    const tokens = line.match(/"[^"]*"|\S+/g);
    if (!tokens || tokens.length < 9) continue;
    const id = Number(tokens[0]);
    if (Number.isNaN(id)) continue;
    const nameToken = tokens[tokens.length - 1];
    const name = String(nameToken || '').replace(/(^")|("$)/g, '');
    maps.push({ id, name });
  }
  return maps;
}

function parseMonsterTxt(content) {
  const lines = String(content || '').split(/\r?\n/);
  const monsters = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;
    const tokens = line.match(/"[^"]*"|\S+/g);
    if (!tokens || tokens.length < 3) continue;
    const id = Number(tokens[0]);
    if (Number.isNaN(id)) continue;
    const nameToken = tokens.find((t) => t.startsWith('"') && t.endsWith('"')) || tokens[2];
    const name = String(nameToken || '').replace(/(^")|("$)/g, '');
    monsters.push({ id, name });
  }
  return monsters;
}

function isEmptyItem(bytes) {
  return bytes[0] === 0xff && (bytes[7] & 0x80) === 0x80 && (bytes[9] & 0xf0) === 0xf0;
}

function decodeItemBytes(bytes) {
  if (!bytes || bytes.length < 10) return { empty: true };
  if (isEmptyItem(bytes)) return { empty: true };
  const itemIndex = bytes[0] | ((bytes[9] & 0xf0) * 32) | ((bytes[7] & 0x80) * 2);
  const section = Math.floor(itemIndex / 32);
  const index = itemIndex % 32;
  const serial = (bytes[3] << 24) | (bytes[4] << 16) | (bytes[5] << 8) | bytes[6];
  return { empty: false, section, index, serial: serial >>> 0 };
}

async function fetchItemSerial() {
  const [rows] = await pool.query('CALL WZ_GetItemSerial()');
  if (Array.isArray(rows)) {
    if (Array.isArray(rows[0])) return rows[0][0]?.Result ?? -1;
    return rows[0]?.Result ?? -1;
  }
  return -1;
}

async function applySerialsIfNeeded(buffer) {
  const { map } = getItemDefs();
  for (let offset = 0; offset + 10 <= buffer.length; offset += 10) {
    const chunk = buffer.subarray(offset, offset + 10);
    const item = decodeItemBytes(chunk);
    if (item.empty) continue;
    const def = map.get(`${item.section}:${item.index}`);
    if (!def || def.haveSerial === 0) continue;
    if (item.serial !== 0) continue;
    const serial = await fetchItemSerial();
    if (serial <= 0) continue;
    chunk[3] = (serial >>> 24) & 0xff;
    chunk[4] = (serial >>> 16) & 0xff;
    chunk[5] = (serial >>> 8) & 0xff;
    chunk[6] = serial & 0xff;
  }
}

async function fetchPlayersOnline() {
  try {
    const [rows] = await pool.query('SELECT COUNT(*) AS total FROM MEMB_STAT WHERE ConnectStat = 1');
    return rows?.[0]?.total ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Status dos servidores de jogo (ConnectServer / GameServer / banco)
// ---------------------------------------------------------------------------
const GAME_SERVER_HOST = process.env.GAME_SERVER_HOST || 'mu-server';
const CONNECT_SERVER_PORT = Number(process.env.CONNECT_SERVER_PORT || 44405);
const GAME_SERVER_PORT = Number(process.env.GAME_SERVER_PORT || 55901);

let statusCache = { data: null, at: 0 };

function tcpPing(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));

    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

async function refreshServerStatus() {
  const startedAt = Date.now();
  const [connectServer, gameServer] = await Promise.all([
    tcpPing(GAME_SERVER_HOST, CONNECT_SERVER_PORT),
    tcpPing(GAME_SERVER_HOST, GAME_SERVER_PORT)
  ]);

  let database = false;
  let playersOnline = 0;
  try {
    const [rows] = await pool.query('SELECT COUNT(*) AS total FROM MEMB_STAT WHERE ConnectStat = 1');
    playersOnline = Number(rows?.[0]?.total ?? 0);
    database = true;
  } catch {
    database = false;
  }

  const data = {
    connectServer,
    gameServer,
    database,
    online: connectServer && gameServer && database,
    playersOnline,
    latencyMs: Date.now() - startedAt,
    checkedAt: new Date().toISOString()
  };

  statusCache = { data, at: Date.now() };
  return data;
}

async function getServerStatus(options = {}) {
  if (options.fresh || !statusCache.data) {
    return refreshServerStatus();
  }
  return statusCache.data;
}

// Atualiza em segundo plano para as paginas responderem do cache (sem esperar)
setInterval(() => { refreshServerStatus().catch(() => {}); }, 15000);
refreshServerStatus().catch(() => {});

async function ensureSchema() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS web_admin (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        username VARCHAR(32) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        must_change_password TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS web_news (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        title VARCHAR(120) NOT NULL,
        body TEXT NOT NULL,
        body_is_html TINYINT(1) NOT NULL DEFAULT 0,
        hide_title TINYINT(1) NOT NULL DEFAULT 0,
        published TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
    `);

    const [newsCols] = await conn.query(
      `SELECT COUNT(*) AS total
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ?
         AND TABLE_NAME = 'web_news'
         AND COLUMN_NAME = 'body_is_html'`,
      [DB_NAME]
    );
    if (newsCols[0]?.total === 0) {
      await conn.query('ALTER TABLE web_news ADD COLUMN body_is_html TINYINT(1) NOT NULL DEFAULT 0');
    }

    const [hideCols] = await conn.query(
      `SELECT COUNT(*) AS total
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ?
         AND TABLE_NAME = 'web_news'
         AND COLUMN_NAME = 'hide_title'`,
      [DB_NAME]
    );
    if (hideCols[0]?.total === 0) {
      await conn.query('ALTER TABLE web_news ADD COLUMN hide_title TINYINT(1) NOT NULL DEFAULT 0');
    }

    await conn.query(`
      CREATE TABLE IF NOT EXISTS web_character_actions (
        account_id VARCHAR(10) NOT NULL,
        character_name VARCHAR(10) NOT NULL,
        action VARCHAR(32) NOT NULL,
        last_used DATETIME NOT NULL,
        PRIMARY KEY (account_id, character_name, action)
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS web_cash (
        account_id VARCHAR(10) NOT NULL,
        cash INT NOT NULL DEFAULT 0,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (account_id)
      )
    `);

    const [rows] = await conn.query('SELECT id FROM web_admin WHERE username = ? LIMIT 1', [ADMIN_USER]);
    if (rows.length === 0) {
      const hash = await bcrypt.hash(ADMIN_PASS, 10);
      await conn.query(
        'INSERT INTO web_admin (username, password_hash, must_change_password) VALUES (?, ?, 1)',
        [ADMIN_USER, hash]
      );
    }
  } finally {
    conn.release();
  }
}

async function verifyTurnstile(token, remoteIp) {
  if (!TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;

  const formData = new URLSearchParams();
  formData.append('secret', TURNSTILE_SECRET_KEY);
  formData.append('response', token);
  if (remoteIp) formData.append('remoteip', remoteIp);

  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formData.toString()
  });
  const data = await resp.json();
  return data.success === true;
}

app.use((req, res, next) => {
  res.locals.turnstileSiteKey = TURNSTILE_SITE_KEY;
  res.locals.session = req.session;
  res.locals.appName = 'Bloodlust';
  res.locals.year = new Date().getFullYear();
  res.locals.timeZone = resolvedTimeZone;
  res.locals.assetsVersion = resolvedAssetVersion;
  res.locals.encodeURIComponent = encodeURIComponent;
  next();
});

app.get('/', async (req, res) => {
  const [newsRows] = await pool.query('SELECT id, title, body, body_is_html, hide_title, created_at FROM web_news WHERE published = 1 ORDER BY created_at DESC LIMIT 5');
  const news = newsRows.map((row) => ({
    ...row,
    excerpt: makeExcerpt(row.body),
    featuredImage: row.body_is_html ? extractFirstImage(row.body) : ''
  }));
  const [ranking] = await pool.query(
    `SELECT Name, cLevel, ResetCount, GrandResetCount, Class
     FROM \`Character\`
     WHERE Class IN (${ACTIVE_CLASSES.map(() => '?').join(',')})
     ORDER BY GrandResetCount DESC, ResetCount DESC, cLevel DESC, Experience DESC
     LIMIT 10`,
    ACTIVE_CLASSES
  );
  const rankingView = ranking.map((row) => ({
    ...row,
    ClassName: getClassName(row.Class),
    ClassIcon: getClassIcon(row.Class)
  }));
  const playersOnline = await fetchPlayersOnline();
  const timeOptions = resolvedTimeZone
    ? { hour12: false, timeZone: resolvedTimeZone }
    : { hour12: false };
  const serverTime = new Date().toLocaleTimeString('pt-BR', timeOptions);
  const eventConfig = loadEventConfig();
  const now = new Date();
  const events = (eventConfig.events || []).map((ev) => {
    const nextAt = getNextEventTime(ev.times, now);
    if (!nextAt) return null;
    const diffSeconds = Math.max(0, Math.floor((nextAt.getTime() - now.getTime()) / 1000));
    return {
      name: ev.name,
      nextAt: nextAt.toISOString(),
      nextTime: nextAt.toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        ...(resolvedTimeZone ? { timeZone: resolvedTimeZone } : {})
      }),
      remainingSeconds: diffSeconds
    };
  }).filter(Boolean);

  const status = await getServerStatus();
  res.render('home', { news, ranking: rankingView, playersOnline, serverTime, events, status, page: 'home', pageTitle: 'Bloodlust - Início' });
});

app.get('/api/status', async (req, res) => {
  try {
    const status = await getServerStatus();
    res.set('Cache-Control', 'no-store');
    res.json(status);
  } catch (err) {
    res.status(500).json({ online: false, error: 'status_unavailable' });
  }
});

app.get('/status', async (req, res) => {
  const status = await getServerStatus();
  res.render('status', {
    status,
    page: 'status',
    pageTitle: 'Bloodlust - Status dos servidores'
  });
});

app.get('/register', (req, res) => {
  res.render('register', { error: null, page: 'register', pageTitle: 'Bloodlust - Cadastro' });
});

app.post('/register', authLimiter, async (req, res) => {
  const { account, password, confirm, email, name } = req.body;

  if (!account || !password || !confirm || !email) {
    return res.render('register', { error: 'Preencha todos os campos.', page: 'register', pageTitle: 'Bloodlust - Cadastro' });
  }

  if (!/^[a-zA-Z0-9]{4,10}$/.test(account)) {
    return res.render('register', { error: 'O usuário deve ter 4-10 caracteres alfanuméricos.', page: 'register', pageTitle: 'Bloodlust - Cadastro' });
  }

  if (password.length < 6 || password !== confirm) {
    return res.render('register', { error: 'A senha deve ter pelo menos 6 caracteres e coincidir.', page: 'register', pageTitle: 'Bloodlust - Cadastro' });
  }

  const turnstileToken = req.body['cf-turnstile-response'];
  const turnstileOk = await verifyTurnstile(turnstileToken, req.ip);
  if (!turnstileOk) {
    return res.render('register', { error: 'Captcha inválido. Tente novamente.', page: 'register', pageTitle: 'Bloodlust - Cadastro' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [existing] = await conn.query('SELECT memb___id FROM MEMB_INFO WHERE memb___id = ? LIMIT 1', [account]);
    if (existing.length > 0) {
      await conn.rollback();
      return res.render('register', { error: 'A conta já existe.', page: 'register', pageTitle: 'Bloodlust - Cadastro' });
    }

    const membName = name && name.trim().length > 0 ? name.trim().slice(0, 10) : account;
    const sno = randomDigits(18);

    await conn.query(
      `INSERT INTO MEMB_INFO
       (memb___id, memb__pwd, memb_name, mail_addr, sno__numb, AccountLevel, AccountExpireDate, bloc_code, Bloc_Expire)
       VALUES (?, UNHEX(MD5(?)), ?, ?, ?, 0, NOW(), '0', '1900-01-01 00:00:00')`,
      [account, password, membName, email, sno]
    );

    await conn.query(
      'INSERT INTO MEMB_STAT (memb___id, ConnectStat) VALUES (?, 0)',
      [account]
    );

    await conn.query(
      'INSERT INTO AccountCharacter (Id) VALUES (?)',
      [account]
    );

    await conn.commit();
    return res.redirect('/login');
  } catch (err) {
    await conn.rollback();
    return res.render('register', { error: 'Erro ao criar a conta.', page: 'register', pageTitle: 'Bloodlust - Cadastro' });
  } finally {
    conn.release();
  }
});

app.get('/login', (req, res) => {
  res.render('login', { error: null, page: 'login', pageTitle: 'Bloodlust - Entrar' });
});

app.post('/login', authLimiter, async (req, res) => {
  const { account, password } = req.body;
  if (!account || !password) {
    return res.render('login', { error: 'Preencha usuário e senha.', page: 'login', pageTitle: 'Bloodlust - Entrar' });
  }

  const [rows] = await pool.query(
    'SELECT memb___id FROM MEMB_INFO WHERE memb___id = ? AND memb__pwd = UNHEX(MD5(?)) LIMIT 1',
    [account, password]
  );

  if (rows.length === 0) {
    return res.render('login', { error: 'Credenciais inválidas.', page: 'login', pageTitle: 'Bloodlust - Entrar' });
  }

  req.session.user = { id: account };
  return res.redirect('/account');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/account', requireUser, async (req, res) => {
  const [rows] = await pool.query('SELECT memb___id, memb_name, mail_addr, AccountLevel FROM MEMB_INFO WHERE memb___id = ? LIMIT 1', [req.session.user.id]);
  const [chars] = await pool.query(
    'SELECT Name, cLevel, Class, MapNumber FROM `Character` WHERE AccountID = ? ORDER BY Name',
    [req.session.user.id]
  );
    const characters = chars.map((row) => ({
      ...row,
      ClassName: getClassName(row.Class),
      ClassIcon: getClassIcon(row.Class),
      MapName: getMapName(row.MapNumber)
    }));
  const notice = req.query.ok ? { type: 'success', text: decodeURIComponent(String(req.query.ok)) } : null;
  const error = req.query.err ? { type: 'danger', text: decodeURIComponent(String(req.query.err)) } : null;
  const cash = await getCash(req.session.user.id);
  res.render('account', {
    account: rows[0],
    characters,
    cash,
    notice,
    error,
    page: 'account',
    pageTitle: 'Bloodlust - Conta'
  });
});

// ---------------------------------------------------------------------------
// Perfil do personagem (inventario / equipamento / bau)
// ---------------------------------------------------------------------------
const PROFILE_EQUIP_LABELS = [
  'Arma', 'Escudo', 'Elmo', 'Armadura', 'Calça', 'Luvas',
  'Botas', 'Asas', 'Pet', 'Pingente', 'Anel 1', 'Anel 2'
];

function buildItemTitle(item) {
  const parts = [item.name];
  if (item.level > 0) parts.push(`+${item.level}`);
  if (item.add > 0) parts.push(`+${item.add} opção`);
  if (item.skill) parts.push('Skill');
  if (item.luck) parts.push('Luck');
  if (item.excellent > 0) parts.push('Excellent');
  if (item.durability > 0 && item.durability < 255) parts.push(`Dur ${item.durability}`);
  return parts.join(' ');
}

function decodeProfileItem(buffer, slot, equipCount, defMap) {
  const offset = slot * 10;
  if (offset + 10 > buffer.length) return null;
  const chunk = buffer.subarray(offset, offset + 10);
  const info = decodeItemBytes(chunk);
  if (info.empty) return null;

  const def = defMap.get(`${info.section}:${info.index}`);
  const bagSlot = slot - equipCount;
  const isEquip = slot < equipCount;

  const item = {
    slot,
    equip: isEquip,
    bagSlot,
    x: isEquip ? 0 : (bagSlot % 8),
    y: isEquip ? 0 : Math.floor(bagSlot / 8),
    section: info.section,
    index: info.index,
    name: def ? def.name : `Item ${info.section}:${info.index}`,
    width: def && def.width > 0 ? def.width : 1,
    height: def && def.height > 0 ? def.height : 1,
    level: (chunk[1] / 8) & 15,
    durability: chunk[2],
    skill: (chunk[1] / 128) & 1 ? 1 : 0,
    luck: (chunk[1] / 4) & 1 ? 1 : 0,
    add: (chunk[1] & 3) + ((chunk[7] & 64) / 16),
    excellent: chunk[7] & 63,
    serial: info.serial
  };
  item.title = buildItemTitle(item);
  return item;
}

function decodeProfileItems(buffer, totalSlots, equipCount = 0) {
  const { map } = getItemDefs();
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || Buffer.alloc(totalSlots * 10, 0xff));
  const items = [];
  for (let slot = 0; slot < totalSlots; slot++) {
    const item = decodeProfileItem(buf, slot, equipCount, map);
    if (item) items.push(item);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Cash (moeda premium) + Cash Shop
// ---------------------------------------------------------------------------
const SHOP_SECTIONS = [
  'Espadas', 'Machados', 'Maças', 'Lanças', 'Arcos e Bestas',
  'Cajados', 'Escudos', 'Elmos', 'Armaduras', 'Calças',
  'Luvas', 'Botas', 'Asas e Extras', 'Pets, Anéis e Pingentes',
  'Joias e Consumíveis', 'Pergaminhos'
];

// Itens especiais: joias, asas, orbs, pets/acessorios e itens de evento.
// Ficam agrupados numa secao propria em vez de misturados com o equipamento.
const SHOP_SPECIAL_REFS = [
  // Joias
  [12, 15], [14, 13], [14, 14], [14, 16], [14, 22], [14, 26],
  // Asas (nivel 1, 2 e 3)
  [12, 0], [12, 1], [12, 2], [12, 3], [12, 4], [12, 5], [12, 6],
  // Orbs (skills)
  [12, 7], [12, 8], [12, 9], [12, 10], [12, 11], [12, 12], [12, 13], [12, 14],
  [12, 16], [12, 17], [12, 18], [12, 19],
  // Pets, aneis e pingentes
  [13, 0], [13, 1], [13, 2], [13, 3], [13, 8], [13, 9], [13, 10], [13, 12], [13, 13],
  // Itens especiais / de evento
  [13, 14], [13, 15], [13, 16], [13, 17], [13, 18], [13, 19],
  [14, 11], [14, 12], [14, 17], [14, 18], [14, 19], [14, 20], [14, 21],
  [14, 23], [14, 24], [14, 25]
];

const SHOP_SPECIAL_TITLE = 'Itens Especiais';

const SHOP_ITEM_PRICE = 1000;      // preço padrão em Cash (full +15)
const SHOP_ITEM_LEVEL = 15;        // +15
const SHOP_ITEM_ADD = 7;           // +28 de opção
const SHOP_ITEM_EXCELLENT = 0x3f;  // excellent completo

const SHOP_KIT_PRICE = 6000;              // preco do kit completo (7 itens full +15)
const SHOP_SET_PARTS = [7, 8, 9, 10, 11]; // elmo, armadura, calca, luvas, botas

// Kits completos por classe: conjunto + arma + asas, todos full +15
const SHOP_KITS = [
  {
    id: 'dk',
    classId: 16,
    name: 'Kit Dark Knight / Blade Knight',
    weapon: { section: 0, index: 20 },  // Knight Blade
    setIndex: 16,                        // conjunto Black Dragon
    wings: { section: 12, index: 5 }     // Wings of Dragon
  },
  {
    id: 'gd',
    classId: 16,
    name: 'Kit Great Dragon (Dark Knight)',
    weapon: { section: 0, index: 20 },  // Knight Blade
    setIndex: 21,                        // conjunto Great Dragon
    wings: { section: 12, index: 5 }     // Wings of Dragon
  },
  {
    id: 'dw',
    classId: 0,
    name: 'Kit Dark Wizard / Soul Master',
    weapon: { section: 5, index: 9 },   // Dragon Soul Staff
    setIndex: 18,                        // conjunto Grand Soul
    wings: { section: 12, index: 4 }     // Wings of Soul
  },
  {
    id: 'elf',
    classId: 32,
    name: 'Kit Fairy Elf / Muse Elf',
    weapon: { section: 4, index: 17 },  // Celestial Bow
    setIndex: 19,                        // conjunto Divine
    wings: { section: 12, index: 3 }     // Wings of Spirits
  },
  {
    id: 'mg',
    classId: 48,
    name: 'Kit Magic Gladiator',
    weapon: { section: 0, index: 31 },  // Rune Blade
    setIndex: 20,                        // conjunto Thunder Hawk
    setParts: [8, 9, 10, 11],            // sem elmo: o MG nao tem elmo disponivel na base
    wings: { section: 12, index: 6 }     // Wings of Darkness
  }
];

async function getCash(accountId) {
  const [rows] = await pool.query('SELECT cash FROM web_cash WHERE account_id = ? LIMIT 1', [accountId]);
  return rows.length ? Number(rows[0].cash) || 0 : 0;
}

async function setCash(accountId, amount) {
  const value = Math.max(0, Math.min(2000000000, Math.trunc(Number(amount) || 0)));
  await pool.query(
    `INSERT INTO web_cash (account_id, cash) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE cash = VALUES(cash)`,
    [accountId, value]
  );
  return value;
}

async function addCash(accountId, delta) {
  const value = Math.trunc(Number(delta) || 0);
  await pool.query(
    `INSERT INTO web_cash (account_id, cash) VALUES (?, GREATEST(0, ?))
     ON DUPLICATE KEY UPDATE cash = GREATEST(0, cash + ?)`,
    [accountId, value, value]
  );
}

function buildFullShopItem(section, index, def) {
  const itemIndex = section * 32 + index;
  const bytes = Buffer.alloc(10, 0xff);
  const level = SHOP_ITEM_LEVEL & 0x0f;
  const skill = def && def.skill ? 1 : 0;
  const add = SHOP_ITEM_ADD;

  bytes[0] = itemIndex & 0xff;
  bytes[1] = level * 8;
  if (skill) bytes[1] |= 0x80;
  bytes[1] |= 0x04;              // luck
  bytes[1] |= add & 3;
  bytes[2] = 255;                // durabilidade máxima
  bytes[3] = 0; bytes[4] = 0; bytes[5] = 0; bytes[6] = 0;  // serial (gerado depois)
  bytes[7] = 0;
  if (itemIndex & 0x100) bytes[7] |= 0x80;
  if (add > 3) bytes[7] |= 0x40;
  bytes[7] |= SHOP_ITEM_EXCELLENT & 0x3f;
  bytes[8] = 0;
  bytes[9] = ((itemIndex >> 9) & 0x0f) << 4;
  return bytes;
}

const WAREHOUSE_COLS = 8;
const WAREHOUSE_ROWS = 15;
const WAREHOUSE_CELLS = WAREHOUSE_COLS * WAREHOUSE_ROWS; // 120

function itemFootprint(def) {
  return {
    w: Math.max(1, Number(def && def.width) || 1),
    h: Math.max(1, Number(def && def.height) || 1)
  };
}

// O bau guarda cada item apenas no slot de cima/esquerda; as demais celulas que o
// item ocupa sao VIRTUAIS (o cliente remonta esse mapa ao carregar o bau).
// Aqui a grade 8x15 real e reconstruida: cada celula aponta para o slot do item que
// a ocupa, ou null se estiver livre. Sem isso, o posicionamento acha que um elmo 2x2
// "cabe" em cima de uma asa 3x3 e os itens ficam sobrepostos no jogo.
function buildWarehouseCellMap(buffer) {
  const { map } = getItemDefs();
  const cells = new Array(WAREHOUSE_CELLS).fill(null);
  const mark = (slot, def) => {
    const { w, h } = itemFootprint(def);
    const x0 = slot % WAREHOUSE_COLS;
    const y0 = Math.floor(slot / WAREHOUSE_COLS);
    cells[slot] = slot;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const x = x0 + dx;
        const y = y0 + dy;
        if (x >= WAREHOUSE_COLS || y >= WAREHOUSE_ROWS) continue;
        cells[y * WAREHOUSE_COLS + x] = slot;
      }
    }
  };

  for (let slot = 0; slot < WAREHOUSE_CELLS; slot++) {
    const chunk = buffer.subarray(slot * 10, slot * 10 + 10);
    if (chunk.length < 10 || isEmptyItem(chunk)) continue;
    const item = decodeItemBytes(chunk);
    mark(slot, map.get(`${item.section}:${item.index}`));
  }
  return cells;
}

function findFreeWarehouseSlot(cells, width, height) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  if (w > WAREHOUSE_COLS || h > WAREHOUSE_ROWS) return -1;
  for (let y = 0; y <= WAREHOUSE_ROWS - h; y++) {
    for (let x = 0; x <= WAREHOUSE_COLS - w; x++) {
      let free = true;
      for (let dy = 0; dy < h && free; dy++) {
        for (let dx = 0; dx < w; dx++) {
          if (cells[(y + dy) * WAREHOUSE_COLS + (x + dx)] !== null) {
            free = false;
            break;
          }
        }
      }
      if (free) return y * WAREHOUSE_COLS + x;
    }
  }
  return -1;
}

function occupyCells(cells, slot, width, height) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const x0 = slot % WAREHOUSE_COLS;
  const y0 = Math.floor(slot / WAREHOUSE_COLS);
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const x = x0 + dx;
      const y = y0 + dy;
      if (x >= WAREHOUSE_COLS || y >= WAREHOUSE_ROWS) continue;
      cells[y * WAREHOUSE_COLS + x] = slot;
    }
  }
}

async function loadWarehouseBuffer(accountId) {
  const [rows] = await pool.query('SELECT Items FROM warehouse WHERE AccountID = ? LIMIT 1', [accountId]);
  let buffer = rows.length && rows[0].Items ? Buffer.from(rows[0].Items) : Buffer.alloc(1200, 0xff);
  if (buffer.length < 1200) {
    const padded = Buffer.alloc(1200, 0xff);
    buffer.copy(padded, 0, 0, Math.min(buffer.length, 1200));
    buffer = padded;
  }
  return buffer;
}

function countFreeWarehouseSlots(buffer) {
  const cells = buildWarehouseCellMap(buffer);
  let free = 0;
  for (const cell of cells) {
    if (cell === null) free++;
  }
  return free;
}

// Itens do bau que estao sobrepostos (bug antigo de posicionamento) ou fora da grade.
// Serve para avisar o jogador e para o reparo.
function findWarehouseConflicts(buffer) {
  const { map } = getItemDefs();
  const cells = new Array(WAREHOUSE_CELLS).fill(-2);
  const conflicts = [];
  for (let slot = 0; slot < WAREHOUSE_CELLS; slot++) {
    const chunk = buffer.subarray(slot * 10, slot * 10 + 10);
    if (chunk.length < 10 || isEmptyItem(chunk)) continue;
    const item = decodeItemBytes(chunk);
    const def = map.get(`${item.section}:${item.index}`);
    const { w, h } = itemFootprint(def);
    const x0 = slot % WAREHOUSE_COLS;
    const y0 = Math.floor(slot / WAREHOUSE_COLS);
    let bad = false;
    if (x0 + w > WAREHOUSE_COLS || y0 + h > WAREHOUSE_ROWS) bad = true;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const x = x0 + dx;
        const y = y0 + dy;
        if (x >= WAREHOUSE_COLS || y >= WAREHOUSE_ROWS) continue;
        const at = y * WAREHOUSE_COLS + x;
        if (cells[at] !== -2 && cells[at] !== slot) bad = true;
        cells[at] = slot;
      }
    }
    if (bad) conflicts.push({ slot, section: item.section, index: item.index, name: def ? def.name : `${item.section}:${item.index}` });
  }
  return conflicts;
}

// Simula a entrega (sem gravar nada) para saber se TODOS os itens cabem no bau.
// Coloca os maiores primeiro, o que melhora bastante o encaixe.
function planWarehousePlacement(buffer, items) {
  const work = Buffer.from(buffer);
  const cells = buildWarehouseCellMap(work);
  const order = items
    .map((item) => item)
    .sort((a, b) => (b.width * b.height) - (a.width * a.height));

  const placed = [];
  for (const item of order) {
    const slot = findFreeWarehouseSlot(cells, item.width, item.height);
    if (slot < 0) {
      return { ok: false, placed: [], missing: item.name, needed: items.length };
    }
    buildFullShopItem(item.section, item.index, item).copy(work, slot * 10);
    occupyCells(cells, slot, item.width, item.height);
    placed.push({ item, slot });
  }

  placed.sort((a, b) => a.slot - b.slot);
  return { ok: true, placed, missing: null, needed: items.length };
}

// Reorganiza o bau usando o tamanho real de cada item, preservando os bytes
// originais (serial, nivel, opcoes). Corrige baus que ficaram com itens sobrepostos.
function repackWarehouse(buffer) {
  const { map } = getItemDefs();
  const items = [];
  for (let slot = 0; slot < WAREHOUSE_CELLS; slot++) {
    const chunk = buffer.subarray(slot * 10, slot * 10 + 10);
    if (chunk.length < 10 || isEmptyItem(chunk)) continue;
    const item = decodeItemBytes(chunk);
    const def = map.get(`${item.section}:${item.index}`);
    const { w, h } = itemFootprint(def);
    items.push({
      section: item.section,
      index: item.index,
      name: def ? def.name : `${item.section}:${item.index}`,
      width: w,
      height: h,
      bytes: Buffer.from(chunk)
    });
  }

  const work = Buffer.alloc(WAREHOUSE_CELLS * 10, 0xff);
  const cells = buildWarehouseCellMap(work);
  const placed = [];
  const failed = [];
  const order = items.slice().sort((a, b) => (b.width * b.height) - (a.width * a.height));
  for (const item of order) {
    const slot = findFreeWarehouseSlot(cells, item.width, item.height);
    if (slot < 0) {
      failed.push(item);
      continue;
    }
    item.bytes.copy(work, slot * 10);
    occupyCells(cells, slot, item.width, item.height);
    placed.push({ item, slot });
  }
  placed.sort((a, b) => a.slot - b.slot);
  return { buffer: work, placed, failed, total: items.length };
}

// Se o bau tiver itens sobrepostos (bug antigo de posicionamento), reorganiza antes
// de mexer nele. Assim qualquer compra tambem conserta baus ja corrompidos.
function healWarehouseBuffer(buffer) {
  if (findWarehouseConflicts(buffer).length === 0) return buffer;
  const repacked = repackWarehouse(buffer);
  if (repacked.failed.length > 0) return buffer;
  return repacked.buffer;
}

// Entrega uma lista de itens de uma vez; valida tudo antes de gravar.
async function deliverItemsToWarehouse(accountId, items) {
  if (!items || items.length === 0) {
    return { ok: false, error: 'Nenhum item para entregar.' };
  }

  const buffer = healWarehouseBuffer(await loadWarehouseBuffer(accountId));
  const plan = planWarehousePlacement(buffer, items);
  if (!plan.ok) {
    const free = countFreeWarehouseSlots(buffer);
    return {
      ok: false,
      error: `Espaço insuficiente no baú: "${plan.missing}" não encaixa. São ${plan.needed} itens e você tem ${free} espaços livres. Libere espaço e tente novamente.`
    };
  }

  for (const entry of plan.placed) {
    buildFullShopItem(entry.item.section, entry.item.index, entry.item).copy(buffer, entry.slot * 10);
  }

  await applySerialsIfNeeded(buffer);

  await pool.query(
    `INSERT INTO warehouse (AccountID, Items, Money, pw) VALUES (?, ?, 0, 0)
     ON DUPLICATE KEY UPDATE Items = VALUES(Items)`,
    [accountId, buffer]
  );
  return { ok: true, slots: plan.placed.map((entry) => entry.slot) };
}

// Valida (sem gravar) se a compra cabe no bau. Usado antes de cobrar o Cash.
async function checkWarehouseSpace(accountId, items) {
  const buffer = healWarehouseBuffer(await loadWarehouseBuffer(accountId));
  const plan = planWarehousePlacement(buffer, items);
  return {
    ok: plan.ok,
    missing: plan.missing,
    needed: plan.needed,
    freeSlots: countFreeWarehouseSlots(buffer)
  };
}

function getShopKits() {
  const { map } = getItemDefs();
  return SHOP_KITS.map((kit) => {
    const refs = [
      kit.weapon,
      ...(kit.setParts || SHOP_SET_PARTS).map((section) => ({ section, index: kit.setIndex })),
      kit.wings
    ];

    const items = [];
    for (const ref of refs) {
      const def = map.get(`${ref.section}:${ref.index}`);
      if (!def) continue;
      items.push({
        section: ref.section,
        index: ref.index,
        name: def.name,
        width: def.width,
        height: def.height,
        skill: def.skill || 0
      });
    }

    return {
      id: kit.id,
      name: kit.name,
      className: getClassName(kit.classId),
      icon: getClassIcon(kit.classId),
      price: SHOP_KIT_PRICE,
      items
    };
  }).filter((kit) => kit.items.length > 0);
}

function getShopCatalog() {
  const { defs, map } = getItemDefs();
  const specialKeys = new Set(SHOP_SPECIAL_REFS.map(([s, i]) => `${s}:${i}`));

  const grouped = new Map();
  for (const def of defs) {
    if (!def || !def.name) continue;
    if (specialKeys.has(`${def.section}:${def.index}`)) continue; // vai para "Itens Especiais"
    if (!grouped.has(def.section)) grouped.set(def.section, []);
    grouped.get(def.section).push({
      section: def.section,
      index: def.index,
      name: def.name,
      width: def.width,
      height: def.height,
      skill: def.skill || 0,
      price: SHOP_ITEM_PRICE
    });
  }

  const catalog = [];

  // Secao de itens especiais (sempre primeiro)
  const specialItems = [];
  for (const [s, i] of SHOP_SPECIAL_REFS) {
    const def = map.get(`${s}:${i}`);
    if (!def || !def.name) continue;
    specialItems.push({
      section: s,
      index: i,
      name: def.name,
      width: def.width,
      height: def.height,
      skill: def.skill || 0,
      price: SHOP_ITEM_PRICE
    });
  }
  if (specialItems.length) {
    catalog.push({
      section: 'special',
      title: SHOP_SPECIAL_TITLE,
      special: true,
      items: specialItems
    });
  }

  for (const [section, items] of [...grouped.entries()].sort((a, b) => a[0] - b[0])) {
    catalog.push({
      section,
      title: SHOP_SECTIONS[section] || `Seção ${section}`,
      items: items.sort((a, b) => a.index - b.index)
    });
  }
  return catalog;
}

app.get('/shop', requireUser, async (req, res) => {
  const accountId = req.session.user.id;
  const cash = await getCash(accountId);
  const catalog = getShopCatalog();

  const rawBuffer = await loadWarehouseBuffer(accountId);
  const conflicts = findWarehouseConflicts(rawBuffer).length;
  const buffer = healWarehouseBuffer(rawBuffer);
  const freeSlots = countFreeWarehouseSlots(buffer);
  const kits = getShopKits().map((kit) => ({
    ...kit,
    fits: planWarehousePlacement(buffer, kit.items).ok
  }));

  const notice = req.query.ok ? { type: 'success', text: decodeURIComponent(String(req.query.ok)) } : null;
  const error = req.query.err ? { type: 'danger', text: decodeURIComponent(String(req.query.err)) } : null;
  res.render('shop', {
    catalog,
    kits,
    cash,
    freeSlots,
    warehouseConflicts: conflicts,
    warehouseSlots: 120,
    itemPrice: SHOP_ITEM_PRICE,
    kitPrice: SHOP_KIT_PRICE,
    notice,
    error,
    page: 'shop',
    pageTitle: 'Bloodlust - Cash Shop'
  });
});

app.post('/shop/buy', requireUser, async (req, res) => {
  const accountId = req.session.user.id;
  if (!(await ensureAccountOffline(accountId))) {
    return res.redirect('/shop?err=' + encodeURIComponent('Saia do jogo para comprar: com o personagem online o servidor salva o bau por cima e o item seria perdido.'));
  }
  const section = Number(req.body.section);
  const index = Number(req.body.index);

  if (!Number.isInteger(section) || !Number.isInteger(index) || section < 0 || index < 0) {
    return res.redirect('/shop?err=' + encodeURIComponent('Item inválido.'));
  }

  const { map } = getItemDefs();
  const def = map.get(`${section}:${index}`);
  if (!def) {
    return res.redirect('/shop?err=' + encodeURIComponent('Item não encontrado.'));
  }

  const item = {
    section,
    index,
    name: def.name,
    width: def.width,
    height: def.height,
    skill: def.skill || 0
  };

  // Valida se o item cabe no bau ANTES de descontar o Cash
  const space = await checkWarehouseSpace(accountId, [item]);
  if (!space.ok) {
    return res.redirect('/shop?err=' + encodeURIComponent(
      `Sem espaço no baú para "${def.name}". Você tem ${space.freeSlots} espaços livres. Libere espaço e tente novamente.`
    ));
  }

  const price = SHOP_ITEM_PRICE;
  const [debit] = await pool.query(
    'UPDATE web_cash SET cash = cash - ? WHERE account_id = ? AND cash >= ?',
    [price, accountId, price]
  );
  if (!debit || debit.affectedRows === 0) {
    const cash = await getCash(accountId);
    return res.redirect('/shop?err=' + encodeURIComponent(`Cash insuficiente. Você tem ${cash} Cash e o item custa ${price}.`));
  }

  const delivered = await deliverItemsToWarehouse(accountId, [item]);
  if (!delivered.ok) {
    await addCash(accountId, price); // devolve o Cash
    return res.redirect('/shop?err=' + encodeURIComponent(delivered.error || 'Não foi possível entregar o item.'));
  }

  return res.redirect('/shop?ok=' + encodeURIComponent(`Comprado: ${def.name} +15 completo. Entregue no baú (slot ${delivered.slots[0]}).`));
});

app.post('/shop/kit/buy', requireUser, async (req, res) => {
  const accountId = req.session.user.id;
  if (!(await ensureAccountOffline(accountId))) {
    return res.redirect('/shop?err=' + encodeURIComponent('Saia do jogo para comprar: com o personagem online o servidor salva o bau por cima e o item seria perdido.'));
  }
  const kitId = String(req.body.kit || '').trim();

  const kit = getShopKits().find((item) => item.id === kitId);
  if (!kit) {
    return res.redirect('/shop?err=' + encodeURIComponent('Kit inválido.'));
  }

  // Valida se TODOS os itens do kit encaixam no bau ANTES de descontar o Cash
  const space = await checkWarehouseSpace(accountId, kit.items);
  if (!space.ok) {
    return res.redirect('/shop?err=' + encodeURIComponent(
      `Sem espaço no baú para o ${kit.name}: "${space.missing}" não encaixa. O kit tem ${kit.items.length} itens e você tem ${space.freeSlots} espaços livres. Libere espaço e tente novamente.`
    ));
  }

  const price = kit.price;
  const [debit] = await pool.query(
    'UPDATE web_cash SET cash = cash - ? WHERE account_id = ? AND cash >= ?',
    [price, accountId, price]
  );
  if (!debit || debit.affectedRows === 0) {
    const cash = await getCash(accountId);
    return res.redirect('/shop?err=' + encodeURIComponent(`Cash insuficiente. Você tem ${cash} Cash e o kit custa ${price}.`));
  }

  const delivered = await deliverItemsToWarehouse(accountId, kit.items);
  if (!delivered.ok) {
    await addCash(accountId, price); // devolve o Cash
    return res.redirect('/shop?err=' + encodeURIComponent(delivered.error || 'Não foi possível entregar o kit.'));
  }

  return res.redirect('/shop?ok=' + encodeURIComponent(`Kit comprado: ${kit.name} (${kit.items.length} itens +15 entregues no baú).`));
});

app.get('/account/character/:name', requireUser, async (req, res) => {
  const accountId = req.session.user.id;
  const charName = String(req.params.name || '');

  const [rows] = await pool.query(
    'SELECT Name, cLevel, Class, MapNumber, MapPosX, MapPosY, Strength, Dexterity, Vitality, Energy, Money, PkLevel, ResetCount, GrandResetCount, Life, Mana, Inventory FROM `Character` WHERE AccountID = ? AND Name = ? LIMIT 1',
    [accountId, charName]
  );
  if (rows.length === 0) {
    return res.redirect('/account?err=' + encodeURIComponent('Personagem não encontrado.'));
  }
  const character = rows[0];

  const [whRows] = await pool.query('SELECT Money, Items FROM warehouse WHERE AccountID = ? LIMIT 1', [accountId]);
  const warehouse = whRows[0] || null;

  const invBuffer = character.Inventory || Buffer.alloc(760, 0xff);
  const allInventory = decodeProfileItems(invBuffer, 76, 12);
  const equipmentBySlot = PROFILE_EQUIP_LABELS.map((_, idx) => allInventory.find((it) => it.slot === idx) || null);
  const inventory = allInventory.filter((it) => !it.equip);
  const warehouseItems = decodeProfileItems(warehouse ? warehouse.Items : null, 120, 0);
  const warehouseMoney = warehouse ? (warehouse.Money ?? 0) : 0;

  const [statRows] = await pool.query('SELECT ConnectStat FROM MEMB_STAT WHERE memb___id = ? LIMIT 1', [accountId]);
  const online = statRows[0] ? statRows[0].ConnectStat === 1 : false;

  res.render('character_profile', {
    character: {
      ...character,
      ClassName: getClassName(character.Class),
      ClassIcon: getClassIcon(character.Class),
      MapName: getMapName(character.MapNumber)
    },
    equipmentBySlot,
    equipLabels: PROFILE_EQUIP_LABELS,
    inventory,
    warehouseItems,
    warehouseMoney,
    online,
    page: 'account',
    pageTitle: `Bloodlust - ${character.Name}`
  });
});

async function ensureAccountOffline(accountId) {
  const [rows] = await pool.query(
    'SELECT ConnectStat FROM MEMB_STAT WHERE memb___id = ? LIMIT 1',
    [accountId]
  );
  return rows[0]?.ConnectStat !== 1;
}

const ACTION_COOLDOWN_MINUTES = 30;

async function checkCooldown(accountId, charName, action, cooldownMinutes = ACTION_COOLDOWN_MINUTES) {
  const [rows] = await pool.query(
    'SELECT last_used FROM web_character_actions WHERE account_id = ? AND character_name = ? AND action = ? LIMIT 1',
    [accountId, charName, action]
  );
  if (rows.length === 0) {
    return { ok: true };
  }
  const lastUsed = new Date(rows[0].last_used);
  const diffSeconds = Math.floor((Date.now() - lastUsed.getTime()) / 1000);
  const cooldownSeconds = cooldownMinutes * 60;
  if (diffSeconds < 0) {
    return { ok: false, remainingSeconds: cooldownSeconds };
  }
  if (diffSeconds >= cooldownSeconds) {
    return { ok: true };
  }
  return { ok: false, remainingSeconds: cooldownSeconds - diffSeconds };
}

async function touchCooldown(accountId, charName, action) {
  await pool.query(
    'INSERT INTO web_character_actions (account_id, character_name, action, last_used) VALUES (?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE last_used = NOW()',
    [accountId, charName, action]
  );
}

function formatCooldown(seconds) {
  const mins = Math.ceil(seconds / 60);
  return `Aguarde ${mins} minuto(s) para usar esta ação novamente.`;
}

app.post('/account/character/:name/clear-inventory', requireUser, async (req, res) => {
  const accountId = req.session.user.id;
  const charName = String(req.params.name || '');
  const offline = await ensureAccountOffline(accountId);
  if (!offline) return res.redirect('/account?err=A conta está online. Desconecte-se para continuar.');

  const [rows] = await pool.query(
    'SELECT Name FROM `Character` WHERE AccountID = ? AND Name = ? LIMIT 1',
    [accountId, charName]
  );
  if (rows.length === 0) return res.redirect('/account?err=Personagem não encontrado.');

  const cd = await checkCooldown(accountId, charName, 'clear_inventory');
  if (!cd.ok) return res.redirect(`/account?err=${encodeURIComponent(formatCooldown(cd.remainingSeconds))}`);

  const emptyInv = Buffer.alloc(760, 0xFF);
  const [result] = await pool.query(
    'UPDATE `Character` SET Inventory = ? WHERE AccountID = ? AND Name = ?',
    [emptyInv, accountId, charName]
  );
  if (!result || result.affectedRows === 0) {
    return res.redirect('/account?err=Não foi possível limpar o inventário. Tente novamente.');
  }
  await touchCooldown(accountId, charName, 'clear_inventory');
  return res.redirect(`/account?ok=Inventário de ${encodeURIComponent(charName)} limpo. Cooldown: ${ACTION_COOLDOWN_MINUTES} min.`);
});

app.post('/account/character/:name/move-home', requireUser, async (req, res) => {
  const accountId = req.session.user.id;
  const charName = String(req.params.name || '');
  const offline = await ensureAccountOffline(accountId);
  if (!offline) return res.redirect('/account?err=A conta está online. Desconecte-se para continuar.');

  const [rows] = await pool.query(
    'SELECT Name, Class FROM `Character` WHERE AccountID = ? AND Name = ? LIMIT 1',
    [accountId, charName]
  );
  if (rows.length === 0) return res.redirect('/account?err=Personagem não encontrado.');

  const cd = await checkCooldown(accountId, charName, 'move_home');
  if (!cd.ok) return res.redirect(`/account?err=${encodeURIComponent(formatCooldown(cd.remainingSeconds))}`);

  const classId = Number(rows[0].Class);
  const isElf = classId === 32 || classId === 33 || classId === 34;
  const target = isElf
    ? { map: 3, x: 174, y: 112 }
    : { map: 0, x: 137, y: 124 };

  const [result] = await pool.query(
    'UPDATE `Character` SET MapNumber = ?, MapPosX = ?, MapPosY = ? WHERE AccountID = ? AND Name = ?',
    [target.map, target.x, target.y, accountId, charName]
  );
  if (!result || result.affectedRows === 0) {
    return res.redirect('/account?err=Não foi possível mover o personagem. Tente novamente.');
  }
  await touchCooldown(accountId, charName, 'move_home');
  return res.redirect(`/account?ok=Personagem ${encodeURIComponent(charName)} movido para zona segura. Cooldown: ${ACTION_COOLDOWN_MINUTES} min.`);
});

app.get('/rankings', async (req, res) => {
  const type = String(req.query.type || 'level').toLowerCase();
  let classFilter = String(req.query.class || '');
  const validTypes = new Set(['level', 'resets', 'gr', 'class', 'guilds']);
  const selectedType = validTypes.has(type) ? type : 'level';

  const classOptions = [
    { value: '', label: 'Todas' },
    ...ACTIVE_CLASSES.map((id) => ({
      value: String(id),
      label: CLASS_NAMES[id] || `Classe ${id}`
    }))
  ];

  if (selectedType === 'guilds') {
    const [rows] = await pool.query(
      `SELECT G.G_Name AS GuildName,
              G.G_Score AS GuildScore,
              G.G_Master AS GuildMaster,
              COUNT(M.Name) AS Members
       FROM Guild G
       LEFT JOIN GuildMember M ON M.G_Name = G.G_Name
       GROUP BY G.G_Name, G.G_Score, G.G_Master
       ORDER BY G.G_Score DESC, Members DESC, G.G_Name ASC
       LIMIT 100`
    );
    return res.render('rankings', {
      type: selectedType,
      classFilter,
      classOptions,
      rows,
      page: 'rankings',
      pageTitle: 'Bloodlust - Rankings'
    });
  }

  let orderBy = 'cLevel DESC, ResetCount DESC, GrandResetCount DESC, Experience DESC';
  if (selectedType === 'resets') {
    orderBy = 'ResetCount DESC, GrandResetCount DESC, cLevel DESC, Experience DESC';
  } else if (selectedType === 'gr') {
    orderBy = 'GrandResetCount DESC, ResetCount DESC, cLevel DESC, Experience DESC';
  }

  const params = [];
  let where = `WHERE Class IN (${ACTIVE_CLASSES.map(() => '?').join(',')})`;
  params.push(...ACTIVE_CLASSES);
  if (selectedType === 'class' && classFilter !== '') {
    const classId = Number(classFilter);
    if (!Number.isNaN(classId) && ACTIVE_CLASSES.includes(classId)) {
      where += ' AND Class = ?';
      params.push(classId);
    } else {
      classFilter = '';
    }
  }

  const [rows] = await pool.query(
    `SELECT Name, cLevel, ResetCount, GrandResetCount, Class
     FROM \`Character\`
     ${where}
     ORDER BY ${orderBy}
     LIMIT 100`,
    params
  );
  const viewRows = rows.map((row) => ({
    ...row,
    ClassName: getClassName(row.Class),
    ClassIcon: getClassIcon(row.Class)
  }));
  res.render('rankings', {
    type: selectedType,
    classFilter,
    classOptions,
    rows: viewRows,
    page: 'rankings',
    pageTitle: 'Bloodlust - Rankings'
  });
});

app.get('/download', (req, res) => {
  const downloads = loadDownloadsConfig();
  res.render('download', { page: 'download', pageTitle: 'Bloodlust - Downloads', downloads });
});

app.get('/news', async (req, res) => {
  const [newsRows] = await pool.query('SELECT id, title, body, body_is_html, hide_title, created_at FROM web_news WHERE published = 1 ORDER BY created_at DESC LIMIT 50');
  const news = newsRows.map((row) => ({
    ...row,
    excerpt: makeExcerpt(row.body)
  }));
  res.render('news', { news, page: 'news', pageTitle: 'Bloodlust - Notícias' });
});

app.get('/news/:id', async (req, res) => {
  const [rows] = await pool.query('SELECT id, title, body, body_is_html, hide_title, created_at FROM web_news WHERE published = 1 AND id = ? LIMIT 1', [req.params.id]);
  if (rows.length === 0) return res.redirect('/news');
  res.render('news_detail', { item: rows[0], page: 'news', pageTitle: `Bloodlust - ${rows[0].title}` });
});

app.get('/admin/login', (req, res) => {
  res.render('admin_login', { error: null });
});

app.get('/admin', (req, res) => {
  res.redirect('/admin/login');
});

app.post('/admin/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;
  const [rows] = await pool.query('SELECT id, username, password_hash, must_change_password FROM web_admin WHERE username = ? LIMIT 1', [username]);
  if (rows.length === 0) return res.render('admin_login', { error: 'Credenciais inválidas.' });

  const ok = await bcrypt.compare(password || '', rows[0].password_hash);
  if (!ok) return res.render('admin_login', { error: 'Credenciais inválidas.' });

  req.session.admin = {
    id: rows[0].id,
    username: rows[0].username,
    mustChange: rows[0].must_change_password === 1
  };

  if (req.session.admin.mustChange) return res.redirect('/admin/password');
  return res.redirect('/admin/news');
});

app.get('/admin/logout', (req, res) => {
  req.session.admin = null;
  res.redirect('/admin/login');
});

app.get('/admin/password', requireAdmin, (req, res) => {
  res.render('admin_password', { error: null });
});

app.post('/admin/password', requireAdmin, async (req, res) => {
  const { password, confirm } = req.body;
  if (!password || password.length < 8 || password !== confirm) {
    return res.render('admin_password', { error: 'Mínimo 8 caracteres e devem coincidir.' });
  }

  const hash = await bcrypt.hash(password, 10);
  await pool.query('UPDATE web_admin SET password_hash = ?, must_change_password = 0 WHERE id = ?', [hash, req.session.admin.id]);
  req.session.admin.mustChange = false;
  return res.redirect('/admin/news');
});

app.get('/admin/downloads', requireAdmin, requireAdminPasswordChange, (req, res) => {
  const notice = req.query.ok ? { type: 'success', text: decodeURIComponent(String(req.query.ok)) } : null;
  const error = req.query.err ? { type: 'danger', text: decodeURIComponent(String(req.query.err)) } : null;
  const config = loadDownloadsConfig();
  const files = listDownloadFiles();
  res.render('admin_downloads', { config, files, notice, error });
});

app.post('/admin/downloads', requireAdmin, requireAdminPasswordChange, (req, res) => {
  const rawClient = String(req.body.client_url || '').trim();
  const rawLauncher = String(req.body.launcher_url || '').trim();
  const rawPatch = String(req.body.patch_url || '').trim();
  const clientSubtitle = sanitizeDownloadText(req.body.client_subtitle);
  const launcherSubtitle = sanitizeDownloadText(req.body.launcher_subtitle);
  const patchSubtitle = sanitizeDownloadText(req.body.patch_subtitle);
  const clientUrl = sanitizeDownloadUrl(rawClient);
  const launcherUrl = sanitizeDownloadUrl(rawLauncher);
  const patchUrl = sanitizeDownloadUrl(rawPatch);

  if (rawClient && !clientUrl) {
    return res.redirect(`/admin/downloads?err=${encodeURIComponent('URL do cliente inválida. Use http(s):// ou um caminho /downloads/...')}`);
  }
  if (rawLauncher && !launcherUrl) {
    return res.redirect(`/admin/downloads?err=${encodeURIComponent('URL do launcher inválida. Use http(s):// ou um caminho /downloads/...')}`);
  }
  if (rawPatch && !patchUrl) {
    return res.redirect(`/admin/downloads?err=${encodeURIComponent('URL dos patches inválida. Use http(s):// ou um caminho /downloads/...')}`);
  }
  saveDownloadsConfig({ clientUrl, clientSubtitle, launcherUrl, launcherSubtitle, patchUrl, patchSubtitle });
  return res.redirect(`/admin/downloads?ok=${encodeURIComponent('Links de downloads atualizados.')}`);
});

app.get('/admin/accounts', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  const q = String(req.query.q || '').trim();
  const notice = req.query.ok ? { type: 'success', text: decodeURIComponent(String(req.query.ok)) } : null;
  const error = req.query.err ? { type: 'danger', text: decodeURIComponent(String(req.query.err)) } : null;
  const params = [];
  let where = '';
  if (q) {
    const like = `%${q}%`;
    where = 'WHERE I.memb___id LIKE ? OR I.memb_name LIKE ? OR I.mail_addr LIKE ?';
    params.push(like, like, like);
  }
  const [rows] = await pool.query(
    `SELECT I.memb___id, I.memb_name, I.mail_addr, I.AccountLevel, I.bloc_code, I.AccountExpireDate, S.ConnectStat
     FROM MEMB_INFO I
     LEFT JOIN MEMB_STAT S ON S.memb___id = I.memb___id
     ${where}
     ORDER BY I.memb___id ASC
     LIMIT 100`,
    params
  );
  res.render('admin_accounts', { accounts: rows, q, notice, error });
});

app.get('/admin/server-editor', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_server_editor');
});

app.get('/admin/server-editor/shops', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_shop_editor');
});

app.get('/admin/server-editor/spawns', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_monsterset_editor');
});

app.get('/admin/server-editor/gates', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_gate_editor');
});

app.get('/admin/server-editor/moves', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_move_editor');
});

app.get('/admin/server-editor/mapmanager', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_mapmanager_editor');
});

app.get('/admin/server-editor/gms', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_gm_editor');
});

app.get('/admin/server-editor/notices', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_notice_editor');
});

app.get('/admin/server-editor/blacklist', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_blacklist_editor');
});

app.get('/admin/server-editor/rates', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_rates_editor');
});

app.get('/admin/server-editor/commands', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_config_editor', { title: 'CFG comandos', kind: 'command', reload: 'command' });
});

app.get('/admin/server-editor/skills', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_config_editor', { title: 'CFG skills', kind: 'skill', reload: 'skill' });
});

app.get('/admin/server-editor/events', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_config_editor', { title: 'CFG eventos', kind: 'event', reload: 'event' });
});

app.get('/admin/server-editor/chaosmix', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_config_editor', { title: 'CFG chaos mix', kind: 'chaosmix', reload: 'chaosmix' });
});

app.get('/admin/server-editor/startup', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_config_editor', { title: 'CFG inicial (StartUp)', kind: 'startup', reload: 'all' });
});

app.get('/admin/server-editor/character', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_config_editor', { title: 'CFG personagem', kind: 'character', reload: 'character' });
});

app.get('/admin/server-editor/bloodcastle', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_raw_editor', { title: 'CFG Blood Castle', kind: 'bloodcastle', reload: 'event', hint: 'Formato tabular: WarningTime, NotifyTime, EventTime, CloseTime (em minutos).' });
});

app.get('/admin/server-editor/devilsquare', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_raw_editor', { title: 'CFG Devil Square', kind: 'devilsquare', reload: 'event', hint: 'Formato tabular: horários e duração do evento (em minutos).' });
});

app.get('/admin/server-editor/invasion', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_raw_editor', { title: 'CFG invasões', kind: 'invasion', reload: 'event', hint: 'Formato tabular: Index, Year, Month, Day, DoW, Hour, Minute, Second. A primeira linha é o mapa.' });
});

app.get('/admin/server-editor/bonus', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_raw_editor', { title: 'CFG bônus', kind: 'bonus', reload: 'event', hint: 'Formato tabular: eventos de bônus (XP/zen extra).' });
});

app.get('/admin/server-editor/eventspawn', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_raw_editor', { title: 'CFG spawn de eventos', kind: 'eventspawn', reload: 'event', hint: 'Formato tabular: spawns de monstros de evento.' });
});

app.get('/admin/server-editor/goldenarcher', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_raw_editor', { title: 'CFG Golden Archer / Bingo', kind: 'goldenarcher', reload: 'event', hint: 'Formato tabular: configuração do evento do Arqueiro Dourado.' });
});

app.get('/admin/server-editor/message-eng', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_raw_editor', { title: 'Mensagens (Inglês)', kind: 'message_eng', reload: 'util', hint: 'Mensagens do servidor em inglês. Salve em ANSI/Windows-1252 sem BOM.' });
});

app.get('/admin/server-editor/message-spn', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_raw_editor', { title: 'Mensagens (Espanhol)', kind: 'message_spn', reload: 'util', hint: 'Mensagens do servidor em espanhol. Salve em ANSI/Windows-1252 sem BOM.' });
});

app.get('/admin/server-editor/message-por', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_raw_editor', { title: 'Mensagens (Português)', kind: 'message_por', reload: 'util', hint: 'Mensagens do servidor em português. Salve em ANSI/Windows-1252 sem BOM.' });
});

app.get('/admin/server-editor/shopmanager', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_raw_editor', { title: 'CFG ShopManager', kind: 'shopmanager', reload: 'shop', hint: 'Lista de lojas do servidor (ShopManager.txt).' });
});

app.get('/admin/server-editor/hackpacket', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_raw_editor', { title: 'CFG anti-hack (pacotes)', kind: 'hackpacket', reload: 'hack', hint: 'Checagem de pacotes do anti-hack (HackPacketCheck.txt).' });
});

app.get('/admin/server-editor/event-item-bag', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_event_item_bag_editor');
});

app.get('/admin/server-editor/customs', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_custom_editor');
});

app.get('/admin/server-editor/monsters', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_monster_editor');
});

app.get('/admin/server-editor/items', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_items_editor');
});

app.get('/admin/server-editor/reset-exp', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_reset_exp_editor');
});

app.get('/admin/server-editor/drop', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_drop_editor');
});

app.get('/admin/server-editor/api/status', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.json({ enabled: false });
  }
  try {
    const data = await editorRequest('GET', '/api/status');
    return res.json({ enabled: true, ...data });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.get('/admin/server-editor/api/backups', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const data = await editorRequest('GET', '/api/backup/list');
    return res.json(data);
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/admin/server-editor/api/backups/create', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const data = await editorRequest('POST', '/api/backup/create', { label: req.body?.label });
    return res.json(data);
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/admin/server-editor/api/backups/restore', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const data = await editorRequest('POST', '/api/backup/restore', { name: req.body?.name });
    return res.json(data);
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

function normalizeShopFileName(value) {
  const name = String(value || '').trim();
  if (!name) return null;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  return name;
}

function normalizeEventBagFileName(value) {
  const name = String(value || '').trim();
  if (!name) return null;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  if (!name.toLowerCase().endsWith('.txt')) return null;
  return name;
}

app.get('/admin/server-editor/api/shops', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const data = await editorRequest('GET', `/api/list?path=${encodeURIComponent('Data/Shop')}`);
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const files = entries
      .filter((entry) => entry.type === 'file' && entry.name.toLowerCase().endsWith('.txt'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    return res.json({ files });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.get('/admin/server-editor/api/event-item-bag/list', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const data = await editorRequest('GET', `/api/list?path=${encodeURIComponent('Data/EventItemBag')}`);
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const files = entries
      .filter((entry) => entry.type === 'file' && entry.name.toLowerCase().endsWith('.txt'))
      .map((entry) => entry.name)
      .sort();
    return res.json({ files });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.get('/admin/server-editor/api/event-item-bag/file', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const name = normalizeEventBagFileName(req.query.name);
    if (!name) {
      return res.status(400).json({ error: 'Nome inválido' });
    }
    const filePath = `Data/EventItemBag/${name}`;
    const data = await editorRequest('GET', `/api/file?path=${encodeURIComponent(filePath)}`);
    return res.json({ content: data.content || '' });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/admin/server-editor/api/event-item-bag/file', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const name = normalizeEventBagFileName(req.body?.name);
    if (!name) {
      return res.status(400).json({ error: 'Nome inválido' });
    }
    const content = String(req.body?.content ?? '');
    const filePath = `Data/EventItemBag/${name}`;
    const data = await editorRequest('POST', '/api/file', { path: filePath, content });
    return res.json({ ok: true, backups: data.backups || [] });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.get('/admin/server-editor/api/event-item-bag/manager', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const data = await editorRequest('GET', `/api/file?path=${encodeURIComponent('Data/EventItemBagManager.txt')}`);
    return res.json({ content: data.content || '' });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/admin/server-editor/api/event-item-bag/manager', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const content = String(req.body?.content ?? '');
    const data = await editorRequest('POST', '/api/file', {
      path: 'Data/EventItemBagManager.txt',
      content
    });
    return res.json({ ok: true, backups: data.backups || [] });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.get('/admin/server-editor/api/shops/file', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const name = normalizeShopFileName(req.query?.name);
    if (!name) {
      return res.status(400).json({ error: 'Nome de arquivo inválido.' });
    }
    const pathValue = `Data/Shop/${name}`;
    const data = await editorRequest('GET', `/api/file?path=${encodeURIComponent(pathValue)}`);
    return res.json({ name, content: data.content || '' });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/admin/server-editor/api/shops/file', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const name = normalizeShopFileName(req.body?.name);
    if (!name) {
      return res.status(400).json({ error: 'Nome de arquivo inválido.' });
    }
    const content = String(req.body?.content ?? '');
    const pathValue = `Data/Shop/${name}`;
    const data = await editorRequest('POST', '/api/file', {
      path: pathValue,
      content
    });
    return res.json({ ok: true, name, backups: data.backups || [] });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.get('/admin/server-editor/api/map-defs', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const data = await editorRequest('GET', `/api/file?path=${encodeURIComponent('Data/MapManager.txt')}`);
    const maps = parseMapManager(data.content || '');
    return res.json({ maps });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.get('/admin/server-editor/api/monster-defs', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const data = await editorRequest('GET', `/api/file?path=${encodeURIComponent('Data/Monster/Monster.txt')}`);
    const monsters = parseMonsterTxt(data.content || '');
    return res.json({ monsters });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.get('/admin/server-editor/api/monster-set', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const data = await editorRequest('GET', `/api/file?path=${encodeURIComponent('Data/Monster/MonsterSetBase.txt')}`);
    return res.json({ content: data.content || '' });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/admin/server-editor/api/monster-set', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const content = String(req.body?.content ?? '');
    const data = await editorRequest('POST', '/api/file', {
      path: 'Data/Monster/MonsterSetBase.txt',
      content
    });
    return res.json({ ok: true, backups: data.backups || [] });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.get('/admin/server-editor/api/terrain', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const map = Number(req.query?.map);
    if (Number.isNaN(map) || map < 0) {
      return res.status(400).json({ error: 'Mapa inválido.' });
    }
    const fileName = `Data/Terrain/Terrain${map + 1}.att`;
    const data = await editorRequest('GET', `/api/binary?path=${encodeURIComponent(fileName)}`);
    return res.json({ map, ...data });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.get('/admin/server-editor/api/gates', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const data = await editorRequest('GET', `/api/file?path=${encodeURIComponent('Data/Move/Gate.txt')}`);
    return res.json({ content: data.content || '' });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/admin/server-editor/api/gates', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const content = String(req.body?.content ?? '');
    const data = await editorRequest('POST', '/api/file', {
      path: 'Data/Move/Gate.txt',
      content
    });
    return res.json({ ok: true, backups: data.backups || [] });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.get('/admin/server-editor/api/moves', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const data = await editorRequest('GET', `/api/file?path=${encodeURIComponent('Data/Move/Move.txt')}`);
    return res.json({ content: data.content || '' });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/admin/server-editor/api/moves', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const content = String(req.body?.content ?? '');
    const data = await editorRequest('POST', '/api/file', {
      path: 'Data/Move/Move.txt',
      content
    });
    return res.json({ ok: true, backups: data.backups || [] });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.get('/admin/server-editor/api/mapmanager', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const data = await editorRequest('GET', `/api/file?path=${encodeURIComponent('Data/MapManager.txt')}`);
    return res.json({ content: data.content || '' });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/admin/server-editor/api/mapmanager', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const content = String(req.body?.content ?? '');
    const data = await editorRequest('POST', '/api/file', {
      path: 'Data/MapManager.txt',
      content
    });
    return res.json({ ok: true, backups: data.backups || [] });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.get('/admin/server-editor/api/gamemaster', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const data = await editorRequest('GET', `/api/file?path=${encodeURIComponent('Data/Util/GameMaster.txt')}`);
    return res.json({ content: data.content || '' });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/admin/server-editor/api/gamemaster', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const content = String(req.body?.content ?? '');
    const data = await editorRequest('POST', '/api/file', {
      path: 'Data/Util/GameMaster.txt',
      content
    });
    return res.json({ ok: true, backups: data.backups || [] });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.get('/admin/server-editor/api/notices', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const data = await editorRequest('GET', `/api/file?path=${encodeURIComponent('Data/Util/Notice.txt')}`);
    return res.json({ content: data.content || '' });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/admin/server-editor/api/notices', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const content = String(req.body?.content ?? '');
    const data = await editorRequest('POST', '/api/file', {
      path: 'Data/Util/Notice.txt',
      content
    });
    return res.json({ ok: true, backups: data.backups || [] });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.get('/admin/server-editor/api/blacklist', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const data = await editorRequest('GET', `/api/file?path=${encodeURIComponent('Data/Util/Blacklist.dat')}`);
    return res.json({ content: data.content || '' });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/admin/server-editor/api/blacklist', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const content = String(req.body?.content ?? '');
    const data = await editorRequest('POST', '/api/file', {
      path: 'Data/Util/Blacklist.dat',
      content
    });
    return res.json({ ok: true, backups: data.backups || [] });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.get('/admin/server-editor/api/common', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const data = await editorRequest('GET', `/api/file?path=${encodeURIComponent('GameServer/Data/GameServerInfo - Common.dat')}`);
    return res.json({ content: data.content || '' });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/admin/server-editor/api/common', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const content = String(req.body?.content ?? '');
    const data = await editorRequest('POST', '/api/file', {
      path: 'GameServer/Data/GameServerInfo - Common.dat',
      content
    });
    return res.json({ ok: true, backups: data.backups || [] });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

function getConfigFilePath(kind) {
  switch (String(kind || '').toLowerCase()) {
    case 'command':
      return 'GameServer/Data/GameServerInfo - Command.dat';
    case 'skill':
      return 'GameServer/Data/GameServerInfo - Skill.dat';
    case 'event':
      return 'GameServer/Data/GameServerInfo - Event.dat';
    case 'chaosmix':
      return 'GameServer/Data/GameServerInfo - ChaosMix.dat';
    case 'startup':
      return 'GameServer/Data/GameServerInfo - StartUp.dat';
    case 'character':
      return 'GameServer/Data/GameServerInfo - Character.dat';
    case 'bloodcastle':
      return 'Data/Event/BloodCastle.dat';
    case 'devilsquare':
      return 'Data/Event/DevilSquare.dat';
    case 'invasion':
      return 'Data/Event/InvasionManager.dat';
    case 'bonus':
      return 'Data/Event/BonusManager.dat';
    case 'eventspawn':
      return 'Data/Event/EventSpawnMonster.dat';
    case 'goldenarcher':
      return 'Data/Event/GoldenArcherBingo.dat';
    case 'message_eng':
      return 'Data/Message_Eng.txt';
    case 'message_spn':
      return 'Data/Message_Spn.txt';
    case 'message_por':
      return 'Data/Message_Por.txt';
    case 'shopmanager':
      return 'Data/ShopManager.txt';
    case 'hackpacket':
      return 'Data/Hack/HackPacketCheck.txt';
    default:
      return null;
  }
}

function getCustomFilePath(kind) {
  switch (String(kind || '').toLowerCase()) {
    case 'safezone':
      return 'Data/Custom/CustomSafeZone.txt';
    case 'pkfree':
      return 'Data/Custom/CustomPkFree.txt';
    case 'npcmove':
      return 'Data/Custom/CustomNpcMove.txt';
    default:
      return null;
  }
}

app.get('/admin/server-editor/api/config', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  const path = getConfigFilePath(req.query?.kind);
  if (!path) {
    return res.status(400).json({ error: 'Config inválida.' });
  }
  try {
    const data = await editorRequest('GET', `/api/file?path=${encodeURIComponent(path)}`);
    return res.json({ content: data.content || '' });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/admin/server-editor/api/config', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  const path = getConfigFilePath(req.query?.kind);
  if (!path) {
    return res.status(400).json({ error: 'Config inválida.' });
  }
  try {
    const content = String(req.body?.content ?? '');
    const data = await editorRequest('POST', '/api/file', { path, content });
    return res.json({ ok: true, backups: data.backups || [] });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.get('/admin/server-editor/api/custom', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const filePath = getCustomFilePath(req.query.kind);
    if (!filePath) {
      return res.status(400).json({ error: 'Tipo de custom inválido' });
    }
    const data = await editorRequest('GET', `/api/file?path=${encodeURIComponent(filePath)}`);
    return res.json({ content: data.content || '' });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/admin/server-editor/api/custom', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const filePath = getCustomFilePath(req.query.kind);
    if (!filePath) {
      return res.status(400).json({ error: 'Tipo de custom inválido' });
    }
    const content = String(req.body?.content ?? '');
    const data = await editorRequest('POST', '/api/file', {
      path: filePath,
      content
    });
    return res.json({ ok: true, backups: data.backups || [] });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.get('/admin/server-editor/api/monster-file', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const data = await editorRequest('GET', `/api/file?path=${encodeURIComponent('Data/Monster/Monster.txt')}`);
    return res.json({ content: data.content || '' });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/admin/server-editor/api/monster-file', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const content = String(req.body?.content ?? '');
    const data = await editorRequest('POST', '/api/file', {
      path: 'Data/Monster/Monster.txt',
      content
    });
    return res.json({ ok: true, backups: data.backups || [] });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

function getItemBasePath(kind) {
  switch (String(kind || '').toLowerCase()) {
    case 'item':
      return 'Data/Item/Item.txt';
    case 'value':
      return 'Data/Item/ItemValue.txt';
    case 'stack':
      return 'Data/Item/ItemStack.txt';
    default:
      return null;
  }
}

app.get('/admin/server-editor/api/items-base', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  const path = getItemBasePath(req.query?.kind);
  if (!path) {
    return res.status(400).json({ error: 'Tipo inválido.' });
  }
  try {
    const data = await editorRequest('GET', `/api/file?path=${encodeURIComponent(path)}`);
    return res.json({ content: data.content || '' });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/admin/server-editor/api/items-base', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  const path = getItemBasePath(req.query?.kind);
  if (!path) {
    return res.status(400).json({ error: 'Tipo inválido.' });
  }
  try {
    const content = String(req.body?.content ?? '');
    const data = await editorRequest('POST', '/api/file', { path, content });
    return res.json({ ok: true, backups: data.backups || [] });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.get('/admin/server-editor/api/drop', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const data = await editorRequest('GET', `/api/file?path=${encodeURIComponent('Data/Item/ItemDrop.txt')}`);
    return res.json({ content: data.content || '' });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/admin/server-editor/api/drop', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const content = String(req.body?.content ?? '');
    const data = await editorRequest('POST', '/api/file', {
      path: 'Data/Item/ItemDrop.txt',
      content
    });
    return res.json({ ok: true, backups: data.backups || [] });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.get('/admin/server-editor/api/item-option-rate', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const data = await editorRequest('GET', `/api/file?path=${encodeURIComponent('Data/Item/ItemOptionRate.txt')}`);
    return res.json({ content: data.content || '' });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

function getResetExpPath(kind) {
  switch (String(kind || '').toLowerCase()) {
    case 'reset':
      return 'Data/Util/ResetTable.txt';
    case 'experience':
      return 'Data/Util/ExperienceTable.txt';
    default:
      return null;
  }
}

app.get('/admin/server-editor/api/reset-exp', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  const path = getResetExpPath(req.query?.kind);
  if (!path) {
    return res.status(400).json({ error: 'Tipo inválido.' });
  }
  try {
    const data = await editorRequest('GET', `/api/file?path=${encodeURIComponent(path)}`);
    return res.json({ content: data.content || '' });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/admin/server-editor/api/reset-exp', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  const path = getResetExpPath(req.query?.kind);
  if (!path) {
    return res.status(400).json({ error: 'Tipo inválido.' });
  }
  try {
    const content = String(req.body?.content ?? '');
    const data = await editorRequest('POST', '/api/file', { path, content });
    return res.json({ ok: true, backups: data.backups || [] });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.get('/admin/server-editor/api/characters', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  const account = String(req.query?.account || '').trim();
  if (!account) {
    return res.status(400).json({ error: 'Conta necessária.' });
  }
  try {
    const [rows] = await pool.query(
      'SELECT Name FROM `Character` WHERE AccountID = ? ORDER BY Name ASC',
      [account]
    );
    const characters = rows.map((row) => row.Name);
    return res.json({ characters });
  } catch (err) {
    return res.status(500).json({ error: 'Não foi possível carregar os personagens.' });
  }
});

app.get('/admin/server-editor/api/accounts', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const q = String(req.query?.q || '').trim();
    let rows;
    if (q) {
      const like = `%${q}%`;
      [rows] = await pool.query(
        'SELECT memb___id FROM MEMB_INFO WHERE memb___id LIKE ? ORDER BY memb___id ASC LIMIT 200',
        [like]
      );
    } else {
      [rows] = await pool.query(
        'SELECT memb___id FROM MEMB_INFO ORDER BY memb___id ASC LIMIT 200'
      );
    }
    const accounts = rows.map((row) => row.memb___id);
    return res.json({ accounts });
  } catch (err) {
    return res.status(500).json({ error: 'Não foi possível carregar as contas.' });
  }
});

app.post('/admin/server-editor/api/reload', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  if (!editorEnabled) {
    return res.status(503).json({ error: 'Editor disabled' });
  }
  try {
    const target = String(req.body?.target || '').toLowerCase();
    const data = await editorRequest('POST', '/api/reload', { target });
    return res.json(data);
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

app.get('/admin/accounts/new', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_account_new', {
    error: null,
    form: {
      account: '',
      name: '',
      email: '',
      code: '',
      accountLevel: 0,
      accountExpire: '',
      blocked: false,
      blockExpire: ''
    }
  });
});

app.post('/admin/accounts/new', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  const account = String(req.body.account || '').trim();
  const password = String(req.body.password || '');
  const confirm = String(req.body.confirm || '');
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim();
  const code = String(req.body.code || '').trim();
  const accountLevelField = parseIntField(req.body.account_level, { min: 0, max: 3 });
  const blocked = req.body.blocked === '1' || req.body.blocked === 'on';
  const accountExpire = parseDateTimeInput(req.body.account_expire);
  const blockExpire = parseDateTimeInput(req.body.block_expire);

  const form = {
    account,
    name,
    email,
    code,
    accountLevel: accountLevelField.ok ? accountLevelField.value : 0,
    accountExpire: accountExpire.ok ? (accountExpire.value ? String(req.body.account_expire || '') : '') : String(req.body.account_expire || ''),
    blocked,
    blockExpire: blockExpire.ok ? (blockExpire.value ? String(req.body.block_expire || '') : '') : String(req.body.block_expire || '')
  };

  if (!validateAccountId(account)) {
    return res.render('admin_account_new', { error: 'O usuário deve ter 4-10 caracteres (letras, números ou _).', form });
  }
  if (!validatePassword(password) || password !== confirm) {
    return res.render('admin_account_new', { error: 'A senha deve ter 4-10 caracteres e coincidir.', form });
  }
  if (!validateName(name)) {
    return res.render('admin_account_new', { error: 'O nome deve ter 4-10 caracteres (letras, números ou _).', form });
  }
  if (!validateCode(code)) {
    return res.render('admin_account_new', { error: 'O código deve ter 18 números.', form });
  }
  if (!validateEmail(email)) {
    return res.render('admin_account_new', { error: 'O e-mail não é válido.', form });
  }
  if (!accountLevelField.ok) {
    return res.render('admin_account_new', { error: 'Account Level inválido (0-3).', form });
  }
  if (!accountExpire.ok) {
    return res.render('admin_account_new', { error: 'Data de expiração inválida.', form });
  }
  if (blocked && !blockExpire.ok) {
    return res.render('admin_account_new', { error: 'Data de bloqueio inválida.', form });
  }
  if (blocked && !blockExpire.value) {
    return res.render('admin_account_new', { error: 'Você deve indicar a data de bloqueio.', form });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [existing] = await conn.query('SELECT memb___id FROM MEMB_INFO WHERE memb___id = ? LIMIT 1', [account]);
    if (existing.length > 0) {
      await conn.rollback();
      return res.render('admin_account_new', { error: 'A conta já existe.', form });
    }

    const accountExpireValue = accountExpire.value ? accountExpire.value : new Date();
    const blockExpireValue = blocked ? blockExpire.value : '1900-01-01 00:00:00';

    await conn.query(
      `INSERT INTO MEMB_INFO
       (memb___id, memb__pwd, memb_name, mail_addr, sno__numb, AccountLevel, AccountExpireDate, bloc_code, Bloc_Expire)
       VALUES (?, UNHEX(MD5(?)), ?, ?, ?, ?, ?, ?, ?)`,
      [account, password, name, email || null, code, accountLevelField.value, accountExpireValue, blocked ? 1 : 0, blockExpireValue]
    );

    await conn.query(
      'INSERT INTO MEMB_STAT (memb___id, ConnectStat) VALUES (?, 0) ON DUPLICATE KEY UPDATE ConnectStat = VALUES(ConnectStat)',
      [account]
    );

    await conn.query(
      'INSERT INTO AccountCharacter (Id) VALUES (?) ON DUPLICATE KEY UPDATE Id = VALUES(Id)',
      [account]
    );

    await conn.commit();
    return res.redirect(`/admin/accounts/${encodeURIComponent(account)}?ok=${encodeURIComponent('Conta criada')}`);
  } catch {
    await conn.rollback();
    return res.render('admin_account_new', { error: 'Não foi possível criar a conta.', form });
  } finally {
    conn.release();
  }
});

app.get('/admin/accounts/:id', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  const accountId = String(req.params.id || '').trim();
  const notice = req.query.ok ? { type: 'success', text: decodeURIComponent(String(req.query.ok)) } : null;
  const error = req.query.err ? { type: 'danger', text: decodeURIComponent(String(req.query.err)) } : null;

  const [rows] = await pool.query(
    'SELECT memb___id, memb_name, mail_addr, sno__numb, AccountLevel, AccountExpireDate, bloc_code, Bloc_Expire FROM MEMB_INFO WHERE memb___id = ? LIMIT 1',
    [accountId]
  );
  if (rows.length === 0) {
    return res.redirect('/admin/accounts?err=Conta não encontrada.');
  }

  const [chars] = await pool.query(
    'SELECT Name, cLevel, ResetCount, GrandResetCount, Class, CtlCode, MapNumber FROM `Character` WHERE AccountID = ? ORDER BY Name',
    [accountId]
  );
  const characters = chars.map((row) => ({
    ...row,
    ClassName: getClassName(row.Class),
    MapName: getMapName(row.MapNumber)
  }));

  const [warehouseRows] = await pool.query(
    'SELECT Money, pw, Items FROM warehouse WHERE AccountID = ? LIMIT 1',
    [accountId]
  );
  const warehouse = warehouseRows[0]
    ? {
        Money: warehouseRows[0].Money ?? 0,
        pw: warehouseRows[0].pw ?? 0,
        itemsBytes: warehouseRows[0].Items ? warehouseRows[0].Items.length : 0
      }
    : null;

  const account = {
    ...rows[0],
    AccountExpireLocal: formatDateTimeLocal(rows[0].AccountExpireDate),
    BlocExpireLocal: formatDateTimeLocal(rows[0].Bloc_Expire),
    blocked: String(rows[0].bloc_code) === '1'
  };

  const [statRows] = await pool.query(
    'SELECT ConnectStat, ServerName, IP, ConnectTM, DisConnectTM FROM MEMB_STAT WHERE memb___id = ? LIMIT 1',
    [accountId]
  );
  const stat = statRows[0]
    ? {
        ...statRows[0],
        ConnectLocal: formatDateTimeLocal(statRows[0].ConnectTM),
        DisconnectLocal: formatDateTimeLocal(statRows[0].DisConnectTM)
      }
    : null;

  const cash = await getCash(accountId);

  res.render('admin_account_edit', { account, stat, characters, warehouse, cash, notice, error });
});

app.post('/admin/accounts/:id/cash', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  const accountId = String(req.params.id || '').trim();
  const amount = parseIntField(req.body.cash, { min: 0, max: 2000000000 });
  const mode = String(req.body.mode || 'set').toLowerCase();

  if (!amount.ok) {
    return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}?err=${encodeURIComponent('Valor de Cash inválido.')}`);
  }

  if (mode === 'add') {
    await addCash(accountId, amount.value);
  } else {
    await setCash(accountId, amount.value);
  }

  return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}?ok=${encodeURIComponent('Cash atualizado.')}`);
});

app.post('/admin/accounts/:id', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  const accountId = String(req.params.id || '').trim();
  const password = String(req.body.password || '');
  const confirm = String(req.body.confirm || '');
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim();
  const code = String(req.body.code || '').trim();
  const accountLevelField = parseIntField(req.body.account_level, { min: 0, max: 3 });
  const blocked = req.body.blocked === '1' || req.body.blocked === 'on';
  const accountExpire = parseDateTimeInput(req.body.account_expire);
  const blockExpire = parseDateTimeInput(req.body.block_expire);

  const [rows] = await pool.query(
    'SELECT memb___id, memb_name, mail_addr, sno__numb, AccountLevel, AccountExpireDate, bloc_code, Bloc_Expire FROM MEMB_INFO WHERE memb___id = ? LIMIT 1',
    [accountId]
  );
  if (rows.length === 0) {
    return res.redirect('/admin/accounts?err=Conta não encontrada.');
  }

  const offline = await ensureAccountOffline(accountId);
  if (!offline) {
    return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}?err=${encodeURIComponent('A conta está online. Desconecte-a para editar.')}`);
  }

  if (!validateName(name)) {
    return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}?err=${encodeURIComponent('Nome inválido (4-10, letras/números/_).')}`);
  }
  if (!validateCode(code)) {
    return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}?err=${encodeURIComponent('Código inválido (18 números).')}`);
  }
  if (!validateEmail(email)) {
    return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}?err=${encodeURIComponent('E-mail inválido.')}`);
  }
  if (!accountLevelField.ok) {
    return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}?err=${encodeURIComponent('Account Level inválido (0-3).')}`);
  }
  if (password) {
    if (!validatePassword(password) || password !== confirm) {
      return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}?err=${encodeURIComponent('Senha inválida ou não coincide.')}`);
    }
  }
  if (!accountExpire.ok) {
    return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}?err=${encodeURIComponent('Data de expiração inválida.')}`);
  }
  if (blocked && !blockExpire.ok) {
    return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}?err=${encodeURIComponent('Data de bloqueio inválida.')}`);
  }
  if (blocked && !blockExpire.value) {
    return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}?err=${encodeURIComponent('Você deve indicar a data de bloqueio.')}`);
  }

  const fields = [
    'memb_name = ?',
    'mail_addr = ?',
    'sno__numb = ?',
    'AccountLevel = ?',
    'AccountExpireDate = ?',
    'bloc_code = ?',
    'Bloc_Expire = ?'
  ];
  const params = [
    name,
    email || null,
    code,
    accountLevelField.value,
    accountExpire.value ? accountExpire.value : rows[0].AccountExpireDate,
    blocked ? 1 : 0,
    blocked ? blockExpire.value : '1900-01-01 00:00:00'
  ];

  if (password) {
    fields.push('memb__pwd = UNHEX(MD5(?))');
    params.push(password);
  }

  params.push(accountId);

  await pool.query(`UPDATE MEMB_INFO SET ${fields.join(', ')} WHERE memb___id = ?`, params);

  return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}?ok=${encodeURIComponent('Conta atualizada')}`);
});

app.get('/admin/accounts/:id/characters/:name', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  const accountId = String(req.params.id || '').trim();
  const charName = String(req.params.name || '').trim();
  const notice = req.query.ok ? { type: 'success', text: decodeURIComponent(String(req.query.ok)) } : null;
  const error = req.query.err ? { type: 'danger', text: decodeURIComponent(String(req.query.err)) } : null;

  const [rows] = await pool.query(
    `SELECT Name, AccountID, cLevel, ResetCount, GrandResetCount, Class, CtlCode,
            LevelUpPoint, Strength, Dexterity, Vitality, Energy, Money, MapNumber, MapPosX, MapPosY, MapDir
     FROM \`Character\`
     WHERE AccountID = ? AND Name = ?
     LIMIT 1`,
    [accountId, charName]
  );
  if (rows.length === 0) {
    return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}?err=${encodeURIComponent('Personagem não encontrado.')}`);
  }

  const character = {
    ...rows[0],
    cLevel: rows[0].cLevel ?? 1,
    ResetCount: rows[0].ResetCount ?? 0,
    GrandResetCount: rows[0].GrandResetCount ?? 0,
    Class: rows[0].Class ?? 0,
    CtlCode: rows[0].CtlCode ?? 0,
    LevelUpPoint: rows[0].LevelUpPoint ?? 0,
    Strength: rows[0].Strength ?? 0,
    Dexterity: rows[0].Dexterity ?? 0,
    Vitality: rows[0].Vitality ?? 0,
    Energy: rows[0].Energy ?? 0,
    Money: rows[0].Money ?? 0,
    MapNumber: rows[0].MapNumber ?? 0,
    MapPosX: rows[0].MapPosX ?? 0,
    MapPosY: rows[0].MapPosY ?? 0,
    MapDir: rows[0].MapDir ?? 0
  };
  const classOptions = buildOptionsFromMap(CLASS_NAMES);
  const mapOptions = buildOptionsFromMap(MAP_NAMES);
  const typeOptions = [
    { value: 0, label: 'Player' },
    { value: 1, label: 'Banned' },
    { value: 32, label: 'GameMaster' }
  ];

  if (!CLASS_NAMES[character.Class]) {
    classOptions.unshift({ value: character.Class, label: `Classe ${character.Class}` });
  }
  if (!MAP_NAMES[character.MapNumber]) {
    mapOptions.unshift({ value: character.MapNumber, label: `Mapa ${character.MapNumber}` });
  }

  res.render('admin_character_edit', {
    accountId,
    character,
    classOptions,
    mapOptions,
    typeOptions,
    notice,
    error
  });
});

app.get('/admin/accounts/:id/characters/:name/inventory', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  const accountId = String(req.params.id || '').trim();
  const charName = String(req.params.name || '').trim();
  const notice = req.query.ok ? { type: 'success', text: decodeURIComponent(String(req.query.ok)) } : null;
  const error = req.query.err ? { type: 'danger', text: decodeURIComponent(String(req.query.err)) } : null;

  const [rows] = await pool.query(
    'SELECT Inventory FROM `Character` WHERE AccountID = ? AND Name = ? LIMIT 1',
    [accountId, charName]
  );
  if (rows.length === 0) {
    return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}?err=${encodeURIComponent('Personagem não encontrado.')}`);
  }

  const inventoryHex = bufferToHex(rows[0].Inventory, 760);
  const offline = await ensureAccountOffline(accountId);

  res.render('admin_inventory_edit', {
    accountId,
    charName,
    inventoryHex,
    offline,
    notice,
    error
  });
});

app.post('/admin/accounts/:id/characters/:name/inventory', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  const accountId = String(req.params.id || '').trim();
  const charName = String(req.params.name || '').trim();

  const offline = await ensureAccountOffline(accountId);
  if (!offline) {
    return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}/characters/${encodeURIComponent(charName)}/inventory?err=${encodeURIComponent('A conta está online. Desconecte-a para editar.')}`);
  }

  const [rows] = await pool.query(
    'SELECT Name FROM `Character` WHERE AccountID = ? AND Name = ? LIMIT 1',
    [accountId, charName]
  );
  if (rows.length === 0) {
    return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}?err=${encodeURIComponent('Personagem não encontrado.')}`);
  }

  const parsed = normalizeHexInput(req.body.inventory_hex, 760);
  if (!parsed.ok) {
    return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}/characters/${encodeURIComponent(charName)}/inventory?err=${encodeURIComponent(parsed.error || 'Hex inválido.')}`);
  }

  await applySerialsIfNeeded(parsed.buffer);

  await pool.query(
    'UPDATE `Character` SET Inventory = ? WHERE AccountID = ? AND Name = ?',
    [parsed.buffer, accountId, charName]
  );

  return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}/characters/${encodeURIComponent(charName)}/inventory?ok=${encodeURIComponent('Inventário atualizado')}`);
});

app.post('/admin/accounts/:id/characters/:name', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  const accountId = String(req.params.id || '').trim();
  const charName = String(req.params.name || '').trim();

  const offline = await ensureAccountOffline(accountId);
  if (!offline) {
    return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}/characters/${encodeURIComponent(charName)}?err=${encodeURIComponent('A conta está online. Desconecte-a para editar.')}`);
  }

  const [rows] = await pool.query(
    'SELECT Name FROM `Character` WHERE AccountID = ? AND Name = ? LIMIT 1',
    [accountId, charName]
  );
  if (rows.length === 0) {
    return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}?err=${encodeURIComponent('Personagem não encontrado.')}`);
  }

  const level = parseIntField(req.body.level, { min: 1, max: 2147483647 });
  const reset = parseIntField(req.body.reset, { min: 0, max: 2147483647 });
  const grandReset = parseIntField(req.body.grand_reset, { min: 0, max: 2147483647 });
  const classId = parseIntField(req.body.class_id, { min: 0, max: 255 });
  const ctlCode = parseIntField(req.body.ctl_code, { min: 0, max: 255 });
  const points = parseIntField(req.body.points, { min: 0, max: 2147483647 });
  const strength = parseIntField(req.body.strength, { min: 0, max: 2147483647 });
  const dexterity = parseIntField(req.body.dexterity, { min: 0, max: 2147483647 });
  const vitality = parseIntField(req.body.vitality, { min: 0, max: 2147483647 });
  const energy = parseIntField(req.body.energy, { min: 0, max: 2147483647 });
  const money = parseIntField(req.body.money, { min: 0, max: 2147483647 });
  const mapNumber = parseIntField(req.body.map_number, { min: 0, max: 255 });
  const posX = parseIntField(req.body.pos_x, { min: 0, max: 255 });
  const posY = parseIntField(req.body.pos_y, { min: 0, max: 255 });
  const mapDir = parseIntField(req.body.map_dir, { min: 0, max: 255 });

  if (!level.ok || !reset.ok || !grandReset.ok || !classId.ok || !ctlCode.ok || !points.ok || !strength.ok || !dexterity.ok || !vitality.ok || !energy.ok || !money.ok || !mapNumber.ok || !posX.ok || !posY.ok || !mapDir.ok) {
    return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}/characters/${encodeURIComponent(charName)}?err=${encodeURIComponent('Há valores inválidos.')}`);
  }

  await pool.query(
    `UPDATE \`Character\`
     SET cLevel = ?, ResetCount = ?, GrandResetCount = ?, Class = ?, CtlCode = ?,
         LevelUpPoint = ?, Strength = ?, Dexterity = ?, Vitality = ?, Energy = ?,
         Money = ?, MapNumber = ?, MapPosX = ?, MapPosY = ?, MapDir = ?
     WHERE AccountID = ? AND Name = ?`,
    [
      level.value,
      reset.value,
      grandReset.value,
      classId.value,
      ctlCode.value,
      points.value,
      strength.value,
      dexterity.value,
      vitality.value,
      energy.value,
      money.value,
      mapNumber.value,
      posX.value,
      posY.value,
      mapDir.value,
      accountId,
      charName
    ]
  );

  return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}/characters/${encodeURIComponent(charName)}?ok=${encodeURIComponent('Personagem atualizado')}`);
});

app.get('/admin/accounts/:id/warehouse', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  const accountId = String(req.params.id || '').trim();
  const notice = req.query.ok ? { type: 'success', text: decodeURIComponent(String(req.query.ok)) } : null;
  const error = req.query.err ? { type: 'danger', text: decodeURIComponent(String(req.query.err)) } : null;

  const [rows] = await pool.query(
    'SELECT Money, pw, Items FROM warehouse WHERE AccountID = ? LIMIT 1',
    [accountId]
  );

  const warehouse = rows[0]
    ? {
        Money: rows[0].Money ?? 0,
        pw: rows[0].pw ?? 0,
        ItemsHex: bufferToHex(rows[0].Items, 1200)
      }
    : {
        Money: 0,
        pw: 0,
        ItemsHex: ''
      };

  res.render('admin_warehouse_edit', { accountId, warehouse, notice, error });
});

app.get('/admin/accounts/:id/warehouse/editor', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  const accountId = String(req.params.id || '').trim();
  const notice = req.query.ok ? { type: 'success', text: decodeURIComponent(String(req.query.ok)) } : null;
  const error = req.query.err ? { type: 'danger', text: decodeURIComponent(String(req.query.err)) } : null;

  const [rows] = await pool.query(
    'SELECT Items FROM warehouse WHERE AccountID = ? LIMIT 1',
    [accountId]
  );

  const itemsHex = rows[0] ? bufferToHex(rows[0].Items, 1200) : bufferToHex(Buffer.alloc(1200, 0xff), 1200);
  const offline = await ensureAccountOffline(accountId);

  const buffer = rows[0] && rows[0].Items ? Buffer.from(rows[0].Items) : Buffer.alloc(1200, 0xff);
  const conflicts = findWarehouseConflicts(buffer);

  res.render('admin_warehouse_graphic', {
    accountId,
    itemsHex,
    offline,
    conflicts,
    notice,
    error
  });
});

// Corrige baus com itens sobrepostos (bug antigo de posicionamento da loja).
// Reorganiza tudo usando o tamanho real de cada item, sem alterar os itens.
app.post('/admin/accounts/:id/warehouse/repair', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  const accountId = String(req.params.id || '').trim();
  const back = `/admin/accounts/${encodeURIComponent(accountId)}/warehouse/editor`;

  const offline = await ensureAccountOffline(accountId);
  if (!offline) {
    return res.redirect(`${back}?err=${encodeURIComponent('A conta está online. Desconecte-a para reparar.')}`);
  }

  const [rows] = await pool.query('SELECT Items FROM warehouse WHERE AccountID = ? LIMIT 1', [accountId]);
  if (!rows[0] || !rows[0].Items) {
    return res.redirect(`${back}?err=${encodeURIComponent('Esta conta ainda não tem baú.')}`);
  }

  const buffer = Buffer.from(rows[0].Items);
  const before = findWarehouseConflicts(buffer);
  if (before.length === 0) {
    return res.redirect(`${back}?ok=${encodeURIComponent('Este baú já está correto, nada para reparar.')}`);
  }

  const repacked = repackWarehouse(buffer);
  if (repacked.failed.length > 0) {
    return res.redirect(`${back}?err=${encodeURIComponent(`Não foi possível reorganizar: ${repacked.failed.length} item(ns) não couberam.`)}`);
  }

  await pool.query(
    `INSERT INTO warehouse (AccountID, Items, Money, pw)
     VALUES (?, ?, 0, 0)
     ON DUPLICATE KEY UPDATE Items = VALUES(Items)`,
    [accountId, repacked.buffer]
  );

  return res.redirect(`${back}?ok=${encodeURIComponent(`Baú reparado: ${repacked.placed.length} itens reorganizados (${before.length} estavam sobrepostos).`)}`);
});

app.post('/admin/accounts/:id/warehouse/editor', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  const accountId = String(req.params.id || '').trim();

  const offline = await ensureAccountOffline(accountId);
  if (!offline) {
    return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}/warehouse/editor?err=${encodeURIComponent('A conta está online. Desconecte-a para editar.')}`);
  }

  const parsed = normalizeHexInput(req.body.items_hex, 1200);
  if (!parsed.ok) {
    return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}/warehouse/editor?err=${encodeURIComponent(parsed.error || 'Hex inválido.')}`);
  }

  await applySerialsIfNeeded(parsed.buffer);

  await pool.query(
    `INSERT INTO warehouse (AccountID, Items, Money, pw)
     VALUES (?, ?, 0, 0)
     ON DUPLICATE KEY UPDATE Items = VALUES(Items)`,
    [accountId, parsed.buffer]
  );

  return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}/warehouse/editor?ok=${encodeURIComponent('Baú atualizado')}`);
});

app.get('/admin/item-defs.json', requireAdmin, requireAdminPasswordChange, (req, res) => {
  const { defs } = getItemDefs();
  res.json({ items: defs });
});

app.post('/admin/accounts/:id/warehouse', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  const accountId = String(req.params.id || '').trim();
  const action = String(req.body.action || 'save').toLowerCase();

  const offline = await ensureAccountOffline(accountId);
  if (!offline) {
    return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}/warehouse?err=${encodeURIComponent('A conta está online. Desconecte-a para editar.')}`);
  }

  const money = parseIntField(req.body.money, { min: 0, max: 2147483647 });
  const pw = parseIntField(req.body.pw, { min: 0, max: 65535 });
  if (!money.ok || !pw.ok) {
    return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}/warehouse?err=${encodeURIComponent('Zen ou senha inválidos.')}`);
  }

  let itemsBuffer = null;
  let finalMoney = money.value;
  let finalPw = pw.value;

  if (action === 'clear') {
    itemsBuffer = Buffer.alloc(1200, 0xff);
    finalMoney = 0;
  } else {
    const parsed = normalizeHexInput(req.body.items_hex, 1200);
    if (!parsed.ok) {
      return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}/warehouse?err=${encodeURIComponent(parsed.error || 'Hex inválido.')}`);
    }
    itemsBuffer = parsed.buffer;
  }

  await pool.query(
    `INSERT INTO warehouse (AccountID, Items, Money, pw)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE Items = VALUES(Items), Money = VALUES(Money), pw = VALUES(pw)`,
    [accountId, itemsBuffer, finalMoney, finalPw]
  );

  const message = action === 'clear' ? 'Baú esvaziado' : 'Baú atualizado';
  return res.redirect(`/admin/accounts/${encodeURIComponent(accountId)}/warehouse?ok=${encodeURIComponent(message)}`);
});

app.get('/admin/news', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  const [news] = await pool.query('SELECT id, title, published, created_at FROM web_news ORDER BY created_at DESC');
  res.render('admin_news', { news });
});

app.get('/admin/news/new', requireAdmin, requireAdminPasswordChange, (req, res) => {
  res.render('admin_news_form', { item: null, error: null });
});

app.post('/admin/news/new', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  const { title, body, published, allow_html, hide_title } = req.body;
  if (!title || !body) return res.render('admin_news_form', { item: null, error: 'Título e conteúdo são obrigatórios.' });
  const allowHtml = allow_html === '1' || allow_html === 'on';
  const safeBody = sanitizeNewsBody(body, allowHtml);
  const hideTitle = hide_title === '1' || hide_title === 'on';
  await pool.query(
    'INSERT INTO web_news (title, body, body_is_html, hide_title, published) VALUES (?, ?, ?, ?, ?)',
    [title, safeBody, allowHtml ? 1 : 0, hideTitle ? 1 : 0, published ? 1 : 0]
  );
  res.redirect('/admin/news');
});

app.get('/admin/news/:id/edit', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  const [rows] = await pool.query('SELECT id, title, body, body_is_html, hide_title, published FROM web_news WHERE id = ? LIMIT 1', [req.params.id]);
  if (rows.length === 0) return res.redirect('/admin/news');
  const item = rows[0];
  if (!item.body_is_html) {
    const withNewLines = String(item.body || '').replace(new RegExp('<br\\s*/?>', 'gi'), '\n');
    item.body = stripHtml(withNewLines);
  }
  res.render('admin_news_form', { item, error: null });
});

app.post('/admin/news/:id/edit', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  const { title, body, published, allow_html, hide_title } = req.body;
  if (!title || !body) {
    return res.render('admin_news_form', {
      item: {
        id: req.params.id,
        title,
        body,
        published,
        body_is_html: allow_html === '1' || allow_html === 'on' ? 1 : 0,
        hide_title: hide_title === '1' || hide_title === 'on' ? 1 : 0
      },
      error: 'Título e conteúdo são obrigatórios.'
    });
  }
  const allowHtml = allow_html === '1' || allow_html === 'on';
  const safeBody = sanitizeNewsBody(body, allowHtml);
  const hideTitle = hide_title === '1' || hide_title === 'on';
  await pool.query(
    'UPDATE web_news SET title = ?, body = ?, body_is_html = ?, hide_title = ?, published = ? WHERE id = ?',
    [title, safeBody, allowHtml ? 1 : 0, hideTitle ? 1 : 0, published ? 1 : 0, req.params.id]
  );
  res.redirect('/admin/news');
});

app.post('/admin/news/:id/delete', requireAdmin, requireAdminPasswordChange, async (req, res) => {
  await pool.query('DELETE FROM web_news WHERE id = ?', [req.params.id]);
  res.redirect('/admin/news');
});

ensureSchema()
  .then(() => {
    app.listen(Number(WEB_PORT), () => {
      console.log(`mu-web listening on ${WEB_PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start mu-web', err);
    process.exit(1);
  });
