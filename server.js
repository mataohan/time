const express = require('express');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;
const JWT_SECRET = 'time_master_secret_key_2024';
const SALT_ROUNDS = 10;

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 初始化数据库
const db = new Database('time_master.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 创建表
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    nickname TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS journals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('健身','影视','学习','工作','日常')),
    title TEXT NOT NULL,
    content TEXT DEFAULT '',
    journal_date DATE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('健身','影视','学习','工作','日常')),
    title TEXT NOT NULL,
    content TEXT DEFAULT '',
    completed INTEGER DEFAULT 0,
    priority INTEGER DEFAULT 0 CHECK(priority IN (0,1,2)),
    due_date DATE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// JWT 认证中间件
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

// ============ 认证路由 ============

// 注册
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, nickname } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: '邮箱和密码不能为空' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: '邮箱格式不正确' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: '密码至少6位' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return res.status(400).json({ error: '该邮箱已被注册' });
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const result = db.prepare('INSERT INTO users (email, password, nickname) VALUES (?, ?, ?)').run(
      email, hashedPassword, nickname || email.split('@')[0]
    );

    const token = jwt.sign({ userId: result.lastInsertRowid, email }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: '注册成功',
      token,
      user: {
        id: result.lastInsertRowid,
        email,
        nickname: nickname || email.split('@')[0]
      }
    });
  } catch (err) {
    res.status(500).json({ error: '服务器错误' });
  }
});

// 登录
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: '邮箱和密码不能为空' });
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      return res.status(400).json({ error: '邮箱或密码错误' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: '邮箱或密码错误' });
    }

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: '登录成功',
      token,
      user: {
        id: user.id,
        email: user.email,
        nickname: user.nickname
      }
    });
  } catch (err) {
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取用户信息
app.get('/api/user', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, email, nickname, created_at FROM users WHERE id = ?').get(req.userId);
  res.json({ user });
});

// ============ 手账路由 ============

// 获取指定月份的手账
app.get('/api/journals', authMiddleware, (req, res) => {
  const { year, month } = req.query;
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = `${year}-${String(month).padStart(2, '0')}-31`;

  const journals = db.prepare(`
    SELECT * FROM journals
    WHERE user_id = ? AND journal_date >= ? AND journal_date <= ?
    ORDER BY journal_date DESC, created_at DESC
  `).all(req.userId, startDate, endDate);

  res.json({ journals });
});

// 获取某一天的手账
app.get('/api/journals/date/:date', authMiddleware, (req, res) => {
  const journals = db.prepare(`
    SELECT * FROM journals
    WHERE user_id = ? AND journal_date = ?
    ORDER BY created_at DESC
  `).all(req.userId, req.params.date);

  res.json({ journals });
});

