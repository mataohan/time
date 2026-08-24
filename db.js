// 数据库层：支持双模式
//   1) 配置 DATABASE_URL → TiDB Cloud（MySQL 协议）
//   2) 未配置 DATABASE_URL → 本地 SQLite（time_master.db，使用 Node 内置 node:sqlite，零外部依赖）
const mysql = require('mysql2/promise');
const path = require('path');

let pool;          // TiDB Cloud 连接池
let sqlite;        // node:sqlite DatabaseSync 实例
let isSqliteMode = false;

// 将 MySQL 方言 SQL 转换为 SQLite 兼容语法（仅 SQLite 模式下生效）
function translateSql(sql) {
  if (!isSqliteMode || !sql) return sql;

  // SQLite 不支持 ALTER TABLE ... MODIFY COLUMN，忽略该语句
  if (/ALTER\s+TABLE\s+\S+\s+MODIFY\b/i.test(sql)) return '';

  return sql
    // SQLite 中只有 INTEGER PRIMARY KEY 才是自增主键
    .replace(/\bINT\b\s+AUTO_INCREMENT\b/gi, 'INTEGER')
    // SQLite 不支持 ON UPDATE CURRENT_TIMESTAMP
    .replace(/ON\s+UPDATE\s+CURRENT_TIMESTAMP/gi, '')
    // 反引号标识符 → 双引号（SQLite 标准）
    .replace(/`/g, '"')
    // YEAR(col) → CAST(strftime('%Y', col) AS INTEGER)
    .replace(/YEAR\((\w+)\)/gi, "CAST(strftime('%Y', $1) AS INTEGER)")
    // MONTH(col) → CAST(strftime('%m', col) AS INTEGER)
    .replace(/MONTH\((\w+)\)/gi, "CAST(strftime('%m', $1) AS INTEGER)");
}

async function init() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    // ===== SQLite 模式（本地开发） =====
    const { DatabaseSync } = require('node:sqlite');
    const dbPath = path.join(__dirname, 'time_master.db');
    try {
      sqlite = new DatabaseSync(dbPath);
      sqlite.exec('PRAGMA journal_mode = WAL');
      sqlite.exec('PRAGMA foreign_keys = ON');
      isSqliteMode = true;
      console.log('✅ SQLite 数据库已连接: ' + dbPath);
    } catch (err) {
      console.error('❌ SQLite 数据库连接失败:', err.message);
      process.exit(1);
    }
    return;
  }

  // ===== TiDB Cloud（MySQL）模式 =====
  try {
    const url = new URL(dbUrl);
    pool = mysql.createPool({
      host: url.hostname,
      port: parseInt(url.port) || 4000,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ''),
      ssl: { rejectUnauthorized: false },
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      charset: 'utf8mb4'
    });

    // 测试连接
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    console.log('✅ TiDB Cloud 数据库连接成功: ' + url.hostname);
  } catch (err) {
    console.error('❌ 数据库连接失败:', err.message);
    console.error('   请检查 DATABASE_URL 是否正确，以及 TiDB Cloud 是否允许外部连接。');
    process.exit(1);
  }
}

function type() {
  return isSqliteMode ? 'sqlite' : 'tidb';
}

// 通用查询
async function query(sql, params = []) {
  sql = translateSql(sql);
  if (isSqliteMode) {
    return sqlite.prepare(sql).all(...params);
  }
  const [rows] = await pool.query(sql, params);
  return rows;
}

module.exports = {
  type,
  init,

  // 执行写操作（不返回结果）
  async run(sql, params = []) {
    sql = translateSql(sql);
    if (isSqliteMode) {
      sqlite.prepare(sql).run(...params);
      return;
    }
    await pool.query(sql, params);
  },

  // 查询单行
  async get(sql, params = []) {
    const rows = await query(sql, params);
    return rows[0] || null;
  },

  // 查询多行
  async all(sql, params = []) {
    return query(sql, params);
  },

  // 执行原生 SQL（DDL 等）
  async exec(sql) {
    sql = translateSql(sql);
    if (isSqliteMode) {
      if (sql.trim()) sqlite.exec(sql);
      return;
    }
    await pool.query(sql);
  },

  // INSERT 并返回新插入的完整行
  async insert(sql, params = []) {
    if (isSqliteMode) {
      sql = translateSql(sql);
      const result = sqlite.prepare(sql).run(...params);
      const match = sql.match(/INTO\s+"?(\w+)"?\s*\(/i);
      if (match) {
        const rows = await query(`SELECT * FROM "${match[1]}" WHERE id = ?`, [result.lastInsertRowid]);
        return rows[0] || { id: result.lastInsertRowid };
      }
      return { id: result.lastInsertRowid };
    }
    const [result] = await pool.query(sql, params);
    const match = sql.match(/INTO\s+`?(\w+)`?\s*\(/i);
    if (match) {
      const rows = await query(
        `SELECT * FROM \`${match[1]}\` WHERE id = ?`,
        [result.insertId]
      );
      return rows[0] || { id: result.insertId };
    }
    return { id: result.insertId };
  },

  // DELETE / UPDATE 返回影响行数
  async change(sql, params = []) {
    sql = translateSql(sql);
    if (isSqliteMode) {
      return sqlite.prepare(sql).run(...params).changes;
    }
    const [result] = await pool.query(sql, params);
    return result.affectedRows;
  }
};
