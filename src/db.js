
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const configuredPath = process.env.DATABASE_PATH || "./data/malak.sqlite";
const databasePath = path.resolve(configuredPath);

fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const db = new Database(databasePath);

db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    points INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    played INTEGER NOT NULL DEFAULT 0,
    daily_date TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (chat_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS chat_stats (
    chat_id TEXT PRIMARY KEY,
    messages_received INTEGER NOT NULL DEFAULT 0,
    replies_sent INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS chat_settings (
    chat_id TEXT PRIMARY KEY,
    locked INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    user_id TEXT,
    action TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

function ensureColumn(table, column, definition, backfill = null) {
  const allowedTables = ["players"];
  const allowedColumns = [
    "username", "wins", "played", "daily_date",
    "created_at", "updated_at"
  ];

  if (!allowedTables.includes(table) || !allowedColumns.includes(column)) {
    throw new Error("Invalid database migration identifier");
  }

  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = columns.some(item => item.name === column);

  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  if (backfill) {
    db.exec(`UPDATE ${table} SET ${column} = ${backfill} WHERE ${column} IS NULL OR ${column} = ''`);
  }
}

// ترقية آمنة للجداول القديمة بدون حذف بيانات اللاعبين
ensureColumn("players", "username", "TEXT NOT NULL DEFAULT ''");
ensureColumn("players", "wins", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("players", "played", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("players", "daily_date", "TEXT NOT NULL DEFAULT ''");

// لا نستخدم CURRENT_TIMESTAMP داخل ALTER TABLE
ensureColumn("players", "created_at", "TEXT NOT NULL DEFAULT ''", "CURRENT_TIMESTAMP");
ensureColumn("players", "updated_at", "TEXT NOT NULL DEFAULT ''", "CURRENT_TIMESTAMP");

// ملء التواريخ تلقائيًا عند تسجيل لاعب جديد في جدول قديم
db.exec(`
  CREATE TRIGGER IF NOT EXISTS players_fill_timestamps
  AFTER INSERT ON players
  FOR EACH ROW
  WHEN NEW.created_at = '' OR NEW.updated_at = ''
  BEGIN
    UPDATE players
    SET
      created_at = CASE WHEN NEW.created_at = '' THEN CURRENT_TIMESTAMP ELSE NEW.created_at END,
      updated_at = CASE WHEN NEW.updated_at = '' THEN CURRENT_TIMESTAMP ELSE NEW.updated_at END
    WHERE chat_id = NEW.chat_id AND user_id = NEW.user_id;
  END;
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_players_points
  ON players(chat_id, points DESC);

  CREATE INDEX IF NOT EXISTS idx_activity_chat
  ON activity(chat_id, created_at);
`);

const statements = {
  registerPlayer: db.prepare(`
    INSERT INTO players (chat_id, user_id, display_name, username)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id, user_id)
    DO UPDATE SET
      display_name = excluded.display_name,
      username = excluded.username,
      updated_at = CURRENT_TIMESTAMP
  `),

  getPlayer: db.prepare(`
    SELECT * FROM players
    WHERE chat_id = ? AND user_id = ?
  `),

  addPoints: db.prepare(`
    UPDATE players
    SET
      points = points + ?,
      wins = wins + ?,
      played = played + ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE chat_id = ? AND user_id = ?
  `),

  topPlayers: db.prepare(`
    SELECT display_name, username, points, wins, played
    FROM players
    WHERE chat_id = ?
    ORDER BY points DESC, wins DESC, display_name COLLATE NOCASE
    LIMIT ?
  `),

  daily: db.prepare(`
    UPDATE players
    SET
      points = points + 20,
      daily_date = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE chat_id = ? AND user_id = ?
  `),

  message: db.prepare(`
    INSERT INTO chat_stats (chat_id, messages_received)
    VALUES (?, 1)
    ON CONFLICT(chat_id)
    DO UPDATE SET
      messages_received = messages_received + 1,
      updated_at = CURRENT_TIMESTAMP
  `),

  reply: db.prepare(`
    INSERT INTO chat_stats (chat_id, replies_sent)
    VALUES (?, 1)
    ON CONFLICT(chat_id)
    DO UPDATE SET
      replies_sent = replies_sent + 1,
      updated_at = CURRENT_TIMESTAMP
  `),

  stats: db.prepare(`
    SELECT
      COALESCE(SUM(messages_received), 0) AS messages_received,
      COALESCE(SUM(replies_sent), 0) AS replies_sent,
      COUNT(*) AS chats
    FROM chat_stats
  `),

  getChat: db.prepare(`
    SELECT * FROM chat_settings WHERE chat_id = ?
  `),

  setChat: db.prepare(`
    INSERT INTO chat_settings (chat_id, locked)
    VALUES (?, ?)
    ON CONFLICT(chat_id)
    DO UPDATE SET
      locked = excluded.locked,
      updated_at = CURRENT_TIMESTAMP
  `),

  activity: db.prepare(`
    INSERT INTO activity (chat_id, user_id, action)
    VALUES (?, ?, ?)
  `)
};

function registerPlayer(chatId, user) {
  if (!user || user.is_bot) return null;

  const id = String(user.id);
  const chat = String(chatId);

  const name = [
    user.first_name,
    user.last_name
  ].filter(Boolean).join(" ").trim() || user.username || "لاعب";

  statements.registerPlayer.run(
    chat,
    id,
    name.slice(0, 100),
    String(user.username || "")
  );

  return statements.getPlayer.get(chat, id);
}

function getPlayer(chatId, user) {
  return registerPlayer(chatId, user);
}

function addPoints(chatId, user, amount, won = false) {
  if (!Number.isInteger(amount) || amount < 0 || amount > 1000) {
    throw new Error("Invalid points amount");
  }

  const player = registerPlayer(chatId, user);
  if (!player) return null;

  return db.transaction(() => {
    statements.addPoints.run(
      amount,
      won ? 1 : 0,
      1,
      String(chatId),
      String(user.id)
    );

    return statements.getPlayer.get(
      String(chatId),
      String(user.id)
    );
  })();
}

function getTopPlayers(chatId, limit = 10) {
  const safeLimit = Math.max(1, Math.min(20, Number(limit) || 10));
  return statements.topPlayers.all(String(chatId), safeLimit);
}

function claimDaily(chatId, user) {
  const player = registerPlayer(chatId, user);
  if (!player) return { ok: false };

  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "Africa/Cairo"
  });

  if (player.daily_date === today) {
    return {
      ok: false,
      player,
      message: "حصلت على مكافأتك اليومية بالفعل. ارجع بكرة."
    };
  }

  statements.daily.run(today, String(chatId), String(user.id));

  return {
    ok: true,
    player: statements.getPlayer.get(String(chatId), String(user.id))
  };
}

function recordMessage(chatId) {
  statements.message.run(String(chatId));
}

function recordReply(chatId) {
  statements.reply.run(String(chatId));
}

function getStats() {
  return statements.stats.get();
}

function logActivity(chatId, userId, action) {
  statements.activity.run(
    String(chatId),
    userId == null ? null : String(userId),
    String(action)
  );
}

function getChatSettings(chatId) {
  return statements.getChat.get(String(chatId)) || {
    chat_id: String(chatId),
    locked: 0
  };
}

function setChatLocked(chatId, locked) {
  statements.setChat.run(String(chatId), locked ? 1 : 0);
}

function closeDatabase() {
  if (db.open) db.close();
}

module.exports = {
  registerPlayer,
  getPlayer,
  addPoints,
  getTopPlayers,
  claimDaily,
  recordMessage,
  recordReply,
  getStats,
  logActivity,
  getChatSettings,
  setChatLocked,
  closeDatabase
};
