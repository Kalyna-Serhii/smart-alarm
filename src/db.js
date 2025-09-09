import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dbDir = path.resolve('./data');
fs.mkdirSync(dbDir, { recursive: true });

const dbPath = path.join(dbDir, 'data.db');
export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY,
    tg_user_id   INTEGER NOT NULL UNIQUE,
    tg_chat_id   INTEGER NOT NULL,
    created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
  );

  CREATE TABLE IF NOT EXISTS alarms (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label        TEXT,
    hour         INTEGER NOT NULL,
    minute       INTEGER NOT NULL,
    days_mask    INTEGER NOT NULL,
    enabled      INTEGER NOT NULL DEFAULT 1,
    repeats      INTEGER NOT NULL DEFAULT 3,
    interval     INTEGER NOT NULL DEFAULT 2,
    created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
    updated_at   INTEGER
  );
`);
