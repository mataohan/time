const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'time_master_secret_2025';
const SALT_ROUNDS = 10;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// CORS：生产环境允许 Render 域名，开发环境允许所有来源
const corsOptions = IS_PRODUCTION
  ? { origin: process.env.CORS_ORIGIN || '*', credentials: true }
  : { origin: '*', credentials: true };
app.use(cors(corsOptions));
app.use(express.json());

// 强制设置静态文件 MIME 类型，避免 Render 代理返回错误 Content-Type
app.use(express.static(path.join(process.cwd(), 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    } else if (filePath.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
    } else if (filePath.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
    } else if (filePath.endsWith('.json')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    } else if (filePath.endsWith('.png')) {
      res.setHeader('Content-Type', 'image/png');
    } else if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) {
      res.setHeader('Content-Type', 'image/jpeg');
    } else if (filePath.endsWith('.svg')) {
      res.setHeader('Content-Type', 'image/svg+xml');
    } else if (filePath.endsWith('.ico')) {
      res.setHeader('Content-Type', 'image/x-icon');
    }
  }
}));

// ========== TiDB Cloud 表初始化 ==========

// 检查某表是否存在指定列（兼容 SQLite / TiDB）
async function columnExists(table, column) {
  if (db.type() === 'sqlite') {
    const rows = await db.all(`PRAGMA table_info(${table})`);
    return rows.some(r => r.name === column);
  }
  const rows = await db.all(`SHOW COLUMNS FROM ${table} LIKE '${column}'`);
  return rows.length > 0;
}

// 日期字符串加 N 天（UTC 安全，无时区偏移），返回 'YYYY-MM-DD'
function addDaysDate(dateStr, days) {
  const d = new Date(String(dateStr).substring(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().substring(0, 10);
}

// 本地时区今天的 'YYYY-MM-DD'
function todayStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

async function initDB() {
  console.log('[INIT] 开始检查数据库表...');

  // 兜底：确保 users 表存在（最关键的登录依赖）
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        nickname VARCHAR(100),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const userCount = await db.get('SELECT COUNT(*) as cnt FROM users');
    console.log(`[INIT] users 表就绪，现有 ${userCount.cnt} 个用户`);
  } catch (err) {
    console.error('[INIT] ❌ 创建 users 表失败:', err.message);
    throw err;
  }
  await db.exec(`
    CREATE TABLE IF NOT EXISTS diaries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      category VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      content TEXT,
      mood VARCHAR(10) DEFAULT '',
      image_url TEXT,
      diary_date DATE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      category VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      content TEXT,
      completed INT DEFAULT 0,
      priority INT DEFAULT 0,
      due_date DATE,
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // 扩宽 category 字段兼容已有表
  try { await db.exec("ALTER TABLE diaries MODIFY category VARCHAR(50) NOT NULL"); } catch (e) { /* 忽略 */ }
  try { await db.exec("ALTER TABLE tasks MODIFY category VARCHAR(50) NOT NULL"); } catch (e) { /* 忽略 */ }

  // v2.1 未完成功能：添加 status / unfinished_reason / unfinished_at
  try { await db.exec("ALTER TABLE tasks ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'pending'"); } catch (e) { /* 已存在 */ }
  try { await db.exec("ALTER TABLE tasks ADD COLUMN unfinished_reason TEXT"); } catch (e) { /* 已存在 */ }
  try { await db.exec("ALTER TABLE tasks ADD COLUMN unfinished_at DATETIME"); } catch (e) { /* 已存在 */ }
  // 迁移已有数据：completed=1 → status='completed'
  try { await db.exec("UPDATE tasks SET status = 'completed' WHERE completed = 1 AND (status = 'pending' OR status IS NULL)"); } catch (e) { /* 忽略 */ }

  // v2.3 完成说明：给 tasks 表增加 completion_note 字段
  try { await db.exec("ALTER TABLE tasks ADD COLUMN completion_note TEXT"); } catch (e) { /* 已存在 */ }

  // v2.4 宠物档案：创建 pets 表
  await db.exec(`
    CREATE TABLE IF NOT EXISTS pets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      name VARCHAR(50) NOT NULL,
      birth_date DATE,
      photo_url VARCHAR(500),
      species VARCHAR(20) DEFAULT 'cat',
      breed VARCHAR(50),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // v2.4 宠物健康事件表
  await db.exec(`
    CREATE TABLE IF NOT EXISTS pet_health_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      pet_id INT NOT NULL,
      event_type VARCHAR(30) NOT NULL,
      event_date DATE NOT NULL,
      title VARCHAR(100),
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE
    )
  `);

  // v2.2 记账功能：创建 expenses 表
  await db.exec(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      category VARCHAR(50) NOT NULL,
      note TEXT,
      expense_date DATE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // v2.4 箍牙提醒功能：创建 orthodontic_records 表
  await db.exec(`
    CREATE TABLE IF NOT EXISTS orthodontic_records (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      start_date DATE NOT NULL,
      tray_number INT NOT NULL DEFAULT 1,
      change_interval INT NOT NULL DEFAULT 14,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // v2.8 碳循环功能：创建 carbon_cycle 表
  await db.exec(`
    CREATE TABLE IF NOT EXISTS carbon_cycle (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      start_date DATE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // v2.9 华住会间夜：创建 hotel_stays 表
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hotel_stays (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      hotel_name VARCHAR(100) NOT NULL,
      start_date DATE NOT NULL,
      duration INT NOT NULL DEFAULT 1,
      points INT DEFAULT 0,
      is_credited BOOLEAN DEFAULT 0,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // v3.1 华住会间夜增强：为已有表补充 积分 / 是否到账 / 备注 字段（兼容旧数据）
  try {
    if (!(await columnExists('hotel_stays', 'points'))) await db.exec('ALTER TABLE hotel_stays ADD COLUMN points INT DEFAULT 0');
    if (!(await columnExists('hotel_stays', 'is_credited'))) await db.exec('ALTER TABLE hotel_stays ADD COLUMN is_credited BOOLEAN DEFAULT 0');
    if (!(await columnExists('hotel_stays', 'notes'))) await db.exec('ALTER TABLE hotel_stays ADD COLUMN notes TEXT');
  } catch (e) {
    console.warn('[INIT] hotel_stays 补充字段失败（请检查表结构）:', e.message);
  }

  // v3.3 华住会连住：check_in_date → start_date + duration 迁移（已有数据 duration=1）
  try {
    const hasCheckIn = await columnExists('hotel_stays', 'check_in_date');
    const hasStart = await columnExists('hotel_stays', 'start_date');
    if (hasCheckIn && !hasStart) {
      await db.exec('ALTER TABLE hotel_stays ADD COLUMN start_date DATE');
      if (!(await columnExists('hotel_stays', 'duration'))) {
        await db.exec('ALTER TABLE hotel_stays ADD COLUMN duration INT NOT NULL DEFAULT 1');
      }
      await db.run('UPDATE hotel_stays SET start_date = check_in_date, duration = 1 WHERE start_date IS NULL');
      try {
        await db.exec('ALTER TABLE hotel_stays DROP COLUMN check_in_date');
      } catch (e) {
        console.warn('[INIT] 无法删除 check_in_date 列（忽略）:', e.message);
      }
      console.log('[INIT] hotel_stays 已迁移为 start_date + duration 结构');
    } else if (!(await columnExists('hotel_stays', 'duration'))) {
      // 兜底：已有 start_date 但缺 duration 列
      await db.exec('ALTER TABLE hotel_stays ADD COLUMN duration INT NOT NULL DEFAULT 1');
      console.log('[INIT] hotel_stays 已补充 duration 列');
    }
  } catch (e) {
    console.warn('[INIT] hotel_stays 迁移跳过:', e.message);
  }

  console.log(`✅ 数据库表初始化完成 (${process.env.DATABASE_URL ? 'TiDB Cloud' : 'SQLite'})`);
}

// ========== JWT 认证中间件 ==========
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.log(`[AUTH] 拒绝: 未携带令牌 (${req.method} ${req.path})`);
    return res.status(401).json({ error: '未授权访问，请先登录', code: 'NO_TOKEN' });
  }
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.userEmail = decoded.email;

    // 详细日志：显示 token 的签发时间和过期时间
    const iatDate = new Date(decoded.iat * 1000).toISOString();
    const expDate = new Date(decoded.exp * 1000).toISOString();
    const remainingMs = decoded.exp * 1000 - Date.now();
    const remainingDays = Math.max(0, (remainingMs / 86400000).toFixed(1));
    console.log(`[AUTH] ✅ 令牌验证通过: userId=${decoded.userId}, email=${decoded.email}, 签发=${iatDate}, 过期=${expDate}, 剩余=${remainingDays}天 (${req.method} ${req.path})`);

    next();
  } catch (err) {
    const token = authHeader.split(' ')[1];
    // 尝试解码已过期的 token 以获取更多诊断信息
    let expiredInfo = '';
    try {
      const decoded = jwt.decode(token, { complete: true });
      if (decoded && decoded.payload) {
        const expDate = new Date(decoded.payload.exp * 1000).toISOString();
        const iatDate = new Date(decoded.payload.iat * 1000).toISOString();
        expiredInfo = `userId=${decoded.payload.userId}, 签发=${iatDate}, 过期=${expDate}, 当前时间=${new Date().toISOString()}`;
      }
    } catch (e) { /* ignore decode error */ }

    if (err.name === 'TokenExpiredError') {
      console.log(`[AUTH] ❌ 令牌已过期 (${req.method} ${req.path}): ${expiredInfo || err.message}, expiredAt=${err.expiredAt}`);
      return res.status(401).json({ error: '登录已过期，请重新登录', code: 'TOKEN_EXPIRED' });
    }
    if (err.message && err.message.includes('invalid signature')) {
      console.error(`[AUTH] ❌ Token验证失败: invalid signature - 请检查 JWT_SECRET 是否一致！`);
      console.error(`[AUTH]    当前服务器 JWT_SECRET 来源: ${process.env.JWT_SECRET ? '环境变量' : '默认值(time_master_secret_2025)'}`);
      console.error(`[AUTH]    如果此 token 是由另一个实例签发的，说明两个实例的 JWT_SECRET 不一致`);
      console.error(`[AUTH]    解决方案: 在 Render 上设置 JWT_SECRET=time_master_secret_2025 环境变量`);
      console.error(`[AUTH]    请求详情: ${req.method} ${req.path}, ${expiredInfo}`);
      return res.status(401).json({ error: '登录凭证无效，请重新登录（可能是服务器密钥不一致）', code: 'TOKEN_SIGNATURE_MISMATCH' });
    }
    console.log(`[AUTH] ❌ 令牌无效 (${req.method} ${req.path}): ${err.message} ${expiredInfo}`);
    return res.status(401).json({ error: '登录已过期，请重新登录', code: 'TOKEN_INVALID' });
  }
}

// ========== Token 诊断接口（不经过 authMiddleware，方便排查问题） ==========
app.get('/api/auth/debug', (req, res) => {
  const authHeader = req.headers.authorization;
  const result = {
    hasAuthHeader: !!authHeader,
    authHeaderPrefix: authHeader ? authHeader.substring(0, 20) + '...' : 'none',
    serverTime: new Date().toISOString(),
    jwtSecretSource: process.env.JWT_SECRET ? '环境变量（自定义）' : '默认值（time_master_secret_2025）',
    jwtSecretLength: JWT_SECRET.length,
    serverUptime: Math.floor(process.uptime()) + 's'
  };

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      result.valid = true;
      result.userId = decoded.userId;
      result.email = decoded.email;
      result.issuedAt = new Date(decoded.iat * 1000).toISOString();
      result.expiresAt = new Date(decoded.exp * 1000).toISOString();
      result.remainingDays = ((decoded.exp * 1000 - Date.now()) / 86400000).toFixed(1);
      result.remainingHours = ((decoded.exp * 1000 - Date.now()) / 3600000).toFixed(1);
    } catch (err) {
      result.valid = false;
      result.error = err.name + ': ' + err.message;
      // 尝试解码过期的 token
      try {
        const decoded = jwt.decode(token, { complete: true });
        if (decoded && decoded.payload) {
          result.decodedPayload = decoded.payload;
          result.expiredAt = new Date(decoded.payload.exp * 1000).toISOString();
        }
      } catch (e) {
        result.decodeError = e.message;
      }
    }
  }

  res.json(result);
});

// ========== 健康检查 ==========
app.get('/api/health', async (req, res) => {
  let dbStatus = 'disconnected';
  let dbDetail = '';
  let userCount = 0;
  try {
    const [dbCheck, userResult] = await Promise.all([
      db.get('SELECT 1').catch(e => { throw e; }),
      db.get('SELECT COUNT(*) as cnt FROM users').catch(() => null)
    ]);
    dbStatus = 'connected';
    if (userResult) userCount = userResult.cnt;
  } catch (e) {
    dbStatus = 'error';
    dbDetail = e.message;
  }
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: IS_PRODUCTION ? 'production' : 'development',
    nodeVersion: process.version,
    database: dbStatus,
    dbDetail: dbDetail || null,
    userCount: userCount,
    uptime: Math.floor(process.uptime()) + 's',
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
  });
});