// 创建手账
app.post('/api/journals', authMiddleware, (req, res) => {
  const { category, title, content, journal_date } = req.body;

  if (!category || !title || !journal_date) {
    return res.status(400).json({ error: '分类、标题和日期不能为空' });
  }

  const validCategories = ['健身', '影视', '学习', '工作', '日常'];
  if (!validCategories.includes(category)) {
    return res.status(400).json({ error: '无效的分类' });
  }

  const result = db.prepare(`
    INSERT INTO journals (user_id, category, title, content, journal_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.userId, category, title, content || '', journal_date);

  const journal = db.prepare('SELECT * FROM journals WHERE id = ?').get(result.lastInsertRowid);
  res.json({ message: '创建成功', journal });
});

// 更新手账
app.put('/api/journals/:id', authMiddleware, (req, res) => {
  const { category, title, content } = req.body;
  const journal = db.prepare('SELECT * FROM journals WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);

  if (!journal) {
    return res.status(404).json({ error: '手账不存在' });
  }

  db.prepare(`
    UPDATE journals SET category = ?, title = ?, content = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(
    category || journal.category,
    title || journal.title,
    content !== undefined ? content : journal.content,
    req.params.id,
    req.userId
  );

  const updated = db.prepare('SELECT * FROM journals WHERE id = ?').get(req.params.id);
  res.json({ message: '更新成功', journal: updated });
});

// 删除手账
app.delete('/api/journals/:id', authMiddleware, (req, res) => {
  const result = db.prepare('DELETE FROM journals WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  if (result.changes === 0) {
    return res.status(404).json({ error: '手账不存在' });
  }
  res.json({ message: '删除成功' });
});

// ============ 待办事项路由 ============

// 获取所有未完成事项
app.get('/api/tasks', authMiddleware, (req, res) => {
  const { category, completed } = req.query;
  let query = 'SELECT * FROM tasks WHERE user_id = ?';
  const params = [req.userId];

  if (category) {
    query += ' AND category = ?';
    params.push(category);
  }

  if (completed !== undefined) {
    query += ' AND completed = ?';
    params.push(parseInt(completed));
  }

  query += ' ORDER BY priority DESC, created_at DESC';

  const tasks = db.prepare(query).all(...params);
  res.json({ tasks });
});

// 创建待办事项
app.post('/api/tasks', authMiddleware, (req, res) => {
  const { category, title, content, priority, due_date } = req.body;

  if (!category || !title) {
    return res.status(400).json({ error: '分类和标题不能为空' });
  }

  const validCategories = ['健身', '影视', '学习', '工作', '日常'];
  if (!validCategories.includes(category)) {
    return res.status(400).json({ error: '无效的分类' });
  }

  const result = db.prepare(`
    INSERT INTO tasks (user_id, category, title, content, priority, due_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.userId, category, title, content || '', priority || 0, due_date || null);

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
  res.json({ message: '创建成功', task });
});

// 更新待办事项
app.put('/api/tasks/:id', authMiddleware, (req, res) => {
  const { category, title, content, completed, priority, due_date } = req.body;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);

  if (!task) {
    return res.status(404).json({ error: '事项不存在' });
  }

  db.prepare(`
    UPDATE tasks SET
      category = ?, title = ?, content = ?,
      completed = ?, priority = ?, due_date = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(
    category || task.category,
    title || task.title,
    content !== undefined ? content : task.content,
    completed !== undefined ? completed : task.completed,
    priority !== undefined ? priority : task.priority,
    due_date !== undefined ? due_date : task.due_date,
    req.params.id,
    req.userId
  );

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  res.json({ message: '更新成功', task: updated });
});

// 删除待办事项
app.delete('/api/tasks/:id', authMiddleware, (req, res) => {
  const result = db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  if (result.changes === 0) {
    return res.status(404).json({ error: '事项不存在' });
  }
  res.json({ message: '删除成功' });
});

// 切换完成状态
app.patch('/api/tasks/:id/toggle', authMiddleware, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!task) {
    return res.status(404).json({ error: '事项不存在' });
  }

  const newStatus = task.completed ? 0 : 1;
  db.prepare('UPDATE tasks SET completed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, req.params.id);

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  res.json({ message: '状态已更新', task: updated });
});

// 获取统计数据
app.get('/api/stats', authMiddleware, (req, res) => {
  const journalCount = db.prepare('SELECT COUNT(*) as count FROM journals WHERE user_id = ?').get(req.userId);
  const taskTotal = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE user_id = ?').get(req.userId);
  const taskCompleted = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND completed = 1').get(req.userId);
  const taskPending = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND completed = 0').get(req.userId);

  const categoryStats = db.prepare(`
    SELECT category, COUNT(*) as count
    FROM tasks WHERE user_id = ? AND completed = 0
    GROUP BY category
  `).all(req.userId);

  const todayJournal = db.prepare(`
    SELECT COUNT(*) as count FROM journals
    WHERE user_id = ? AND journal_date = date('now','localtime')
  `).get(req.userId);

  res.json({
    stats: {
      journalCount: journalCount.count,
      taskTotal: taskTotal.count,
      taskCompleted: taskCompleted.count,
      taskPending: taskPending.count,
      categoryStats,
      todayJournal: todayJournal.count
    }
  });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`⏰ 时间管理大师服务已启动: http://localhost:${PORT}`);
});
