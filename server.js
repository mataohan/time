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
app.use(express.static(path.join(process.cwd(), 'public')));

// ========== TiDB Cloud 表初始化 ==========
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

  console.log('✅ TiDB Cloud 表初始化完成');
}

// ========== JWT 认证中间件 ==========
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.log(`[AUTH] 拒绝: 未携带令牌 (${req.method} ${req.path})`);
    return res.status(401).json({ error: '未授权访问，请先登录' });
  }
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.userEmail = decoded.email;
    next();
  } catch (err) {
    console.log(`[AUTH] 拒绝: 令牌无效 (${req.method} ${req.path}) - ${err.message}`);
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

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

    const token = jwt.sign({ userId: user.id, email }, JWT_SECRET, { expiresIn: '7d' });
    const elapsed = Date.now() - startTime;
    console.log(`[REGISTER] 注册成功: userId=${user.id}, email=${email} (${elapsed}ms)`);
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

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    const elapsed = Date.now() - startTime;
    console.log(`[LOGIN] 登录成功: userId=${user.id}, email=${email} (${elapsed}ms)`);
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
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const end = `${year}-${String(month).padStart(2, '0')}-31`;
    sql += ' AND diary_date >= ? AND diary_date <= ?';
    params.push(start, end);
  }
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }

  sql += ' ORDER BY diary_date DESC, created_at DESC';
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

// 获取消费记录
app.get('/api/expenses', authMiddleware, async (req, res) => {
  const { year, month, start_date, end_date } = req.query;
  let sql = 'SELECT * FROM expenses WHERE user_id = ?';
  const params = [req.userId];

  if (start_date && end_date) {
    sql += ' AND expense_date >= ? AND expense_date <= ?';
    params.push(start_date, end_date);
  } else if (year && month) {
    sql += ' AND expense_date >= ? AND expense_date <= ?';
    params.push(`${year}-${String(month).padStart(2, '0')}-01`, `${year}-${String(month).padStart(2, '0')}-31`);
  } else if (year) {
    sql += ' AND expense_date >= ? AND expense_date <= ?';
    params.push(`${year}-01-01`, `${year}-12-31`);
  }

  sql += ' ORDER BY expense_date DESC, created_at DESC';
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
  if (!['餐饮', '购物', '交通', '娱乐', '医疗', '其他'].includes(category)) {
    return res.status(400).json({ error: '无效的分类' });
  }
  const expense = await db.insert(
    'INSERT INTO expenses (user_id, amount, category, note, expense_date) VALUES (?, ?, ?, ?, ?)',
    [req.userId, amt, category, note || '', expense_date]
  );
  res.json({ message: '记账成功', expense });
});

// 更新消费记录
app.put('/api/expenses/:id', authMiddleware, async (req, res) => {
  const expense = await db.get('SELECT * FROM expenses WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  if (!expense) return res.status(404).json({ error: '消费记录不存在' });
  const { amount, category, note, expense_date } = req.body;
  const amt = amount !== undefined ? parseFloat(amount) : expense.amount;
  if (amount !== undefined && (isNaN(amt) || amt <= 0)) return res.status(400).json({ error: '金额必须为正数' });
  await db.run(
    'UPDATE expenses SET amount=?, category=?, note=?, expense_date=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?',
    [amt, category || expense.category, note !== undefined ? note : expense.note, expense_date || expense.expense_date, req.params.id, req.userId]
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

// ========== SPA fallback ==========
app.get('*', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

// ========== 全局错误处理 ==========
app.use((err, req, res, next) => {
  console.error(`[ERROR] 未捕获异常:`, err.message, err.stack);
  res.status(500).json({ error: '服务器内部错误' });
});

// ========== 启动 ==========
console.log('========================================');
console.log('   ⏰ 时间管理大师 v2.0');
console.log('========================================');
console.log(`   环境: ${IS_PRODUCTION ? '生产 (Production)' : '开发 (Development)'}`);
console.log(`   端口: ${PORT}`);
console.log(`   数据库类型: TiDB Cloud (MySQL)`);
console.log(`   DATABASE_URL 已配置: ${process.env.DATABASE_URL ? '✅ 是' : '❌ 否'}`);
console.log(`   JWT_SECRET 已配置: ${process.env.JWT_SECRET ? '✅ 是 (自定义)' : '⚠️ 否 (使用默认值)'}`);
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
  console.error('   1. DATABASE_URL 环境变量未设置或格式错误');
  console.error('   2. TiDB Cloud 集群未启动或网络不通');
  console.error('   3. 数据库用户名/密码错误');
  console.error('   4. IP 白名单未配置 (需在 TiDB Cloud 中添加 Render 出口 IP)');
  console.error('========================================');
  process.exit(1);
});
