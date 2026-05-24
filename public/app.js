// ==================== API 通信层 ====================
const API_BASE = window.location.origin;

const API = {
  token: localStorage.getItem('tm_token'),

  setToken(t) { this.token = t; localStorage.setItem('tm_token', t || ''); },

  async _fetch(url, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
    const res = await fetch(API_BASE + url, { ...options, headers });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '请求失败');
    return data;
  },

  async get(url) { return this._fetch(url); },
  async post(url, body) { return this._fetch(url, { method: 'POST', body: JSON.stringify(body) }); },
  async put(url, body) { return this._fetch(url, { method: 'PUT', body: JSON.stringify(body) }); },
  async del(url) { return this._fetch(url, { method: 'DELETE' }); },
  async patch(url, body) { return this._fetch(url, { method: 'PATCH', body: JSON.stringify(body) }); },

  // ---- 认证 ----
  register: (b) => API.post('/api/register', b),
  login: (b) => API.post('/api/login', b),
  logout: () => API.post('/api/logout'),

  // ---- 日记 ----
  getDiaries: (y, m, cat) => {
    var params = 'year=' + y + '&month=' + m;
    if (cat) params += '&category=' + cat;
    return API.get('/api/diaries?' + params);
  },
  getDiariesByDate: (d) => API.get('/api/diaries/date/' + d),
  createDiary: (b) => API.post('/api/diaries', b),
  updateDiary: (id, b) => API.put('/api/diaries/' + id, b),
  deleteDiary: (id) => API.del('/api/diaries/' + id),

  // ---- 任务 ----
  getTasks: (params) => API.get('/api/tasks?' + new URLSearchParams(params).toString()),
  createTask: (b) => API.post('/api/tasks', b),
  updateTask: (id, b) => API.put('/api/tasks/' + id, b),
  deleteTask: (id) => API.del('/api/tasks/' + id),
  toggleTask: (id) => API.patch('/api/tasks/' + id + '/toggle'),

  // ---- 统计 ----
  getStats: () => API.get('/api/stats')
};

// ==================== 全局状态 ====================
let user = JSON.parse(localStorage.getItem('tm_user') || 'null');
let isLogin = true;
let currentTab = 'calendar';
let currentYear, currentMonth, selectedDate;
let diaryMap = {};
let calFilter = null;
let taskFilter = 'all';
let tasksCache = [];
let diariesCache = [];
let diaryFilter = null;

const CATS = ['健身', '影视', '学习', '工作', '日常', '游戏'];
const CAT_EMOJI = { 健身: '💪', 影视: '🎬', 学习: '📚', 工作: '💼', 日常: '🌟', 游戏: '🎮' };
const CAT_CSS = { 健身: 'fitness', 影视: 'movie', 学习: 'study', 工作: 'work', 日常: 'daily', 游戏: 'game' };
const CAT_TC_ID = { 健身: 'tcFitness', 影视: 'tcMovie', 学习: 'tcStudy', 工作: 'tcWork', 日常: 'tcDaily', 游戏: 'tcGame' };
const MOODS = { '好': '😊', '一般': '😐', '差': '😞' };
const MOOD_CSS = { '好': 'mood-good', '一般': 'mood-ok', '差': 'mood-bad' };

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
function esc(s) { var d = document.createElement('div'); d.textContent = (s || ''); return d.innerHTML; }
function today() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

// 格式化 SQLite 时间字符串为 YYYY-MM-DD HH:MM，不经过 new Date() 避免时区漂移
function fmtTimeShort(dt) {
  if (!dt) return '';
  var m = dt.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  if (m) return m[2];
  return dt;
}

// ==================== 实时时钟 ====================
function startClock() {
  function tick() {
    var el = document.getElementById('liveClock');
    if (!el) return;
    var d = new Date();
    el.textContent = String(d.getHours()).padStart(2, '0') + ':' +
                     String(d.getMinutes()).padStart(2, '0') + ':' +
                     String(d.getSeconds()).padStart(2, '0');
  }
  tick();
  setInterval(tick, 1000);
}

