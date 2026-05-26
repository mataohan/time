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
  getStats: () => API.get('/api/stats'),

  // ---- 记账 ----
  getExpenses: (params) => API.get('/api/expenses?' + new URLSearchParams(params).toString()),
  createExpense: (b) => API.post('/api/expenses', b),
  updateExpense: (id, b) => API.put('/api/expenses/' + id, b),
  deleteExpense: (id) => API.del('/api/expenses/' + id)
};

// ==================== 全局状态 ====================
let user = JSON.parse(localStorage.getItem('tm_user') || 'null');
let isLogin = true;
let currentTab = 'calendar';
let currentYear, currentMonth, selectedDate;
let diaryMap = {};
let taskStatusFilter = 'pending';
let taskCatFilter = null;
let tasksCache = [];
let diariesCache = [];
let diaryFilter = null;
let modalDirty = false;
let draftTimer = null;
const DRAFT_KEYS = { diary: 'draft_handwrite', task: 'draft_todo' };

const CATS = ['健身', '影视', '学习', '工作', '日常', '游戏', '视频消化'];
const CAT_EMOJI = { 健身: '💪', 影视: '🎬', 学习: '📚', 工作: '💼', 日常: '🌟', 游戏: '🎮', 视频消化: '🎥' };
const CAT_CSS = { 健身: 'fitness', 影视: 'movie', 学习: 'study', 工作: 'work', 日常: 'daily', 游戏: 'game', 视频消化: 'video' };
const CAT_TC_ID = { 健身: 'tcFitness', 影视: 'tcMovie', 学习: 'tcStudy', 工作: 'tcWork', 日常: 'tcDaily', 游戏: 'tcGame', 视频消化: 'tcVideo' };
const MOODS = { '好': '😊', '一般': '😐', '差': '😞' };
const MOOD_CSS = { '好': 'mood-good', '一般': 'mood-ok', '差': 'mood-bad' };

const EXP_CATS = ['餐饮', '购物', '交通', '娱乐', '医疗', '其他'];
const EXP_EMOJI = { 餐饮: '🍜', 购物: '🛒', 交通: '🚗', 娱乐: '🎮', 医疗: '🏥', 其他: '📦' };
const EXP_CSS = { 餐饮: 'dining', 购物: 'shopping', 交通: 'transport', 娱乐: 'entertainment', 医疗: 'medical', 其他: 'other' };

let expYear, expMonth, expSelectedDate, expensesCache = [];

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

// 将服务器时间转为本地 Date 对象（服务器存 UTC, 序列化为 ISO 字符串或 Date 对象）
function toLocalDate(dt) {
  if (!dt) return null;
  if (dt instanceof Date) return dt;
  var s = String(dt).trim();
  // ISO 8601 或带时区格式, new Date() 可直接解析
  if (s.indexOf('T') !== -1 || s.indexOf('Z') !== -1) return new Date(s);
  // 纯 "YYYY-MM-DD HH:MM:SS" 无时区 → 假定为 UTC
  return new Date(s.replace(' ', 'T') + 'Z');
}

// 格式化为本地时间 HH:MM
function fmtTimeShort(dt) {
  var d = toLocalDate(dt);
  if (d && !isNaN(d.getTime())) {
    return d.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  var m = String(dt || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  return m ? m[2] : String(dt || '');
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
  // 后台预加载待办事项，初始化角标数字
  loadTasks();
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
    document.getElementById('expensesTab').style.display = 'none';
    loadDiaries();
  } else if (tab === 'tasks') {
    btns[1].classList.add('active');
    document.getElementById('calendarTab').style.display = 'none';
    document.getElementById('tasksTab').style.display = 'grid';
    document.getElementById('expensesTab').style.display = 'none';
    loadTasks();
  } else if (tab === 'expenses') {
    btns[2].classList.add('active');
    document.getElementById('calendarTab').style.display = 'none';
    document.getElementById('tasksTab').style.display = 'none';
    document.getElementById('expensesTab').style.display = 'block';
    initExpenses();
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
      var dot = document.createElement('span');
      dot.className = 'day-dot dot-' + CAT_CSS[c];
      dotsEl.appendChild(dot);
    }
  }
}

