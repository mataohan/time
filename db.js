// 数据库抽象层：本地 SQLite (sql.js) / Railway PostgreSQL 自动切换
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'time_master.db');
let _db, _type, SQL;

async function init() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    _db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    _type = 'pg';
  } else {
    SQL = await initSqlJs();
    if (fs.existsSync(DB_PATH)) {
      const buffer = fs.readFileSync(DB_PATH);
      _db = new SQL.Database(buffer);
    } else {
      _db = new SQL.Database();
    }
    _db.run('PRAGMA journal_mode=WAL');
    _db.run('PRAGMA foreign_keys=ON');
    _type = 'sqlite';
    saveToFile();
  }
}

// sql.js 是内存数据库，写操作后需要手动持久化到磁盘
function saveToFile() {
  if (_type === 'sqlite' && _db) {
    const data = _db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }
}

// 将 SQLite ? 占位符转换为 PostgreSQL $1, $2 ...
function _pg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

module.exports = {
  type() { return _type; },
  init,

  async run(sql, params = []) {
    if (_type === 'pg') {
      await _db.query(_pg(sql), params);
    } else {
      _db.run(sql, params);
      saveToFile();
    }
  },

  async get(sql, params = []) {
    if (_type === 'pg') {
      const r = await _db.query(_pg(sql), params);
      return r.rows[0] || null;
    } else {
      try {
        const stmt = _db.prepare(sql);
        stmt.bind(params);
        if (stmt.step()) {
          const row = stmt.getAsObject();
          stmt.free();
          return row;
        }
        stmt.free();
        return null;
      } catch (e) {
        // 一些 DDL 语句不能用 prepare，回退到 exec
        return null;
      }
    }
  },

  async all(sql, params = []) {
    if (_type === 'pg') {
      const r = await _db.query(_pg(sql), params);
      return r.rows;
    } else {
      const stmt = _db.prepare(sql);
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.free();
      return rows;
    }
  },

  async exec(sql) {
    if (_type === 'pg') {
      await _db.query(sql);
    } else {
      _db.run(sql);
      saveToFile();
    }
  },

  // INSERT 并返回新行
  async insert(sql, params = []) {
    if (_type === 'pg') {
      const pgSql = _pg(sql) + ' RETURNING *';
      const r = await _db.query(pgSql, params);
      return r.rows[0];
    } else {
      _db.run(sql, params);
      const result = _db.exec('SELECT last_insert_rowid() as id');
      const lastId = result[0].values[0][0];
      saveToFile();

      const match = sql.match(/INTO\s+["']?(\w+)["']?/i);
      if (match) {
        const table = match[1];
        const stmt = _db.prepare(`SELECT * FROM "${table}" WHERE id = ?`);
        stmt.bind([lastId]);
        if (stmt.step()) {
          const row = stmt.getAsObject();
          stmt.free();
          return row;
        }
        stmt.free();
      }
      return { id: lastId };
    }
  },

  // DELETE / UPDATE 返回影响行数
  async change(sql, params = []) {
    if (_type === 'pg') {
      const r = await _db.query(_pg(sql), params);
      return r.rowCount;
    } else {
      _db.run(sql, params);
      const changes = _db.getRowsModified();
      saveToFile();
      return changes;
    }
  }
};
