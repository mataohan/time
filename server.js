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

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

// ========== TiDB Cloud 表初始化 ==========
async function initDB() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      nickname VARCHAR(100),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
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
    return res.status(401).json({ error: '未授权访问' });
  }
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.userEmail = decoded.email;
    next();
  } catch (err) {
    return res.status(401).json({ error: '令牌无效或已过期' });
  }
}

// ========== 认证路由 ==========

app.post('/api/register', async (req, res) => {
  try {
    const { email, password, nickname } = req.body;
    if (!email || !password) return res.status(400).json({ error: '邮箱和密码不能为空' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });

    const existing = await db.get('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) return res.status(400).json({ error: '该邮箱已被注册' });

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await db.insert(
      'INSERT INTO users (email, password, nickname) VALUES (?, ?, ?)',
      [email, hashedPassword, nickname || email.split('@')[0]]
    );

    const token = jwt.sign({ userId: user.id, email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      message: '注册成功',
      token,
      user: { id: user.id, email, nickname: user.nickname }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: '邮箱和密码不能为空' });

    const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) return res.status(400).json({ error: '邮箱或密码错误' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: '邮箱或密码错误' });

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      message: '登录成功',
      token,
      user: { id: user.id, email: user.email, nickname: user.nickname }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
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

  const { category, title, content, completed, priority, due_date, completed_at, status, unfinished_reason } = req.body;

  const setClauses = [];
  const params = [];

  if (category !== undefined) { setClauses.push('category=?'); params.push(category); }
  if (title !== undefined) { setClauses.push('title=?'); params.push(title); }
  if (content !== undefined) { setClauses.push('content=?'); params.push(content); }
  if (priority !== undefined) { setClauses.push('priority=?'); params.push(priority); }
  if (due_date !== undefined) { setClauses.push('due_date=?'); params.push(due_date); }

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

// ========== 启动 ==========
db.init().then(() => initDB()).then(() => {
  app.listen(PORT, () => {
    console.log(`⏰ 时间管理大师 v2.0 已启动: http://localhost:${PORT}`);
    console.log(`   数据库: TiDB Cloud (MySQL)`);
  });
}).catch(err => {
  console.error('❌ 启动失败:', err.message);
  process.exit(1);
});
