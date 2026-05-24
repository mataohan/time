// 数据库层：TiDB Cloud（MySQL 协议）连接池
const mysql = require('mysql2/promise');

let pool;

async function init() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('❌ DATABASE_URL 环境变量未设置！请在 Render 环境变量中配置 TiDB Cloud 连接字符串。');
    console.error('   格式: mysql://user:password@host:port/database');
    process.exit(1);
  }

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
  return 'tidb';
}

// 通用查询
async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

module.exports = {
  type,
  init,

  // 执行写操作（不返回结果）
  async run(sql, params = []) {
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
    await pool.query(sql);
  },

  // INSERT 并返回新插入的完整行
  async insert(sql, params = []) {
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
    const [result] = await pool.query(sql, params);
    return result.affectedRows;
  }
};
