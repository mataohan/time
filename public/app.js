// ==================== 数据存储 ====================
const DB = {
  get(k) { try { return JSON.parse(localStorage.getItem('tm_' + k)); } catch { return null; } },
  set(k, v) { localStorage.setItem('tm_' + k, JSON.stringify(v)); },
  users() { return this.get('users') || []; },
  journals() { return this.get('journals') || []; },
  tasks() { return this.get('tasks') || []; },
  saveUsers(u) { this.set('users', u); },
  saveJournals(j) { this.set('journals', j); },
  saveTasks(t) { this.set('tasks', t); },
};

// ==================== 全局状态 ====================
let user = DB.get('current_user');
let isLogin = true;
let currentTab = 'calendar';
let currentYear, currentMonth, selectedDate;
let journalMap = {};
let calFilter = null;
let taskFilter = 'all';

const CATS = ['健身', '影视', '学习', '工作', '日常'];
const CAT_EMOJI = { 健身: '💪', 影视: '🎬', 学习: '📚', 工作: '💼', 日常: '🌟' };
const CAT_CSS = { 健身: 'fitness', 影视: 'movie', 学习: 'study', 工作: 'work', 日常: 'daily' };

// ==================== 工具 ====================
function toast(msg, type) {
  type = type || 'success';
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = 'toast toast-' + type;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(function () { t.remove(); }, 3000);
}
function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function uid() { return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
function today() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

// ==================== 认证 ====================
function toggleAuthMode() {
  isLogin = !isLogin;
  document.getElementById('authSubmitBtn').textContent = isLogin ? '登 录' : '注 册';
  document.getElementById('nicknameGroup').style.display = isLogin ? 'none' : 'block';
  document.getElementById('switchText').textContent = isLogin ? '还没有账号？' : '已有账号？';
  document.getElementById('switchLink').textContent = isLogin ? '立即注册' : '去登录';
  document.getElementById('authError').style.display = 'none';
  document.getElementById('authForm').reset();
}

function togglePw() {
  var pw = document.getElementById('password');
  var btn = document.getElementById('pwToggle');
  if (pw.type === 'password') { pw.type = 'text'; btn.textContent = '🙈'; }
  else { pw.type = 'password'; btn.textContent = '👁️'; }
}

document.getElementById('authForm').addEventListener('submit', function (e) {
  e.preventDefault();
  var email = document.getElementById('email').value.trim();
  var password = document.getElementById('password').value;
  var nickname = document.getElementById('nickname').value.trim();
  var errEl = document.getElementById('authError');
  errEl.style.display = 'none';

  if (!email || !password) { errEl.textContent = '邮箱和密码不能为空'; errEl.style.display = 'block'; return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.textContent = '邮箱格式不正确'; errEl.style.display = 'block'; return; }
  if (password.length < 6) { errEl.textContent = '密码至少6位'; errEl.style.display = 'block'; return; }

  var users = DB.users();
  if (isLogin) {
    var u = users.find(function (x) { return x.email === email; });
    if (!u) { errEl.textContent = '邮箱或密码错误'; errEl.style.display = 'block'; return; }
    var pwHash = btoa(password);
    if (u.password !== pwHash) { errEl.textContent = '邮箱或密码错误'; errEl.style.display = 'block'; return; }
    user = { id: u.id, email: u.email, nickname: u.nickname };
    DB.set('current_user', user);
    toast('登录成功！');
    showApp();
  } else {
    if (users.find(function (x) { return x.email === email; })) { errEl.textContent = '该邮箱已被注册'; errEl.style.display = 'block'; return; }
    var newUser = { id: uid(), email: email, password: btoa(password), nickname: nickname || email.split('@')[0], createdAt: new Date().toISOString() };
    users.push(newUser);
    DB.saveUsers(users);
    user = { id: newUser.id, email: newUser.email, nickname: newUser.nickname };
    DB.set('current_user', user);
    toast('注册成功！');
    showApp();
  }
});

function logout() {
  user = null;
  DB.set('current_user', null);
  document.getElementById('authPage').style.display = 'flex';
  document.getElementById('appPage').style.display = 'none';
  toast('已退出登录');
}

// ==================== 应用入口 ====================
function showApp() {
  document.getElementById('authPage').style.display = 'none';
  document.getElementById('appPage').style.display = 'block';
  document.getElementById('userNickname').textContent = user.nickname || user.email;
  document.getElementById('userAvatar').textContent = (user.nickname || user.email)[0].toUpperCase();
  var now = new Date();
  currentYear = now.getFullYear();
  currentMonth = now.getMonth() + 1;
  selectedDate = today();
  switchTab('calendar');
}

// ==================== 标签切换 ====================
function switchTab(tab) {
  currentTab = tab;
  var btns = document.querySelectorAll('.tab-btn');
  for (var i = 0; i < btns.length; i++) btns[i].classList.remove('active');
  if (tab === 'calendar') {
    btns[0].classList.add('active');
    document.getElementById('calendarTab').style.display = 'grid';
    document.getElementById('tasksTab').style.display = 'none';
    renderCalendar();
    updateCalStats();
    selectDate(selectedDate);
  } else {
    btns[1].classList.add('active');
    document.getElementById('calendarTab').style.display = 'none';
    document.getElementById('tasksTab').style.display = 'grid';
    loadTasks();
  }
}

// ==================== 日历 ====================
function renderCalendar() {
  document.getElementById('calendarTitle').textContent = currentYear + '年 ' + currentMonth + '月';
  var grid = document.getElementById('calendarGrid');
  grid.innerHTML = '';
  var headers = ['日', '一', '二', '三', '四', '五', '六'];
  for (var i = 0; i < headers.length; i++) {
    var h = document.createElement('div');
    h.className = 'day-header';
    h.textContent = headers[i];
    grid.appendChild(h);
  }

  var firstDay = new Date(currentYear, currentMonth - 1, 1).getDay();
  var daysInMonth = new Date(currentYear, currentMonth, 0).getDate();
  var prevDays = new Date(currentYear, currentMonth - 1, 0).getDate();
  var todayStr = today();

  // 上月填充
  for (var i = firstDay - 1; i >= 0; i--) {
    var d = prevDays - i;
    var m = currentMonth === 1 ? 12 : currentMonth - 1;
    var y = currentMonth === 1 ? currentYear - 1 : currentYear;
    grid.appendChild(createDay(d, y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'), true));
  }
  // 当月
  for (var d = 1; d <= daysInMonth; d++) {
    var ds = currentYear + '-' + String(currentMonth).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    grid.appendChild(createDay(d, ds, false, ds === todayStr, ds === selectedDate));
  }
  // 下月填充
  var total = firstDay + daysInMonth;
  var rem = total % 7 === 0 ? 0 : 7 - (total % 7);
  for (var d = 1; d <= rem; d++) {
    var m = currentMonth === 12 ? 1 : currentMonth + 1;
    var y = currentMonth === 12 ? currentYear + 1 : currentYear;
    grid.appendChild(createDay(d, y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'), true));
  }
  updateDots();
}

function createDay(day, dateStr, otherMonth, isToday, isSelected) {
  var el = document.createElement('div');
  var cls = 'calendar-day';
  if (otherMonth) cls += ' other-month';
  if (isToday) cls += ' today';
  if (isSelected) cls += ' selected';
  el.className = cls;
  var num = document.createElement('div');
  num.className = 'day-num';
  num.textContent = day;
  el.appendChild(num);
  var dots = document.createElement('div');
  dots.className = 'day-dots';
  dots.id = 'dots-' + dateStr;
  el.appendChild(dots);
  if (!otherMonth) {
    el.onclick = (function (ds) { return function () { selectDate(ds); }; })(dateStr);
  }
  return el;
}

function updateDots() {
  journalMap = {};
  var journals = DB.journals().filter(function (j) { return j.userId === user.id; });
  for (var i = 0; i < journals.length; i++) {
    var j = journals[i];
    if (!journalMap[j.date]) journalMap[j.date] = {};
    journalMap[j.date][j.category] = true;
  }
  var allDots = document.querySelectorAll('.day-dots');
  for (var i = 0; i < allDots.length; i++) allDots[i].innerHTML = '';

  var keys = Object.keys(journalMap);
  for (var i = 0; i < keys.length; i++) {
    var ds = keys[i];
    var cats = journalMap[ds];
    var dotsEl = document.getElementById('dots-' + ds);
    if (!dotsEl) continue;
    var catKeys = Object.keys(cats);
    for (var j = 0; j < catKeys.length; j++) {
      var c = catKeys[j];
      if (calFilter && c !== calFilter) continue;
      var dot = document.createElement('span');
      dot.className = 'day-dot dot-' + CAT_CSS[c];
      dotsEl.appendChild(dot);
    }
  }
}

function updateCalStats() {
  var journals = DB.journals().filter(function (j) { return j.userId === user.id; });
  var counts = { 健身: 0, 影视: 0, 学习: 0, 工作: 0, 日常: 0 };
  for (var i = 0; i < journals.length; i++) {
    var c = journals[i].category;
    if (counts[c] !== undefined) counts[c]++;
  }
  document.getElementById('statFitness').textContent = counts['健身'];
  document.getElementById('statMovie').textContent = counts['影视'];
  document.getElementById('statStudy').textContent = counts['学习'];
  document.getElementById('statWork').textContent = counts['工作'];
  document.getElementById('statDaily').textContent = counts['日常'];
}

function filterCalCat(cat) {
  calFilter = calFilter === cat ? null : cat;
  updateDots();
  toast(calFilter ? '已筛选: ' + cat : '已取消筛选');
}

function selectDate(ds) {
  selectedDate = ds;
  renderCalendar();
  var journals = DB.journals().filter(function (j) { return j.userId === user.id && j.date === ds; });
  renderJournalDetail(ds, journals);
}

function renderJournalDetail(ds, journals) {
  var detail = document.getElementById('journalDetail');
  var title = document.getElementById('journalDateTitle');
  var list = document.getElementById('journalList');
  detail.style.display = 'block';
  title.textContent = '📅 ' + ds + ' 的手账';

  if (journals.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">📖</div><p>这一天还没有手账记录</p></div>';
    return;
  }

  var html = '';
  for (var i = 0; i < journals.length; i++) {
    var j = journals[i];
    var time = new Date(j.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    html += '<div class="journal-item">';
    html += '<div class="journal-meta">';
    html += '<span class="journal-category cat-' + CAT_CSS[j.category] + '">' + CAT_EMOJI[j.category] + ' ' + j.category + '</span>';
    html += '<span style="color:var(--text-muted);font-size:12px;">' + time + '</span>';
    html += '</div>';
    html += '<div class="journal-title">' + esc(j.title) + '</div>';
    if (j.content) html += '<div class="journal-content">' + esc(j.content) + '</div>';
    html += '<div class="journal-actions">';
    html += '<button class="btn-edit" onclick="event.stopPropagation();openJournalModal(\'' + j.id + '\')">✏️ 编辑</button>';
    html += '<button class="btn-del" onclick="event.stopPropagation();deleteJournal(\'' + j.id + '\')">🗑️ 删除</button>';
    html += '</div></div>';
  }
  list.innerHTML = html;
}

// ==================== 手账 CRUD ====================
function openJournalModal(id) {
  var allJournals = DB.journals().filter(function (j) { return j.userId === user.id; });
  var journal = id ? allJournals.find(function (j) { return j.id === id; }) : null;
  var isEdit = !!journal;

  var catOpts = '';
  for (var i = 0; i < CATS.length; i++) {
    catOpts += '<option value="' + CATS[i] + '" ' + (journal && journal.category === CATS[i] ? 'selected' : '') + '>' + CAT_EMOJI[CATS[i]] + ' ' + CATS[i] + '</option>';
  }

  document.getElementById('modalContent').innerHTML =
    '<h3>' + (isEdit ? '编辑手账' : '写手账') + '</h3>' +
    '<div class="form-group"><label>分类</label><select id="jCat">' + catOpts + '</select></div>' +
    '<div class="form-group"><label>标题</label><input type="text" id="jTitle" value="' + (journal ? esc(journal.title) : '') + '" placeholder="给今天的手账起个标题"></div>' +
    '<div class="form-group"><label>内容</label><textarea id="jContent" placeholder="记录今天的事情...">' + (journal ? esc(journal.content || '') : '') + '</textarea></div>' +
    '<div class="modal-actions">' +
    '<button class="btn-cancel" onclick="closeModal()">取消</button>' +
    '<button class="btn-submit" onclick="saveJournal(\'' + (id || '') + '\')">' + (isEdit ? '保存修改' : '创建手账') + '</button>' +
    '</div>';
  document.getElementById('modalOverlay').style.display = 'flex';
  setTimeout(function () {
    var el = document.getElementById('jTitle');
    if (el) el.focus();
  }, 100);
}

function saveJournal(id) {
  var cat = document.getElementById('jCat').value;
  var title = document.getElementById('jTitle').value.trim();
  var content = document.getElementById('jContent').value.trim();
  if (!title) { toast('请输入标题', 'error'); return; }

  var journals = DB.journals();
  if (id) {
    var idx = journals.findIndex(function (j) { return j.id === id && j.userId === user.id; });
    if (idx !== -1) {
      journals[idx].category = cat;
      journals[idx].title = title;
      journals[idx].content = content;
      journals[idx].updatedAt = new Date().toISOString();
    }
    toast('手账已更新');
  } else {
    journals.push({ id: uid(), userId: user.id, category: cat, title: title, content: content, date: selectedDate, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    toast('手账已创建');
  }
  DB.saveJournals(journals);
  closeModal();
  selectDate(selectedDate);
  updateCalStats();
}

function deleteJournal(id) {
  if (!confirm('确定删除这条手账？')) return;
  var journals = DB.journals().filter(function (j) { return !(j.id === id && j.userId === user.id); });
  DB.saveJournals(journals);
  toast('手账已删除');
  selectDate(selectedDate);
  updateCalStats();
}

function closeModal() {
  document.getElementById('modalOverlay').style.display = 'none';
}

function prevMonth() {
  if (currentMonth === 1) { currentMonth = 12; currentYear--; }
  else currentMonth--;
  renderCalendar();
}
function nextMonth() {
  if (currentMonth === 12) { currentMonth = 1; currentYear++; }
  else currentMonth++;
  renderCalendar();
}
function goToToday() {
  var now = new Date();
  currentYear = now.getFullYear();
  currentMonth = now.getMonth() + 1;
  selectedDate = today();
  renderCalendar();
  selectDate(selectedDate);
}

// ==================== 待办事项 ====================
function loadTasks() {
  var allTasks = DB.tasks().filter(function (t) { return t.userId === user.id; });
  var filtered;
  if (taskFilter === 'completed') {
    filtered = allTasks.filter(function (t) { return t.completed; });
  } else if (taskFilter === 'all') {
    filtered = allTasks.filter(function (t) { return !t.completed; });
  } else {
    filtered = allTasks.filter(function (t) { return t.category === taskFilter && !t.completed; });
  }
  filtered.sort(function (a, b) { return b.priority - a.priority || new Date(b.createdAt) - new Date(a.createdAt); });
  renderTaskList(filtered);
  updateTaskCounts(allTasks);
}

function renderTaskList(tasks) {
  var list = document.getElementById('taskList');
  var title = document.getElementById('taskListTitle');
  var names = { all: '全部待办事项', completed: '已完成事项' };
  for (var i = 0; i < CATS.length; i++) names[CATS[i]] = CATS[i] + '待办';
  title.textContent = names[taskFilter] || '待办事项';

  if (tasks.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">📝</div><p>暂无' + names[taskFilter] + '</p></div>';
    return;
  }

  var priLabels = { 2: '高', 1: '中', 0: '低' };
  var priCls = { 2: 'priority-high', 1: 'priority-mid', 0: 'priority-low' };
  var html = '';

  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    html += '<div class="task-item ' + (t.completed ? 'completed' : '') + ' ' + priCls[t.priority] + '">';
    html += '<div class="task-checkbox" onclick="toggleTask(\'' + t.id + '\')">' + (t.completed ? '✓' : '') + '</div>';
    html += '<div class="task-body">';
    html += '<div class="task-title">' + esc(t.title) + '</div>';
    if (t.content) html += '<div class="task-content">' + esc(t.content) + '</div>';
    html += '<div class="task-meta">';
    html += '<span class="journal-category cat-' + CAT_CSS[t.category] + '">' + CAT_EMOJI[t.category] + ' ' + t.category + '</span>';
    if (t.priority > 0) html += '<span style="color:' + (t.priority === 2 ? 'var(--danger)' : 'var(--warning)') + '">⚡ ' + priLabels[t.priority] + '优先</span>';
    if (t.dueDate) html += '<span>📅 ' + t.dueDate + '</span>';
    html += '</div></div>';
    html += '<div class="task-actions">';
    html += '<button class="btn-task-edit" onclick="openTaskModal(\'' + t.id + '\')" title="编辑">✏️</button>';
    html += '<button class="btn-task-del" onclick="deleteTask(\'' + t.id + '\')" title="删除">🗑️</button>';
    html += '</div></div>';
  }
  list.innerHTML = html;
}

function updateTaskCounts(allTasks) {
  var pending = allTasks.filter(function (t) { return !t.completed; });
  var completed = allTasks.filter(function (t) { return t.completed; });
  document.getElementById('tcAll').textContent = pending.length;
  for (var i = 0; i < CATS.length; i++) {
    var c = CATS[i];
    document.getElementById('tc' + c).textContent = pending.filter(function (t) { return t.category === c; }).length;
  }
  document.getElementById('tcCompleted').textContent = completed.length;
  document.getElementById('pendingBadge').textContent = pending.length;
}

function filterTasks(f) {
  taskFilter = f;
  var btns = document.querySelectorAll('.task-cat-btn');
  for (var i = 0; i < btns.length; i++) btns[i].classList.remove('active');
  var idxs = { all: 0, 健身: 1, 影视: 2, 学习: 3, 工作: 4, 日常: 5, completed: 6 };
  if (btns[idxs[f]]) btns[idxs[f]].classList.add('active');
  loadTasks();
}

function toggleTask(id) {
  var tasks = DB.tasks();
  var idx = tasks.findIndex(function (t) { return t.id === id && t.userId === user.id; });
  if (idx !== -1) {
    tasks[idx].completed = !tasks[idx].completed;
    tasks[idx].updatedAt = new Date().toISOString();
  }
  DB.saveTasks(tasks);
  loadTasks();
}

function openTaskModal(id) {
  var allTasks = DB.tasks().filter(function (t) { return t.userId === user.id; });
  var task = id ? allTasks.find(function (t) { return t.id === id; }) : null;
  var isEdit = !!task;

  var catOpts = '';
  for (var i = 0; i < CATS.length; i++) {
    catOpts += '<option value="' + CATS[i] + '" ' + (task && task.category === CATS[i] ? 'selected' : '') + '>' + CAT_EMOJI[CATS[i]] + ' ' + CATS[i] + '</option>';
  }

  var priOpts = [
    '<option value="0" ' + (task && task.priority === 0 ? 'selected' : '') + '>🟢 低</option>',
    '<option value="1" ' + (task && task.priority === 1 ? 'selected' : '') + '>🟡 中</option>',
    '<option value="2" ' + (task && task.priority === 2 ? 'selected' : '') + '>🔴 高</option>'
  ].join('');

  document.getElementById('modalContent').innerHTML =
    '<h3>' + (isEdit ? '编辑事项' : '新增事项') + '</h3>' +
    '<div class="form-group"><label>分类</label><select id="tCat">' + catOpts + '</select></div>' +
    '<div class="form-group"><label>标题</label><input type="text" id="tTitle" value="' + (task ? esc(task.title) : '') + '" placeholder="事项标题"></div>' +
    '<div class="form-group"><label>详细描述</label><textarea id="tContent" placeholder="补充描述...">' + (task ? esc(task.content || '') : '') + '</textarea></div>' +
    '<div class="form-group"><label>优先级</label><select id="tPriority">' + priOpts + '</select></div>' +
    '<div class="form-group"><label>截止日期（可选）</label><input type="date" id="tDueDate" value="' + (task && task.dueDate ? task.dueDate : '') + '"></div>' +
    '<div class="modal-actions">' +
    '<button class="btn-cancel" onclick="closeModal()">取消</button>' +
    '<button class="btn-submit" onclick="saveTask(\'' + (id || '') + '\')">' + (isEdit ? '保存修改' : '创建事项') + '</button>' +
    '</div>';
  document.getElementById('modalOverlay').style.display = 'flex';
  setTimeout(function () {
    var el = document.getElementById('tTitle');
    if (el) el.focus();
  }, 100);
}

function saveTask(id) {
  var cat = document.getElementById('tCat').value;
  var title = document.getElementById('tTitle').value.trim();
  var content = document.getElementById('tContent').value.trim();
  var priority = parseInt(document.getElementById('tPriority').value);
  var dueDate = document.getElementById('tDueDate').value || null;
  if (!title) { toast('请输入标题', 'error'); return; }

  var tasks = DB.tasks();
  if (id) {
    var idx = tasks.findIndex(function (t) { return t.id === id && t.userId === user.id; });
    if (idx !== -1) {
      tasks[idx].category = cat;
      tasks[idx].title = title;
      tasks[idx].content = content;
      tasks[idx].priority = priority;
      tasks[idx].dueDate = dueDate;
      tasks[idx].updatedAt = new Date().toISOString();
    }
    toast('事项已更新');
  } else {
    tasks.push({ id: uid(), userId: user.id, category: cat, title: title, content: content, priority: priority, dueDate: dueDate, completed: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    toast('事项已创建');
  }
  DB.saveTasks(tasks);
  closeModal();
  loadTasks();
}

function deleteTask(id) {
  if (!confirm('确定删除这个事项？')) return;
  var tasks = DB.tasks().filter(function (t) { return !(t.id === id && t.userId === user.id); });
  DB.saveTasks(tasks);
  toast('事项已删除');
  loadTasks();
}

// ==================== 键盘快捷键 ====================
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') closeModal();
});

// ==================== 初始化 ====================
(function () {
  if (user) {
    // 验证用户数据完整性
    var users = DB.users();
    var found = users.find(function (u) { return u.id === user.id; });
    if (found) {
      user.nickname = found.nickname;
      showApp();
    } else {
      DB.set('current_user', null);
      user = null;
    }
  }
})();
