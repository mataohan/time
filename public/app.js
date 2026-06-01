'use strict';

// ==================== 加载检测 ====================
(function() {
  var errEl = document.getElementById('jsLoadError');
  if (errEl) errEl.style.display = 'none';
  console.log('[APP] app.js 加载成功 ✅ 版本: v2.7');
})();

// ==================== API 通信层 ====================
const API_BASE = window.location.origin;

const API = {
  token: localStorage.getItem('tm_token'),

  setToken(t) { this.token = t; localStorage.setItem('tm_token', t || ''); },

  async _fetch(url, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (this.token) headers['Authorization'] = 'Bearer ' + this.token;

    // 默认 15 秒超时
    const timeoutMs = options.timeout || 15000;
    const controller = new AbortController();
    const timeoutId = setTimeout(function () { controller.abort(); }, timeoutMs);
    var fetchOptions = { ...options, headers, signal: controller.signal };
    delete fetchOptions.timeout;

    var res;
    try {
      res = await fetch(API_BASE + url, fetchOptions);
    } catch (networkErr) {
      clearTimeout(timeoutId);
      if (networkErr.name === 'AbortError') {
        console.error('[API] 请求超时:', url, '(' + timeoutMs + 'ms)');
        throw new Error('请求超时，服务器可能无响应，请稍后重试');
      }
      console.error('[API] 网络请求失败:', url, networkErr.message);
      throw new Error('无法连接到服务器，请检查网络连接');
    }
    clearTimeout(timeoutId);

    // ====== 401 响应拦截：自动登出 ======
    if (res.status === 401) {
      console.warn('[API] 收到 401 未授权，自动登出');
      API.setToken('');
      localStorage.removeItem('tm_user');
      // 避免重复跳转
      if (document.getElementById('appPage').style.display !== 'none') {
        document.getElementById('authPage').style.display = 'flex';
        document.getElementById('appPage').style.display = 'none';
        toast('登录已过期，请重新登录', 'error');
      }
      throw new Error('登录已过期，请重新登录');
    }

    var data;
    try {
      data = await res.json();
    } catch (jsonErr) {
      console.error('[API] JSON 解析失败:', url, res.status, jsonErr.message);
      throw new Error('服务器返回了无效的响应 (' + res.status + ')');
    }
    if (!res.ok) throw new Error(data.error || '请求失败 (' + res.status + ')');
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
  getExpenseStats: (params) => API.get('/api/expenses/stats?' + new URLSearchParams(params).toString()),
  createExpense: (b) => API.post('/api/expenses', b),
  updateExpense: (id, b) => API.put('/api/expenses/' + id, b),
  deleteExpense: (id) => API.del('/api/expenses/' + id),

  // ---- 宠物档案 ----
  getPets: () => API.get('/api/pets'),
  createPet: (b) => API.post('/api/pets', b),
  updatePet: (id, b) => API.put('/api/pets/' + id, b),
  deletePet: (id) => API.del('/api/pets/' + id),
  // ---- 健康事件 ----
  getHealthEvents: (petId) => API.get('/api/pets/' + petId + '/events'),
  createHealthEvent: (petId, b) => API.post('/api/pets/' + petId + '/events', b),
  updateHealthEvent: (petId, eventId, b) => API.put('/api/pets/' + petId + '/events/' + eventId, b),
  deleteHealthEvent: (petId, eventId) => API.del('/api/pets/' + petId + '/events/' + eventId)
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

const HEALTH_EVENT_TYPES = [
  { key: 'vaccine', label: '疫苗', emoji: '💉', css: 'vaccine' },
  { key: 'deworm', label: '驱虫', emoji: '🐛', css: 'deworm' },
  { key: 'vet_visit', label: '就诊', emoji: '🏥', css: 'vet-visit' },
  { key: 'other', label: '其他', emoji: '📋', css: 'other-event' }
];
const HEALTH_TYPE_MAP = {};
for (var _hi = 0; _hi < HEALTH_EVENT_TYPES.length; _hi++) {
  HEALTH_TYPE_MAP[HEALTH_EVENT_TYPES[_hi].key] = HEALTH_EVENT_TYPES[_hi];
}
let petsCache = [];
let petEventCache = {};

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

function toLocalDate(dt) {
  if (!dt) return null;
  if (dt instanceof Date) return dt;
  var s = String(dt).trim();
  if (s.indexOf('T') !== -1 || s.indexOf('Z') !== -1) return new Date(s);
  return new Date(s.replace(' ', 'T') + 'Z');
}

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
  var submitBtn = document.getElementById('authSubmitBtn');
  errEl.style.display = 'none';

  if (!email || !password) { errEl.textContent = '邮箱和密码不能为空'; errEl.style.display = 'block'; return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.textContent = '邮箱格式不正确'; errEl.style.display = 'block'; return; }
  if (password.length < 6) { errEl.textContent = '密码至少6位'; errEl.style.display = 'block'; return; }

  submitBtn.disabled = true;
  submitBtn.textContent = '请稍候...';

  var serverOk = false;
  try {
    var health = await API._fetch('/api/health', { timeout: 3000 });
    if (health.status === 'ok') {
      serverOk = true;
      console.log('[AUTH] 健康检查通过:', health.database);
    }
  } catch (healthErr) {
    console.warn('[AUTH] 健康检查失败:', healthErr.message);
  }

  if (!serverOk) {
    errEl.textContent = '服务器暂时无法连接，请检查服务器状态或稍后再试';
    errEl.style.display = 'block';
    submitBtn.disabled = false;
    submitBtn.textContent = isLogin ? '登 录' : '注 册';
    return;
  }

  var lastError = null;
  for (var attempt = 1; attempt <= 2; attempt++) {
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
      toast(result.message || '登录成功');
      showApp();
      return;
    } catch (err) {
      lastError = err;
      console.error('[AUTH] 第' + attempt + '次尝试失败:', err.message);
      if (attempt < 2) {
        submitBtn.textContent = '重试中... (' + attempt + '/2)';
        await new Promise(function (r) { setTimeout(r, 1000); });
      }
    }
  }

  var msg = (lastError && lastError.message) || '请求失败';
  if (msg === 'Failed to fetch' || msg.indexOf('NetworkError') !== -1 || msg.indexOf('fetch') !== -1) {
    msg = '无法连接到服务器，请检查网络或服务器状态';
  }
  errEl.textContent = msg;
  errEl.style.display = 'block';
  console.error('[AUTH] 请求失败:', lastError);
  submitBtn.disabled = false;
  submitBtn.textContent = isLogin ? '登 录' : '注 册';
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
    document.getElementById('petsTab').style.display = 'none';
    document.getElementById('fitnessTab').style.display = 'none';
    loadDiaries();
  } else if (tab === 'tasks') {
    btns[1].classList.add('active');
    document.getElementById('calendarTab').style.display = 'none';
    document.getElementById('tasksTab').style.display = 'grid';
    document.getElementById('expensesTab').style.display = 'none';
    document.getElementById('petsTab').style.display = 'none';
    document.getElementById('fitnessTab').style.display = 'none';
    loadTasks();
  } else if (tab === 'expenses') {
    btns[2].classList.add('active');
    document.getElementById('calendarTab').style.display = 'none';
    document.getElementById('tasksTab').style.display = 'none';
    document.getElementById('petsTab').style.display = 'none';
    document.getElementById('fitnessTab').style.display = 'none';
    document.getElementById('expensesTab').style.display = 'block';
    initExpenses();
  } else if (tab === 'pets') {
    btns[3].classList.add('active');
    document.getElementById('calendarTab').style.display = 'none';
    document.getElementById('tasksTab').style.display = 'none';
    document.getElementById('expensesTab').style.display = 'none';
    document.getElementById('fitnessTab').style.display = 'none';
    document.getElementById('petsTab').style.display = 'block';
    loadPets();
  } else if (tab === 'fitness') {
    btns[4].classList.add('active');
    document.getElementById('calendarTab').style.display = 'none';
    document.getElementById('tasksTab').style.display = 'none';
    document.getElementById('expensesTab').style.display = 'none';
    document.getElementById('petsTab').style.display = 'none';
    document.getElementById('fitnessTab').style.display = 'block';
    initFitness();
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

  var draftBanner = '';
  if (!isEdit) {
    var draft = loadDraft(DRAFT_KEYS.diary);
    if (draft && !isDraftEmpty(draft)) {
      draftBanner = '<div class="draft-banner" id="draftBanner"><span>📝 检测到上次未完成的草稿，是否恢复？</span><div class="draft-banner-actions"><button onclick="restoreDraft(event,\'' + DRAFT_KEYS.diary + '\')">恢复</button><button onclick="discardDraft(event,\'' + DRAFT_KEYS.diary + '\')">放弃</button></div></div>';
    }
  }

  var diaryDate = diary ? diary.diary_date : selectedDate;
  document.getElementById('modalContent').innerHTML =
    draftBanner +
    '<h3>' + (isEdit ? '编辑手账' : '写手账') + '</h3>' +
    '<div class="modal-form-grid">' +
    '<div class="form-group form-group-full"><label>标题</label><input type="text" id="dTitle" value="' + (diary ? esc(diary.title) : '') + '" placeholder="给今天的手账起个标题" oninput="modalDirty=true"></div>' +
    '<div class="form-group form-group-col"><label>分类</label><select id="dCat" onchange="modalDirty=true">' + catOpts + '</select></div>' +
    '<div class="form-group form-group-col"><label>心情</label><select id="dMood" onchange="modalDirty=true">' + moodOpts + '</select></div>' +
    '<div class="form-group form-group-col"><label>日期</label><input type="date" id="dDate" value="' + diaryDate + '" onchange="modalDirty=true"></div>' +
    '<div class="form-group form-group-full"><label>内容</label><textarea id="dContent" placeholder="记录今天的事情..." oninput="modalDirty=true">' + (diary ? esc(diary.content || '') : '') + '</textarea></div>' +
    '<div class="form-group form-group-full"><label>配图URL（可选）</label><input type="url" id="dImageUrl" value="' + (diary ? esc(diary.image_url || '') : '') + '" placeholder="https://example.com/image.jpg" oninput="modalDirty=true"></div>' +
    '<div class="modal-actions form-group-full">' +
    '<button class="btn-cancel" onclick="closeModal()">取消</button>' +
    '<button class="btn-submit" onclick="saveDiary(\'' + (id || '') + '\')">' + (isEdit ? '保存修改' : '创建手账') + '</button>' +
    '</div></div>';
  document.getElementById('modalOverlay').style.display = 'flex';

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
  var dDateEl = document.getElementById('dDate');
  var diaryDate = (dDateEl && dDateEl.value) || selectedDate;
  if (!title) { toast('请输入标题', 'error'); return; }

  try {
    if (id) {
      await API.updateDiary(id, { category: cat, title: title, content: content, diary_date: diaryDate, mood: mood, image_url: image_url });
      toast('手账已更新');
    } else {
      await API.createDiary({ category: cat, title: title, content: content, diary_date: diaryDate, mood: mood, image_url: image_url });
      toast('手账已创建');
    }
    clearDraft(DRAFT_KEYS.diary);
    stopDraftAutoSave();
    modalDirty = false;
    closeModal();
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

function normalizeDate(d) {
  if (!d) return '';
  if (typeof d === 'object' && d instanceof Date) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }
  if (typeof d === 'string') return d.substring(0, 10);
  return String(d);
}

async function loadDiaries() {
  try {
    var result = await API.getDiaries(currentYear, currentMonth, diaryFilter);
    diariesCache = result.diaries || [];
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

    var allResult = await API.getTasks({});
    updateTaskCounts(allResult.tasks || []);
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

    if (isDone) {
      var note = t.completion_note || '';
      html += '<div class="completion-note-area" id="cnArea-' + t.id + '">';
      if (note) {
        html += '<div class="completion-note-text" id="cnText-' + t.id + '">💡 ' + esc(note) + '</div>';
      }
      html += '<div class="completion-note-edit" id="cnEditWrap-' + t.id + '" style="display:' + (note ? 'none' : 'flex') + '">';
      html += '<textarea id="cnInput-' + t.id + '" class="completion-note-input" placeholder="补充完成说明..." rows="2">' + esc(note) + '</textarea>';
      html += '<button class="completion-note-save" onclick="saveCompletionNote(\'' + t.id + '\')" title="保存">💾</button>';
      html += '</div>';
      if (note) {
        html += '<button class="completion-note-btn" onclick="editCompletionNote(\'' + t.id + '\')" title="编辑说明">✏️</button>';
      } else {
        html += '<button class="completion-note-btn" id="cnBtn-' + t.id + '" onclick="editCompletionNote(\'' + t.id + '\')" title="添加说明">＋补充说明</button>';
      }
      html += '</div>';
    }

    html += '<div class="task-actions">';
    if (!isDone && !isUnfinished) {
      html += '<button class="btn-task-unfinish" onclick="openUnfinishedModal(\'' + t.id + '\')" title="标记为未完成">❌</button>';
    }
    if (isUnfinished) {
      html += '<button class="btn-task-restore" onclick="restoreTask(\'' + t.id + '\')" title="恢复为待办">🔄</button>';
    }
    html += '<button class="btn-task-edit" onclick="openTaskModal(\'' + t.id + '\')" title="编辑">✏️</button>';
    html += '<button class="btn-task-del" onclick="deleteTask(\'' + t.id + '\')" title="删除">🗑️</button>';
    html += '</div></div>';
  }
  list.innerHTML = html;
}

function updateTaskCounts(allTasks) {
  var tasks = allTasks || tasksCache;
  var pending = tasks.filter(function (t) { return t.status === 'pending' || (!t.status && !t.completed); });
  var completed = tasks.filter(function (t) { return t.status === 'completed' || t.completed; });
  var unfinished = tasks.filter(function (t) { return t.status === 'unfinished'; });
  var el;
  el = document.getElementById('tcPending'); if (el) el.textContent = pending.length;
  el = document.getElementById('tcCompleted'); if (el) el.textContent = completed.length;
  el = document.getElementById('tcUnfinished'); if (el) el.textContent = unfinished.length;
  for (var i = 0; i < CATS.length; i++) {
    var c = CATS[i];
    el = document.getElementById(CAT_TC_ID[c]);
    if (el) el.textContent = pending.filter(function (t) { return t.category === c; }).length;
  }
  el = document.getElementById('pendingBadge'); if (el) el.textContent = pending.length;
}

function filterTasksByStatus(status) {
  taskStatusFilter = status;
  taskCatFilter = null;
  var sbtns = document.querySelectorAll('.task-status-btn');
  var sidxs = { pending: 0, completed: 1, unfinished: 2 };
  for (var i = 0; i < sbtns.length; i++) sbtns[i].classList.remove('active');
  if (sbtns[sidxs[status]]) sbtns[sidxs[status]].classList.add('active');
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

async function toggleTask(id) {
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

  var completedAtHtml = '';
  if (isEdit && (task.status === 'completed' || task.completed)) {
    var catVal = '';
    if (task.completed_at) {
      catVal = typeof task.completed_at === 'string' ? task.completed_at.substring(0, 16) : '';
    }
    completedAtHtml = '<div class="form-group form-group-full"><label>✅ 完成时间（可编辑）</label><input type="datetime-local" id="tCompletedAt" value="' + esc(catVal) + '" oninput="modalDirty=true"></div>';
  }

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
    '<div class="modal-form-grid">' +
    '<div class="form-group form-group-full"><label>标题</label><input type="text" id="tTitle" value="' + (task ? esc(task.title) : '') + '" placeholder="事项标题" oninput="modalDirty=true"></div>' +
    '<div class="form-group form-group-col"><label>分类</label><select id="tCat" onchange="modalDirty=true">' + catOpts + '</select></div>' +
    '<div class="form-group form-group-col"><label>优先级</label><select id="tPriority" onchange="modalDirty=true">' + priOpts + '</select></div>' +
    '<div class="form-group form-group-col"><label>截止日期</label><input type="date" id="tDueDate" value="' + (task && task.due_date ? task.due_date : '') + '" oninput="modalDirty=true"></div>' +
    '<div class="form-group form-group-full"><label>详细描述</label><textarea id="tContent" placeholder="补充描述..." oninput="modalDirty=true">' + (task ? esc(task.content || '') : '') + '</textarea></div>' +
    completedAtHtml +
    '<div class="modal-actions form-group-full">' +
    '<button class="btn-cancel" onclick="closeModal()">取消</button>' +
    '<button class="btn-submit" onclick="saveTask(\'' + (id || '') + '\')">' + (isEdit ? '保存修改' : '创建事项') + '</button>' +
    '</div></div>';
  document.getElementById('modalOverlay').style.display = 'flex';

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

function editCompletionNote(id) {
  var textEl = document.getElementById('cnText-' + id);
  var editWrap = document.getElementById('cnEditWrap-' + id);
  var btnEl = document.getElementById('cnBtn-' + id);
  if (textEl) textEl.style.display = 'none';
  if (editWrap) editWrap.style.display = 'flex';
  if (btnEl) btnEl.style.display = 'none';
  var area = document.getElementById('cnArea-' + id);
  if (area) {
    var btns = area.querySelectorAll('.completion-note-btn');
    for (var i = 0; i < btns.length; i++) btns[i].style.display = 'none';
  }
  var input = document.getElementById('cnInput-' + id);
  if (input) { input.focus(); input.select(); }
}

async function saveCompletionNote(id) {
  var input = document.getElementById('cnInput-' + id);
  if (!input) return;
  var note = input.value.trim();
  try {
    await API.updateTask(id, { completion_note: note || null });
    await loadTasks();
    toast(note ? '完成说明已保存' : '完成说明已清空');
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
    console.log('[EXP FRONT] loadExpenses: year=' + expYear + ' month=' + expMonth);
    var result = await API.getExpenses({ year: expYear, month: expMonth });
    console.log('[EXP FRONT] 收到 ' + (result.expenses ? result.expenses.length : 0) + ' 条记录');
    expensesCache = (result.expenses || []).map(function (e) {
      e.expense_date = normalizeDate(e.expense_date);
      return e;
    });
    renderExpCalendar();
    // 从后端获取真实统计数据
    await loadExpStats();
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

async function loadExpStats() {
  try {
    console.log('[EXP FRONT] loadExpStats: year=' + expYear + ' month=' + expMonth);
    var stats = await API.getExpenseStats({ year: expYear, month: expMonth });
    console.log('[EXP FRONT] 统计数据: 年度=' + stats.yearTotal + ' 月度=' + stats.monthTotal);
    var el;
    el = document.getElementById('expYearLabel'); if (el) el.textContent = expYear;
    el = document.getElementById('expMonthLabel'); if (el) el.textContent = expMonth;
    el = document.getElementById('expYearTotal'); if (el) el.textContent = '¥ ' + Number(stats.yearTotal || 0).toFixed(2);
    el = document.getElementById('expMonthTotal'); if (el) el.textContent = '¥ ' + Number(stats.monthTotal || 0).toFixed(2);
  } catch (err) {
    console.error('[EXP FRONT] 加载统计失败:', err.message);
    fallbackExpStats();
  }
}

function fallbackExpStats() {
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
  console.log('[EXP FRONT] fallbackExpStats: 年度=' + yearTotal + ' 月度=' + monthTotal);
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
    '<div class="modal-form-grid">' +
    '<div class="form-group form-group-col"><label>金额（元）<span style="color:var(--danger)">*</span></label><input type="number" id="eAmount" value="' + (expense ? Number(expense.amount) : '') + '" placeholder="请输入消费金额" step="0.01" min="0.01" oninput="modalDirty=true"></div>' +
    '<div class="form-group form-group-col"><label>分类</label><select id="eCat" onchange="modalDirty=true">' + catOpts + '</select></div>' +
    '<div class="form-group form-group-col"><label>日期</label><input type="date" id="eDate" value="' + defDate + '" onchange="modalDirty=true"></div>' +
    '<div class="form-group form-group-full"><label>备注（可选）</label><input type="text" id="eNote" value="' + (expense ? esc(expense.note || '') : '') + '" placeholder="买了什么..." oninput="modalDirty=true"></div>' +
    '<div class="modal-actions form-group-full">' +
    '<button class="btn-cancel" onclick="closeModal()">取消</button>' +
    '<button class="btn-submit" onclick="saveExpense(\'' + (id || '') + '\')">' + (isEdit ? '保存修改' : '记一笔') + '</button>' +
    '</div></div>';
  document.getElementById('modalOverlay').style.display = 'flex';
  setTimeout(function () {
    var el = document.getElementById('eAmount');
    if (el) el.focus();
  }, 100);
}

async function saveExpense(id) {
  var amount = parseFloat(document.getElementById('eAmount').value);
  var cat = document.getElementById('eCat').value;
  var dateRaw = document.getElementById('eDate').value;
  var note = document.getElementById('eNote').value.trim();
  if (isNaN(amount) || amount <= 0) { toast('请输入有效金额', 'error'); return; }
  if (!dateRaw) { toast('请选择日期', 'error'); return; }

  // 确保日期是 YYYY-MM-DD 格式，避免时区偏移
  var date = dateRaw;
  var dateMatch = dateRaw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dateMatch) {
    date = dateMatch[1] + '-' + dateMatch[2] + '-' + dateMatch[3];
  }
  console.log('[EXP FRONT] saveExpense: date=' + date + ' amount=' + amount + ' cat=' + cat + ' id=' + (id || 'new'));

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
    var dParts = date.split('-');
    if (parseInt(dParts[0]) !== expYear || parseInt(dParts[1]) !== expMonth) {
      expYear = parseInt(dParts[0]);
      expMonth = parseInt(dParts[1]);
      populateExpMonthPicker();
    }
    await loadExpenses();
    expSelectedDate = date;
    var list = expensesCache.filter(function (e) { return e.expense_date === date; });
    renderExpList(date, list);
    renderExpCalendar();
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
  loadExpStats();
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

// ==================== 宠物档案 ====================
async function loadPets() {
  try {
    var result = await API.getPets();
    petsCache = result.pets || [];
    renderPetsList();
  } catch (err) { toast('加载宠物失败: ' + err.message, 'error'); }
}

function calcAge(birthDate) {
  if (!birthDate) return '';
  var bd = new Date(birthDate);
  if (isNaN(bd.getTime())) return '';
  var now = new Date();
  var years = now.getFullYear() - bd.getFullYear();
  var months = now.getMonth() - bd.getMonth();
  if (months < 0) { years--; months += 12; }
  if (years > 0) return years + '岁' + (months > 0 ? months + '个月' : '');
  return months + '个月';
}

function renderPetsList() {
  var grid = document.getElementById('petsGrid');
  if (!grid) return;

  if (petsCache.length === 0) {
    grid.innerHTML = '<div class="empty-state"><div class="empty-icon">🐱</div><p>还没有添加宠物，点击上方按钮添加吧</p></div>';
    return;
  }

  var html = '';
  for (var i = 0; i < petsCache.length; i++) {
    var p = petsCache[i];
    var age = calcAge(p.birth_date);
    var photo = p.photo_url || '';
    html += '<div class="pet-card">';
    html += '<div class="pet-photo">';
    if (photo) {
      html += '<img src="' + esc(photo) + '" alt="' + esc(p.name) + '" onerror="handlePetPhotoError(this)" loading="lazy">';
    } else {
      html += '<div class="pet-photo-placeholder">🐱</div>';
    }
    html += '</div>';
    html += '<div class="pet-info">';
    html += '<div class="pet-name-row"><span class="pet-name">' + esc(p.name) + '</span>';
    if (p.breed) html += '<span class="pet-breed">' + esc(p.breed) + '</span>';
    html += '</div>';
    html += '<div class="pet-meta">';
    if (p.birth_date) html += '<span class="pet-meta-item">🎂 ' + p.birth_date + (age ? ' (' + age + ')' : '') + '</span>';
    html += '<span class="pet-meta-item">🐾 ' + (p.species === 'cat' ? '猫咪' : p.species) + '</span>';
    html += '</div>';
    html += '<div class="pet-card-actions">';
    html += '<button class="pet-action-btn" onclick="openHealthEventModal(\'' + p.id + '\')" title="添加健康事件">➕ 健康事件</button>';
    html += '<button class="pet-action-btn" onclick="openPetModal(\'' + p.id + '\')" title="编辑档案">✏️ 编辑档案</button>';
    html += '<button class="pet-action-btn pet-action-del" onclick="deletePet(\'' + p.id + '\')" title="删除">🗑️</button>';
    html += '</div>';
    if (p.recent_events && p.recent_events.length > 0) {
      html += '<div class="pet-health-preview">';
      html += '<div class="pet-health-title">📋 最近健康记录</div>';
      for (var j = 0; j < p.recent_events.length; j++) {
        var ev = p.recent_events[j];
        var typeCfg = HEALTH_TYPE_MAP[ev.event_type] || HEALTH_TYPE_MAP['other'];
        html += '<div class="pet-health-item">';
        html += '<span class="pet-health-tag health-tag-' + typeCfg.css + '">' + typeCfg.emoji + ' ' + typeCfg.label + '</span>';
        html += '<span class="pet-health-date">' + ev.event_date + '</span>';
        if (ev.title) html += '<span class="pet-health-evtitle">' + esc(ev.title) + '</span>';
        html += '</div>';
      }
      html += '<button class="pet-view-all-btn" onclick="viewAllHealthEvents(\'' + p.id + '\')">查看全部健康事件 →</button>';
      html += '</div>';
    }
    html += '</div></div>';
  }
  grid.innerHTML = html;
}

function openPetModal(id) {
  var pet = id ? petsCache.find(function (p) { return p.id == id; }) : null;
  var isEdit = !!pet;
  stopDraftAutoSave();
  modalDirty = false;

  document.getElementById('modalContent').innerHTML =
    '<h3>' + (isEdit ? '编辑宠物档案' : '添加新宠物') + '</h3>' +
    '<div class="modal-form-grid">' +
    '<div class="form-group form-group-full"><label>名字 <span style="color:var(--danger)">*</span></label><input type="text" id="petName" value="' + (pet ? esc(pet.name) : '') + '" placeholder="宠物的名字" oninput="modalDirty=true"></div>' +
    '<div class="form-group form-group-col"><label>出生日期</label><input type="date" id="petBirth" value="' + (pet && pet.birth_date ? pet.birth_date : '') + '" onchange="modalDirty=true"></div>' +
    '<div class="form-group form-group-col"><label>品种</label><input type="text" id="petBreed" value="' + (pet ? esc(pet.breed || '') : '') + '" placeholder="如：英短、布偶" oninput="modalDirty=true"></div>' +
    '<div class="form-group form-group-col"><label>物种</label><select id="petSpecies" onchange="modalDirty=true"><option value="cat"' + (!pet || pet.species === 'cat' ? ' selected' : '') + '>🐱 猫</option><option value="dog"' + (pet && pet.species === 'dog' ? ' selected' : '') + '>🐶 狗</option><option value="other"' + (pet && pet.species === 'other' ? ' selected' : '') + '>🐾 其他</option></select></div>' +
    '<div class="form-group form-group-full"><label>照片URL（可选）</label><input type="url" id="petPhoto" value="' + (pet ? esc(pet.photo_url || '') : '') + '" placeholder="https://example.com/photo.jpg" oninput="modalDirty=true"></div>' +
    '<div class="modal-actions form-group-full">' +
    '<button class="btn-cancel" onclick="closeModal()">取消</button>' +
    '<button class="btn-submit" onclick="savePet(\'' + (id || '') + '\')">' + (isEdit ? '保存修改' : '添加宠物') + '</button>' +
    '</div></div>';
  document.getElementById('modalOverlay').style.display = 'flex';
  setTimeout(function () {
    var el = document.getElementById('petName');
    if (el) el.focus();
  }, 100);
}

async function savePet(id) {
  var name = document.getElementById('petName').value.trim();
  var birth_date = document.getElementById('petBirth').value || null;
  var breed = document.getElementById('petBreed').value.trim() || null;
  var species = document.getElementById('petSpecies').value;
  var photo_url = document.getElementById('petPhoto').value.trim() || null;
  if (!name) { toast('请输入宠物名字', 'error'); return; }

  try {
    if (id) {
      await API.updatePet(id, { name: name, birth_date: birth_date, breed: breed, species: species, photo_url: photo_url });
      toast('宠物信息已更新');
    } else {
      await API.createPet({ name: name, birth_date: birth_date, breed: breed, species: species, photo_url: photo_url });
      toast('宠物已添加 🐱');
    }
    modalDirty = false;
    closeModal();
    await loadPets();
  } catch (err) { toast(err.message, 'error'); }
}

async function deletePet(id) {
  if (!confirm('确定删除这个宠物档案吗？所有健康事件记录也会被删除。')) return;
  try {
    await API.deletePet(id);
    toast('宠物档案已删除');
    await loadPets();
  } catch (err) { toast(err.message, 'error'); }
}

function openHealthEventModal(petId, eventId) {
  var ev = null;
  if (eventId && petEventCache[petId]) {
    ev = petEventCache[petId].find(function (e) { return e.id == eventId; });
  }
  var isEdit = !!ev;
  stopDraftAutoSave();
  modalDirty = false;

  var typeOpts = '';
  for (var i = 0; i < HEALTH_EVENT_TYPES.length; i++) {
    var t = HEALTH_EVENT_TYPES[i];
    typeOpts += '<option value="' + t.key + '" ' + (ev && ev.event_type === t.key ? 'selected' : '') + '>' + t.emoji + ' ' + t.label + '</option>';
  }

  var evDate = ev ? ev.event_date : today();
  document.getElementById('modalContent').innerHTML =
    '<h3>' + (isEdit ? '编辑健康事件' : '添加健康事件') + '</h3>' +
    '<div class="modal-form-grid">' +
    '<div class="form-group form-group-col"><label>事件类型</label><select id="evType" onchange="modalDirty=true">' + typeOpts + '</select></div>' +
    '<div class="form-group form-group-col"><label>日期 <span style="color:var(--danger)">*</span></label><input type="date" id="evDate" value="' + evDate + '" onchange="modalDirty=true"></div>' +
    '<div class="form-group form-group-full"><label>标题</label><input type="text" id="evTitle" value="' + (ev ? esc(ev.title || '') : '') + '" placeholder="如：狂犬疫苗第一针" oninput="modalDirty=true"></div>' +
    '<div class="form-group form-group-full"><label>备注</label><textarea id="evNotes" placeholder="如：下次加强针时间为..." oninput="modalDirty=true">' + (ev ? esc(ev.notes || '') : '') + '</textarea></div>' +
    '<div class="modal-actions form-group-full">' +
    '<button class="btn-cancel" onclick="closeModal()">取消</button>' +
    '<button class="btn-submit" onclick="saveHealthEvent(\'' + petId + '\', \'' + (eventId || '') + '\')">' + (isEdit ? '保存修改' : '添加事件') + '</button>' +
    '</div></div>';
  document.getElementById('modalOverlay').style.display = 'flex';
  setTimeout(function () {
    var el = document.getElementById('evTitle');
    if (el) el.focus();
  }, 100);
}

async function saveHealthEvent(petId, eventId) {
  var event_type = document.getElementById('evType').value;
  var event_date = document.getElementById('evDate').value;
  var title = document.getElementById('evTitle').value.trim() || null;
  var notes = document.getElementById('evNotes').value.trim() || null;
  if (!event_date) { toast('请选择日期', 'error'); return; }

  try {
    if (eventId) {
      await API.updateHealthEvent(petId, eventId, { event_type: event_type, event_date: event_date, title: title, notes: notes });
      toast('健康事件已更新');
    } else {
      await API.createHealthEvent(petId, { event_type: event_type, event_date: event_date, title: title, notes: notes });
      toast('健康事件已添加');
    }
    modalDirty = false;
    closeModal();
    await loadPets();
  } catch (err) { toast(err.message, 'error'); }
}

async function viewAllHealthEvents(petId) {
  var pet = petsCache.find(function (p) { return p.id == petId; });
  if (!pet) return;
  try {
    var result = await API.getHealthEvents(petId);
    petEventCache[petId] = result.events || [];
    var events = petEventCache[petId];
    stopDraftAutoSave();
    modalDirty = false;

    var html = '<h3>📋 ' + esc(pet.name) + ' 的健康记录</h3>';
    if (events.length === 0) {
      html += '<div class="empty-state"><div class="empty-icon">📋</div><p>暂无健康事件记录</p></div>';
    } else {
      html += '<div class="health-timeline">';
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        var typeCfg = HEALTH_TYPE_MAP[ev.event_type] || HEALTH_TYPE_MAP['other'];
        html += '<div class="health-timeline-item">';
        html += '<div class="health-timeline-dot health-tag-' + typeCfg.css + '"></div>';
        html += '<div class="health-timeline-content">';
        html += '<div class="health-timeline-header">';
        html += '<span class="pet-health-tag health-tag-' + typeCfg.css + '">' + typeCfg.emoji + ' ' + typeCfg.label + '</span>';
        html += '<span class="pet-health-date">' + ev.event_date + '</span>';
        html += '</div>';
        if (ev.title) html += '<div class="health-timeline-title">' + esc(ev.title) + '</div>';
        if (ev.notes) html += '<div class="health-timeline-notes">' + esc(ev.notes) + '</div>';
        html += '<div class="health-timeline-actions">';
        html += '<button class="btn-task-edit" onclick="openHealthEventModal(\'' + petId + '\', \'' + ev.id + '\')">✏️</button>';
        html += '<button class="btn-task-del" onclick="deleteHealthEvent(\'' + petId + '\', \'' + ev.id + '\')">🗑️</button>';
        html += '</div>';
        html += '</div></div>';
      }
      html += '</div>';
    }
    html += '<div class="modal-actions"><button class="btn-cancel" onclick="closeModal()">关闭</button><button class="btn-submit" onclick="openHealthEventModal(\'' + petId + '\')">+ 添加事件</button></div>';

    document.getElementById('modalContent').innerHTML = html;
    document.getElementById('modalOverlay').style.display = 'flex';
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteHealthEvent(petId, eventId) {
  if (!confirm('确定删除这条健康事件？')) return;
  try {
    await API.deleteHealthEvent(petId, eventId);
    toast('健康事件已删除');
    closeModal();
    await loadPets();
  } catch (err) { toast(err.message, 'error'); }
}

function handlePetPhotoError(img) {
  if (img && img.parentElement) {
    img.parentElement.innerHTML = '<div class="pet-photo-placeholder">🐱</div>';
  }
}

function showModal(content, title) {
  stopDraftAutoSave();
  modalDirty = false;
  var html = '<h3>' + esc(title || '详情') + '</h3><div>' + content + '</div><div class="modal-actions"><button class="btn-cancel" onclick="closeModal()">关闭</button></div>';
  document.getElementById('modalContent').innerHTML = html;
  document.getElementById('modalOverlay').style.display = 'flex';
}

// ==================== 健身计划 ====================
var fitnessInitialized = false;
var fitnessPlan = [];
var fitnessDayMap = {};

function initFitness() {
  if (!fitnessInitialized) {
    buildFitnessPlan();
    fitnessInitialized = true;
  }
  renderFitnessCalendar();
  renderMealPlan();
  renderFitnessMotto();
  updateFitnessDateRange();
}

function buildFitnessPlan() {
  var todayDate = new Date();
  fitnessPlan = [];
  fitnessDayMap = {};

  var weeklySchedule = [
    { type: '胸+三头', icon: '💪', color: '#4fc3f7', isRest: false },
    { type: '背+二头', icon: '🔙', color: '#ba68c8', isRest: false },
    { type: '休息日', icon: '😴', color: '#5a6480', isRest: true },
    { type: '腿+肩', icon: '🦵', color: '#ff9800', isRest: false },
    { type: '核心+有氧', icon: '🏃', color: '#4caf50', isRest: false },
    { type: '全身循环', icon: '🔄', color: '#ef5350', isRest: false },
    { type: '休息日', icon: '😴', color: '#5a6480', isRest: true }
  ];

  var weeklyDetail = [
    {
      title: '胸肌 + 三头肌训练',
      warmup: '跑步机快走5分钟 + 肩关节绕环 + 胸部拉伸',
      exercises: [
        { name: '平板史密斯机卧推', sets: '4x10-12', weight: '逐步加重', tip: '肩胛骨收紧，下落至胸肌有拉伸感，推起时肘微屈不锁死' },
        { name: '上斜哑铃卧推', sets: '3x12', weight: '中等重量', tip: '凳角30-45度，专注上胸发力，哑铃下放至胸两侧' },
        { name: '坐姿夹胸机', sets: '3x15', weight: '适中', tip: '保持手肘微弯，顶峰收缩1-2秒，感受胸缝挤压' },
        { name: '绳索下压（三头）', sets: '4x12-15', weight: '中等', tip: '上臂贴近身体不动，手腕锁定，完全伸展' },
        { name: '哑铃颈后臂屈伸', sets: '3x12', weight: '轻-中', tip: '单臂交替，肘尖朝天，慢放快收' }
      ],
      cooldown: '胸肌拉伸 + 三头拉伸各30秒 × 2组'
    },
    {
      title: '背部 + 二头肌训练',
      warmup: '跑步机快走5分钟 + 肩部绕环 + 猫牛式',
      exercises: [
        { name: '高位下拉（宽握）', sets: '4x10-12', weight: '渐进加重', tip: '挺胸沉肩，下拉至锁骨，顶峰收缩1-2秒' },
        { name: '坐姿划船（窄握）', sets: '4x12', weight: '中等', tip: '身体不前倾，拉至腹部，夹紧背部，慢放' },
        { name: '直臂下压', sets: '3x15', weight: '轻-中', tip: '手臂微弯，感受背阔肌发力，控制慢放' },
        { name: '哑铃弯举（二头）', sets: '4x10-12', weight: '中等', tip: '肘部固定，避免借力摆动，顶峰收缩' },
        { name: '锤式弯举', sets: '3x12', weight: '中等', tip: '掌心相对握法，侧重肱肌和肱桡肌' }
      ],
      cooldown: '背部拉伸 + 二头拉伸各30秒 × 2组'
    },
    {
      title: '休息日', warmup: '', exercises: [],
      cooldown: '建议：泡沫轴放松全身 + 拉伸 + 散步30分钟促进恢复'
    },
    {
      title: '腿部 + 肩部训练',
      warmup: '跑步机快走5分钟 + 髋关节绕环 + 腿摆动',
      exercises: [
        { name: '倒蹬机（腿举）', sets: '4x12-15', weight: '渐进加重', tip: '全脚掌踩稳，膝盖不内扣，下放至90度' },
        { name: '腿弯举（股二头）', sets: '3x12-15', weight: '中等', tip: '控制离心，感受大腿后侧发力' },
        { name: '坐姿腿屈伸', sets: '3x15', weight: '中等', tip: '脚尖微向外，顶峰收缩股四头肌' },
        { name: '哑铃推举（肩）', sets: '4x10-12', weight: '中等', tip: '核心收紧不后仰，肘略向前，推至头顶' },
        { name: '侧平举', sets: '4x15', weight: '轻', tip: '肘微弯，不超过肩高，控制下放不要甩' },
        { name: '面拉（后束）', sets: '3x15', weight: '轻', tip: '拉向面部，手肘外展，改善圆肩驼背' }
      ],
      cooldown: '股四头肌 + 腘绳肌 + 肩部拉伸各30秒 × 2组'
    },
    {
      title: '核心训练 + 爬坡有氧',
      warmup: '动态拉伸5分钟（高抬腿、开合跳、踢臀跑）',
      exercises: [
        { name: '平板支撑', sets: '3组，每组力竭', weight: '自重', tip: '身体呈直线，收紧腹部臀部，不塌腰不撅臀' },
        { name: '卷腹', sets: '3x20', weight: '自重', tip: '下巴离胸一拳距离，腰部贴地，慢速控制' },
        { name: '俄罗斯转体', sets: '3x20(每侧)', weight: '自重', tip: '双脚离地，核心收紧控制旋转，可用小哑铃加重' },
        { name: '悬垂举腿（或仰卧举腿）', sets: '3x15', weight: '自重', tip: '控制摆动，感受下腹发力' },
        { name: '爬坡有氧（跑步机）', sets: '35分钟', weight: '坡度8-10 速度5-6km/h', tip: '保持心率120-140，不扶扶手，自然摆臂' }
      ],
      cooldown: '全身拉伸5分钟，重点拉伸腹部和髋屈肌'
    },
    {
      title: '全身循环训练',
      warmup: '跳绳3分钟 + 动态拉伸全身',
      exercises: [
        { name: '哑铃深蹲 + 推举', sets: '4x12', weight: '中等', tip: '蹲至大腿平行，起身后顺势推举，全程核心收紧' },
        { name: '哑铃划船 + 弯举', sets: '3x12(每侧)', weight: '中等', tip: '单臂支撑凳面，背部发力后接二头弯举' },
        { name: '俯卧撑', sets: '3x力竭', weight: '自重', tip: '身体成直线，核心收紧，慢下快上' },
        { name: '哑铃弓步走', sets: '3x12(每侧)', weight: '轻-中', tip: '步幅适中，后膝接近地面但不触碰，身体保持直立' },
        { name: '爬坡有氧（跑步机）', sets: '25分钟', weight: '坡度8-10 速度5-6km/h', tip: '循环训练后做有氧，燃脂效果更佳' }
      ],
      cooldown: '全身泡沫轴放松5分钟'
    },
    {
      title: '休息日', warmup: '', exercises: [],
      cooldown: '建议：瑜伽/拉伸30分钟 + 散步 + 充分睡眠帮助肌肉恢复'
    }
  ];

  for (var d = 0; d < 21; d++) {
    var date = new Date(todayDate);
    date.setDate(date.getDate() + d);
    var dateStr = formatDate(date);
    var dayOfWeek = date.getDay();
    var scheduleIdx = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    var schedule = weeklySchedule[scheduleIdx];
    var detail = weeklyDetail[scheduleIdx];

    var planItem = {
      dateStr: dateStr,
      dayIndex: d + 1,
      dayOfWeek: dayOfWeek,
      dayName: ['日', '一', '二', '三', '四', '五', '六'][dayOfWeek],
      type: schedule.type,
      icon: schedule.icon,
      color: schedule.color,
      isRest: schedule.isRest,
      title: detail.title,
      warmup: detail.warmup,
      exercises: detail.exercises,
      cooldown: detail.cooldown
    };
    fitnessPlan.push(planItem);
    fitnessDayMap[dateStr] = d;
  }
}

function formatDate(d) {
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var dd = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + dd;
}

function updateFitnessDateRange() {
  var el = document.getElementById('fitnessDateRange');
  if (!el || fitnessPlan.length === 0) return;
  el.textContent = fitnessPlan[0].dateStr + ' ~ ' + fitnessPlan[20].dateStr;
}

function renderFitnessCalendar() {
  var grid = document.getElementById('fitnessCalendarGrid');
  if (!grid) return;
  grid.innerHTML = '';

  var headers = ['日', '一', '二', '三', '四', '五', '六'];
  for (var i = 0; i < headers.length; i++) {
    var h = document.createElement('div');
    h.className = 'fitness-cal-day-header';
    h.textContent = headers[i];
    grid.appendChild(h);
  }

  var firstDate = new Date(fitnessPlan[0].dateStr);
  var firstDayOfWeek = firstDate.getDay();

  for (var i = 0; i < firstDayOfWeek; i++) {
    var empty = document.createElement('div');
    empty.className = 'fitness-cal-day fitness-cal-empty';
    grid.appendChild(empty);
  }

  for (var d = 0; d < 21; d++) {
    var plan = fitnessPlan[d];
    var cell = document.createElement('div');
    cell.className = 'fitness-cal-day';
    cell.style.borderLeftColor = plan.color;
    cell.style.borderLeftWidth = '3px';
    cell.style.borderLeftStyle = 'solid';

    if (plan.isRest) {
      cell.classList.add('fitness-cal-rest');
    }

    var dateLabel = document.createElement('div');
    dateLabel.className = 'fitness-cal-date';
    dateLabel.textContent = 'Day ' + (d + 1) + ' · ' + plan.dateStr.slice(5);
    cell.appendChild(dateLabel);

    var headerRow = document.createElement('div');
    headerRow.className = 'fitness-cal-header-row';
    var dayBadge = document.createElement('span');
    dayBadge.className = 'fitness-cal-day-badge';
    dayBadge.textContent = '周' + plan.dayName;
    dayBadge.style.background = plan.color + '20';
    dayBadge.style.color = plan.color;
    headerRow.appendChild(dayBadge);
    var iconEl = document.createElement('span');
    iconEl.className = 'fitness-cal-icon';
    iconEl.textContent = plan.icon;
    headerRow.appendChild(iconEl);
    cell.appendChild(headerRow);

    var typeEl = document.createElement('div');
    typeEl.className = 'fitness-cal-type';
    typeEl.textContent = plan.type;
    cell.appendChild(typeEl);

    if (!plan.isRest && plan.exercises.length > 0) {
      var summary = document.createElement('div');
      summary.className = 'fitness-cal-summary';

      var totalSets = 0;
      for (var e = 0; e < plan.exercises.length; e++) {
        var setsMatch = plan.exercises[e].sets.match(/(\d+)/);
        if (setsMatch) totalSets += parseInt(setsMatch[1]);
      }

      var summaryHtml = '<span class="fitness-cal-stat">🏋️ ' + plan.exercises.length + '个动作</span>';
      summaryHtml += '<span class="fitness-cal-stat">📊 ' + totalSets + '组</span>';
      var estMin = plan.exercises.length * 8 + 15;
      summaryHtml += '<span class="fitness-cal-stat">⏱ ~' + estMin + 'min</span>';
      summary.innerHTML = summaryHtml;
      cell.appendChild(summary);
    }

    if (plan.isRest) {
      var restLabel = document.createElement('div');
      restLabel.className = 'fitness-cal-rest-label';
      restLabel.textContent = '恢复日';
      cell.appendChild(restLabel);
    }

    cell.onclick = (function(idx) {
      return function() { showFitnessDetail(idx); };
    })(d);

    grid.appendChild(cell);
  }
}

function showFitnessDetail(idx) {
  var plan = fitnessPlan[idx];
  var content = '';

  content += '<div style="margin-bottom:20px;display:flex;align-items:center;gap:12px;">';
  content += '<span style="font-size:36px;">' + plan.icon + '</span>';
  content += '<div>';
  content += '<h3 style="margin:0;color:' + plan.color + '">' + plan.title + '</h3>';
  content += '<span style="font-size:14px;color:var(--text-muted)">Day ' + plan.dayIndex + ' · ' + plan.dateStr + ' 周' + plan.dayName + '</span>';
  content += '</div></div>';

  if (plan.isRest) {
    content += '<div style="background:rgba(76,175,80,0.08);border:1px solid rgba(76,175,80,0.2);border-radius:12px;padding:20px;text-align:center;">';
    content += '<div style="font-size:48px;margin-bottom:12px;">😴</div>';
    content += '<p style="font-size:16px;color:var(--success);margin-bottom:8px;">休息日是训练的一部分</p>';
    content += '<p style="font-size:14px;color:var(--text-secondary);">' + (plan.cooldown || '充分休息，为下一次训练蓄力') + '</p>';
    content += '</div>';
  } else {
    if (plan.warmup) {
      content += '<div style="margin-bottom:16px;padding:12px 16px;background:rgba(255,152,0,0.08);border:1px solid rgba(255,152,0,0.2);border-radius:10px;">';
      content += '<div style="font-size:14px;font-weight:600;color:var(--warning);margin-bottom:4px;">🔥 热身</div>';
      content += '<div style="font-size:14px;color:var(--text-secondary);">' + plan.warmup + '</div>';
      content += '</div>';
    }

    content += '<div style="margin-bottom:16px;">';
    content += '<div style="font-size:14px;font-weight:600;color:var(--accent);margin-bottom:10px;">📋 训练动作</div>';
    for (var i = 0; i < plan.exercises.length; i++) {
      var ex = plan.exercises[i];
      content += '<div style="background:var(--bg-input);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:8px;">';
      content += '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">';
      content += '<span style="font-weight:600;font-size:15px;">' + (i + 1) + '. ' + ex.name + '</span>';
      content += '<span style="font-size:13px;color:' + plan.color + ';background:' + plan.color + '15;padding:3px 10px;border-radius:10px;">' + ex.sets + '</span>';
      content += '</div>';
      if (ex.weight) {
        content += '<div style="font-size:13px;color:var(--text-muted);margin-top:4px;">重量: ' + ex.weight + '</div>';
      }
      content += '<div style="font-size:13px;color:var(--text-secondary);margin-top:4px;line-height:1.6;">💡 ' + ex.tip + '</div>';
      content += '</div>';
    }
    content += '</div>';

    if (plan.cooldown) {
      content += '<div style="padding:12px 16px;background:rgba(77,208,225,0.08);border:1px solid rgba(77,208,225,0.2);border-radius:10px;">';
      content += '<div style="font-size:14px;font-weight:600;color:#4dd0e1;margin-bottom:4px;">🧊 放松拉伸</div>';
      content += '<div style="font-size:14px;color:var(--text-secondary);">' + plan.cooldown + '</div>';
      content += '</div>';
    }
  }

  showModal(content, '训练详情');
}

// ==================== 饮食建议 ====================
var mealPlans = {
  breakfast: {
    name: '早餐 (7:30-8:30)', icon: '🌅',
    foods: [
      { name: '燕麦', amount: '50g（干重）', note: '加250ml热水或脱脂牛奶泡软' },
      { name: '鸡蛋', amount: '2个（全蛋）', note: '水煮或微量油煎，撒少许黑胡椒' },
      { name: '蓝莓/草莓', amount: '80g', note: '搭配燕麦食用，补充抗氧化剂' }
    ],
    tip: '做法：燕麦加水/奶煮3分钟，鸡蛋水煮6分钟，水果洗净即可。总约420大卡。',
    totalCal: '~420大卡', macros: '蛋白质28g · 碳水50g · 脂肪14g',
    alternatives: [
      { name: '全麦面包', amount: '2片', note: '替代燕麦，配花生酱' },
      { name: '蛋白粉', amount: '1勺(30g)', note: '替代1个鸡蛋，与水/牛奶混合' },
      { name: '香蕉', amount: '1根', note: '替代浆果，补充钾和快碳' }
    ]
  },
  lunch: {
    name: '午餐 (12:00-13:00)', icon: '☀️',
    foods: [
      { name: '鸡胸肉', amount: '150g（生重）', note: '加盐、黑胡椒、少许酱油腌制后煎/烤' },
      { name: '糙米饭', amount: '100g（熟重约半碗）', note: '可提前煮好分装冷冻' },
      { name: '西兰花', amount: '200g', note: '水煮或清炒，加少许蒜末' },
      { name: '橄榄油', amount: '5g', note: '拌蔬菜或煎鸡胸时使用' }
    ],
    tip: '做法：鸡胸肉两面煎至金黄（每面4分钟），西兰花焯水2分钟，糙米饭微波加热。总约520大卡。',
    totalCal: '~520大卡', macros: '蛋白质45g · 碳水48g · 脂肪16g',
    alternatives: [
      { name: '三文鱼', amount: '150g', note: '替代鸡胸肉，补充Omega-3' },
      { name: '红薯', amount: '150g', note: '替代糙米饭，低GI慢碳' },
      { name: '芦笋/菠菜', amount: '200g', note: '替代西兰花，换口味' }
    ]
  },
  preWorkout: {
    name: '练前加餐 (训练前1-1.5小时)', icon: '⏰',
    foods: [
      { name: '全麦吐司', amount: '1片', note: '提供训练所需快碳' },
      { name: '香蕉', amount: '半根', note: '补充钾，防抽筋' },
      { name: '黑咖啡', amount: '1杯（无糖）', note: '提升训练专注度和代谢率' }
    ],
    tip: '训练前不要吃太饱，以碳水为主快速供能。总约180大卡。',
    totalCal: '~180大卡', macros: '蛋白质3g · 碳水38g · 脂肪2g',
    alternatives: [
      { name: '能量棒', amount: '半根', note: '替代吐司+香蕉，便携' },
      { name: '葡萄干', amount: '20g', note: '替代香蕉，快速补充糖原' },
      { name: '绿茶', amount: '1杯', note: '替代黑咖啡，温和提神' }
    ]
  },
  dinner: {
    name: '练后晚餐 (训练后1小时内)', icon: '🌙',
    foods: [
      { name: '瘦牛肉/鱼肉', amount: '120g', note: '补充训练后所需蛋白质，煎或蒸' },
      { name: '混合蔬菜沙拉', amount: '250g', note: '生菜+番茄+黄瓜+彩椒，加少量油醋汁' },
      { name: '红薯/玉米', amount: '100g', note: '补充糖原，修复肌肉' },
      { name: '脱脂酸奶', amount: '100ml', note: '餐后补充益生菌和酪蛋白' }
    ],
    tip: '做法：牛肉煎至七分熟（每面3分钟），蔬菜洗净切块，红薯蒸或烤20分钟。总约530大卡。',
    totalCal: '~530大卡', macros: '蛋白质42g · 碳水45g · 脂肪18g',
    alternatives: [
      { name: '豆腐', amount: '200g', note: '替代牛肉，植物蛋白' },
      { name: '藜麦', amount: '80g', note: '替代红薯，完全蛋白谷物' },
      { name: '希腊酸奶', amount: '150g', note: '替代脱脂酸奶，更高蛋白' }
    ]
  }
};

function getCurrentMeal() {
  var h = new Date().getHours();
  if (h >= 5 && h < 10) return 'breakfast';
  if (h >= 10 && h < 15) return 'lunch';
  if (h >= 15 && h < 17.5) return 'preWorkout';
  return 'dinner';
}

function renderMealPlan() {
  var timeline = document.getElementById('fitnessMealTimeline');
  var summary = document.getElementById('fitnessMealSummary');
  var dateEl = document.getElementById('fitnessMealDate');
  if (!timeline || !summary) return;

  var now = new Date();
  dateEl.textContent = formatDate(now);

  var currentMeal = getCurrentMeal();
  var mealKeys = ['breakfast', 'lunch', 'preWorkout', 'dinner'];
  var totalCal = 0, totalP = 0, totalC = 0, totalF = 0;

  var html = '';
  for (var i = 0; i < mealKeys.length; i++) {
    var key = mealKeys[i];
    var meal = mealPlans[key];
    var isActive = key === currentMeal;

    html += '<div class="fitness-meal-item' + (isActive ? ' fitness-meal-active' : '') + '">';
    html += '<div class="fitness-meal-time">';
    html += '<span class="fitness-meal-dot" style="background:' + (isActive ? 'var(--accent)' : 'var(--border)') + '"></span>';
    html += '<div>';
    html += '<div class="fitness-meal-label">' + meal.icon + ' ' + meal.name + (isActive ? ' ⬅️ 当前' : '') + '</div>';
    html += '<div class="fitness-meal-cal">' + meal.totalCal + '</div>';
    html += '</div></div>';

    html += '<div class="fitness-meal-foods">';
    for (var j = 0; j < meal.foods.length; j++) {
      var f = meal.foods[j];
      html += '<div class="fitness-meal-food-item">';
      html += '<span class="fitness-meal-food-name">' + f.name + '</span>';
      html += '<span class="fitness-meal-food-amount">' + f.amount + '</span>';
      html += '<span class="fitness-meal-food-note">' + f.note + '</span>';
      html += '</div>';
    }
    html += '<div class="fitness-meal-tip">👨‍🍳 ' + meal.tip + '</div>';
    html += '<div class="fitness-meal-macros">📊 ' + meal.macros + '</div>';

    html += '<details class="fitness-meal-alt"><summary>🔄 可替换食材（点击展开）</summary>';
    for (var k = 0; k < meal.alternatives.length; k++) {
      var alt = meal.alternatives[k];
      html += '<div class="fitness-meal-alt-item"><span>' + alt.name + '</span><span>' + alt.amount + '</span><span style="font-size:12px;color:var(--text-muted)">' + alt.note + '</span></div>';
    }
    html += '</details>';
    html += '</div></div>';

    var calMatch = meal.totalCal.match(/(\d+)/);
    if (calMatch) totalCal += parseInt(calMatch[1]);
    var macroMatch = meal.macros.match(/蛋白质(\d+)g.*碳水(\d+)g.*脂肪(\d+)g/);
    if (macroMatch) {
      totalP += parseInt(macroMatch[1]);
      totalC += parseInt(macroMatch[2]);
      totalF += parseInt(macroMatch[3]);
    }
  }
  timeline.innerHTML = html;
  summary.innerHTML = '<div class="fitness-meal-total">📊 全天总计：约 <strong>' + totalCal + '大卡</strong>（目标1850大卡）</div>' +
    '<div class="fitness-meal-macros" style="margin-top:8px;">蛋白质' + totalP + 'g · 碳水' + totalC + 'g · 脂肪' + totalF + 'g</div>';
}

var fitnessMottos = [
  '💪 每一滴汗水，都是未来的你在感谢现在的你',
  '🔥 没有白流的汗，没有白费的努力',
  '🏆 今天不想练，明天更不想练——所以今天就去练',
  '⚡ 比你优秀的人比你还努力，你有什么资格不奋斗',
  '🎯 把目标刻在心里，把行动落在脚下',
  '🌟 21天可以养成一个习惯，今天是第几天？',
  '🦁 肌肉不会自己长出来，脂肪不会自己消失',
  '🏃 爬坡虽累，但山顶的风景值得',
  '💎 你不是在减肥，你是在雕刻一个更好的自己',
  '🚀 所有的惊艳，都来自长久的坚持',
  '🌊 每次训练都是对自己的投资，复利效应惊人',
  '⛰️ 最难的不是动作，是走进健身房的第一步',
  '🦅 要么练，要么不练，没有"试试看"',
  '🎖️ 自律给我自由',
  '🔋 训练是最好的充电方式',
  '👊 今天流的汗，是昨天吃的债',
  '🏋️ 重量不会说谎，你付出了多少它就回馈多少',
  '🌈 坚持不一定成功，但放弃一定很轻松——选前者',
  '🧬 每一次训练都在改变你的基因表达',
  '💯 满分不是目标，比昨天进步1%才是'
];

var lastMottoIdx = -1;

function renderFitnessMotto() {
  var el = document.getElementById('fitnessMottoText');
  if (!el) return;
  var idx;
  do {
    idx = Math.floor(Math.random() * fitnessMottos.length);
  } while (idx === lastMottoIdx && fitnessMottos.length > 1);
  lastMottoIdx = idx;
  el.textContent = fitnessMottos[idx];
}

function refreshFitnessMotto() {
  renderFitnessMotto();
  var mottoCard = document.getElementById('fitnessMotto');
  if (mottoCard) {
    mottoCard.style.transform = 'scale(1.02)';
    setTimeout(function() { mottoCard.style.transform = ''; }, 200);
  }
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