// ========== 认证路由 ==========

app.post('/api/register', async (req, res) => {
  const startTime = Date.now();
  try {
    const { email, password, nickname } = req.body;
    console.log(`[REGISTER] 收到注册请求: email=${email}`);

    if (!email || !password) {
      console.log(`[REGISTER] 拒绝: 邮箱或密码为空`);
      return res.status(400).json({ success: false, error: '邮箱和密码不能为空' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      console.log(`[REGISTER] 拒绝: 邮箱格式不正确`);
      return res.status(400).json({ success: false, error: '邮箱格式不正确' });
    }
    if (password.length < 6) {
      console.log(`[REGISTER] 拒绝: 密码过短`);
      return res.status(400).json({ success: false, error: '密码至少6位' });
    }

    // 检查数据库连接（带超时）
    try {
      await Promise.race([
        db.get('SELECT 1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('数据库查询超时(5s)')), 5000))
      ]);
    } catch (dbErr) {
      console.error(`[REGISTER] 数据库连接失败:`, dbErr.message);
      return res.status(500).json({ success: false, error: '数据库连接失败，请稍后再试' });
    }

    const existing = await db.get('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) {
      console.log(`[REGISTER] 拒绝: 邮箱已注册`);
      return res.status(400).json({ success: false, error: '该邮箱已被注册' });
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await db.insert(
      'INSERT INTO users (email, password, nickname) VALUES (?, ?, ?)',
      [email, hashedPassword, nickname || email.split('@')[0]]
    );

    const token = jwt.sign({ userId: user.id, email }, JWT_SECRET, { expiresIn: '30d' });
    const elapsed = Date.now() - startTime;

    // 验证签发后的 token 信息
    const decoded = jwt.decode(token);
    const expDate = new Date(decoded.exp * 1000).toISOString();
    console.log(`[REGISTER] 注册成功: userId=${user.id}, email=${email}, token过期=${expDate}, 有效期=30天 (${elapsed}ms)`);
    res.json({
      success: true,
      message: '注册成功',
      token,
      user: { id: user.id, email, nickname: user.nickname }
    });
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error(`[REGISTER] 服务器错误 (${elapsed}ms):`, err.message, err.stack);
    res.status(500).json({ success: false, error: '服务器内部错误: ' + (IS_PRODUCTION ? '请稍后再试' : err.message) });
  }
});

app.post('/api/login', async (req, res) => {
  const startTime = Date.now();
  try {
    const { email, password } = req.body;
    console.log(`[LOGIN] 收到登录请求: email=${email}`);

    if (!email || !password) {
      console.log(`[LOGIN] 拒绝: 邮箱或密码为空`);
      return res.status(400).json({ success: false, error: '邮箱和密码不能为空' });
    }

    // 检查数据库连接（带超时）
    try {
      await Promise.race([
        db.get('SELECT 1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('数据库查询超时(5s)')), 5000))
      ]);
    } catch (dbErr) {
      console.error(`[LOGIN] 数据库连接失败:`, dbErr.message);
      return res.status(500).json({ success: false, error: '数据库连接失败，请稍后再试' });
    }

    const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      console.log(`[LOGIN] 拒绝: 用户不存在 (email=${email})`);
      return res.status(400).json({ success: false, error: '邮箱或密码错误' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      console.log(`[LOGIN] 拒绝: 密码错误 (email=${email})`);
      return res.status(400).json({ success: false, error: '邮箱或密码错误' });
    }

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    const elapsed = Date.now() - startTime;

    // 验证签发后的 token 信息
    const decoded = jwt.decode(token);
    const expDate = new Date(decoded.exp * 1000).toISOString();
    console.log(`[LOGIN] 登录成功: userId=${user.id}, email=${email}, token过期=${expDate}, 有效期=30天 (${elapsed}ms)`);
    res.json({
      success: true,
      message: '登录成功',
      token,
      user: { id: user.id, email: user.email, nickname: user.nickname }
    });
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error(`[LOGIN] 服务器错误 (${elapsed}ms):`, err.message, err.stack);
    res.status(500).json({ success: false, error: '服务器内部错误: ' + (IS_PRODUCTION ? '请稍后再试' : err.message) });
  }
});

app.post('/api/logout', (req, res) => {
  res.json({ message: '已退出' });
});

// ========== 日记路由 (diaries) ==========

// 获取用户所有日记（支持按月筛选 & 按分类筛选）
app.get('/api/diaries', authMiddleware, async (req, res) => {
  const { year, month, category } = req.query;
  let sql = 'SELECT * FROM diaries WHERE user_id = ?';
  const params = [req.userId];

  if (year && month) {
    // 使用 YEAR() 和 MONTH() 函数，精准匹配，不受日期边界和时区影响
    sql += ' AND YEAR(diary_date) = ? AND MONTH(diary_date) = ?';
    params.push(parseInt(year), parseInt(month));
  } else if (year) {
    sql += ' AND YEAR(diary_date) = ?';
    params.push(parseInt(year));
  }
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }

  sql += ' ORDER BY diary_date DESC, created_at DESC';

  // 调试日志：打印查询参数和 SQL
  console.log(`[API] 接收参数: year=${year}, month=${month}, category=${category || '无'}`);
  console.log(`[API] SQL: ${sql}, params: [${params.join(', ')}]`);

  const diaries = await db.all(sql, params);
  res.json({ diaries });
});

// 获取某一天的日记
app.get('/api/diaries/date/:date', authMiddleware, async (req, res) => {
  const diaries = await db.all(
    'SELECT * FROM diaries WHERE user_id = ? AND diary_date = ? ORDER BY created_at DESC',
    [req.userId, req.params.date]
  );
  res.json({ diaries });
});

// 创建日记
app.post('/api/diaries', authMiddleware, async (req, res) => {
  const { category, title, content, diary_date, mood, image_url } = req.body;
  if (!category || !title || !diary_date) {
    return res.status(400).json({ error: '分类、标题和日期不能为空' });
  }
  if (!['健身', '影视', '学习', '工作', '日常', '游戏', '视频消化'].includes(category)) {
    return res.status(400).json({ error: '无效的分类' });
  }

  const diary = await db.insert(
    'INSERT INTO diaries (user_id, category, title, content, diary_date, mood, image_url) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [req.userId, category, title, content || '', diary_date, mood || '', image_url || '']
  );
  res.json({ message: '创建成功', diary });
});

// 更新日记
app.put('/api/diaries/:id', authMiddleware, async (req, res) => {
  const diary = await db.get('SELECT * FROM diaries WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  if (!diary) return res.status(404).json({ error: '日记不存在' });

  const { category, title, content, mood, image_url } = req.body;
  await db.run(
    'UPDATE diaries SET category=?, title=?, content=?, mood=?, image_url=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?',
    [
      category !== undefined ? category : diary.category,
      title !== undefined ? title : diary.title,
      content !== undefined ? content : diary.content,
      mood !== undefined ? mood : diary.mood,
      image_url !== undefined ? image_url : diary.image_url,
      req.params.id, req.userId
    ]
  );
  const updated = await db.get('SELECT * FROM diaries WHERE id = ?', [req.params.id]);
  res.json({ message: '更新成功', diary: updated });
});

// 删除日记
app.delete('/api/diaries/:id', authMiddleware, async (req, res) => {
  const changes = await db.change('DELETE FROM diaries WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  if (changes === 0) return res.status(404).json({ error: '日记不存在' });
  res.json({ message: '删除成功' });
});

// ========== 待办路由 ==========

app.get('/api/tasks', authMiddleware, async (req, res) => {
  const { category, completed, status } = req.query;
  let sql = 'SELECT * FROM tasks WHERE user_id = ?';
  const params = [req.userId];

  if (category) { sql += ' AND category = ?'; params.push(category); }

  // 支持 status 参数（pending / completed / unfinished），兼容旧的 completed 参数
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  } else if (completed !== undefined) {
    // 旧版兼容：completed=1 → status='completed'，completed=0 → status='pending'
    sql += ' AND status = ?';
    params.push(parseInt(completed) === 1 ? 'completed' : 'pending');
  }

  sql += ' ORDER BY priority DESC, created_at DESC';
  const tasks = await db.all(sql, params);
  res.json({ tasks });
});

app.post('/api/tasks', authMiddleware, async (req, res) => {
  const { category, title, content, priority, due_date } = req.body;
  if (!category || !title) return res.status(400).json({ error: '分类和标题不能为空' });
  if (!['健身', '影视', '学习', '工作', '日常', '游戏', '视频消化'].includes(category)) return res.status(400).json({ error: '无效的分类' });

  const task = await db.insert(
    'INSERT INTO tasks (user_id, category, title, content, priority, due_date, status, completed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [req.userId, category, title, content || '', priority || 0, due_date || null, 'pending', 0]
  );
  res.json({ message: '创建成功', task });
});

app.put('/api/tasks/:id', authMiddleware, async (req, res) => {
  const task = await db.get('SELECT * FROM tasks WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  if (!task) return res.status(404).json({ error: '事项不存在' });

  const { category, title, content, completed, priority, due_date, completed_at, status, unfinished_reason, completion_note } = req.body;

  const setClauses = [];
  const params = [];

  if (category !== undefined) { setClauses.push('category=?'); params.push(category); }
  if (title !== undefined) { setClauses.push('title=?'); params.push(title); }
  if (content !== undefined) { setClauses.push('content=?'); params.push(content); }
  if (priority !== undefined) { setClauses.push('priority=?'); params.push(priority); }
  if (due_date !== undefined) { setClauses.push('due_date=?'); params.push(due_date); }
  if (completion_note !== undefined) { setClauses.push('completion_note=?'); params.push(completion_note || null); }

  // 处理 status 字段的状态转换
  if (status !== undefined) {
    if (status === 'completed') {
      setClauses.push('status=?', 'completed=?', 'completed_at=CURRENT_TIMESTAMP');
      params.push('completed', 1);
    } else if (status === 'unfinished') {
      if (!unfinished_reason || !unfinished_reason.trim()) {
        return res.status(400).json({ error: '请填写未完成原因' });
      }
      setClauses.push('status=?', 'completed=?', 'unfinished_reason=?', 'unfinished_at=CURRENT_TIMESTAMP');
      params.push('unfinished', 0, unfinished_reason);
    } else if (status === 'pending') {
      setClauses.push('status=?', 'completed=?', 'unfinished_reason=NULL', 'unfinished_at=NULL', 'completed_at=NULL');
      params.push('pending', 0);
    }
  }

  // 向后兼容：处理旧的 completed 字段
  if (completed !== undefined && status === undefined) {
    setClauses.push('completed=?'); params.push(completed);
    setClauses.push('status=?'); params.push(completed ? 'completed' : 'pending');
    if (completed && !task.completed) setClauses.push('completed_at=CURRENT_TIMESTAMP');
    if (!completed && task.completed) setClauses.push('completed_at=NULL');
  }

  // 处理完成时间的独立编辑
  if (completed_at !== undefined && status === undefined && completed === undefined) {
    setClauses.push('completed_at=?'); params.push(completed_at || null);
  }

  setClauses.push('updated_at=CURRENT_TIMESTAMP');
  params.push(req.params.id, req.userId);

  await db.run('UPDATE tasks SET ' + setClauses.join(', ') + ' WHERE id=? AND user_id=?', params);
  const updated = await db.get('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
  res.json({ message: '更新成功', task: updated });
});

app.delete('/api/tasks/:id', authMiddleware, async (req, res) => {
  const changes = await db.change('DELETE FROM tasks WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  if (changes === 0) return res.status(404).json({ error: '事项不存在' });
  res.json({ message: '删除成功' });
});

app.patch('/api/tasks/:id/toggle', authMiddleware, async (req, res) => {
  const task = await db.get('SELECT * FROM tasks WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  if (!task) return res.status(404).json({ error: '事项不存在' });

  // toggle 仅在 pending 和 completed 之间切换；unfinished 则恢复为 pending
  const curStatus = task.status || (task.completed ? 'completed' : 'pending');
  let newStatus, newCompleted;
  if (curStatus === 'pending') {
    newStatus = 'completed'; newCompleted = 1;
  } else {
    newStatus = 'pending'; newCompleted = 0;
  }

  if (newStatus === 'completed') {
    await db.run(
      'UPDATE tasks SET status=?, completed=?, completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?',
      [newStatus, newCompleted, req.params.id]
    );
  } else {
    await db.run(
      'UPDATE tasks SET status=?, completed=?, completed_at=NULL, unfinished_reason=NULL, unfinished_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?',
      [newStatus, newCompleted, req.params.id]
    );
  }
  const updated = await db.get('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
  res.json({ message: '状态已更新', task: updated });
});

// ========== 记账路由 ==========

// 获取消费记录（支持 year/month/date 灵活筛选，date 优先）
app.get('/api/expenses', authMiddleware, async (req, res) => {
  const { year, month, date, category, keyword, minAmount, maxAmount } = req.query;
  let sql = 'SELECT * FROM expenses WHERE user_id = ?';
  const params = [req.userId];

  // date 参数优先：如果提供了 date，忽略 year 和 month，直接按日期查询
  if (date && date.trim()) {
    // 支持 YYYY-MM-DD 或纯数字日期
    const dateStr = String(date).trim();
    sql += ' AND DATE(expense_date) = ?';
    params.push(dateStr.substring(0, 10));
  } else {
    // year 和 month 的筛选
    const hasYear = year && year !== 'all' && year !== '';
    const hasMonth = month && month !== 'all' && month !== '';

    if (hasYear && hasMonth) {
      sql += ' AND YEAR(expense_date) = ? AND MONTH(expense_date) = ?';
      params.push(parseInt(year), parseInt(month));
    } else if (hasYear) {
      sql += ' AND YEAR(expense_date) = ?';
      params.push(parseInt(year));
    } else if (hasMonth) {
      sql += ' AND MONTH(expense_date) = ?';
      params.push(parseInt(month));
    }
    // year 和 month 都为 'all'/空：不限制时间
  }

  if (category && category !== 'all') {
    sql += ' AND category = ?';
    params.push(category);
  }

  // 关键字模糊搜索：备注和分类
  if (keyword && keyword.trim()) {
    const kw = '%' + keyword.trim() + '%';
    sql += ' AND (note LIKE ? OR category LIKE ?)';
    params.push(kw, kw);
  }

  // 金额区间筛选
  if (minAmount !== undefined && minAmount !== '') {
    sql += ' AND amount >= ?';
    params.push(parseFloat(minAmount));
  }
  if (maxAmount !== undefined && maxAmount !== '') {
    sql += ' AND amount <= ?';
    params.push(parseFloat(maxAmount));
  }

  sql += ' ORDER BY expense_date DESC, created_at DESC';

  // 调试日志
  console.log(`[API] 接收参数: year=${year}, month=${month}, date=${date || '无'}, category=${category || '无'}, keyword=${keyword || '无'}, minAmount=${minAmount || '无'}, maxAmount=${maxAmount || '无'}`);
  console.log(`[API] SQL: ${sql}, params: [${params.join(', ')}]`);

  const expenses = await db.all(sql, params);
  res.json({ expenses });
});

// 创建消费记录
app.post('/api/expenses', authMiddleware, async (req, res) => {
  const { amount, category, note, expense_date } = req.body;
  if (!amount || !category || !expense_date) {
    return res.status(400).json({ error: '金额、分类和日期不能为空' });
  }
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: '金额必须为正数' });
  if (!['餐饮', '购物', '交通', '娱乐', '医疗', '其他', '爱车', '路费', '住宿'].includes(category)) {
    return res.status(400).json({ error: '无效的分类' });
  }

  // 确保 expense_date 为 YYYY-MM-DD 格式（截断时区信息，避免日期偏移）
  const safeDate = String(expense_date).substring(0, 10);

  const expense = await db.insert(
    'INSERT INTO expenses (user_id, amount, category, note, expense_date) VALUES (?, ?, ?, ?, ?)',
    [req.userId, amt, category, note || '', safeDate]
  );
  console.log(`[EXPENSE] 创建成功: id=${expense.id}, amount=${amt}, date=${safeDate}`);
  res.json({ message: '记账成功', expense });
});

// 更新消费记录
app.put('/api/expenses/:id', authMiddleware, async (req, res) => {
  const expense = await db.get('SELECT * FROM expenses WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  if (!expense) return res.status(404).json({ error: '消费记录不存在' });
  const { amount, category, note, expense_date } = req.body;
  const amt = amount !== undefined ? parseFloat(amount) : expense.amount;
  if (amount !== undefined && (isNaN(amt) || amt <= 0)) return res.status(400).json({ error: '金额必须为正数' });

  // 确保日期为 YYYY-MM-DD 格式
  const safeDate = expense_date ? String(expense_date).substring(0, 10) : expense.expense_date;

  await db.run(
    'UPDATE expenses SET amount=?, category=?, note=?, expense_date=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?',
    [amt, category || expense.category, note !== undefined ? note : expense.note, safeDate, req.params.id, req.userId]
  );
  const updated = await db.get('SELECT * FROM expenses WHERE id = ?', [req.params.id]);
  res.json({ message: '更新成功', expense: updated });
});

// 删除消费记录
app.delete('/api/expenses/:id', authMiddleware, async (req, res) => {
  const changes = await db.change('DELETE FROM expenses WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  if (changes === 0) return res.status(404).json({ error: '消费记录不存在' });
  res.json({ message: '删除成功' });
});

// 记账统计：返回年总额、月总额、分类汇总（支持 date/year/month 灵活筛选）
app.get('/api/expenses/stats', authMiddleware, async (req, res) => {
  const { year, month, date, category, keyword, minAmount, maxAmount } = req.query;

  // 构建额外筛选条件
  const catFilter = (category && category !== 'all') ? category : null;

  let extraSql = '';
  const extraParams = [];

  if (catFilter) {
    extraSql += ' AND category = ?';
    extraParams.push(catFilter);
  }

  if (keyword && keyword.trim()) {
    const kw = '%' + keyword.trim() + '%';
    extraSql += ' AND (note LIKE ? OR category LIKE ?)';
    extraParams.push(kw, kw);
  }

  if (minAmount !== undefined && minAmount !== '') {
    extraSql += ' AND amount >= ?';
    extraParams.push(parseFloat(minAmount));
  }
  if (maxAmount !== undefined && maxAmount !== '') {
    extraSql += ' AND amount <= ?';
    extraParams.push(parseFloat(maxAmount));
  }

  // 构建时间筛选条件
  let timeSql = '';
  const timeParams = [];

  // date 为 'all' 或空时视为无日期筛选（避免 DATE(expense_date)='all' 查询不到记录）
  if (date && date !== 'all' && date.trim()) {
    // 日期优先：精确到某一天
    const dateStr = String(date).trim().substring(0, 10);
    timeSql = ' AND DATE(expense_date) = ?';
    timeParams.push(dateStr);
    console.log(`[API Stats] date=${dateStr}, category=${catFilter || '无'}, keyword=${keyword || '无'}`);
  } else {
    const hasYear = year && year !== 'all' && year !== '';
    const hasMonth = month && month !== 'all' && month !== '';

    if (hasYear && hasMonth) {
      timeSql = ' AND YEAR(expense_date) = ? AND MONTH(expense_date) = ?';
      timeParams.push(parseInt(year), parseInt(month));
    } else if (hasYear) {
      timeSql = ' AND YEAR(expense_date) = ?';
      timeParams.push(parseInt(year));
    } else if (hasMonth) {
      timeSql = ' AND MONTH(expense_date) = ?';
      timeParams.push(parseInt(month));
    }
    // year 和 month 都为 'all'/空：不限制时间
    console.log(`[API Stats] year=${year}, month=${month}, category=${catFilter || '无'}, keyword=${keyword || '无'}`);
  }

  const baseWhere = 'WHERE user_id = ?' + timeSql + extraSql;
  const baseParams = [req.userId, ...timeParams, ...extraParams];

  // 总金额（用于没有具体年月时的全量统计）
  const allRow = await db.get(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM expenses ' + baseWhere,
    baseParams
  );

  // 分类汇总
  const catRows = await db.all(
    'SELECT category, COALESCE(SUM(amount), 0) AS total FROM expenses ' + baseWhere + ' GROUP BY category',
    baseParams
  );

  const categories = {};
  for (const row of catRows) {
    categories[row.category] = row.total;
  }

  // 如果筛选了具体日期，月总额和年总额等于该日总额
  let yearTotal = allRow.total;
  let monthTotal = allRow.total;

  // 当有具体年月时，年总额和月总额分别计算
  if (!date || date === 'all' || !date.trim()) {
    const hasYear = year && year !== 'all' && year !== '';
    const hasMonth = month && month !== 'all' && month !== '';

    if (hasYear && hasMonth) {
      // 年总额
      const yearRow = await db.get(
        'SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE user_id = ? AND YEAR(expense_date) = ?' + extraSql,
        [req.userId, parseInt(year), ...extraParams]
      );
      yearTotal = yearRow.total;
      monthTotal = allRow.total; // monthTotal 即当前筛选结果
    } else if (hasYear) {
      yearTotal = allRow.total;
      monthTotal = allRow.total;
    } else if (hasMonth) {
      yearTotal = allRow.total;
      monthTotal = allRow.total;
    }
    // 都为 all：yearTotal 和 monthTotal 都等于全量总额
  }
  // date 模式：yearTotal 和 monthTotal 都等于当天总额

  // 调试：返回满足当月条件的记录数，帮助排查 "统计为0" 问题
  const countRow = await db.get(
    'SELECT COUNT(*) AS cnt FROM expenses ' + baseWhere,
    baseParams
  );

  res.json({
    yearTotal: yearTotal,
    monthTotal: monthTotal,
    categories,
    _debug: {
      userId: req.userId,
      year: year,
      month: month,
      date: date || null,
      timeSql: timeSql,
      timeParams: timeParams,
      matchedCount: countRow ? countRow.cnt : 0,
      baseParams: baseParams
    }
  });
});

// ========== 箍牙提醒路由 ==========

// 获取当前用户的箍牙记录（返回最新一条）
app.get('/api/orthodontic', authMiddleware, async (req, res) => {
  const record = await db.get(
    'SELECT * FROM orthodontic_records WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [req.userId]
  );
  if (!record) {
    return res.json({ record: null });
  }
  // 返回记录 + 计算下次换牙套日期
  const startDate = new Date(record.start_date);
  const nextDate = new Date(startDate);
  nextDate.setDate(nextDate.getDate() + record.change_interval);

  // 计算距今已佩戴天数和剩余天数
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startDay = new Date(record.start_date);
  startDay.setHours(0, 0, 0, 0);
  const daysWorn = Math.floor((today - startDay) / (1000 * 60 * 60 * 24));
  const daysLeft = Math.max(0, Math.ceil((nextDate - today) / (1000 * 60 * 60 * 24)));

  // 判断是否过期
  const isOverdue = daysLeft === 0 && daysWorn >= record.change_interval;

  res.json({
    record: {
      ...record,
      next_change_date: nextDate.toISOString().substring(0, 10),
      days_worn: daysWorn,
      days_left: daysLeft,
      is_overdue: isOverdue
    }
  });
});

// 创建或更新箍牙记录
app.post('/api/orthodontic', authMiddleware, async (req, res) => {
  const { start_date, tray_number, change_interval } = req.body;
  if (!start_date) {
    return res.status(400).json({ error: '佩戴开始日期不能为空' });
  }
  const safeDate = String(start_date).substring(0, 10);
  const trayNum = parseInt(tray_number) || 1;
  const interval = parseInt(change_interval) || 14;

  // 检查是否已有记录
  const existing = await db.get(
    'SELECT * FROM orthodontic_records WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [req.userId]
  );

  let record;
  if (existing) {
    await db.run(
      'UPDATE orthodontic_records SET start_date = ?, tray_number = ?, change_interval = ? WHERE id = ? AND user_id = ?',
      [safeDate, trayNum, interval, existing.id, req.userId]
    );
    record = await db.get('SELECT * FROM orthodontic_records WHERE id = ?', [existing.id]);
  } else {
    record = await db.insert(
      'INSERT INTO orthodontic_records (user_id, start_date, tray_number, change_interval) VALUES (?, ?, ?, ?)',
      [req.userId, safeDate, trayNum, interval]
    );
  }

  // 计算下次换牙套日期
  const startDate2 = new Date(record.start_date);
  const nextDate = new Date(startDate2);
  nextDate.setDate(nextDate.getDate() + record.change_interval);

  res.json({
    message: existing ? '更新成功' : '创建成功',
    record: {
      ...record,
      next_change_date: nextDate.toISOString().substring(0, 10)
    }
  });
});

// 更新箍牙记录
app.put('/api/orthodontic', authMiddleware, async (req, res) => {
  const existing = await db.get(
    'SELECT * FROM orthodontic_records WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [req.userId]
  );
  if (!existing) {
    return res.status(404).json({ error: '暂无箍牙记录' });
  }

  const { start_date, tray_number, change_interval } = req.body;
  const safeDate = start_date ? String(start_date).substring(0, 10) : existing.start_date;
  const trayNum = tray_number !== undefined ? parseInt(tray_number) : existing.tray_number;
  const interval = change_interval !== undefined ? parseInt(change_interval) : existing.change_interval;

  await db.run(
    'UPDATE orthodontic_records SET start_date = ?, tray_number = ?, change_interval = ? WHERE id = ? AND user_id = ?',
    [safeDate, trayNum, interval, existing.id, req.userId]
  );

  const record = await db.get('SELECT * FROM orthodontic_records WHERE id = ?', [existing.id]);

  const startDate2 = new Date(record.start_date);
  const nextDate = new Date(startDate2);
  nextDate.setDate(nextDate.getDate() + record.change_interval);

  res.json({
    message: '更新成功',
    record: {
      ...record,
      next_change_date: nextDate.toISOString().substring(0, 10)
    }
  });
});

// 删除箍牙记录
app.delete('/api/orthodontic', authMiddleware, async (req, res) => {
  const changes = await db.change(
    'DELETE FROM orthodontic_records WHERE user_id = ?',
    [req.userId]
  );
  if (changes === 0) return res.status(404).json({ error: '暂无箍牙记录可删除' });
  res.json({ message: '删除成功' });
});

// ========== 碳循环路由 ==========

// 辅助函数：计算碳循环信息
function calcCarbonCycle(startDateStr) {
  const startDate = new Date(startDateStr);
  startDate.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const diffDays = Math.floor((today - startDate) / (1000 * 60 * 60 * 24));
  // 每4天一个周期：0,1,2=低碳日，3=高碳日
  const cycleDay = (diffDays % 4) + 1; // 1-4
  const type = (diffDays % 4 === 3) ? 'high' : 'low';
  // 距离下一次高碳日天数
  const daysToHigh = (diffDays % 4 === 3) ? 0 : (3 - (diffDays % 4));

  return {
    type: type,
    cycle_day: cycleDay,
    days_to_high: daysToHigh,
    date: today.toISOString().substring(0, 10)
  };
}

// 获取碳循环记录和今天的信息
app.get('/api/carbon', authMiddleware, async (req, res) => {
  const record = await db.get(
    'SELECT * FROM carbon_cycle WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [req.userId]
  );
  if (!record) {
    return res.json({ record: null, today: null });
  }

  const today = calcCarbonCycle(record.start_date);
  res.json({
    record: {
      id: record.id,
      start_date: record.start_date,
      created_at: record.created_at
    },
    today: today
  });
});

// 获取今日碳循环类型（轻量接口）
app.get('/api/carbon/today', authMiddleware, async (req, res) => {
  const record = await db.get(
    'SELECT * FROM carbon_cycle WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [req.userId]
  );
  if (!record) {
    return res.json({ today: null });
  }

  const today = calcCarbonCycle(record.start_date);
  res.json({ today: today });
});

// 创建或更新碳循环起始日期
app.post('/api/carbon', authMiddleware, async (req, res) => {
  const { start_date } = req.body;
  if (!start_date) {
    return res.status(400).json({ error: '起始日期不能为空' });
  }
  const safeDate = String(start_date).substring(0, 10);

  // 检查是否已有记录
  const existing = await db.get(
    'SELECT * FROM carbon_cycle WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [req.userId]
  );

  let record;
  if (existing) {
    await db.run(
      'UPDATE carbon_cycle SET start_date = ? WHERE id = ? AND user_id = ?',
      [safeDate, existing.id, req.userId]
    );
    record = await db.get('SELECT * FROM carbon_cycle WHERE id = ?', [existing.id]);
  } else {
    record = await db.insert(
      'INSERT INTO carbon_cycle (user_id, start_date) VALUES (?, ?)',
      [req.userId, safeDate]
    );
  }

  const today = calcCarbonCycle(record.start_date);
  res.json({
    message: existing ? '更新成功' : '创建成功',
    record: record,
    today: today
  });
});

// ========== 华住会间夜路由 ==========

// 获取用户所有入住记录（按 start_date 倒序）
app.get('/api/hotels', authMiddleware, async (req, res) => {
  const stays = await db.all(
    'SELECT * FROM hotel_stays WHERE user_id = ? ORDER BY start_date DESC',
    [req.userId]
  );
  res.json({ stays });
});

// 查询指定酒店的入住状态
app.get('/api/hotels/check', authMiddleware, async (req, res) => {
  const { hotel_name } = req.query;
  if (!hotel_name || !hotel_name.trim()) {
    return res.status(400).json({ error: '酒店名称不能为空' });
  }

  const name = hotel_name.trim();
  // 获取该酒店最近一次入住记录
  const lastStay = await db.get(
    'SELECT * FROM hotel_stays WHERE user_id = ? AND hotel_name = ? ORDER BY start_date DESC LIMIT 1',
    [req.userId, name]
  );

  if (!lastStay) {
    return res.json({
      exists: false,
      last_check_in: null,
      last_duration: null,
      cooling_until: null,
      days_remaining: null,
      can_check_in: true
    });
  }

  // 冷却期以 start_date 为基准：start_date + 31 天为冷却期最后一天（含），
  // start_date + 32 天之后才可以再次入住。
  // 例如 2026-08-01 入住 → 冷却期至 2026-09-01（含），2026-09-02 可再次入住。
  const startStr = String(lastStay.start_date).substring(0, 10);
  const coolingUntilStr = addDaysDate(startStr, 31);
  const nextAvailableStr = addDaysDate(startStr, 32);
  const todayS = todayStr();

  const canCheckIn = todayS >= nextAvailableStr;
  const daysRemaining = canCheckIn
    ? 0
    : Math.ceil((new Date(nextAvailableStr + 'T00:00:00Z') - new Date(todayS + 'T00:00:00Z')) / 86400000);

  res.json({
    exists: true,
    last_check_in: startStr,
    last_duration: lastStay.duration || 1,
    cooling_until: coolingUntilStr,
    days_remaining: daysRemaining,
    can_check_in: canCheckIn
  });
});

// 检查同一时间段（含连住区间）是否已记录同一酒店
async function checkHotelOverlap(userId, name, startDate, duration, excludeId) {
  const existingStays = excludeId
    ? await db.all('SELECT * FROM hotel_stays WHERE user_id = ? AND hotel_name = ? AND id != ?', [userId, name, excludeId])
    : await db.all('SELECT * FROM hotel_stays WHERE user_id = ? AND hotel_name = ?', [userId, name]);
  const newEnd = addDaysDate(startDate, duration - 1);
  for (const es of existingStays) {
    const esEnd = addDaysDate(es.start_date, (es.duration || 1) - 1);
    if (startDate <= esEnd && newEnd >= String(es.start_date).substring(0, 10)) {
      return true;
    }
  }
  return false;
}

// 新增一条入住记录（支持连住：start_date + duration）
app.post('/api/hotels', authMiddleware, async (req, res) => {
  try {
    const { hotel_name, start_date, duration, points, is_credited, notes } = req.body;
    if (!hotel_name || !hotel_name.trim()) {
      return res.status(400).json({ error: '酒店名称不能为空' });
    }
    if (!start_date) {
      return res.status(400).json({ error: '入住日期不能为空' });
    }

    const name = hotel_name.trim();
    const safeDate = String(start_date).substring(0, 10);
    const dur = Math.max(1, parseInt(duration, 10) || 1);
    if (dur > 30) {
      return res.status(400).json({ error: '连住天数不能超过 30 天' });
    }
    const pts = points !== undefined && points !== '' && points !== null ? (parseInt(points, 10) || 0) : 0;
    const credited = is_credited ? 1 : 0;
    const note = notes !== undefined ? String(notes) : '';

    // 检查同一时间段（含连住区间）是否已记录同一酒店
    if (await checkHotelOverlap(req.userId, name, safeDate, dur)) {
      return res.status(400).json({ error: '该时间段已记录过此酒店的入住，请勿重复添加' });
    }

    const stay = await db.insert(
      'INSERT INTO hotel_stays (user_id, hotel_name, start_date, duration, points, is_credited, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.userId, name, safeDate, dur, pts, credited, note]
    );
    res.json({ message: '入住记录已添加', stay });
  } catch (err) {
    console.error('[HOTELS] POST /api/hotels 服务器错误:', err.message, err.stack);
    res.status(500).json({ error: '服务器错误: ' + err.message });
  }
});

// 编辑一条入住记录（可修改 起始日期 / 连住天数 / 积分 / 是否到账 / 备注）
app.put('/api/hotels/:id', authMiddleware, async (req, res) => {
  try {
    const stay = await db.get(
      'SELECT * FROM hotel_stays WHERE id = ? AND user_id = ?',
      [req.params.id, req.userId]
    );
    if (!stay) return res.status(404).json({ error: '入住记录不存在' });

    const { hotel_name, start_date, duration, points, is_credited, notes } = req.body;
    const newName = hotel_name !== undefined && hotel_name !== '' ? String(hotel_name).trim() : stay.hotel_name;
    const newStart = start_date !== undefined && start_date !== '' ? String(start_date).substring(0, 10) : String(stay.start_date).substring(0, 10);
    const newDur = duration !== undefined && duration !== '' ? Math.max(1, parseInt(duration, 10) || 1) : (stay.duration || 1);
    if (newDur > 30) {
      return res.status(400).json({ error: '连住天数不能超过 30 天' });
    }
    const pts = points !== undefined && points !== '' && points !== null ? (parseInt(points, 10) || 0) : (stay.points || 0);

    // 检查与同酒店其他记录的时间段重叠（排除自身）
    if (await checkHotelOverlap(req.userId, newName, newStart, newDur, req.params.id)) {
      return res.status(400).json({ error: '该时间段已记录过此酒店的入住，请勿重复添加' });
    }

    await db.change(
      `UPDATE hotel_stays SET
         hotel_name = ?,
         start_date = ?,
         duration = ?,
         points = ?,
         is_credited = ?,
         notes = ?,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
      [
        newName,
        newStart,
        newDur,
        pts,
        is_credited !== undefined ? (is_credited ? 1 : 0) : (stay.is_credited ? 1 : 0),
        notes !== undefined ? String(notes) : (stay.notes || ''),
        req.params.id,
        req.userId
      ]
    );

    const updated = await db.get(
      'SELECT * FROM hotel_stays WHERE id = ? AND user_id = ?',
      [req.params.id, req.userId]
    );
    res.json({ message: '入住记录已更新', stay: updated });
  } catch (err) {
    console.error('[HOTELS] PUT /api/hotels/:id 服务器错误:', err.message, err.stack);
    res.status(500).json({ error: '服务器错误: ' + err.message });
  }
});

// 删除一条入住记录
app.delete('/api/hotels/:id', authMiddleware, async (req, res) => {
  const changes = await db.change(
    'DELETE FROM hotel_stays WHERE id = ? AND user_id = ?',
    [req.params.id, req.userId]
  );
  if (changes === 0) return res.status(404).json({ error: '入住记录不存在' });
  res.json({ message: '删除成功' });
});

// ========== 宠物档案路由 ==========

// 获取当前用户所有宠物（含最近3条健康事件）
app.get('/api/pets', authMiddleware, async (req, res) => {
  const pets = await db.all(
    'SELECT * FROM pets WHERE user_id = ? ORDER BY created_at DESC',
    [req.userId]
  );
  // 为每只宠物附带最近3条健康事件
  for (const pet of pets) {
    pet.recent_events = await db.all(
      'SELECT * FROM pet_health_events WHERE pet_id = ? ORDER BY event_date DESC LIMIT 3',
      [pet.id]
    );
  }
  res.json({ pets });
});

// 新增宠物
app.post('/api/pets', authMiddleware, async (req, res) => {
  const { name, birth_date, photo_url, species, breed } = req.body;
  if (!name) return res.status(400).json({ error: '宠物名字不能为空' });
  const pet = await db.insert(
    'INSERT INTO pets (user_id, name, birth_date, photo_url, species, breed) VALUES (?, ?, ?, ?, ?, ?)',
    [req.userId, name, birth_date || null, photo_url || null, species || 'cat', breed || null]
  );
  const created = await db.get('SELECT * FROM pets WHERE id = ?', [pet.id]);
  created.recent_events = [];
  res.json({ message: '宠物添加成功', pet: created });
});

// 修改宠物
app.put('/api/pets/:id', authMiddleware, async (req, res) => {
  const pet = await db.get('SELECT * FROM pets WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  if (!pet) return res.status(404).json({ error: '宠物不存在' });
  const { name, birth_date, photo_url, species, breed } = req.body;
  await db.run(
    'UPDATE pets SET name=?, birth_date=?, photo_url=?, species=?, breed=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?',
    [
      name !== undefined ? name : pet.name,
      birth_date !== undefined ? birth_date : pet.birth_date,
      photo_url !== undefined ? photo_url : pet.photo_url,
      species !== undefined ? species : pet.species,
      breed !== undefined ? breed : pet.breed,
      req.params.id, req.userId
    ]
  );
  const updated = await db.get('SELECT * FROM pets WHERE id = ?', [req.params.id]);
  updated.recent_events = await db.all(
    'SELECT * FROM pet_health_events WHERE pet_id = ? ORDER BY event_date DESC LIMIT 3',
    [req.params.id]
  );
  res.json({ message: '宠物信息已更新', pet: updated });
});

// 删除宠物（级联删除健康事件）
app.delete('/api/pets/:id', authMiddleware, async (req, res) => {
  const changes = await db.change('DELETE FROM pets WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  if (changes === 0) return res.status(404).json({ error: '宠物不存在' });
  res.json({ message: '宠物已删除' });
});

// ========== 健康事件路由 ==========

// 获取某只宠物的所有健康事件
app.get('/api/pets/:petId/events', authMiddleware, async (req, res) => {
  const pet = await db.get('SELECT * FROM pets WHERE id = ? AND user_id = ?', [req.params.petId, req.userId]);
  if (!pet) return res.status(404).json({ error: '宠物不存在' });
  const events = await db.all(
    'SELECT * FROM pet_health_events WHERE pet_id = ? ORDER BY event_date DESC',
    [req.params.petId]
  );
  res.json({ events });
});

// 添加健康事件
app.post('/api/pets/:petId/events', authMiddleware, async (req, res) => {
  const pet = await db.get('SELECT * FROM pets WHERE id = ? AND user_id = ?', [req.params.petId, req.userId]);
  if (!pet) return res.status(404).json({ error: '宠物不存在' });
  const { event_type, event_date, title, notes } = req.body;
  if (!event_type || !event_date) return res.status(400).json({ error: '事件类型和日期不能为空' });
  if (!['vaccine', 'deworm', 'vet_visit', 'other'].includes(event_type)) {
    return res.status(400).json({ error: '无效的事件类型' });
  }
  const event = await db.insert(
    'INSERT INTO pet_health_events (pet_id, event_type, event_date, title, notes) VALUES (?, ?, ?, ?, ?)',
    [req.params.petId, event_type, event_date, title || null, notes || null]
  );
  const created = await db.get('SELECT * FROM pet_health_events WHERE id = ?', [event.id]);
  res.json({ message: '健康事件已添加', event: created });
});

// 修改健康事件
app.put('/api/pets/:petId/events/:eventId', authMiddleware, async (req, res) => {
  const pet = await db.get('SELECT * FROM pets WHERE id = ? AND user_id = ?', [req.params.petId, req.userId]);
  if (!pet) return res.status(404).json({ error: '宠物不存在' });
  const ev = await db.get('SELECT * FROM pet_health_events WHERE id = ? AND pet_id = ?', [req.params.eventId, req.params.petId]);
  if (!ev) return res.status(404).json({ error: '健康事件不存在' });
  const { event_type, event_date, title, notes } = req.body;
  await db.run(
    'UPDATE pet_health_events SET event_type=?, event_date=?, title=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND pet_id=?',
    [
      event_type !== undefined ? event_type : ev.event_type,
      event_date !== undefined ? event_date : ev.event_date,
      title !== undefined ? title : ev.title,
      notes !== undefined ? notes : ev.notes,
      req.params.eventId, req.params.petId
    ]
  );
  const updated = await db.get('SELECT * FROM pet_health_events WHERE id = ?', [req.params.eventId]);
  res.json({ message: '健康事件已更新', event: updated });
});

// 删除健康事件
app.delete('/api/pets/:petId/events/:eventId', authMiddleware, async (req, res) => {
  const pet = await db.get('SELECT * FROM pets WHERE id = ? AND user_id = ?', [req.params.petId, req.userId]);
  if (!pet) return res.status(404).json({ error: '宠物不存在' });
  const changes = await db.change(
    'DELETE FROM pet_health_events WHERE id = ? AND pet_id = ?',
    [req.params.eventId, req.params.petId]
  );
  if (changes === 0) return res.status(404).json({ error: '健康事件不存在' });
  res.json({ message: '健康事件已删除' });
});

// ========== 统计 ==========
app.get('/api/stats', authMiddleware, async (req, res) => {
  const diaryCount = await db.get('SELECT COUNT(*) as count FROM diaries WHERE user_id = ?', [req.userId]);
  const taskTotal = await db.get('SELECT COUNT(*) as count FROM tasks WHERE user_id = ?', [req.userId]);
  const taskCompleted = await db.get("SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status = 'completed'", [req.userId]);
  const taskPending = await db.get("SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status = 'pending'", [req.userId]);
  const taskUnfinished = await db.get("SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status = 'unfinished'", [req.userId]);

  const tasks = await db.all('SELECT * FROM tasks WHERE user_id = ?', [req.userId]);
  const catCounts = {};
  for (const t of tasks) {
    if (t.status === 'pending') {
      catCounts[t.category] = (catCounts[t.category] || 0) + 1;
    }
  }

  res.json({
    stats: {
      diaryCount: diaryCount.count,
      taskTotal: taskTotal.count,
      taskCompleted: taskCompleted.count,
      taskPending: taskPending.count,
      taskUnfinished: taskUnfinished.count,
      categoryStats: catCounts
    }
  });
});

// ========== SPA fallback (仅对非静态资源返回 HTML，避免 JS/CSS 被错误解析) ==========
app.get('*', (req, res) => {
  // 如果请求路径以常见的静态资源后缀结尾，返回 404 而不是 HTML
  const staticExts = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map|json|xml|txt|webmanifest)$/i;
  if (staticExts.test(req.path)) {
    return res.status(404).json({ error: '资源不存在' });
  }
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

// ========== 全局错误处理 ==========
app.use((err, req, res, next) => {
  console.error(`[ERROR] 未捕获异常:`, err.message, err.stack);
  res.status(500).json({ error: '服务器内部错误' });
});

// 兜底：捕获未处理的 Promise rejection，避免进程崩溃导致 Render 返回 503
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] 未处理的 Promise rejection（已阻止进程退出）:', reason instanceof Error ? (reason.stack || reason.message) : reason);
});

// ========== 启动 ==========
console.log('========================================');
console.log('   ⏰ 时间管理大师 v2.1');
console.log('========================================');
console.log(`   环境: ${IS_PRODUCTION ? '生产 (Production)' : '开发 (Development)'}`);
console.log(`   端口: ${PORT}`);
console.log(`   数据库类型: ${process.env.DATABASE_URL ? 'TiDB Cloud (MySQL)' : 'SQLite (本地 time_master.db)'}`);
console.log(`   DATABASE_URL 已配置: ${process.env.DATABASE_URL ? '✅ 是' : '❌ 否 (使用本地 SQLite)'}`);
if (!process.env.JWT_SECRET) {
  console.warn('   ⚠️ 警告: JWT_SECRET 环境变量未设置！');
  console.warn('   ⚠️ 将使用默认值 "time_master_secret_2025"');
  console.warn('   ⚠️ 如果 Render 上重新部署且未设置 JWT_SECRET 环境变量，');
  console.warn('   ⚠️ 新实例会使用默认值签发 token，但旧 token 可能无效。');
  console.warn('   ⚠️ 建议在 Render 环境变量中设置 JWT_SECRET=time_master_secret_2025');
  console.warn('   ⚠️ 确保所有实例使用相同的 JWT_SECRET！');
}
console.log(`   JWT_SECRET 已配置: ${process.env.JWT_SECRET ? '✅ 是 (自定义, 长度=' + process.env.JWT_SECRET.length + ')' : '⚠️ 否 (使用默认值, 长度=' + JWT_SECRET.length + ')'}`);
console.log(`   CORS: ${IS_PRODUCTION ? (process.env.CORS_ORIGIN || '允许所有来源') : '允许所有来源 (开发模式)'}`);
console.log('========================================');

db.init().then(() => {
  console.log(`   数据库连接: ✅ 已建立`);
  return initDB();
}).then(() => {
  app.listen(PORT, () => {
    console.log(`   🚀 服务已启动，监听端口 ${PORT}`);
    console.log(`   📱 访问: http://localhost:${PORT}`);
    console.log('========================================');
  });
}).catch(err => {
  console.error('========================================');
  console.error('❌ 启动失败:', err.message);
  console.error('   可能原因:');
  if (process.env.DATABASE_URL) {
    console.error('   1. DATABASE_URL 环境变量格式错误');
    console.error('   2. TiDB Cloud 集群未启动或网络不通');
    console.error('   3. 数据库用户名/密码错误');
    console.error('   4. IP 白名单未配置 (需在 TiDB Cloud 中添加 Render 出口 IP)');
  } else {
    console.error('   1. 本地 SQLite 文件 (time_master.db) 创建失败，请检查目录写入权限');
  }
  console.error('========================================');
  process.exit(1);
});