// ==================== 认证 ====================
function toggleAuthMode() {
  isLogin = !isLogin;
  var el;
  el = document.getElementById('authSubmitBtn'); if (el) el.textContent = isLogin ? '登 录' : '注 册';
  var ng = document.getElementById('nicknameGroup'); if (ng) ng.style.display = isLogin ? 'none' : 'block';
  el = document.getElementById('switchText'); if (el) el.textContent = isLogin ? '还没有账号？' : '已有账号？';
  el = document.getElementById('switchLink'); if (el) el.textContent = isLogin ? '立即注册' : '去登录';
  el = document.getElementById('authError'); if (el) el.style.display = 'none';
  var form = document.getElementById('authForm'); if (form) form.reset();
}

function togglePw() {
  var pw = document.getElementById('password');
  var btn = document.getElementById('pwToggle');
  if (!pw || !btn) return;
  if (pw.type === 'password') { pw.type = 'text'; btn.textContent = '🙈'; }
  else { pw.type = 'password'; btn.textContent = '👁️'; }
}

document.getElementById('authForm').addEventListener('submit', async function (e) {
  e.preventDefault();
  var email = document.getElementById('email').value.trim();
  var password = document.getElementById('password').value;
  var nickname = document.getElementById('nickname').value.trim();
  var errEl = document.getElementById('authError');
  errEl.style.display = 'none';

  if (!email || !password) { errEl.textContent = '邮箱和密码不能为空'; errEl.style.display = 'block'; return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.textContent = '邮箱格式不正确'; errEl.style.display = 'block'; return; }
  if (password.length < 6) { errEl.textContent = '密码至少6位'; errEl.style.display = 'block'; return; }

  try {
    var result;
    if (isLogin) {
      result = await API.login({ email: email, password: password });
    } else {
      result = await API.register({ email: email, password: password, nickname: nickname });
    }
    API.setToken(result.token);
    user = result.user;
    localStorage.setItem('tm_user', JSON.stringify(user));
    toast(result.message);
    showApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
});

async function logout() {
  try { await API.logout(); } catch (e) { /* ignore */ }
  API.setToken('');
  user = null;
  localStorage.removeItem('tm_user');
  document.getElementById('authPage').style.display = 'flex';
  document.getElementById('appPage').style.display = 'none';
  toast('已退出登录');
}

// ==================== 应用入口 ====================
function showApp() {
  document.getElementById('authPage').style.display = 'none';
  document.getElementById('appPage').style.display = 'block';
  var el;
  el = document.getElementById('userNickname'); if (el) el.textContent = user.nickname || user.email;
  el = document.getElementById('userAvatar'); if (el) el.textContent = (user.nickname || user.email)[0].toUpperCase();
  var now = new Date();
  currentYear = now.getFullYear();
  currentMonth = now.getMonth() + 1;
  selectedDate = today();
  startClock();
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
    loadDiaries();
  } else {
    btns[1].classList.add('active');
    document.getElementById('calendarTab').style.display = 'none';
    document.getElementById('tasksTab').style.display = 'grid';
    loadTasks();
  }
}