function filterDiaryCat(cat) {
  diaryFilter = (cat === '全部') ? null : (diaryFilter === cat ? null : cat);
  var btns = document.querySelectorAll('.journal-filter-btn');
  for (var i = 0; i < btns.length; i++) btns[i].classList.remove('active');
  if (diaryFilter) {
    var idxs = { 全部:0, 健身:1, 影视:2, 学习:3, 工作:4, 日常:5, 游戏:6, 视频消化:7 };
    if (btns[idxs[diaryFilter]]) btns[idxs[diaryFilter]].classList.add('active');
  } else {
    if (btns[0]) btns[0].classList.add('active');
  }
  loadDiaries();
}

function selectDate(ds, skipRender) {
  selectedDate = ds;
  if (!skipRender) renderCalendar();
  var diaries = diariesCache.filter(function (d) { return normalizeDate(d.diary_date) === ds; });
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
    html += '<span style="color:var(--text-muted);font-size:13px;">' + time + '</span>';
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

  stopDraftAutoSave();
  modalDirty = false;

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

  // 检查草稿（仅新建手账时）
  var draftBanner = '';
  if (!isEdit) {
    var draft = loadDraft(DRAFT_KEYS.diary);
    if (draft && !isDraftEmpty(draft)) {
      draftBanner = '<div class="draft-banner" id="draftBanner"><span>📝 检测到上次未完成的草稿，是否恢复？</span><div class="draft-banner-actions"><button onclick="restoreDraft(event,\'' + DRAFT_KEYS.diary + '\')">恢复</button><button onclick="discardDraft(event,\'' + DRAFT_KEYS.diary + '\')">放弃</button></div></div>';
    }
  }

  document.getElementById('modalContent').innerHTML =
    draftBanner +
    '<h3>' + (isEdit ? '编辑手账' : '写手账') + '</h3>' +
    '<div class="form-row"><div class="form-group"><label>分类</label><select id="dCat" onchange="modalDirty=true">' + catOpts + '</select></div>' +
    '<div class="form-group"><label>心情</label><select id="dMood" onchange="modalDirty=true">' + moodOpts + '</select></div></div>' +
    '<div class="form-group"><label>标题</label><input type="text" id="dTitle" value="' + (diary ? esc(diary.title) : '') + '" placeholder="给今天的手账起个标题" oninput="modalDirty=true"></div>' +
    '<div class="form-group"><label>内容</label><textarea id="dContent" placeholder="记录今天的事情..." oninput="modalDirty=true">' + (diary ? esc(diary.content || '') : '') + '</textarea></div>' +
    '<div class="form-group"><label>配图URL（可选）</label><input type="url" id="dImageUrl" value="' + (diary ? esc(diary.image_url || '') : '') + '" placeholder="https://example.com/image.jpg" oninput="modalDirty=true"></div>' +
    '<div class="modal-actions">' +
    '<button class="btn-cancel" onclick="closeModal()">取消</button>' +
    '<button class="btn-submit" onclick="saveDiary(\'' + (id || '') + '\')">' + (isEdit ? '保存修改' : '创建手账') + '</button>' +
    '</div>';
  document.getElementById('modalOverlay').style.display = 'flex';

  // 仅新建时启动自动保存
  if (!isEdit) startDraftAutoSave(DRAFT_KEYS.diary);

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
    clearDraft(DRAFT_KEYS.diary);
    stopDraftAutoSave();
    modalDirty = false;
    closeModal();
    // 清除分类筛选，确保新创建/编辑的手账一定能显示
    diaryFilter = null;
    var btns = document.querySelectorAll('.journal-filter-btn');
    for (var i = 0; i < btns.length; i++) btns[i].classList.remove('active');
    if (btns[0]) btns[0].classList.add('active');
    await loadDiaries();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteDiary(id) {
  if (!confirm('确定删除这条手账？')) return;
  try {
    await API.deleteDiary(id);
    toast('手账已删除');
    // 清除筛选后重新加载，否则删除后日记可能仍在缓存中不更新
    diaryFilter = null;
    var btns = document.querySelectorAll('.journal-filter-btn');
    for (var i = 0; i < btns.length; i++) btns[i].classList.remove('active');
    if (btns[0]) btns[0].classList.add('active');
    await loadDiaries();
  } catch (err) { toast(err.message, 'error'); }
}

function closeModal() {
  if (modalDirty && !confirm('您输入的内容尚未保存，确定要离开吗？')) return;
  stopDraftAutoSave();
  modalDirty = false;
  document.getElementById('modalOverlay').style.display = 'none';
}

// ==================== 同步加载日记 ====================
// 将 MySQL2 返回的 Date 对象统一转为 YYYY-MM-DD 字符串，避免 === 比较失败
function normalizeDate(d) {
  if (!d) return '';
  if (typeof d === 'object' && d instanceof Date) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }
  // 截取日期部分 "YYYY-MM-DD"
  if (typeof d === 'string') return d.substring(0, 10);
  return String(d);
}

async function loadDiaries() {
  try {
    var result = await API.getDiaries(currentYear, currentMonth, diaryFilter);
    diariesCache = result.diaries || [];
    // 标准化所有日记的日期字段
    for (var i = 0; i < diariesCache.length; i++) {
      diariesCache[i].diary_date = normalizeDate(diariesCache[i].diary_date);
    }
    renderCalendar();
    selectDate(selectedDate, true);
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
}

// ==================== 待办事项 ====================
async function loadTasks() {
  try {
    var params = { status: taskStatusFilter };
    if (taskCatFilter) params.category = taskCatFilter;
    var result = await API.getTasks(params);
    tasksCache = result.tasks || [];
    renderTaskList(tasksCache);
    updateTaskCounts();
  } catch (err) { toast('加载任务失败: ' + err.message, 'error'); }
}

function fmtTime(dt) {
  var d = toLocalDate(dt);
  if (d && !isNaN(d.getTime())) {
    return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  var m = String(dt || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  return m ? m[1] + ' ' + m[2] : String(dt || '');
}

// ==================== 草稿自动保存 ====================
function getModalFormData() {
  var modal = document.getElementById('modalContent');
  if (!modal) return {};
  var data = {};
  var els = modal.querySelectorAll('input, textarea, select');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (el.id) {
      data[el.id] = el.type === 'checkbox' ? el.checked : el.value;
    }
  }
  return data;
}

function isDraftEmpty(data) {
  if (!data) return true;
  var vals = Object.values(data);
  for (var i = 0; i < vals.length; i++) {
    if (vals[i] && String(vals[i]).trim() !== '') return false;
  }
  return true;
}

function saveDraft(key) {
  var data = getModalFormData();
  if (Object.keys(data).length === 0 || isDraftEmpty(data)) return;
  localStorage.setItem(key, JSON.stringify(data));
}

function loadDraft(key) {
  try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
  catch (e) { return null; }
}

function clearDraft(key) {
  localStorage.removeItem(key);
}

function stopDraftAutoSave() {
  if (draftTimer) { clearInterval(draftTimer); draftTimer = null; }
}

function startDraftAutoSave(key) {
  stopDraftAutoSave();
  draftTimer = setInterval(function () { saveDraft(key); }, 5000);
}

function restoreDraft(e, key) {
  e.stopPropagation();
  var draft = loadDraft(key);
  if (!draft) return;
  var keys = Object.keys(draft);
  for (var i = 0; i < keys.length; i++) {
    var el = document.getElementById(keys[i]);
    if (el) {
      if (el.type === 'checkbox') el.checked = draft[keys[i]];
      else el.value = draft[keys[i]];
    }
  }
  modalDirty = true;
  var banner = document.getElementById('draftBanner');
  if (banner) banner.remove();
  toast('已恢复草稿');
}

function discardDraft(e, key) {
  e.stopPropagation();
  clearDraft(key);
  var banner = document.getElementById('draftBanner');
  if (banner) banner.remove();
}

function renderTaskList(tasks) {
  var list = document.getElementById('taskList');
  if (!list) return;
  var title = document.getElementById('taskListTitle');
  var names = { pending: '待办事项', completed: '已完成事项', unfinished: '未完成事项' };
  var label = (names[taskStatusFilter] || '待办事项') + (taskCatFilter ? ' · ' + taskCatFilter : '');
  if (title) title.textContent = label;

  if (tasks.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">📝</div><p>暂无' + label + '</p></div>';
    return;
  }

  var priLabels = { 2: '高', 1: '中', 0: '低' };
  var priCls = { 2: 'priority-high', 1: 'priority-mid', 0: 'priority-low' };
  var html = '';

  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    var isDone = t.status === 'completed' || t.completed;
    var isUnfinished = t.status === 'unfinished';
    var cls = 'task-item' + (isDone ? ' completed' : '') + (isUnfinished ? ' task-unfinished' : '') + ' ' + (priCls[t.priority] || '');
    html += '<div class="' + cls + '">';

    // 左侧圆圈
    if (isUnfinished) {
      html += '<div class="task-checkbox task-unfinish-dot" onclick="restoreTask(\'' + t.id + '\')" title="恢复为待办">↩</div>';
    } else if (isDone) {
      html += '<div class="task-checkbox" onclick="toggleTask(\'' + t.id + '\')" title="取消完成">✓</div>';
    } else {
      html += '<div class="task-checkbox" onclick="toggleTask(\'' + t.id + '\')" title="标记完成"></div>';
    }

    html += '<div class="task-body">';
    html += '<div class="task-title">' + esc(t.title) + '</div>';
    if (t.content) html += '<div class="task-content">' + esc(t.content) + '</div>';

    // 未完成：显示原因和时间
    if (isUnfinished && t.unfinished_reason) {
      html += '<div class="task-unfinished-reason">💬 ' + esc(t.unfinished_reason) + '</div>';
      if (t.unfinished_at) html += '<div class="task-unfinished-time">🕐 标记时间: ' + fmtTime(t.unfinished_at) + '</div>';
    }

    html += '<div class="task-meta">';
    html += '<span class="journal-category cat-' + CAT_CSS[t.category] + '">' + CAT_EMOJI[t.category] + ' ' + t.category + '</span>';
    if (t.priority > 0) html += '<span style="color:' + (t.priority === 2 ? 'var(--danger)' : 'var(--warning)') + '">⚡ ' + priLabels[t.priority] + '优先</span>';
    if (t.due_date) html += '<span>📅 ' + t.due_date + '</span>';
    html += '<span class="task-time">🕐 设置: ' + fmtTime(t.created_at) + '</span>';
    if (isDone && t.completed_at) {
      html += '<span class="task-time task-time-done">✅ 完成: ' + fmtTime(t.completed_at) + '</span>';
    } else if (!isUnfinished) {
      html += '<span class="task-time task-time-pending">⏳ 完成: 未完成</span>';
    }
    html += '</div></div>';

    // 右侧按钮
    html += '<div class="task-actions">';
    // 待办项显示"未完成"按钮
    if (!isDone && !isUnfinished) {
      html += '<button class="btn-task-unfinish" onclick="openUnfinishedModal(\'' + t.id + '\')" title="标记为未完成">❌</button>';
    }
    // 未完成项显示"恢复"按钮
    if (isUnfinished) {
      html += '<button class="btn-task-restore" onclick="restoreTask(\'' + t.id + '\')" title="恢复为待办">🔄</button>';
    }
    html += '<button class="btn-task-edit" onclick="openTaskModal(\'' + t.id + '\')" title="编辑">✏️</button>';
    html += '<button class="btn-task-del" onclick="deleteTask(\'' + t.id + '\')" title="删除">🗑️</button>';
    html += '</div></div>';
  }
  list.innerHTML = html;
}

function updateTaskCounts() {
  var pending = tasksCache.filter(function (t) { return t.status === 'pending' || (!t.status && !t.completed); });
  var completed = tasksCache.filter(function (t) { return t.status === 'completed' || t.completed; });
  var unfinished = tasksCache.filter(function (t) { return t.status === 'unfinished'; });
  var el;
  el = document.getElementById('tcPending'); if (el) el.textContent = pending.length;
  el = document.getElementById('tcCompleted'); if (el) el.textContent = completed.length;
  el = document.getElementById('tcUnfinished'); if (el) el.textContent = unfinished.length;
  // 分类计数（仅 pending）
  for (var i = 0; i < CATS.length; i++) {
    var c = CATS[i];
    el = document.getElementById(CAT_TC_ID[c]);
    if (el) el.textContent = pending.filter(function (t) { return t.category === c; }).length;
  }
  el = document.getElementById('pendingBadge'); if (el) el.textContent = pending.length;
}

// ==================== 任务筛选 ====================
function filterTasksByStatus(status) {
  taskStatusFilter = status;
  taskCatFilter = null;
  var sbtns = document.querySelectorAll('.task-status-btn');
  var sidxs = { pending: 0, completed: 1, unfinished: 2 };
  for (var i = 0; i < sbtns.length; i++) sbtns[i].classList.remove('active');
  if (sbtns[sidxs[status]]) sbtns[sidxs[status]].classList.add('active');
  // 重置分类筛选
  var cbtns = document.querySelectorAll('.task-subcat-btn');
  for (var i = 0; i < cbtns.length; i++) cbtns[i].classList.remove('active');
  if (cbtns[0]) cbtns[0].classList.add('active');
  loadTasks();
}

function filterTasksByCat(cat) {
  taskCatFilter = cat;
  var btns = document.querySelectorAll('.task-subcat-btn');
  var catList = [''].concat(CATS);
  for (var i = 0; i < btns.length; i++) btns[i].classList.remove('active');
  for (var i = 0; i < catList.length; i++) {
    if (String(catList[i]) === String(cat || '')) { if (btns[i]) btns[i].classList.add('active'); break; }
  }
  loadTasks();
}

// ==================== 任务操作 ====================
async function toggleTask(id) {
  // 确认对话框
  var task = tasksCache.find(function (t) { return t.id == id; });
  var isCompleted = task && (task.status === 'completed' || task.completed);
  if (!isCompleted && !confirm('确定完成此事项吗？')) return;
  try {
    await API.toggleTask(id);
    toast(isCompleted ? '已恢复为待办' : '事项已完成 ✅');
    await loadTasks();
  } catch (err) { toast(err.message, 'error'); }
}

function openUnfinishedModal(id) {
  stopDraftAutoSave();
  modalDirty = false;
  document.getElementById('modalContent').innerHTML =
    '<h3>❌ 标记为未完成</h3>' +
    '<div class="form-group"><label>未完成原因（必填）</label><textarea id="unReason" placeholder="请填写未完成的原因..." oninput="modalDirty=true"></textarea></div>' +
    '<div class="modal-actions">' +
    '<button class="btn-cancel" onclick="closeModal()">取消</button>' +
    '<button class="btn-submit" onclick="confirmUnfinished(\'' + id + '\')">确认标记</button>' +
    '</div>';
  document.getElementById('modalOverlay').style.display = 'flex';
  setTimeout(function () {
    var el = document.getElementById('unReason');
    if (el) el.focus();
  }, 100);
}

async function confirmUnfinished(id) {
  var reason = document.getElementById('unReason').value.trim();
  if (!reason) { toast('请填写未完成原因', 'error'); return; }
  try {
    await API.updateTask(id, { status: 'unfinished', unfinished_reason: reason });
    modalDirty = false;
    closeModal();
    toast('已标记为未完成');
    await loadTasks();
  } catch (err) { toast(err.message, 'error'); }
}

async function restoreTask(id) {
  try {
    await API.updateTask(id, { status: 'pending' });
    toast('已恢复为待办');
    await loadTasks();
  } catch (err) { toast(err.message, 'error'); }
}

function openTaskModal(id) {
  var task = id ? tasksCache.find(function (t) { return t.id == id; }) : null;
  var isEdit = !!task;

  stopDraftAutoSave();
  modalDirty = false;

  var catOpts = '';
  for (var i = 0; i < CATS.length; i++) {
    catOpts += '<option value="' + CATS[i] + '" ' + (task && task.category === CATS[i] ? 'selected' : '') + '>' + CAT_EMOJI[CATS[i]] + ' ' + CATS[i] + '</option>';
  }

  var priOpts = [
    '<option value="0" ' + (task && task.priority === 0 ? 'selected' : '') + '>🟢 低</option>',
    '<option value="1" ' + (task && task.priority === 1 ? 'selected' : '') + '>🟡 中</option>',
    '<option value="2" ' + (task && task.priority === 2 ? 'selected' : '') + '>🔴 高</option>'
  ].join('');

  // 已完成任务可编辑完成时间
  var completedAtHtml = '';
  if (isEdit && (task.status === 'completed' || task.completed)) {
    var catVal = '';
    if (task.completed_at) {
      catVal = typeof task.completed_at === 'string' ? task.completed_at.substring(0, 16) : '';
    }
    completedAtHtml = '<div class="form-group"><label>✅ 完成时间（可编辑）</label><input type="datetime-local" id="tCompletedAt" value="' + esc(catVal) + '" oninput="modalDirty=true"></div>';
  }

  // 检查草稿（仅新增任务时）
  var draftBanner = '';
  if (!isEdit) {
    var draft = loadDraft(DRAFT_KEYS.task);
    if (draft && !isDraftEmpty(draft)) {
      draftBanner = '<div class="draft-banner" id="draftBanner"><span>📝 检测到上次未完成的任务草稿，是否恢复？</span><div class="draft-banner-actions"><button onclick="restoreDraft(event,\'' + DRAFT_KEYS.task + '\')">恢复</button><button onclick="discardDraft(event,\'' + DRAFT_KEYS.task + '\')">放弃</button></div></div>';
    }
  }

  document.getElementById('modalContent').innerHTML =
    draftBanner +
    '<h3>' + (isEdit ? '编辑事项' : '新增事项') + '</h3>' +
    '<div class="form-group"><label>分类</label><select id="tCat" onchange="modalDirty=true">' + catOpts + '</select></div>' +
    '<div class="form-group"><label>标题</label><input type="text" id="tTitle" value="' + (task ? esc(task.title) : '') + '" placeholder="事项标题" oninput="modalDirty=true"></div>' +
    '<div class="form-group"><label>详细描述</label><textarea id="tContent" placeholder="补充描述..." oninput="modalDirty=true">' + (task ? esc(task.content || '') : '') + '</textarea></div>' +
    '<div class="form-group"><label>优先级</label><select id="tPriority" onchange="modalDirty=true">' + priOpts + '</select></div>' +
    '<div class="form-group"><label>截止日期（可选）</label><input type="date" id="tDueDate" value="' + (task && task.due_date ? task.due_date : '') + '" oninput="modalDirty=true"></div>' +
    completedAtHtml +
    '<div class="modal-actions">' +
    '<button class="btn-cancel" onclick="closeModal()">取消</button>' +
    '<button class="btn-submit" onclick="saveTask(\'' + (id || '') + '\')">' + (isEdit ? '保存修改' : '创建事项') + '</button>' +
    '</div>';
  document.getElementById('modalOverlay').style.display = 'flex';

  // 仅新建时启动自动保存
  if (!isEdit) startDraftAutoSave(DRAFT_KEYS.task);

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
    clearDraft(DRAFT_KEYS.task);
    stopDraftAutoSave();
    modalDirty = false;
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

// ==================== 记账 ====================
function initExpenses() {
  var now = new Date();
  expYear = now.getFullYear();
  expMonth = now.getMonth() + 1;
  expSelectedDate = today();
  populateExpMonthPicker();
  loadExpenses();
}

function populateExpMonthPicker() {
  var ySel = document.getElementById('expYearSelect');
  var mSel = document.getElementById('expMonthSelect');
  var now = new Date();
  var cy = now.getFullYear();
  if (ySel) {
    ySel.innerHTML = '';
    for (var y = cy - 2; y <= cy + 1; y++) {
      ySel.innerHTML += '<option value="' + y + '" ' + (y === expYear ? 'selected' : '') + '>' + y + '年</option>';
    }
  }
  if (mSel) {
    mSel.innerHTML = '';
    for (var m = 1; m <= 12; m++) {
      mSel.innerHTML += '<option value="' + m + '" ' + (m === expMonth ? 'selected' : '') + '>' + m + '月</option>';
    }
  }
}

function changeExpMonth() {
  expYear = parseInt(document.getElementById('expYearSelect').value);
  expMonth = parseInt(document.getElementById('expMonthSelect').value);
  loadExpenses();
}

async function loadExpenses() {
  try {
    var result = await API.getExpenses({ year: expYear, month: expMonth });
    expensesCache = (result.expenses || []).map(function (e) {
      e.expense_date = normalizeDate(e.expense_date);
      return e;
    });
    renderExpCalendar();
    updateExpStats();
    if (expSelectedDate) {
      var parts = expSelectedDate.split('-');
      if (parseInt(parts[0]) === expYear && parseInt(parts[1]) === expMonth) {
        selectExpDate(expSelectedDate);
      } else {
        expSelectedDate = null;
        clearExpDetail();
      }
    }
  } catch (err) { toast('加载记账失败: ' + err.message, 'error'); }
}

function renderExpCalendar() {
  var el = document.getElementById('expCalendarTitle');
  if (el) el.textContent = expYear + '年 ' + expMonth + '月';
  var grid = document.getElementById('expCalendarGrid');
  if (!grid) return;
  grid.innerHTML = '';
  var headers = ['日', '一', '二', '三', '四', '五', '六'];
  for (var i = 0; i < headers.length; i++) {
    var h = document.createElement('div');
    h.className = 'day-header';
    h.textContent = headers[i];
    grid.appendChild(h);
  }
  var firstDay = new Date(expYear, expMonth - 1, 1).getDay();
  var daysInMonth = new Date(expYear, expMonth, 0).getDate();
  var prevDays = new Date(expYear, expMonth - 1, 0).getDate();
  var todayStr = today();
  for (var i = firstDay - 1; i >= 0; i--) {
    var d = prevDays - i;
    var m = expMonth === 1 ? 12 : expMonth - 1;
    var y = expMonth === 1 ? expYear - 1 : expYear;
    grid.appendChild(createExpDay(d, y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'), true));
  }
  for (var d = 1; d <= daysInMonth; d++) {
    var ds = expYear + '-' + String(expMonth).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    grid.appendChild(createExpDay(d, ds, false, ds === todayStr, ds === expSelectedDate));
  }
  var total = firstDay + daysInMonth;
  var rem = total % 7 === 0 ? 0 : 7 - (total % 7);
  for (var d = 1; d <= rem; d++) {
    var m = expMonth === 12 ? 1 : expMonth + 1;
    var y = expMonth === 12 ? expYear + 1 : expYear;
    grid.appendChild(createExpDay(d, y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'), true));
  }
  updateExpDots();
}

function createExpDay(day, dateStr, otherMonth, isToday, isSelected) {
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
  dots.id = 'exp-dots-' + dateStr;
  el.appendChild(dots);
  if (!otherMonth) {
    el.onclick = (function (ds) { return function () { selectExpDate(ds); }; })(dateStr);
  }
  return el;
}

function updateExpDots() {
  var map = {};
  for (var i = 0; i < expensesCache.length; i++) {
    var e = expensesCache[i];
    if (!map[e.expense_date]) map[e.expense_date] = {};
    map[e.expense_date][e.category] = true;
  }
  var allDots = document.querySelectorAll('#expCalendarGrid .day-dots');
  for (var i = 0; i < allDots.length; i++) allDots[i].innerHTML = '';
  var keys = Object.keys(map);
  for (var i = 0; i < keys.length; i++) {
    var ds = keys[i];
    var cats = map[ds];
    var dotsEl = document.getElementById('exp-dots-' + ds);
    if (!dotsEl) continue;
    var catKeys = Object.keys(cats);
    for (var j = 0; j < catKeys.length; j++) {
      var c = catKeys[j];
      var dot = document.createElement('span');
      dot.className = 'day-dot exp-dot-' + EXP_CSS[c];
      dotsEl.appendChild(dot);
    }
  }
}

function selectExpDate(ds) {
  expSelectedDate = ds;
  renderExpCalendar();
  var list = expensesCache.filter(function (e) { return e.expense_date === ds; });
  renderExpList(ds, list);
}

function clearExpDetail() {
  document.getElementById('expDateTitle').textContent = '📅 选择日期查看消费';
  document.getElementById('expenseList').innerHTML = '<div class="empty-state"><div class="empty-icon">💰</div><p>选择日期查看消费记录</p></div>';
  document.getElementById('expDailyTotal').style.display = 'none';
}

function renderExpList(ds, expenses) {
  document.getElementById('expDateTitle').textContent = '📅 ' + ds + ' 消费记录';
  var list = document.getElementById('expenseList');
  var daily = document.getElementById('expDailyTotal');
  if (expenses.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">💰</div><p>这一天没有消费记录</p></div>';
    daily.style.display = 'none';
    return;
  }
  var total = 0;
  for (var i = 0; i < expenses.length; i++) total += Number(expenses[i].amount);
  daily.style.display = 'block';
  daily.innerHTML = '当日合计：<strong>¥ ' + total.toFixed(2) + '</strong>（' + expenses.length + ' 笔）';
  var html = '';
  for (var i = 0; i < expenses.length; i++) {
    var e = expenses[i];
    html += '<div class="expense-item">';
    html += '<span class="expense-cat expense-cat-' + EXP_CSS[e.category] + '">' + EXP_EMOJI[e.category] + ' ' + e.category + '</span>';
    html += '<div class="expense-amount">¥ ' + Number(e.amount).toFixed(2) + '</div>';
    if (e.note) html += '<div class="expense-note">' + esc(e.note) + '</div>';
    html += '<div class="expense-actions">';
    html += '<button class="btn-task-edit" onclick="openExpenseModal(\'' + e.id + '\')" title="编辑">✏️</button>';
    html += '<button class="btn-task-del" onclick="deleteExpense(\'' + e.id + '\')" title="删除">🗑️</button>';
    html += '</div></div>';
  }
  list.innerHTML = html;
}

function openExpenseModal(id) {
  var expense = id ? expensesCache.find(function (e) { return e.id == id; }) : null;
  var isEdit = !!expense;
  stopDraftAutoSave();
  modalDirty = false;
  var catOpts = '';
  for (var i = 0; i < EXP_CATS.length; i++) {
    catOpts += '<option value="' + EXP_CATS[i] + '" ' + (expense && expense.category === EXP_CATS[i] ? 'selected' : '') + '>' + EXP_EMOJI[EXP_CATS[i]] + ' ' + EXP_CATS[i] + '</option>';
  }
  var defDate = expense ? expense.expense_date : (expSelectedDate || today());
  document.getElementById('modalContent').innerHTML =
    '<h3>' + (isEdit ? '编辑消费' : '记一笔') + '</h3>' +
    '<div class="form-group"><label>金额（元）<span style="color:var(--danger)">*</span></label><input type="number" id="eAmount" value="' + (expense ? Number(expense.amount) : '') + '" placeholder="请输入消费金额" step="0.01" min="0.01" oninput="modalDirty=true"></div>' +
    '<div class="form-group"><label>分类</label><select id="eCat" onchange="modalDirty=true">' + catOpts + '</select></div>' +
    '<div class="form-group"><label>日期</label><input type="date" id="eDate" value="' + defDate + '" onchange="modalDirty=true"></div>' +
    '<div class="form-group"><label>备注（可选）</label><input type="text" id="eNote" value="' + (expense ? esc(expense.note || '') : '') + '" placeholder="买了什么..." oninput="modalDirty=true"></div>' +
    '<div class="modal-actions">' +
    '<button class="btn-cancel" onclick="closeModal()">取消</button>' +
    '<button class="btn-submit" onclick="saveExpense(\'' + (id || '') + '\')">' + (isEdit ? '保存修改' : '记一笔') + '</button>' +
    '</div>';
  document.getElementById('modalOverlay').style.display = 'flex';
  setTimeout(function () {
    var el = document.getElementById('eAmount');
    if (el) el.focus();
  }, 100);
}

async function saveExpense(id) {
  var amount = parseFloat(document.getElementById('eAmount').value);
  var cat = document.getElementById('eCat').value;
  var date = document.getElementById('eDate').value;
  var note = document.getElementById('eNote').value.trim();
  if (isNaN(amount) || amount <= 0) { toast('请输入有效金额', 'error'); return; }
  if (!date) { toast('请选择日期', 'error'); return; }
  try {
    if (id) {
      await API.updateExpense(id, { amount: amount, category: cat, note: note, expense_date: date });
      toast('消费记录已更新');
    } else {
      await API.createExpense({ amount: amount, category: cat, note: note, expense_date: date });
      toast('已记一笔');
    }
    modalDirty = false;
    closeModal();
    // 根据返回日期决定是否切换月份
    var dParts = date.split('-');
    if (parseInt(dParts[0]) !== expYear || parseInt(dParts[1]) !== expMonth) {
      expYear = parseInt(dParts[0]);
      expMonth = parseInt(dParts[1]);
      populateExpMonthPicker();
    }
    await loadExpenses();
    // 选中保存的日期
    expSelectedDate = date;
    var list = expensesCache.filter(function (e) { return e.expense_date === date; });
    renderExpList(date, list);
    renderExpCalendar();
    updateExpStats();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteExpense(id) {
  if (!confirm('确定删除这条消费记录？')) return;
  try {
    await API.deleteExpense(id);
    toast('消费记录已删除');
    await loadExpenses();
  } catch (err) { toast(err.message, 'error'); }
}

function updateExpStats() {
  var yearTotal = 0;
  var monthTotal = 0;
  var monthPrefix = expYear + '-' + String(expMonth).padStart(2, '0') + '-';
  for (var i = 0; i < expensesCache.length; i++) {
    var e = expensesCache[i];
    if (e.expense_date && e.expense_date.startsWith(String(expYear))) yearTotal += Number(e.amount);
    if (e.expense_date && e.expense_date.startsWith(monthPrefix)) monthTotal += Number(e.amount);
  }
  var el;
  el = document.getElementById('expYearLabel'); if (el) el.textContent = expYear;
  el = document.getElementById('expMonthLabel'); if (el) el.textContent = expMonth;
  el = document.getElementById('expYearTotal'); if (el) el.textContent = '¥ ' + yearTotal.toFixed(2);
  el = document.getElementById('expMonthTotal'); if (el) el.textContent = '¥ ' + monthTotal.toFixed(2);
}

function expPrevMonth() {
  if (expMonth === 1) { expMonth = 12; expYear--; }
  else expMonth--;
  populateExpMonthPicker();
  loadExpenses();
}
function expNextMonth() {
  if (expMonth === 12) { expMonth = 1; expYear++; }
  else expMonth++;
  populateExpMonthPicker();
  loadExpenses();
}
async function expGoToToday() {
  var now = new Date();
  expYear = now.getFullYear();
  expMonth = now.getMonth() + 1;
  expSelectedDate = today();
  populateExpMonthPicker();
  await loadExpenses();
}

// ==================== 键盘快捷键 ====================
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    var overlay = document.getElementById('modalOverlay');
    if (overlay && overlay.style.display !== 'none') closeModal();
  }
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