// ==================== 日历 ====================
function updateDots() {
  diaryMap = {};
  for (var i = 0; i < diariesCache.length; i++) {
    var d = diariesCache[i];
    if (!diaryMap[d.diary_date]) diaryMap[d.diary_date] = {};
    diaryMap[d.diary_date][d.category] = true;
  }
  var allDots = document.querySelectorAll('.day-dots');
  for (var i = 0; i < allDots.length; i++) allDots[i].innerHTML = '';

  var keys = Object.keys(diaryMap);
  for (var i = 0; i < keys.length; i++) {
    var ds = keys[i];
    var cats = diaryMap[ds];
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
  var counts = { 健身: 0, 影视: 0, 学习: 0, 工作: 0, 日常: 0, 游戏: 0 };
  for (var i = 0; i < diariesCache.length; i++) {
    var c = diariesCache[i].category;
    if (counts[c] !== undefined) counts[c]++;
  }
  var el;
  el = document.getElementById('statFitness'); if (el) el.textContent = counts['健身'];
  el = document.getElementById('statMovie'); if (el) el.textContent = counts['影视'];
  el = document.getElementById('statStudy'); if (el) el.textContent = counts['学习'];
  el = document.getElementById('statWork'); if (el) el.textContent = counts['工作'];
  el = document.getElementById('statDaily'); if (el) el.textContent = counts['日常'];
  el = document.getElementById('statGame'); if (el) el.textContent = counts['游戏'];
}

function filterCalCat(cat) {
  calFilter = calFilter === cat ? null : cat;
  updateDots();
  toast(calFilter ? '已筛选: ' + cat : '已取消筛选');
}

function filterDiaryCat(cat) {
  diaryFilter = (cat === '全部') ? null : (diaryFilter === cat ? null : cat);
  var btns = document.querySelectorAll('.journal-filter-btn');
  for (var i = 0; i < btns.length; i++) btns[i].classList.remove('active');
  if (diaryFilter) {
    var idxs = { 全部:0, 健身:1, 影视:2, 学习:3, 工作:4, 日常:5, 游戏:6 };
    if (btns[idxs[diaryFilter]]) btns[idxs[diaryFilter]].classList.add('active');
  } else {
    if (btns[0]) btns[0].classList.add('active');
  }
  loadDiaries();
}

function selectDate(ds) {
  selectedDate = ds;
  renderCalendar();
  var diaries = diariesCache.filter(function (d) { return d.diary_date === ds; });
  if (diaryFilter) {
    diaries = diaries.filter(function (d) { return d.category === diaryFilter; });
  }
  renderDiaryDetail(ds, diaries);
}

function renderDiaryDetail(ds, diaries) {
  var detail = document.getElementById('journalDetail');
  if (!detail) return;
  var title = document.getElementById('journalDateTitle');
  var list = document.getElementById('journalList');
  if (!list) return;
  detail.style.display = 'block';
  if (title) title.textContent = '📅 ' + ds + ' 的手账';

  if (diaries.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">📖</div><p>这一天还没有手账记录</p></div>';
    return;
  }

  var html = '';
  for (var i = 0; i < diaries.length; i++) {
    var d = diaries[i];
    var time = fmtTimeShort(d.created_at);
    html += '<div class="diary-item">';
    html += '<div class="diary-meta">';
    html += '<span class="journal-category cat-' + CAT_CSS[d.category] + '">' + CAT_EMOJI[d.category] + ' ' + d.category + '</span>';
    if (d.mood) html += '<span class="mood-tag ' + MOOD_CSS[d.mood] + '">' + (MOODS[d.mood] || '') + ' ' + d.mood + '</span>';
    html += '<span style="color:var(--text-muted);font-size:12px;">' + time + '</span>';
    html += '</div>';
    html += '<div class="diary-title">' + esc(d.title) + '</div>';
    if (d.content) html += '<div class="diary-content">' + esc(d.content) + '</div>';
    if (d.image_url) {
      html += '<div class="diary-image"><img src="' + esc(d.image_url) + '" alt="配图" onerror="this.parentElement.style.display=\'none\'" loading="lazy"></div>';
    }
    html += '<div class="diary-actions">';
    html += '<button class="btn-edit" onclick="event.stopPropagation();openDiaryModal(\'' + d.id + '\')">✏️ 编辑</button>';
    html += '<button class="btn-del" onclick="event.stopPropagation();deleteDiary(\'' + d.id + '\')">🗑️ 删除</button>';
    html += '</div></div>';
  }
  list.innerHTML = html;
}

// ==================== 日记 CRUD ====================
function openDiaryModal(id) {
  var diary = id ? diariesCache.find(function (d) { return d.id == id; }) : null;
  var isEdit = !!diary;

  var catOpts = '';
  for (var i = 0; i < CATS.length; i++) {
    catOpts += '<option value="' + CATS[i] + '" ' + (diary && diary.category === CATS[i] ? 'selected' : '') + '>' + CAT_EMOJI[CATS[i]] + ' ' + CATS[i] + '</option>';
  }

  var moodOpts = '<option value="">-- 选择心情 --</option>';
  var moodKeys = Object.keys(MOODS);
  for (var j = 0; j < moodKeys.length; j++) {
    var m = moodKeys[j];
    moodOpts += '<option value="' + m + '" ' + (diary && diary.mood === m ? 'selected' : '') + '>' + MOODS[m] + ' ' + m + '</option>';
  }

  document.getElementById('modalContent').innerHTML =
    '<h3>' + (isEdit ? '编辑手账' : '写手账') + '</h3>' +
    '<div class="form-row"><div class="form-group"><label>分类</label><select id="dCat">' + catOpts + '</select></div>' +
    '<div class="form-group"><label>心情</label><select id="dMood">' + moodOpts + '</select></div></div>' +
    '<div class="form-group"><label>标题</label><input type="text" id="dTitle" value="' + (diary ? esc(diary.title) : '') + '" placeholder="给今天的手账起个标题"></div>' +
    '<div class="form-group"><label>内容</label><textarea id="dContent" placeholder="记录今天的事情...">' + (diary ? esc(diary.content || '') : '') + '</textarea></div>' +
    '<div class="form-group"><label>配图URL（可选）</label><input type="url" id="dImageUrl" value="' + (diary ? esc(diary.image_url || '') : '') + '" placeholder="https://example.com/image.jpg"></div>' +
    '<div class="modal-actions">' +
    '<button class="btn-cancel" onclick="closeModal()">取消</button>' +
    '<button class="btn-submit" onclick="saveDiary(\'' + (id || '') + '\')">' + (isEdit ? '保存修改' : '创建手账') + '</button>' +
    '</div>';
  document.getElementById('modalOverlay').style.display = 'flex';
  setTimeout(function () {
    var el = document.getElementById('dTitle');
    if (el) el.focus();
  }, 100);
}

async function saveDiary(id) {
  var cat = document.getElementById('dCat').value;
  var title = document.getElementById('dTitle').value.trim();
  var content = document.getElementById('dContent').value.trim();
  var mood = document.getElementById('dMood').value;
  var image_url = document.getElementById('dImageUrl').value.trim();
  if (!title) { toast('请输入标题', 'error'); return; }

  try {
    if (id) {
      await API.updateDiary(id, { category: cat, title: title, content: content, mood: mood, image_url: image_url });
      toast('手账已更新');
    } else {
      await API.createDiary({ category: cat, title: title, content: content, diary_date: selectedDate, mood: mood, image_url: image_url });
      toast('手账已创建');
    }
    closeModal();
    await loadDiaries();
    selectDate(selectedDate);
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteDiary(id) {
  if (!confirm('确定删除这条手账？')) return;
  try {
    await API.deleteDiary(id);
    toast('手账已删除');
    await loadDiaries();
    selectDate(selectedDate);
  } catch (err) { toast(err.message, 'error'); }
}

function closeModal() {
  document.getElementById('modalOverlay').style.display = 'none';
}

// ==================== 同步加载日记 ====================
async function loadDiaries() {
  try {
    var result = await API.getDiaries(currentYear, currentMonth, diaryFilter);
    diariesCache = result.diaries || [];
    renderCalendar();
    updateCalStats();
    selectDate(selectedDate);
  } catch (err) {
    toast('加载日记失败: ' + err.message, 'error');
  }
}

function renderCalendar() {
  var el = document.getElementById('calendarTitle');
  if (el) el.textContent = currentYear + '年 ' + currentMonth + '月';
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

  for (var i = firstDay - 1; i >= 0; i--) {
    var d = prevDays - i;
    var m = currentMonth === 1 ? 12 : currentMonth - 1;
    var y = currentMonth === 1 ? currentYear - 1 : currentYear;
    grid.appendChild(createDay(d, y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'), true));
  }
  for (var d = 1; d <= daysInMonth; d++) {
    var ds = currentYear + '-' + String(currentMonth).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    grid.appendChild(createDay(d, ds, false, ds === todayStr, ds === selectedDate));
  }
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

function prevMonth() {
  if (currentMonth === 1) { currentMonth = 12; currentYear--; }
  else currentMonth--;
  loadDiaries();
}
function nextMonth() {
  if (currentMonth === 12) { currentMonth = 1; currentYear++; }
  else currentMonth++;
  loadDiaries();
}
async function goToToday() {
  var now = new Date();
  currentYear = now.getFullYear();
  currentMonth = now.getMonth() + 1;
  selectedDate = today();
  await loadDiaries();
  selectDate(selectedDate);
}

// ==================== 待办事项 ====================
async function loadTasks() {
  try {
    var params = {};
    if (taskFilter !== 'all' && taskFilter !== 'completed') params.category = taskFilter;
    if (taskFilter === 'completed') params.completed = '1';
    var result = await API.getTasks(params);
    tasksCache = result.tasks || [];

    var filtered = tasksCache;
    if (taskFilter === 'all') {
      filtered = tasksCache.filter(function (t) { return !t.completed; });
    } else if (taskFilter === 'completed') {
      filtered = tasksCache;
    } else {
      filtered = tasksCache.filter(function (t) { return !t.completed; });
    }
    filtered.sort(function (a, b) { return b.priority - a.priority || new Date(b.created_at) - new Date(a.created_at); });
    renderTaskList(filtered);
    updateTaskCounts();
  } catch (err) { toast('加载任务失败: ' + err.message, 'error'); }
}

function renderTaskList(tasks) {
  var list = document.getElementById('taskList');
  if (!list) return;
  var title = document.getElementById('taskListTitle');
  var names = { all: '全部待办事项', completed: '已完成事项' };
  for (var i = 0; i < CATS.length; i++) names[CATS[i]] = CATS[i] + '待办';
  if (title) title.textContent = names[taskFilter] || '待办事项';

  if (tasks.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">📝</div><p>暂无' + (names[taskFilter] || '') + '</p></div>';
    return;
  }

  function fmtTime(dt) {
    if (!dt) return '';
    // SQLite 返回 "YYYY-MM-DD HH:MM:SS" 格式，直接提取避免 new Date() 时区漂移
    var m = dt.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
    if (m) return m[1] + ' ' + m[2];
    return dt;
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
    if (t.due_date) html += '<span>📅 ' + t.due_date + '</span>';
    // 设置时间 & 完成时间
    html += '<span class="task-time">🕐 设置: ' + fmtTime(t.created_at) + '</span>';
    if (t.completed && t.completed_at) {
      html += '<span class="task-time task-time-done">✅ 完成: ' + fmtTime(t.completed_at) + '</span>';
    } else {
      html += '<span class="task-time task-time-pending">⏳ 完成: 未完成</span>';
    }
    html += '</div></div>';
    html += '<div class="task-actions">';
    html += '<button class="btn-task-edit" onclick="openTaskModal(\'' + t.id + '\')" title="编辑">✏️</button>';
    html += '<button class="btn-task-del" onclick="deleteTask(\'' + t.id + '\')" title="删除">🗑️</button>';
    html += '</div></div>';
  }
  list.innerHTML = html;
}

function updateTaskCounts() {
  var pending = tasksCache.filter(function (t) { return !t.completed; });
  var completed = tasksCache.filter(function (t) { return t.completed; });
  var el;
  el = document.getElementById('tcAll'); if (el) el.textContent = pending.length;
  for (var i = 0; i < CATS.length; i++) {
    var c = CATS[i];
    el = document.getElementById(CAT_TC_ID[c]); if (el) el.textContent = pending.filter(function (t) { return t.category === c; }).length;
  }
  el = document.getElementById('tcCompleted'); if (el) el.textContent = completed.length;
  el = document.getElementById('pendingBadge'); if (el) el.textContent = pending.length;
}

function filterTasks(f) {
  taskFilter = f;
  var btns = document.querySelectorAll('.task-cat-btn');
  for (var i = 0; i < btns.length; i++) btns[i].classList.remove('active');
  var idxs = { all: 0, 健身: 1, 影视: 2, 学习: 3, 工作: 4, 日常: 5, 游戏: 6, completed: 7 };
  if (btns[idxs[f]]) btns[idxs[f]].classList.add('active');
  loadTasks();
}

async function toggleTask(id) {
  try {
    await API.toggleTask(id);
    await loadTasks();
  } catch (err) { toast(err.message, 'error'); }
}

function openTaskModal(id) {
  var task = id ? tasksCache.find(function (t) { return t.id == id; }) : null;
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

  // 完成时间编辑（仅已完成任务显示）
  var completedAtHtml = '';
  if (isEdit && task.completed) {
    var catVal = task.completed_at ? task.completed_at.substring(0, 16) : '';
    completedAtHtml = '<div class="form-group"><label>✅ 完成时间（可编辑）</label><input type="datetime-local" id="tCompletedAt" value="' + catVal + '"></div>';
  }

  document.getElementById('modalContent').innerHTML =
    '<h3>' + (isEdit ? '编辑事项' : '新增事项') + '</h3>' +
    '<div class="form-group"><label>分类</label><select id="tCat">' + catOpts + '</select></div>' +
    '<div class="form-group"><label>标题</label><input type="text" id="tTitle" value="' + (task ? esc(task.title) : '') + '" placeholder="事项标题"></div>' +
    '<div class="form-group"><label>详细描述</label><textarea id="tContent" placeholder="补充描述...">' + (task ? esc(task.content || '') : '') + '</textarea></div>' +
    '<div class="form-group"><label>优先级</label><select id="tPriority">' + priOpts + '</select></div>' +
    '<div class="form-group"><label>截止日期（可选）</label><input type="date" id="tDueDate" value="' + (task && task.due_date ? task.due_date : '') + '"></div>' +
    completedAtHtml +
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

async function saveTask(id) {
  var cat = document.getElementById('tCat').value;
  var title = document.getElementById('tTitle').value.trim();
  var content = document.getElementById('tContent').value.trim();
  var priority = parseInt(document.getElementById('tPriority').value);
  var dueDate = document.getElementById('tDueDate').value || null;
  if (!title) { toast('请输入标题', 'error'); return; }

  var body = { category: cat, title: title, content: content, priority: priority, due_date: dueDate };
  // 已完成任务可修改完成时间
  var catEl = document.getElementById('tCompletedAt');
  if (catEl) {
    body.completed_at = catEl.value || null;
  }

  try {
    if (id) {
      await API.updateTask(id, body);
      toast('事项已更新');
    } else {
      await API.createTask(body);
      toast('事项已创建');
    }
    closeModal();
    await loadTasks();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteTask(id) {
  if (!confirm('确定删除这个事项？')) return;
  try {
    await API.deleteTask(id);
    toast('事项已删除');
    await loadTasks();
  } catch (err) { toast(err.message, 'error'); }
}

// ==================== 键盘快捷键 ====================
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') closeModal();
});

// ==================== 初始化 ====================
(function () {
  if (user && API.token) {
    var ap = document.getElementById('authPage');
    if (ap) ap.style.display = 'none';
    showApp();
  } else {
    API.setToken('');
    localStorage.removeItem('tm_user');
    user = null;
  }
})();
