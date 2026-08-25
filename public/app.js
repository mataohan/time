'use strict';

// ==================== 加载检测 ====================
// 如果 JS 文件被错误返回为 HTML 或其他非 JS 内容，此行会报 SyntaxError
// 正常加载时，隐藏加载错误提示
(function() {
  var errEl = document.getElementById('jsLoadError');
  if (errEl) errEl.style.display = 'none';
  console.log('[APP] app.js 加载成功 ✅ 版本: v3.0');
})();

// ==================== API 通信层 ====================
const API_BASE = window.location.origin;

const API = {
  // 同时检查两个可能的存储键（兼容旧版 tm_user 和新版 tm_token）
  token: localStorage.getItem('tm_token') || (function() {
    // 兼容旧版：如果 tm_token 不存在但 tm_user 中有 token，迁移过来
    var oldUser = null;
    try { oldUser = JSON.parse(localStorage.getItem('tm_user')); } catch(e) {}
    if (oldUser && oldUser.token) {
      console.log('[API] 从 tm_user 迁移 token 到 tm_token');
      localStorage.setItem('tm_token', oldUser.token);
      return oldUser.token;
    }
    return '';
  })(),

  setToken(t) {
    this.token = t || '';
    if (t) {
      localStorage.setItem('tm_token', t);
    } else {
      localStorage.removeItem('tm_token');
    }
    console.log('[API] token 已' + (t ? '设置' : '清除') + (t ? ' (长度=' + t.length + ', 前10字符=' + t.substring(0, 10) + '...)' : ''));
  },

  /**
   * 获取当前有效的 token
   * 🔧 核心修复：不再依赖 this.token 内存变量，改为每次实时从 localStorage 读取
   * 这样无论什么原因导致内存 token 丢失，都能保证每次请求都带上最新 token
   */
  _getToken() {
    // 直接从 localStorage 读取，这是唯一可靠的数据源
    var storedToken = localStorage.getItem('tm_token');
    if (storedToken) {
      // 同步更新内存中的缓存（用于其他地方读取 API.token）
      this.token = storedToken;
      return storedToken;
    }
    // 兜底：尝试从 user 对象中恢复（兼容旧版数据）
    var userData = null;
    try { userData = JSON.parse(localStorage.getItem('tm_user')); } catch(e) {}
    if (userData && userData.token) {
      // 迁移旧版 token 到新键名
      localStorage.setItem('tm_token', userData.token);
      this.token = userData.token;
      console.warn('[API] ⚠️ 从 tm_user 迁移 token 到 tm_token');
      return userData.token;
    }
    this.token = '';
    return '';
  },

  async _fetch(url, options = {}) {
    // 🔧 关键修复：每次请求都实时从 localStorage 读取 token，不再依赖内存缓存
    var currentToken = this._getToken();

    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (currentToken) {
      headers['Authorization'] = 'Bearer ' + currentToken;
      // 详细日志：每次请求都打印 token 摘要，方便排查
      console.log('[API] 📡 请求: ' + (options.method || 'GET') + ' ' + url + ' | token=' + currentToken.substring(0, 12) + '... | token长度=' + currentToken.length);
    } else {
      console.warn('[API] ⚠️ 请求未携带 token: ' + (options.method || 'GET') + ' ' + url);
    }

    // 默认 15 秒超时
    const timeoutMs = options.timeout || 15000;
    const controller = new AbortController();
    const timeoutId = setTimeout(function () { controller.abort(); }, timeoutMs);
    var fetchOptions = { ...options, headers, signal: controller.signal };
    delete fetchOptions.timeout; // 移除自定义字段

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

    var data;
    try {
      data = await res.json();
    } catch (jsonErr) {
      console.error('[API] JSON 解析失败:', url, res.status, jsonErr.message);
      throw new Error('服务器返回了无效的响应 (' + res.status + ')');
    }

    // 401 自动登出
    if (res.status === 401) {
      console.warn('[API] 收到 401 未授权 (code=' + (data.code || 'unknown') + ')，当前token=' + (currentToken ? currentToken.substring(0, 12) + '...' : '无'));
      API.setToken('');
      localStorage.removeItem('tm_user');
      // 只在实际显示 app 页面时才切回登录页（避免无限循环）
      var appPage = document.getElementById('appPage');
      if (appPage && appPage.style.display !== 'none') {
        document.getElementById('authPage').style.display = 'flex';
        document.getElementById('appPage').style.display = 'none';
        toast('登录已过期，请重新登录', 'error');
      }
      throw new Error('登录已过期，请重新登录');
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
    // 确保 year/month 是整数（1-12），不做任何月份偏移
    var params = 'year=' + parseInt(y) + '&month=' + parseInt(m);
    if (cat) params += '&category=' + encodeURIComponent(cat);
    console.log('[请求] GET /api/diaries?' + params);
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
  getExpenses: (params) => {
    var qs = new URLSearchParams(params).toString();
    console.log('[请求] GET /api/expenses?' + qs);
    return API.get('/api/expenses?' + qs);
  },
  createExpense: (b) => API.post('/api/expenses', b),
  updateExpense: (id, b) => API.put('/api/expenses/' + id, b),
  deleteExpense: (id) => API.del('/api/expenses/' + id),
  getExpenseStats: (year, month, date, category, keyword, minAmount, maxAmount) => {
    var url;
    // 只有 date 是真正的日期（非空、非 'all'）时才按日期优先查询
    var isDate = date && date !== 'all' && String(date).trim();
    if (isDate) {
      // 日期优先
      url = '/api/expenses/stats?date=' + encodeURIComponent(date);
    } else {
      // 构建年月参数（year/month 为 'all' 或空时忽略，实现"全部"）
      var parts = [];
      if (year && year !== 'all') parts.push('year=' + year);
      if (month && month !== 'all') parts.push('month=' + month);
      url = '/api/expenses/stats?' + (parts.length > 0 ? parts.join('&') : '');
    }
    if (category && category !== 'all') url += '&category=' + encodeURIComponent(category);
    if (keyword) url += '&keyword=' + encodeURIComponent(keyword);
    if (minAmount) url += '&minAmount=' + encodeURIComponent(minAmount);
    if (maxAmount) url += '&maxAmount=' + encodeURIComponent(maxAmount);
    return API.get(url);
  },

  // ---- 宠物档案 ----
  getPets: () => API.get('/api/pets'),
  createPet: (b) => API.post('/api/pets', b),
  updatePet: (id, b) => API.put('/api/pets/' + id, b),
  deletePet: (id) => API.del('/api/pets/' + id),
  // ---- 健康事件 ----
  getHealthEvents: (petId) => API.get('/api/pets/' + petId + '/events'),
  createHealthEvent: (petId, b) => API.post('/api/pets/' + petId + '/events', b),
  updateHealthEvent: (petId, eventId, b) => API.put('/api/pets/' + petId + '/events/' + eventId, b),
  deleteHealthEvent: (petId, eventId) => API.del('/api/pets/' + petId + '/events/' + eventId),

  // ---- 箍牙提醒 ----
  getOrthodontic: () => API.get('/api/orthodontic'),
  createOrthodontic: (b) => API.post('/api/orthodontic', b),
  updateOrthodontic: (b) => API.put('/api/orthodontic', b),
  deleteOrthodontic: () => API.del('/api/orthodontic'),

  // ---- 碳循环 ----
  getCarbon: () => API.get('/api/carbon'),
  createCarbon: (b) => API.post('/api/carbon', b),
  getCarbonToday: () => API.get('/api/carbon/today'),

  // ---- 华住会间夜 ----
  getHotels: () => API.get('/api/hotels'),
  createHotel: (b) => API.post('/api/hotels', b),
  updateHotel: (id, b) => API.put('/api/hotels/' + id, b),
  deleteHotel: (id) => API.del('/api/hotels/' + id),
  checkHotel: (name) => API.get('/api/hotels/check?hotel_name=' + encodeURIComponent(name))
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

const EXP_CATS = ['餐饮', '购物', '交通', '娱乐', '医疗', '其他', '爱车', '住宿'];
const EXP_EMOJI = { 餐饮: '🍜', 购物: '🛒', 交通: '🚗', 娱乐: '🎮', 医疗: '🏥', 其他: '📦', 爱车: '🚘', 路费: '🛣️', 住宿: '🏨' };
const EXP_CSS = { 餐饮: 'dining', 购物: 'shopping', 交通: 'transport', 娱乐: 'entertainment', 医疗: 'medical', 其他: 'other', 爱车: 'car', 路费: 'toll', 住宿: 'lodging' };

let expYear, expMonth, expSelectedDate, expFilterCat = 'all', expFilterDate = '', expensesCache = [];

// 箍牙提醒相关变量
let orthoRecord = null;
let orthoCalendarYear, orthoCalendarMonth;
let orthoChangeDates = []; // 所有换牙套日期列表

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
  var submitBtn = document.getElementById('authSubmitBtn');
  errEl.style.display = 'none';

  if (!email || !password) { errEl.textContent = '邮箱和密码不能为空'; errEl.style.display = 'block'; return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.textContent = '邮箱格式不正确'; errEl.style.display = 'block'; return; }
  if (password.length < 6) { errEl.textContent = '密码至少6位'; errEl.style.display = 'block'; return; }

  // 显示加载状态
  submitBtn.disabled = true;
  submitBtn.textContent = '请稍候...';

  // 先快速检查服务器健康状态（2s 超时）
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

  // 重试逻辑：最多尝试 2 次
  var lastError = null;
  for (var attempt = 1; attempt <= 2; attempt++) {
    try {
      var result;
      if (isLogin) {
        result = await API.login({ email: email, password: password });
      } else {
        result = await API.register({ email: email, password: password, nickname: nickname });
      }
      // 🔧 关键修复：登录成功后，先写入 localStorage，再更新内存
      // 因为 _getToken() 现在实时从 localStorage 读取，必须确保 localStorage 先有值
      localStorage.setItem('tm_token', result.token);
      API.setToken(result.token);
      user = result.user;
      localStorage.setItem('tm_user', JSON.stringify(user));
      toast(result.message || '登录成功');
      showApp();
      return; // 成功，直接返回
    } catch (err) {
      lastError = err;
      console.error('[AUTH] 第' + attempt + '次尝试失败:', err.message);
      if (attempt < 2) {
        // 等待 1 秒后重试
        submitBtn.textContent = '重试中... (' + attempt + '/2)';
        await new Promise(function (r) { setTimeout(r, 1000); });
      }
    }
  }

  // 所有尝试都失败了
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
  console.log('[AUTH] 用户登出');
  API.setToken('');
  user = null;
  localStorage.removeItem('tm_user');
  localStorage.removeItem('tm_token');  // 确保同时清除
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
  // 启动时检查箍牙提醒
  checkOrthoReminderOnStart();
  // 加载主页每日提醒横幅
  loadDailyBanner();
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
    document.getElementById('reportTab').style.display = 'none';
    document.getElementById('petsTab').style.display = 'none';
    document.getElementById('carbonTab').style.display = 'none';
    document.getElementById('orthodonticTab').style.display = 'none';
    document.getElementById('hotelsTab').style.display = 'none';
    loadDiaries();
  } else if (tab === 'tasks') {
    btns[1].classList.add('active');
    document.getElementById('calendarTab').style.display = 'none';
    document.getElementById('tasksTab').style.display = 'grid';
    document.getElementById('expensesTab').style.display = 'none';
    document.getElementById('reportTab').style.display = 'none';
    document.getElementById('petsTab').style.display = 'none';
    document.getElementById('carbonTab').style.display = 'none';
    document.getElementById('orthodonticTab').style.display = 'none';
    document.getElementById('hotelsTab').style.display = 'none';
    loadTasks();
  } else if (tab === 'expenses') {
    btns[2].classList.add('active');
    document.getElementById('calendarTab').style.display = 'none';
    document.getElementById('tasksTab').style.display = 'none';
    document.getElementById('reportTab').style.display = 'none';
    document.getElementById('petsTab').style.display = 'none';
    document.getElementById('carbonTab').style.display = 'none';
    document.getElementById('orthodonticTab').style.display = 'none';
    document.getElementById('hotelsTab').style.display = 'none';
    document.getElementById('expensesTab').style.display = 'block';
    initExpenses();
  } else if (tab === 'report') {
    btns[3].classList.add('active');
    document.getElementById('calendarTab').style.display = 'none';
    document.getElementById('tasksTab').style.display = 'none';
    document.getElementById('expensesTab').style.display = 'none';
    document.getElementById('petsTab').style.display = 'none';
    document.getElementById('carbonTab').style.display = 'none';
    document.getElementById('orthodonticTab').style.display = 'none';
    document.getElementById('hotelsTab').style.display = 'none';
    document.getElementById('reportTab').style.display = 'block';
    initExpenseReport();
  } else if (tab === 'pets') {
    btns[4].classList.add('active');
    document.getElementById('calendarTab').style.display = 'none';
    document.getElementById('tasksTab').style.display = 'none';
    document.getElementById('expensesTab').style.display = 'none';
    document.getElementById('reportTab').style.display = 'none';
    document.getElementById('carbonTab').style.display = 'none';
    document.getElementById('orthodonticTab').style.display = 'none';
    document.getElementById('hotelsTab').style.display = 'none';
    document.getElementById('petsTab').style.display = 'block';
    loadPets();
  } else if (tab === 'orthodontic') {
    btns[5].classList.add('active');
    document.getElementById('calendarTab').style.display = 'none';
    document.getElementById('tasksTab').style.display = 'none';
    document.getElementById('expensesTab').style.display = 'none';
    document.getElementById('reportTab').style.display = 'none';
    document.getElementById('petsTab').style.display = 'none';
    document.getElementById('carbonTab').style.display = 'none';
    document.getElementById('hotelsTab').style.display = 'none';
    document.getElementById('orthodonticTab').style.display = 'block';
    initOrthodontic();
  } else if (tab === 'carbon') {
    btns[6].classList.add('active');
    document.getElementById('calendarTab').style.display = 'none';
    document.getElementById('tasksTab').style.display = 'none';
    document.getElementById('expensesTab').style.display = 'none';
    document.getElementById('reportTab').style.display = 'none';
    document.getElementById('petsTab').style.display = 'none';
    document.getElementById('orthodonticTab').style.display = 'none';
    document.getElementById('hotelsTab').style.display = 'none';
    document.getElementById('carbonTab').style.display = 'block';
    initCarbonCycle();
  } else if (tab === 'hotels') {
    btns[7].classList.add('active');
    document.getElementById('calendarTab').style.display = 'none';
    document.getElementById('tasksTab').style.display = 'none';
    document.getElementById('expensesTab').style.display = 'none';
    document.getElementById('reportTab').style.display = 'none';
    document.getElementById('petsTab').style.display = 'none';
    document.getElementById('orthodonticTab').style.display = 'none';
    document.getElementById('carbonTab').style.display = 'none';
    document.getElementById('hotelsTab').style.display = 'block';
    initHotels();
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

    // 始终拉取全量任务用于计算角标数量，避免切换选项卡后角标归零
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

    // 已完成事项：显示完成说明
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

function updateTaskCounts(allTasks) {
  var tasks = allTasks || tasksCache;
  var pending = tasks.filter(function (t) { return t.status === 'pending' || (!t.status && !t.completed); });
  var completed = tasks.filter(function (t) { return t.status === 'completed' || t.completed; });
  var unfinished = tasks.filter(function (t) { return t.status === 'unfinished'; });
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
    completedAtHtml = '<div class="form-group form-group-full"><label>✅ 完成时间（可编辑）</label><input type="datetime-local" id="tCompletedAt" value="' + esc(catVal) + '" oninput="modalDirty=true"></div>';
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

// ==================== 完成说明 ====================
function editCompletionNote(id) {
  var textEl = document.getElementById('cnText-' + id);
  var editWrap = document.getElementById('cnEditWrap-' + id);
  var btnEl = document.getElementById('cnBtn-' + id);
  if (textEl) textEl.style.display = 'none';
  if (editWrap) editWrap.style.display = 'flex';
  if (btnEl) btnEl.style.display = 'none';
  // 隐藏所有编辑按钮（如果之前有）
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
    // 刷新当前列表
    await loadTasks();
    toast(note ? '完成说明已保存' : '完成说明已清空');
  } catch (err) { toast(err.message, 'error'); }
}

// ==================== 记账 ====================
function initExpenses() {
  var now = new Date();
  expYear = String(now.getFullYear());
  expMonth = String(now.getMonth() + 1);
  expFilterDate = '';
  expSelectedDate = today();
  populateExpMonthPicker();
  populateExpFilterBar();
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
      ySel.innerHTML += '<option value="' + y + '" ' + (String(y) === String(expYear) ? 'selected' : '') + '>' + y + '年</option>';
    }
  }
  if (mSel) {
    mSel.innerHTML = '';
    for (var m = 1; m <= 12; m++) {
      mSel.innerHTML += '<option value="' + m + '" ' + (String(m) === String(expMonth) ? 'selected' : '') + '>' + m + '月</option>';
    }
  }
}

function changeExpMonth() {
  expYear = parseInt(document.getElementById('expYearSelect').value);
  expMonth = parseInt(document.getElementById('expMonthSelect').value);
  // 同步筛选栏的年月
  syncFilterBarFromPicker();
  loadExpenses();
}

// 初始化筛选栏的年月下拉框 + 分类下拉框
function populateExpFilterBar() {
  var ySel = document.getElementById('expFilterYear');
  var mSel = document.getElementById('expFilterMonth');
  var cSel = document.getElementById('expFilterCat');
  var dEl = document.getElementById('expFilterDate');
  var now = new Date();
  var cy = now.getFullYear();
  if (ySel) {
    ySel.innerHTML = '<option value="all">全部年份</option>';
    for (var y = cy - 2; y <= cy + 1; y++) {
      ySel.innerHTML += '<option value="' + y + '" ' + (String(y) === String(expYear) ? 'selected' : '') + '>' + y + '年</option>';
    }
  }
  if (mSel) {
    mSel.innerHTML = '<option value="all">全部月份</option>';
    for (var m = 1; m <= 12; m++) {
      mSel.innerHTML += '<option value="' + m + '" ' + (String(m) === String(expMonth) ? 'selected' : '') + '>' + m + '月</option>';
    }
  }
  if (cSel) {
    cSel.innerHTML = '<option value="all" ' + (expFilterCat === 'all' ? 'selected' : '') + '>全部分类</option>';
    for (var i = 0; i < EXP_CATS.length; i++) {
      var c = EXP_CATS[i];
      cSel.innerHTML += '<option value="' + c + '" ' + (expFilterCat === c ? 'selected' : '') + '>' + EXP_EMOJI[c] + ' ' + c + '</option>';
    }
  }
  // 同步日期选择器
  if (dEl && expFilterDate) {
    dEl.value = expFilterDate;
  } else if (dEl) {
    dEl.value = '';
  }
}

// 筛选栏查询按钮：从筛选栏读取年/月/日期/分类并加载数据
function queryExpenses() {
  var yEl = document.getElementById('expFilterYear');
  var mEl = document.getElementById('expFilterMonth');
  var dEl = document.getElementById('expFilterDate');
  var cEl = document.getElementById('expFilterCat');

  // 日期输入框优先
  if (dEl && dEl.value) {
    expFilterDate = dEl.value;
  } else {
    expFilterDate = '';
  }

  if (yEl) expYear = yEl.value;
  if (mEl) expMonth = mEl.value;
  if (cEl) {
    expFilterCat = cEl.value || 'all';
  }

  // 同步顶部统计栏的年月选择器（仅当有具体年月时）
  if (!expFilterDate && expYear !== 'all' && expMonth !== 'all') {
    // 同步整数年月到顶部选择器
    var py = parseInt(expYear);
    var pm = parseInt(expMonth);
    var pySel = document.getElementById('expYearSelect');
    var pmSel = document.getElementById('expMonthSelect');
    if (pySel) pySel.value = py;
    if (pmSel) pmSel.value = pm;
    populateExpMonthPicker(); // 刷新顶部选择器以反映当前值
  }

  // 清除选中日期（筛选条件改变后旧日期可能不在结果中）
  expSelectedDate = null;
  loadExpenses();
}

// 日期选择器变化时，自动清空年/月为"全部"（因为日期优先）
function onExpFilterDateChange() {
  var dEl = document.getElementById('expFilterDate');
  if (dEl && dEl.value) {
    // 日期有值时，年月设为"全部"以提示用户日期优先
    var yEl = document.getElementById('expFilterYear');
    var mEl = document.getElementById('expFilterMonth');
    if (yEl) yEl.value = 'all';
    if (mEl) mEl.value = 'all';
  }
}

// 重置筛选条件：恢复默认（当年当月、全部分类、清空日期）
function resetExpFilter() {
  var now = new Date();
  expYear = String(now.getFullYear());
  expMonth = String(now.getMonth() + 1);
  expFilterCat = 'all';
  expFilterDate = '';
  expSelectedDate = today();
  populateExpMonthPicker();
  populateExpFilterBar();
  loadExpenses();
}

// 从顶部统计栏的年月选择器同步到筛选栏
function syncFilterBarFromPicker() {
  var fy = document.getElementById('expFilterYear');
  var fm = document.getElementById('expFilterMonth');
  var fc = document.getElementById('expFilterCat');
  if (fy) fy.value = expYear;
  if (fm) fm.value = expMonth;
  if (fc) fc.value = expFilterCat;
  // 顶部选择器变更时清除日期筛选
  expFilterDate = '';
  var dEl = document.getElementById('expFilterDate');
  if (dEl) dEl.value = '';
}

async function loadExpenses() {
  try {
    // 构建查询参数：日期优先（date 为 'all' 或空时视为无日期筛选）
    var params = {};
    if (expFilterDate && expFilterDate !== 'all') {
      params.date = expFilterDate;
    } else {
      if (expYear && expYear !== 'all') params.year = expYear;
      if (expMonth && expMonth !== 'all') params.month = expMonth;
    }
    if (expFilterCat && expFilterCat !== 'all') params.category = expFilterCat;
    var result = await API.getExpenses(params);
    expensesCache = (result.expenses || []).map(function (e) {
      e.expense_date = normalizeDate(e.expense_date);
      return e;
    });
    renderExpCalendar();
    updateExpStats();
    if (expSelectedDate) {
      var parts = expSelectedDate.split('-');
      if (parseInt(parts[0]) === parseInt(expYear) && parseInt(parts[1]) === parseInt(expMonth)) {
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
  var msg = expFilterCat && expFilterCat !== 'all' ? '没有符合条件的记账记录' : '选择日期查看消费记录';
  document.getElementById('expenseList').innerHTML = '<div class="empty-state"><div class="empty-icon">💰</div><p>' + msg + '</p></div>';
  document.getElementById('expDailyTotal').style.display = 'none';
}

function renderExpList(ds, expenses) {
  document.getElementById('expDateTitle').textContent = '📅 ' + ds + ' 消费记录';
  var list = document.getElementById('expenseList');
  var daily = document.getElementById('expDailyTotal');
  if (expenses.length === 0) {
    var emptyMsg = (expFilterCat && expFilterCat !== 'all') ? '没有符合条件的记账记录' : '这一天没有消费记录';
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">💰</div><p>' + emptyMsg + '</p></div>';
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
  // 如果在 expensesCache 中找不到（例如在账单查询页面打开编辑），从 reportCache 中查找
  if (!expense && id) {
    expense = reportCache.find(function (e) { return e.id == id; });
  }
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
  var dateInput = document.getElementById('eDate').value;
  var note = document.getElementById('eNote').value.trim();
  if (isNaN(amount) || amount <= 0) { toast('请输入有效金额', 'error'); return; }
  if (!dateInput) { toast('请选择日期', 'error'); return; }

  // 确保日期为 YYYY-MM-DD 格式（input[type=date] 本身返回此格式，但做安全截取防止时区问题）
  var date = String(dateInput).substring(0, 10);

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
    // 如果当前在账单查询页面，同步刷新
    if (currentTab === 'report') {
      loadExpenseReport();
    }
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
    // 照片区
    html += '<div class="pet-photo">';
    if (photo) {
      html += '<img src="' + esc(photo) + '" alt="' + esc(p.name) + '" onerror="handlePetPhotoError(this)" loading="lazy">';
    } else {
      html += '<div class="pet-photo-placeholder">🐱</div>';
    }
    html += '</div>';
    // 信息区
    html += '<div class="pet-info">';
    html += '<div class="pet-name-row"><span class="pet-name">' + esc(p.name) + '</span>';
    if (p.breed) html += '<span class="pet-breed">' + esc(p.breed) + '</span>';
    html += '</div>';
    html += '<div class="pet-meta">';
    if (p.birth_date) html += '<span class="pet-meta-item">🎂 ' + p.birth_date + (age ? ' (' + age + ')' : '') + '</span>';
    html += '<span class="pet-meta-item">🐾 ' + (p.species === 'cat' ? '猫咪' : p.species) + '</span>';
    html += '</div>';
    // 操作按钮
    html += '<div class="pet-card-actions">';
    html += '<button class="pet-action-btn" onclick="openHealthEventModal(\'' + p.id + '\')" title="添加健康事件">➕ 健康事件</button>';
    html += '<button class="pet-action-btn" onclick="openPetModal(\'' + p.id + '\')" title="编辑档案">✏️ 编辑档案</button>';
    html += '<button class="pet-action-btn pet-action-del" onclick="deletePet(\'' + p.id + '\')" title="删除">🗑️</button>';
    html += '</div>';
    // 最近健康事件摘要
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

// ---- 宠物弹窗 ----
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

// ---- 健康事件弹窗 ----
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

// ---- 查看全部健康事件（时间线弹窗） ----
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

// 从后端 stats API 获取年/月总额，回退到客户端计算
async function loadExpStats() {
  try {
    // 注意：getExpenseStats 签名是 (year, month, date, category, ...)
    // 第三个参数是 date（日期），第四个参数才是 category
    var cat = expFilterCat;
    var date = expFilterDate || '';
    // year/month 可能是具体值、'all' 或空，统一归一化为 null（不传，表示“全部”）
    var yParam = (expYear !== undefined && expYear !== null && expYear !== '' && expYear !== 'all') ? expYear : null;
    var mParam = (expMonth !== undefined && expMonth !== null && expMonth !== '' && expMonth !== 'all') ? expMonth : null;

    // 分别调用两次接口，得到两个维度的统计：
    //  - 年度总额：只传年份（month=null），后端返回该年所有月份总和
    //  - 月度总额：传 year+month，后端返回该年该月总和
    var yearStats, monthStats;
    if (date && date !== 'all') {
      // 已选择具体日期：两者都按该日期统计
      yearStats = await API.getExpenseStats(null, null, date, cat);
      monthStats = yearStats;
    } else {
      var results = await Promise.all([
        API.getExpenseStats(yParam, null, date, cat),
        API.getExpenseStats(yParam, mParam, date, cat)
      ]);
      yearStats = results[0];
      monthStats = results[1];
    }

    // 确保是数字
    var yt = Number(yearStats.yearTotal) || 0;
    var mt = Number(monthStats.monthTotal) || 0;
    var el;
    el = document.getElementById('expYearLabel'); if (el) el.textContent = yParam === null ? '全部' : expYear;
    el = document.getElementById('expMonthLabel'); if (el) el.textContent = mParam === null ? '全部' : expMonth;
    el = document.getElementById('expYearTotal'); if (el) el.textContent = '¥ ' + yt.toFixed(2);
    el = document.getElementById('expMonthTotal'); if (el) el.textContent = '¥ ' + mt.toFixed(2);
  } catch (err) {
    console.warn('[EXP] stats API 失败，使用客户端计算:', err.message);
    fallbackExpStats();
  }
}

// 客户端兜底统计（当 stats API 不可用时）
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
}

function updateExpStats() {
  loadExpStats();
}

function expPrevMonth() {
  if (expMonth === 1) { expMonth = 12; expYear--; }
  else expMonth--;
  populateExpMonthPicker();
  populateExpFilterBar();
  loadExpenses();
}
function expNextMonth() {
  if (expMonth === 12) { expMonth = 1; expYear++; }
  else expMonth++;
  populateExpMonthPicker();
  populateExpFilterBar();
  loadExpenses();
}
async function expGoToToday() {
  var now = new Date();
  expYear = now.getFullYear();
  expMonth = now.getMonth() + 1;
  expSelectedDate = today();
  populateExpMonthPicker();
  populateExpFilterBar();
  await loadExpenses();
}

// ==================== 账单查询 ====================
var reportCache = [];

function initExpenseReport() {
  var now = new Date();
  var ySel = document.getElementById('rptYear');
  var mSel = document.getElementById('rptMonth');
  var cSel = document.getElementById('rptCat');
  var dEl = document.getElementById('rptDate');
  var cy = now.getFullYear();
  var cm = now.getMonth() + 1;

  if (ySel) {
    ySel.innerHTML = '<option value="all">全部年份</option>';
    for (var y = cy - 2; y <= cy + 1; y++) {
      ySel.innerHTML += '<option value="' + y + '" ' + (y === cy ? 'selected' : '') + '>' + y + '年</option>';
    }
  }
  if (mSel) {
    mSel.innerHTML = '<option value="all">全部月份</option>';
    for (var m = 1; m <= 12; m++) {
      mSel.innerHTML += '<option value="' + m + '" ' + (m === cm ? 'selected' : '') + '>' + m + '月</option>';
    }
  }
  if (cSel) {
    cSel.innerHTML = '<option value="all" selected>全部分类</option>';
    for (var i = 0; i < EXP_CATS.length; i++) {
      var c = EXP_CATS[i];
      cSel.innerHTML += '<option value="' + c + '">' + EXP_EMOJI[c] + ' ' + c + '</option>';
    }
  }
  // 清空日期选择器
  if (dEl) dEl.value = '';
  // 首次进入自动加载当前月数据
  loadExpenseReport();
}

// 日期选择器变化时，自动清空年/月为"全部"（因为日期优先）
function onRptDateChange() {
  var dEl = document.getElementById('rptDate');
  if (dEl && dEl.value) {
    var yEl = document.getElementById('rptYear');
    var mEl = document.getElementById('rptMonth');
    if (yEl) yEl.value = 'all';
    if (mEl) mEl.value = 'all';
  }
}

function resetReportFilter() {
  var now = new Date();
  document.getElementById('rptYear').value = now.getFullYear();
  document.getElementById('rptMonth').value = now.getMonth() + 1;
  document.getElementById('rptDate').value = '';
  document.getElementById('rptCat').value = 'all';
  document.getElementById('rptKeyword').value = '';
  document.getElementById('rptMinAmount').value = '';
  document.getElementById('rptMaxAmount').value = '';
  loadExpenseReport();
}

async function loadExpenseReport() {
  var yEl = document.getElementById('rptYear');
  var mEl = document.getElementById('rptMonth');
  var dEl = document.getElementById('rptDate');
  var cEl = document.getElementById('rptCat');
  var kwEl = document.getElementById('rptKeyword');
  var minEl = document.getElementById('rptMinAmount');
  var maxEl = document.getElementById('rptMaxAmount');

  var year = yEl ? yEl.value : '';
  var month = mEl ? mEl.value : '';
  var dateVal = dEl ? (dEl.value || '') : '';
  var cat = cEl ? (cEl.value || 'all') : 'all';
  var keyword = kwEl ? (kwEl.value || '').trim() : '';
  var minAmount = minEl ? minEl.value : '';
  var maxAmount = maxEl ? maxEl.value : '';

  try {
    // 构建查询参数：日期优先（date 为 'all' 或空时视为无日期筛选）
    var params = {};
    if (dateVal && dateVal !== 'all') {
      params.date = dateVal;
    } else {
      if (year && year !== 'all') params.year = year;
      if (month && month !== 'all') params.month = month;
    }
    if (cat && cat !== 'all') params.category = cat;
    if (keyword) params.keyword = keyword;
    if (minAmount) params.minAmount = minAmount;
    if (maxAmount) params.maxAmount = maxAmount;

    var [expResult, stats] = await Promise.all([
      API.getExpenses(params),
      API.getExpenseStats(year, month, dateVal, cat, keyword, minAmount, maxAmount)
    ]);

    reportCache = (expResult.expenses || []).map(function(e) {
      e.expense_date = normalizeDate(e.expense_date);
      return e;
    });

    // 渲染统计卡片
    var yt = Number(stats.yearTotal) || 0;
    var mt = Number(stats.monthTotal) || 0;
    document.getElementById('rptMonthTotal').textContent = '¥ ' + mt.toFixed(2);
    document.getElementById('rptYearTotal').textContent = '¥ ' + yt.toFixed(2);
    document.getElementById('rptCount').textContent = reportCache.length + ' 条';

    // 渲染明细表格
    renderReportTable();
  } catch (err) {
    toast('加载账单失败: ' + err.message, 'error');
  }
}

function renderReportTable() {
  var tbody = document.getElementById('rptTableBody');
  var cardList = document.getElementById('rptCardList');

  // 空数据处理
  if (reportCache.length === 0) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="report-empty">没有符合条件的记账记录</td></tr>';
    if (cardList) cardList.innerHTML = '<div class="report-card-empty">没有符合条件的记账记录</div>';
    return;
  }

  // 渲染表格（桌面端）
  if (tbody) {
    var html = '';
    for (var i = 0; i < reportCache.length; i++) {
      var e = reportCache[i];
      html += '<tr>';
      html += '<td class="report-td-date">' + esc(e.expense_date) + '</td>';
      html += '<td><span class="expense-cat expense-cat-' + EXP_CSS[e.category] + '">' + EXP_EMOJI[e.category] + ' ' + e.category + '</span></td>';
      html += '<td class="report-td-amount">¥ ' + Number(e.amount).toFixed(2) + '</td>';
      html += '<td class="report-td-note">' + (e.note ? esc(e.note) : '—') + '</td>';
      html += '<td class="report-td-actions">';
      html += '<button class="btn-task-edit" onclick="openExpenseModal(\'' + e.id + '\')" title="编辑">✏️</button>';
      html += '<button class="btn-task-del" onclick="deleteReportExpense(\'' + e.id + '\')" title="删除">🗑️</button>';
      html += '</td>';
      html += '</tr>';
    }
    tbody.innerHTML = html;
  }

  // 渲染卡片列表（手机端，备注完整显示）
  if (cardList) {
    var cards = '';
    for (var j = 0; j < reportCache.length; j++) {
      var r = reportCache[j];
      var noteContent = r.note ? esc(r.note) : '';
      cards += '<div class="report-card-item">';
      cards += '<div class="report-card-row">';
      cards += '<span class="report-card-date">' + esc(r.expense_date) + '</span>';
      cards += '<span class="expense-cat expense-cat-' + EXP_CSS[r.category] + '">' + EXP_EMOJI[r.category] + ' ' + r.category + '</span>';
      cards += '<span class="report-card-amount">¥ ' + Number(r.amount).toFixed(2) + '</span>';
      cards += '</div>';
      cards += '<div class="report-card-note">' + (noteContent || '<span class="report-card-note-empty">暂无备注</span>') + '</div>';
      cards += '<div class="report-card-actions">';
      cards += '<button class="btn-task-edit" onclick="openExpenseModal(\'' + r.id + '\')">✏️ 编辑</button>';
      cards += '<button class="btn-task-del" onclick="deleteReportExpense(\'' + r.id + '\')">🗑️ 删除</button>';
      cards += '</div>';
      cards += '</div>';
    }
    cardList.innerHTML = cards;
  }
}

async function deleteReportExpense(id) {
  if (!confirm('确定删除这条消费记录？')) return;
  try {
    await API.deleteExpense(id);
    toast('消费记录已删除');
    // 重新加载报告数据
    await loadExpenseReport();
    // 如果当前也在记账tab，同步刷新
    if (currentTab === 'expenses') {
      await loadExpenses();
    }
  } catch (err) { toast(err.message, 'error'); }
}

// ==================== 宠物照片加载失败处理 ====================
function handlePetPhotoError(img) {
  if (img && img.parentElement) {
    img.parentElement.innerHTML = '<div class="pet-photo-placeholder">🐱</div>';
  }
}

// ==================== 碳循环 ====================
var carbonData = null; // { start_date, today_type, cycle_day, days_to_high }
var carbonCalendarYear, carbonCalendarMonth;

// 碳循环食谱
var carbonRecipes = {
  low: {
    breakfast: '2个水煮蛋 + 半个牛油果 + 无糖豆浆200ml',
    lunch: '鸡胸肉150g + 西兰花200g + 少量橄榄油',
    dinner: '清蒸鱼120g + 凉拌黄瓜 + 菌菇汤',
    snack: '坚果15g（约10颗杏仁）或希腊酸奶100g',
    tip: '低碳日重点：控制碳水摄入，多吃蛋白质和蔬菜，保持血糖稳定。'
  },
  high: {
    breakfast: '全麦面包2片 + 花生酱 + 香蕉1根 + 牛奶200ml',
    lunch: '糙米饭150g + 牛肉炒彩椒 + 炒青菜',
    dinner: '红薯150g + 煎三文鱼 + 混合沙拉',
    snack: '全麦饼干2片 + 水果（苹果/橙子）',
    tip: '高碳日重点：补充糖原，为训练提供能量，选择优质碳水来源。'
  }
};

async function initCarbonCycle() {
  var now = new Date();
  carbonCalendarYear = now.getFullYear();
  carbonCalendarMonth = now.getMonth() + 1;
  await loadCarbonData();
}

async function loadCarbonData() {
  try {
    var result = await API.get('/api/carbon');
    if (result.record && result.today) {
      carbonData = result;
      document.getElementById('carbonEmpty').style.display = 'none';
      document.getElementById('carbonData').style.display = 'block';
      renderCarbonStatus();
      renderCarbonCalendar();
      renderCarbonRecipe();
    } else {
      carbonData = null;
      document.getElementById('carbonEmpty').style.display = 'block';
      document.getElementById('carbonData').style.display = 'none';
    }
  } catch (err) {
    console.error('[CARBON] 加载数据失败:', err);
    toast('加载碳循环数据失败: ' + err.message, 'error');
  }
}

function renderCarbonStatus() {
  if (!carbonData) return;
  var today = carbonData.today;
  var isHigh = today.type === 'high';

  // 状态卡片样式
  var card = document.getElementById('carbonStatusCard');
  card.style.background = isHigh
    ? 'linear-gradient(135deg, rgba(255,152,0,0.15), rgba(255,152,0,0.05))'
    : 'linear-gradient(135deg, rgba(76,175,80,0.15), rgba(76,175,80,0.05))';
  card.style.borderColor = isHigh ? 'rgba(255,152,0,0.4)' : 'rgba(76,175,80,0.4)';

  document.getElementById('carbonStatusIcon').textContent = isHigh ? '🍞' : '🥗';
  document.getElementById('carbonStatusType').textContent = isHigh ? '高碳日' : '低碳日';
  document.getElementById('carbonStatusType').style.color = isHigh ? '#ff9800' : '#4caf50';
  document.getElementById('carbonStatusDetail').textContent = '周期第 ' + today.cycle_day + ' 天';

  var daysToHigh = today.days_to_high;
  var countdownEl = document.getElementById('carbonCountdownValue');
  if (daysToHigh === 0) {
    countdownEl.textContent = '就是今天！🎉';
    countdownEl.style.color = '#ff9800';
  } else {
    countdownEl.textContent = daysToHigh + ' 天';
    countdownEl.style.color = '';
  }
}

function renderCarbonCalendar() {
  var grid = document.getElementById('carbonCalendarGrid');
  var title = document.getElementById('carbonCalendarTitle');
  if (!grid) return;

  if (!carbonCalendarYear || !carbonCalendarMonth) {
    var now = new Date();
    carbonCalendarYear = now.getFullYear();
    carbonCalendarMonth = now.getMonth() + 1;
  }

  if (title) {
    title.textContent = carbonCalendarYear + '年 ' + carbonCalendarMonth + '月';
  }

  // 构建碳循环日期映射：从 start_date 到未来 60 天
  var cycleMap = {};
  if (carbonData && carbonData.record) {
    var startDate = new Date(carbonData.record.start_date);
    startDate.setHours(0, 0, 0, 0);
    var endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 60);
    var current = new Date(startDate);
    while (current <= endDate) {
      var dateStr = formatDate(current);
      var diffDays = Math.floor((current - startDate) / (1000 * 60 * 60 * 24));
      cycleMap[dateStr] = (diffDays % 4 === 3) ? 'high' : 'low';
      current.setDate(current.getDate() + 1);
    }
  }

  var firstDay = new Date(carbonCalendarYear, carbonCalendarMonth - 1, 1);
  var lastDay = new Date(carbonCalendarYear, carbonCalendarMonth, 0);
  var totalDays = lastDay.getDate();
  var startDow = firstDay.getDay();
  var todayStr = formatDate(new Date());

  var html = '<div class="carbon-weekday">日</div><div class="carbon-weekday">一</div><div class="carbon-weekday">二</div><div class="carbon-weekday">三</div><div class="carbon-weekday">四</div><div class="carbon-weekday">五</div><div class="carbon-weekday">六</div>';

  for (var j = 0; j < startDow; j++) {
    html += '<div class="carbon-day carbon-day-empty"></div>';
  }

  for (var d = 1; d <= totalDays; d++) {
    var dateStr = carbonCalendarYear + '-' + String(carbonCalendarMonth).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    var isToday = (dateStr === todayStr);
    var dayType = cycleMap[dateStr];

    var cls = 'carbon-day';
    if (isToday) cls += ' carbon-day-today';
    if (dayType === 'low') cls += ' carbon-day-low';
    else if (dayType === 'high') cls += ' carbon-day-high';
    else cls += ' carbon-day-none';

    var label = dayType === 'high' ? '高' : (dayType === 'low' ? '低' : '');
    html += '<div class="' + cls + '">';
    html += '<span class="carbon-day-num">' + d + '</span>';
    if (label) {
      html += '<span class="carbon-day-label">' + label + '</span>';
    }
    html += '</div>';
  }

  grid.innerHTML = html;
}

function carbonPrevMonth() {
  carbonCalendarMonth--;
  if (carbonCalendarMonth < 1) { carbonCalendarMonth = 12; carbonCalendarYear--; }
  renderCarbonCalendar();
}

function carbonNextMonth() {
  carbonCalendarMonth++;
  if (carbonCalendarMonth > 12) { carbonCalendarMonth = 1; carbonCalendarYear++; }
  renderCarbonCalendar();
}

function carbonGoToToday() {
  var now = new Date();
  carbonCalendarYear = now.getFullYear();
  carbonCalendarMonth = now.getMonth() + 1;
  renderCarbonCalendar();
}

function renderCarbonRecipe() {
  if (!carbonData || !carbonData.today) return;
  var isHigh = carbonData.today.type === 'high';
  var recipe = isHigh ? carbonRecipes.high : carbonRecipes.low;

  document.getElementById('carbonRecipeTitle').textContent = isHigh ? '🍞 高碳日食谱推荐' : '🥗 低碳日食谱推荐';
  document.getElementById('carbonRecipeTag').textContent = isHigh ? '高碳日' : '低碳日';
  document.getElementById('carbonRecipeTag').style.background = isHigh ? 'rgba(255,152,0,0.2)' : 'rgba(76,175,80,0.2)';
  document.getElementById('carbonRecipeTag').style.color = isHigh ? '#ff9800' : '#4caf50';

  var html = '';
  html += '<div class="carbon-recipe-meals">';
  html += '<div class="carbon-recipe-meal"><div class="carbon-recipe-meal-label">🌅 早餐</div><div class="carbon-recipe-meal-text">' + recipe.breakfast + '</div></div>';
  html += '<div class="carbon-recipe-meal"><div class="carbon-recipe-meal-label">☀️ 午餐</div><div class="carbon-recipe-meal-text">' + recipe.lunch + '</div></div>';
  html += '<div class="carbon-recipe-meal"><div class="carbon-recipe-meal-label">🌙 晚餐</div><div class="carbon-recipe-meal-text">' + recipe.dinner + '</div></div>';
  if (recipe.snack) {
    html += '<div class="carbon-recipe-meal"><div class="carbon-recipe-meal-label">🍪 加餐</div><div class="carbon-recipe-meal-text">' + recipe.snack + '</div></div>';
  }
  html += '</div>';
  html += '<div class="carbon-recipe-tip">💡 ' + recipe.tip + '</div>';

  document.getElementById('carbonRecipeContent').innerHTML = html;
}

async function setupCarbonCycle() {
  try {
    var todayStr = formatDate(new Date());
    await API.post('/api/carbon', { start_date: todayStr });
    toast('碳循环已启动！从今天开始 🥗');
    await loadCarbonData();
  } catch (err) {
    toast('设置失败: ' + err.message, 'error');
  }
}

async function resetCarbonCycle() {
  if (!confirm('确定要重置碳循环起始日期为今天吗？')) return;
  try {
    var todayStr = formatDate(new Date());
    await API.post('/api/carbon', { start_date: todayStr });
    toast('碳循环起始日期已重置为今天 🔄');
    await loadCarbonData();
  } catch (err) {
    toast('重置失败: ' + err.message, 'error');
  }
}

// ==================== 主页每日提醒横幅 ====================
async function loadDailyBanner() {
  var banner = document.getElementById('dailyBanner');
  if (!banner) return;

  // 并行加载碳循环和箍牙数据
  try {
    var carbonResult = null;
    var orthoResult = null;

    try { carbonResult = await API.get('/api/carbon'); } catch (e) { /* ignore */ }
    try { orthoResult = await API.getOrthodontic(); } catch (e) { /* ignore */ }

    var hasCarbon = carbonResult && carbonResult.today;
    var hasOrtho = orthoResult && orthoResult.record;

    if (!hasCarbon && !hasOrtho) {
      banner.style.display = 'none';
      return;
    }

    banner.style.display = 'block';

    // 碳循环横幅
    var carbonEl = document.getElementById('dailyBannerCarbon');
    if (hasCarbon) {
      carbonEl.style.display = 'flex';
      var isHigh = carbonResult.today.type === 'high';
      document.getElementById('dailyBannerCarbonIcon').textContent = isHigh ? '🍞' : '🥗';
      document.getElementById('dailyBannerCarbonText').textContent = isHigh
        ? '今天高碳日，可以尽情享受碳水！'
        : '今天低碳日，建议低碳饮食';
      carbonEl.style.background = isHigh
        ? 'linear-gradient(135deg, rgba(255,152,0,0.12), rgba(255,152,0,0.04))'
        : 'linear-gradient(135deg, rgba(76,175,80,0.12), rgba(76,175,80,0.04))';
      carbonEl.style.borderLeftColor = isHigh ? '#ff9800' : '#4caf50';
    } else {
      carbonEl.style.display = 'none';
    }

    // 箍牙横幅
    var orthoEl = document.getElementById('dailyBannerOrtho');
    if (hasOrtho) {
      orthoEl.style.display = 'flex';
      var record = orthoResult.record;
      var daysWorn = record.days_worn;
      var daysLeft = record.days_left;
      var isOverdue = record.is_overdue;

      if (isOverdue) {
        document.getElementById('dailyBannerOrthoIcon').textContent = '⚠️';
        document.getElementById('dailyBannerOrthoText').textContent = '已超更换计划 ' + (daysWorn - record.change_interval) + ' 天，请尽快更换！';
        orthoEl.style.background = 'linear-gradient(135deg, rgba(239,83,80,0.12), rgba(239,83,80,0.04))';
        orthoEl.style.borderLeftColor = '#ef5350';
      } else if (daysLeft === 0) {
        document.getElementById('dailyBannerOrthoIcon').textContent = '🦷';
        document.getElementById('dailyBannerOrthoText').textContent = '今天该换新牙套了！';
        orthoEl.style.background = 'linear-gradient(135deg, rgba(255,152,0,0.12), rgba(255,152,0,0.04))';
        orthoEl.style.borderLeftColor = '#ff9800';
      } else {
        document.getElementById('dailyBannerOrthoIcon').textContent = '🦷';
        document.getElementById('dailyBannerOrthoText').textContent = '第 ' + record.tray_number + ' 副，已佩戴 ' + daysWorn + ' 天，还有 ' + daysLeft + ' 天更换';
        orthoEl.style.background = '';
        orthoEl.style.borderLeftColor = 'var(--accent)';
      }
    } else {
      orthoEl.style.display = 'flex';
      document.getElementById('dailyBannerOrthoIcon').textContent = '🦷';
      document.getElementById('dailyBannerOrthoText').textContent = '尚未记录箍牙信息，请去设置';
      orthoEl.style.background = '';
      orthoEl.style.borderLeftColor = 'var(--border)';
    }

    // 如果只有一个模块显示，隐藏分隔线
    var divider = document.querySelector('.daily-banner-divider');
    if (divider) {
      var carbonVisible = document.getElementById('dailyBannerCarbon').style.display !== 'none';
      var orthoVisible = document.getElementById('dailyBannerOrtho').style.display !== 'none';
      divider.style.display = (carbonVisible && orthoVisible) ? 'block' : 'none';
    }
  } catch (err) {
    console.error('[BANNER] 加载横幅数据失败:', err);
  }
}

// ==================== 键盘快捷键 ====================
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    var overlay = document.getElementById('modalOverlay');
    if (overlay && overlay.style.display !== 'none') closeModal();
  }
});

// ==================== Token 过期检测（客户端本地解码） ====================
/**
 * 检查 token 是否已过期（客户端本地解码 exp 字段，无需网络请求）
 * @returns {{ expired: boolean, expiresAt: string|null, remainingMinutes: number|null }}
 */
function checkTokenExpiry() {
  var token = localStorage.getItem('tm_token');
  if (!token) return { expired: true, expiresAt: null, remainingMinutes: null };

  try {
    // 解析 JWT payload（中间段是 base64url 编码的 JSON）
    var parts = token.split('.');
    if (parts.length !== 3) return { expired: true, expiresAt: null, remainingMinutes: null };

    // base64url 转 base64，然后 atob 解码
    var payload = parts[1];
    payload = payload.replace(/-/g, '+').replace(/_/g, '/');
    // 补齐 padding
    while (payload.length % 4) payload += '=';
    var decoded = JSON.parse(atob(payload));

    if (!decoded.exp) return { expired: false, expiresAt: null, remainingMinutes: null };

    var expMs = decoded.exp * 1000;
    var nowMs = Date.now();
    var remainingMs = expMs - nowMs;
    var remainingMinutes = Math.max(0, Math.floor(remainingMs / 60000));
    var expired = remainingMs <= 0;

    var expiresAt = new Date(expMs).toISOString();

    if (expired) {
      console.warn('[TOKEN-CHECK] ⚠️ Token 已过期! 过期时间: ' + expiresAt + ', 当前时间: ' + new Date().toISOString());
    } else {
      var remainingDays = (remainingMs / 86400000).toFixed(1);
      console.log('[TOKEN-CHECK] ✅ Token 有效, 过期时间: ' + expiresAt + ', 剩余: ' + remainingDays + ' 天 (' + remainingMinutes + ' 分钟)');
    }

    return { expired: expired, expiresAt: expiresAt, remainingMinutes: remainingMinutes };
  } catch (e) {
    console.error('[TOKEN-CHECK] 解码 token 失败:', e.message);
    return { expired: false, expiresAt: null, remainingMinutes: null };
  }
}

// ==================== Token 诊断工具（开发调试用） ====================
async function debugToken() {
  try {
    // 🔧 使用 _getToken() 实时读取，确保拿到最新的 token
    var currentToken = API._getToken();
    var result = await fetch(API_BASE + '/api/auth/debug', {
      headers: currentToken ? { 'Authorization': 'Bearer ' + currentToken } : {}
    });
    var info = await result.json();
    console.log('[TOKEN-DEBUG] Token 状态:', JSON.stringify(info, null, 2));
    return info;
  } catch (e) {
    console.error('[TOKEN-DEBUG] 诊断失败:', e.message);
    return null;
  }
}

// ==================== 初始化 ====================
(function () {
  // 🔧 关键修复：初始化时先确保 token 和 localStorage 同步
  // 如果内存中 token 为空但 localStorage 中有，从 localStorage 恢复
  if (!API.token) {
    var storedToken = localStorage.getItem('tm_token');
    if (storedToken) {
      console.log('[INIT] 🔧 从 localStorage 恢复 token (长度=' + storedToken.length + ')');
      API.token = storedToken;
    } else if (user && user.token) {
      // 兼容旧版：从 user 对象中恢复 token
      console.log('[INIT] 🔧 从 user.token 恢复并迁移 token');
      API.token = user.token;
      localStorage.setItem('tm_token', user.token);
    }
  }

  console.log('[INIT] 初始化开始: user=' + (user ? user.email : 'null') + ', token=' + (API.token ? '有(长度=' + API.token.length + ')' : '无'));

  // 修复：如果 user 存在但 token 缺失，需要重新登录
  if (user && !API.token) {
    console.warn('[INIT] user 存在但 token 缺失，清除用户状态要求重新登录');
    localStorage.removeItem('tm_user');
    user = null;
  }

  if (user && API.token) {
    var ap = document.getElementById('authPage');
    if (ap) ap.style.display = 'none';

    // 🔧 第一步：客户端本地快速检查 token 是否过期（无需网络请求）
    var expiryCheck = checkTokenExpiry();
    if (expiryCheck.expired) {
      console.warn('[INIT] ⚠️ Token 已过期（客户端本地检测），清除登录状态');
      API.setToken('');
      localStorage.removeItem('tm_user');
      user = null;
      // 恢复显示登录页
      if (ap) ap.style.display = 'flex';
      var appEl = document.getElementById('appPage');
      if (appEl) appEl.style.display = 'none';
      toast('登录已过期，请重新登录', 'error');
      return; // 不继续初始化
    }

    // 🔧 第二步：启动时通过网络请求验证 token 有效性（检查签名是否匹配）
    API._fetch('/api/auth/debug', { timeout: 5000 }).then(function(debugInfo) {
      if (debugInfo.valid) {
        console.log('[INIT] ✅ Token 有效, 剩余 ' + debugInfo.remainingDays + ' 天');
        showApp();
      } else {
        console.warn('[INIT] ⚠️ Token 无效:', debugInfo.error);
        // 检查是否是签名不匹配
        if (debugInfo.error && debugInfo.error.indexOf('invalid signature') !== -1) {
          console.error('[INIT] 🔑 Token 签名不匹配！可能是服务器 JWT_SECRET 不一致');
          console.error('[INIT]    请确保 Render 环境变量 JWT_SECRET 设置为 time_master_secret_2025');
        }
        API.setToken('');
        localStorage.removeItem('tm_user');
        user = null;
        if (ap) ap.style.display = 'flex';
        var appEl2 = document.getElementById('appPage');
        if (appEl2) appEl2.style.display = 'none';
        toast('登录已过期，请重新登录', 'error');
      }
    }).catch(function(err) {
      // 诊断接口失败可能只是网络问题，仍然尝试显示应用
      console.warn('[INIT] 诊断接口调用失败，仍尝试进入应用:', err.message);
      showApp();
    });
  } else {
    API.setToken('');
    localStorage.removeItem('tm_user');
    user = null;
    console.log('[INIT] 未登录，显示登录页');
  }
})();

// ==================== 箍牙提醒板块 ====================

// 初始化箍牙板块
async function initOrthodontic() {
  var now = new Date();
  orthoCalendarYear = now.getFullYear();
  orthoCalendarMonth = now.getMonth() + 1;
  await loadOrthoData();
}

// 加载箍牙数据
async function loadOrthoData() {
  try {
    var result = await API.getOrthodontic();
    orthoRecord = result.record;

    if (orthoRecord) {
      // 计算换牙套日期列表
      calcOrthoChangeDates();
      // 渲染统计卡片
      renderOrthoStats();
      // 渲染日历
      try {
        renderOrthoCalendar();
      } catch (renderErr) {
        console.error('[ORTHO] 日历渲染失败:', renderErr);
      }
      // 显示/隐藏空状态
      document.getElementById('orthoEmpty').style.display = 'none';
      document.getElementById('orthoStats').style.display = 'flex';
      document.getElementById('orthoCalendarWrap').style.display = 'block';
      // 检查提醒
      checkOrthoAlert();
    } else {
      orthoRecord = null;
      orthoChangeDates = [];
      document.getElementById('orthoStats').style.display = 'none';
      document.getElementById('orthoCalendarWrap').style.display = 'none';
      document.getElementById('orthoEmpty').style.display = 'block';
      document.getElementById('orthoAlertBanner').style.display = 'none';
    }
  } catch (err) {
    console.error('[ORTHO] 加载数据失败:', err);
    toast('加载箍牙数据失败: ' + err.message, 'error');
  }
}

// 计算所有换牙套日期（从 start_date 开始，每 change_interval 天一个，推算到未来 2 年）
function calcOrthoChangeDates() {
  if (!orthoRecord) { orthoChangeDates = []; return; }
  var start = new Date(orthoRecord.start_date);
  start.setHours(0, 0, 0, 0);
  var interval = orthoRecord.change_interval || 14;
  var end = new Date(start);
  end.setFullYear(end.getFullYear() + 2); // 推算到未来 2 年
  orthoChangeDates = [];
  var current = new Date(start);
  var trayNum = orthoRecord.tray_number || 1;
  while (current <= end) {
    orthoChangeDates.push({
      date: formatDate(current),
      trayNumber: trayNum
    });
    current.setDate(current.getDate() + interval);
    trayNum++;
  }
}

// 格式化日期为 YYYY-MM-DD
function formatDate(d) {
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

// 渲染统计卡片
function renderOrthoStats() {
  if (!orthoRecord) return;
  var daysWorn = orthoRecord.days_worn;
  var daysLeft = orthoRecord.days_left;
  var isOverdue = orthoRecord.is_overdue;
  var nextDate = orthoRecord.next_change_date;

  // 格式化下次更换日期
  var nextParts = nextDate.split('-');
  var nextStr = nextParts[0] + '年' + parseInt(nextParts[1]) + '月' + parseInt(nextParts[2]) + '日';

  document.getElementById('orthoTrayNum').textContent = '第 ' + orthoRecord.tray_number + ' 副';
  document.getElementById('orthoDaysWorn').textContent = daysWorn + ' 天';
  if (isOverdue) {
    document.getElementById('orthoDaysLeft').textContent = '已超 ' + (daysWorn - orthoRecord.change_interval) + ' 天 ⚠️';
    document.getElementById('orthoDaysLeft').style.color = '#ef5350';
  } else {
    document.getElementById('orthoDaysLeft').textContent = daysLeft + ' 天';
    document.getElementById('orthoDaysLeft').style.color = '';
  }
  document.getElementById('orthoNextDate').textContent = nextStr;
}

// 渲染箍牙日历
function renderOrthoCalendar() {
  var grid = document.getElementById('orthoCalendarGrid');
  var title = document.getElementById('orthoCalendarTitle');
  if (!grid) return;

  // 确保 calendar year/month 已初始化
  if (!orthoCalendarYear || !orthoCalendarMonth) {
    var now = new Date();
    orthoCalendarYear = now.getFullYear();
    orthoCalendarMonth = now.getMonth() + 1;
  }

  if (title) {
    title.textContent = orthoCalendarYear + '年 ' + orthoCalendarMonth + '月';
  }

  var firstDay = new Date(orthoCalendarYear, orthoCalendarMonth - 1, 1);
  var lastDay = new Date(orthoCalendarYear, orthoCalendarMonth, 0);
  var totalDays = lastDay.getDate();
  var startDow = firstDay.getDay(); // 0=周日

  // 构建换牙套日期映射（用于快速查找）
  var changeDateMap = {};
  for (var i = 0; i < orthoChangeDates.length; i++) {
    changeDateMap[orthoChangeDates[i].date] = orthoChangeDates[i].trayNumber;
  }

  var todayStr = formatDate(new Date());

  var html = '<div class="ortho-weekday">日</div><div class="ortho-weekday">一</div><div class="ortho-weekday">二</div><div class="ortho-weekday">三</div><div class="ortho-weekday">四</div><div class="ortho-weekday">五</div><div class="ortho-weekday">六</div>';

  // 空白格
  for (var j = 0; j < startDow; j++) {
    html += '<div class="ortho-day ortho-day-empty"></div>';
  }

  // 日期格
  for (var d = 1; d <= totalDays; d++) {
    var dateStr = orthoCalendarYear + '-' + String(orthoCalendarMonth).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    var isToday = (dateStr === todayStr);
    var trayNum = changeDateMap[dateStr];
    var isChangeDay = (trayNum !== undefined);

    var cls = 'ortho-day';
    if (isToday) cls += ' ortho-day-today';
    if (isChangeDay) cls += ' ortho-day-change';

    html += '<div class="' + cls + '"' + (isChangeDay ? ' onclick="showOrthoDayInfo(\'' + dateStr + '\', ' + trayNum + ')"' : '') + '>';
    html += '<span class="ortho-day-num">' + d + '</span>';
    if (isChangeDay) {
      html += '<span class="ortho-day-dot">🦷</span>';
    }
    html += '</div>';
  }

  grid.innerHTML = html;
}

// 点击换牙套日期
function showOrthoDayInfo(dateStr, trayNum) {
  var parts = dateStr.split('-');
  var displayStr = parts[0] + '年' + parseInt(parts[1]) + '月' + parseInt(parts[2]) + '日';
  toast('🦷 ' + displayStr + '：第 ' + trayNum + ' 副牙套佩戴日');
}

// 上月
function orthoPrevMonth() {
  orthoCalendarMonth--;
  if (orthoCalendarMonth < 1) { orthoCalendarMonth = 12; orthoCalendarYear--; }
  renderOrthoCalendar();
}

// 下月
function orthoNextMonth() {
  orthoCalendarMonth++;
  if (orthoCalendarMonth > 12) { orthoCalendarMonth = 1; orthoCalendarYear++; }
  renderOrthoCalendar();
}

// 回到今天
function orthoGoToToday() {
  var now = new Date();
  orthoCalendarYear = now.getFullYear();
  orthoCalendarMonth = now.getMonth() + 1;
  renderOrthoCalendar();
}

// 检查是否需要提醒
function checkOrthoAlert() {
  if (!orthoRecord) return;
  var banner = document.getElementById('orthoAlertBanner');
  if (!banner) return;

  var daysLeft = orthoRecord.days_left;
  var isOverdue = orthoRecord.is_overdue;
  var daysWorn = orthoRecord.days_worn;
  var interval = orthoRecord.change_interval;

  if (isOverdue) {
    var overdueDays = daysWorn - interval;
    document.getElementById('orthoAlertIcon').textContent = '⚠️';
    document.getElementById('orthoAlertText').textContent = '您已超出换牙套计划 ' + overdueDays + ' 天，请尽快更换！';
    banner.style.display = 'flex';
    banner.className = 'ortho-alert-banner ortho-alert-danger';
  } else if (daysLeft === 0) {
    // 今天就是换牙套日
    document.getElementById('orthoAlertIcon').textContent = '🦷';
    document.getElementById('orthoAlertText').textContent = '提醒：今天是第 ' + orthoRecord.tray_number + ' 副牙套的更换日，请及时更换！';
    banner.style.display = 'flex';
    banner.className = 'ortho-alert-banner ortho-alert-success';
  } else {
    banner.style.display = 'none';
  }
}

// 打开换新牙套弹窗
function openChangeTrayModal() {
  var now = formatDate(new Date());
  var nextTrayNum = orthoRecord ? (orthoRecord.tray_number + 1) : 1;
  var interval = orthoRecord ? orthoRecord.change_interval : 14;

  var html = '<h3>🦷 换新牙套</h3>';
  html += '<div class="form-group"><label>开始佩戴日期</label><input type="date" id="modalOrthoStartDate" value="' + now + '"></div>';
  html += '<div class="form-group"><label>牙套编号（第几副）</label><input type="number" id="modalOrthoTrayNum" value="' + nextTrayNum + '" min="1"></div>';
  html += '<div class="form-group"><label>更换间隔（天）</label><input type="number" id="modalOrthoInterval" value="' + interval + '" min="1" max="365"></div>';
  html += '<div class="modal-actions"><button class="btn-primary" onclick="submitChangeTray()">确认更换</button><button class="btn-secondary" onclick="closeModal()">取消</button></div>';

  openCustomModal(html);
}

// 提交换牙套
async function submitChangeTray() {
  var startDate = document.getElementById('modalOrthoStartDate').value;
  var trayNum = parseInt(document.getElementById('modalOrthoTrayNum').value);
  var interval = parseInt(document.getElementById('modalOrthoInterval').value);

  if (!startDate) { toast('请选择开始日期', 'error'); return; }
  if (!trayNum || trayNum < 1) { toast('请输入有效的牙套编号', 'error'); return; }
  if (!interval || interval < 1) { toast('请输入有效的间隔天数', 'error'); return; }

  try {
    await API.createOrthodontic({ start_date: startDate, tray_number: trayNum, change_interval: interval });
    closeModal();
    toast('牙套更换记录已保存 🦷');
    await loadOrthoData();
  } catch (err) {
    toast('保存失败: ' + err.message, 'error');
  }
}

// 打开修改间隔弹窗
function openEditIntervalModal() {
  if (!orthoRecord) { toast('请先创建箍牙记录', 'error'); return; }
  var html = '<h3>⚙️ 修改更换间隔</h3>';
  html += '<p style="color:var(--text-secondary);margin-bottom:16px;">当前间隔：' + orthoRecord.change_interval + ' 天</p>';
  html += '<div class="form-group"><label>新的更换间隔（天）</label><input type="number" id="editInterval" value="' + orthoRecord.change_interval + '" min="1" max="365"></div>';
  html += '<div class="modal-actions"><button class="btn-primary" onclick="submitEditInterval()">确认修改</button><button class="btn-secondary" onclick="closeModal()">取消</button></div>';
  openCustomModal(html);
}

// 提交修改间隔
async function submitEditInterval() {
  var interval = parseInt(document.getElementById('editInterval').value);
  if (!interval || interval < 1) { toast('请输入有效的间隔天数', 'error'); return; }
  try {
    await API.updateOrthodontic({ change_interval: interval });
    closeModal();
    toast('更换间隔已更新');
    await loadOrthoData();
  } catch (err) {
    toast('修改失败: ' + err.message, 'error');
  }
}

// 删除记录
async function deleteOrthoRecord() {
  if (!orthoRecord) return;
  if (!confirm('确定删除箍牙记录吗？此操作不可恢复。')) return;
  try {
    await API.deleteOrthodontic();
    orthoRecord = null;
    orthoChangeDates = [];
    toast('记录已删除');
    await loadOrthoData();
  } catch (err) {
    toast('删除失败: ' + err.message, 'error');
  }
}

// 自定义弹窗辅助
function openCustomModal(html) {
  var overlay = document.getElementById('modalOverlay');
  var content = document.getElementById('modalContent');
  content.innerHTML = html;
  overlay.style.display = 'flex';
}

// 在应用初始化时检查箍牙提醒
async function checkOrthoReminderOnStart() {
  try {
    var result = await API.getOrthodontic();
    if (!result.record) return;
    var daysLeft = result.record.days_left;
    var isOverdue = result.record.is_overdue;
    var daysWorn = result.record.days_worn;
    var interval = result.record.change_interval;

    if (isOverdue) {
      var overdueDays = daysWorn - interval;
      toast('⚠️ 您已超出换牙套计划 ' + overdueDays + ' 天，请尽快更换！', 'error');
    } else if (daysLeft <= 2 && daysLeft >= 0) {
      if (daysLeft === 0) {
        toast('🦷 今天是第 ' + result.record.tray_number + ' 副牙套的更换日！', 'info');
      } else {
        toast('🦷 距离下次换牙套还剩 ' + daysLeft + ' 天', 'info');
      }
    }
  } catch (e) {
    // 静默失败，不影响主流程
  }
}

// ==================== 华住会间夜 ====================
var hotelsCache = []; // 入住记录缓存
var hotelsCalendarYear, hotelsCalendarMonth;
var hotelsMapByDate = {}; // 日期 → 入住记录对象数组映射

async function initHotels() {
  var now = new Date();
  hotelsCalendarYear = now.getFullYear();
  hotelsCalendarMonth = now.getMonth() + 1;
  await loadHotels();
}

async function loadHotels() {
  try {
    var result = await API.getHotels();
    hotelsCache = result.stays || [];
    buildHotelsDateMap();
    buildHotelsByName();
    renderHotelsStats();
    renderHotelsNames();
    renderHotelsCalendar();
  } catch (err) {
    toast('加载入住记录失败: ' + err.message, 'error');
  }
}

// 日期字符串加 N 天（UTC 安全），返回 'YYYY-MM-DD'
function addDaysStr(dateStr, days) {
  var d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().substring(0, 10);
}

// 某条记录覆盖到的最后一天（连住区间结束日）
function stayEndDate(stay) {
  return addDaysStr(normalizeDate(stay.start_date), (parseInt(stay.duration, 10) || 1) - 1);
}

function buildHotelsDateMap() {
  hotelsMapByDate = {};
  for (var i = 0; i < hotelsCache.length; i++) {
    var s = hotelsCache[i];
    var start = normalizeDate(s.start_date);
    var dur = Math.max(1, parseInt(s.duration, 10) || 1);
    // 连住：从 start_date 起连续 dur 天，每一天都映射到该记录
    for (var k = 0; k < dur; k++) {
      var date = addDaysStr(start, k);
      if (!hotelsMapByDate[date]) hotelsMapByDate[date] = [];
      hotelsMapByDate[date].push(s);
    }
  }
}

// 同一日期多条记录时，用于区分各酒店的小圆点颜色
var hotelsDotColors = ['#4caf50', '#42a5f5', '#ffa726', '#ab47bc', '#ec407a', '#26a69a', '#ef5350', '#ffca28'];

// 按酒店名分组：{ 酒店名: { count: 入住记录条数, dates: { 'YYYY-MM-DD': true } } }
var hotelsByName = {};
// 当前高亮的酒店名（null 表示无高亮）
var hotelsHighlightName = null;

// 按酒店名称分组，统计入住次数与覆盖的全部日期（start_date 起连住 N 天）
function buildHotelsByName() {
  hotelsByName = {};
  for (var i = 0; i < hotelsCache.length; i++) {
    var s = hotelsCache[i];
    var name = s.hotel_name;
    if (!name) continue;
    if (!hotelsByName[name]) hotelsByName[name] = { count: 0, dates: {} };
    hotelsByName[name].count++;
    var start = normalizeDate(s.start_date);
    var dur = Math.max(1, parseInt(s.duration, 10) || 1);
    for (var k = 0; k < dur; k++) {
      hotelsByName[name].dates[addDaysStr(start, k)] = true;
    }
  }
}

// 渲染“我的酒店”标签区
function renderHotelsNames() {
  var wrap = document.getElementById('hotelsNamesWrap');
  var list = document.getElementById('hotelsNamesList');
  if (!wrap || !list) return;
  var names = Object.keys(hotelsByName);
  if (names.length === 0) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';
  // 若高亮酒店已被全部删除，自动取消高亮
  if (hotelsHighlightName && !hotelsByName[hotelsHighlightName]) hotelsHighlightName = null;
  var html = '';
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    var info = hotelsByName[name];
    var active = hotelsHighlightName === name;
    html += '<button class="hotels-name-tag' + (active ? ' hotels-name-tag-active' : '') + '" data-name="' + esc(name) + '" onclick="hotelsToggleHighlight(this)" title="点击高亮 ' + esc(name) + ' 的所有入住日期，再次点击取消">' + esc(name) + '<span class="hotels-name-tag-count">×' + info.count + '</span></button>';
  }
  list.innerHTML = html;
  var clearBtn = document.getElementById('hotelsNamesClearBtn');
  if (clearBtn) clearBtn.style.display = hotelsHighlightName ? 'inline-flex' : 'none';
}

// 点击酒店标签：切换高亮
function hotelsToggleHighlight(el) {
  if (!el) return;
  var name = el.getAttribute('data-name');
  if (!name) return;
  if (hotelsHighlightName === name) {
    hotelsClearHighlight();
  } else {
    hotelsHighlightName = name;
    renderHotelsNames();
    renderHotelsCalendar();
  }
}

// 取消高亮，恢复普通日历视图
function hotelsClearHighlight() {
  hotelsHighlightName = null;
  renderHotelsNames();
  renderHotelsCalendar();
}

function renderHotelsStats() {
  // 总间夜数 = 所有记录的连住天数之和
  var totalNights = 0;
  for (var i = 0; i < hotelsCache.length; i++) {
    totalNights += parseInt(hotelsCache[i].duration, 10) || 1;
  }
  var lastStay = hotelsCache.length > 0 ? hotelsCache[0] : null;

  // 计算当前可入住的酒店数量（按酒店名去重，不在冷却期内的）
  var hotelNames = {};
  var todayS = formatDate(new Date());
  for (var i = 0; i < hotelsCache.length; i++) {
    var s = hotelsCache[i];
    hotelNames[s.hotel_name] = true;
  }
  // 对每个酒店检查是否在冷却期内（以 start_date 为基准，start_date + 32 天可再次入住）
  var availableCount = 0;
  var names = Object.keys(hotelNames);
  for (var n = 0; n < names.length; n++) {
    var name = names[n];
    // 找到该酒店最近一次入住
    var latest = null;
    for (var i = 0; i < hotelsCache.length; i++) {
      if (hotelsCache[i].hotel_name === name) {
        latest = hotelsCache[i];
        break; // 缓存已按日期倒序排列
      }
    }
    if (latest) {
      var nextAvailable = addDaysStr(normalizeDate(latest.start_date), 32);
      if (todayS >= nextAvailable) {
        availableCount++;
      }
    }
  }

  document.getElementById('hotelsTotalNights').textContent = totalNights + ' 次';
  document.getElementById('hotelsLastStay').textContent = lastStay
    ? (lastStay.hotel_name + ' (' + normalizeDate(lastStay.start_date) + (parseInt(lastStay.duration, 10) > 1 ? '·连住' + (parseInt(lastStay.duration, 10) || 1) + '天' : '') + ')')
    : '—';
  document.getElementById('hotelsAvailable').textContent = names.length > 0
    ? availableCount + ' / ' + names.length
    : '—';
}

function renderHotelsCalendar() {
  var grid = document.getElementById('hotelsCalendarGrid');
  var title = document.getElementById('hotelsCalendarTitle');
  if (!grid) return;

  if (!hotelsCalendarYear || !hotelsCalendarMonth) {
    var now = new Date();
    hotelsCalendarYear = now.getFullYear();
    hotelsCalendarMonth = now.getMonth() + 1;
  }

  if (title) {
    title.textContent = hotelsCalendarYear + '年 ' + hotelsCalendarMonth + '月';
  }

  var firstDay = new Date(hotelsCalendarYear, hotelsCalendarMonth - 1, 1);
  var lastDay = new Date(hotelsCalendarYear, hotelsCalendarMonth, 0);
  var totalDays = lastDay.getDate();
  var startDow = firstDay.getDay();
  var todayStr = formatDate(new Date());

  var html = '<div class="hotels-weekday">日</div><div class="hotels-weekday">一</div><div class="hotels-weekday">二</div><div class="hotels-weekday">三</div><div class="hotels-weekday">四</div><div class="hotels-weekday">五</div><div class="hotels-weekday">六</div>';

  for (var j = 0; j < startDow; j++) {
    html += '<div class="hotels-day hotels-day-empty"></div>';
  }

  // 手机端空间有限，摘要最多显示 2 家；电脑端最多 3 家
  var maxShown = window.innerWidth < 480 ? 2 : 3;

  for (var d = 1; d <= totalDays; d++) {
    var dateStr = hotelsCalendarYear + '-' + String(hotelsCalendarMonth).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    var isToday = (dateStr === todayStr);
    var staysOnDate = hotelsMapByDate[dateStr];
    var hasCheckIn = staysOnDate && staysOnDate.length > 0;
    var stays = hasCheckIn ? staysOnDate : [];

    // 高亮选中酒店覆盖的日期（含连住延续日）
    var isHighlight = false;
    if (hotelsHighlightName && hotelsByName[hotelsHighlightName] && hotelsByName[hotelsHighlightName].dates[dateStr]) {
      isHighlight = true;
    }

    var cls = 'hotels-day';
    if (isToday) cls += ' hotels-day-today';
    if (hasCheckIn) cls += ' hotels-day-checkin';
    if (isHighlight) cls += ' hotels-day-highlight';

    html += '<div id="hcal_' + dateStr + '" class="' + cls + '" onclick="openHotelDayModal(\'' + dateStr + '\')" style="cursor:pointer;" title="' + (hasCheckIn ? ('当天入住 ' + stays.length + ' 家酒店，点击查看管理') : '点击查看当天入住记录') + '">';
    html += '<span class="hotels-day-num">' + d + '</span>';
    if (hasCheckIn) {
      // 每条记录单独一行：起始日显示酒店名 + 积分 + 到账状态（✓/✗）；连住延续日显示“续”标记，不重复计积分
      var shown = Math.min(stays.length, maxShown);
      for (var i = 0; i < shown; i++) {
        var st = stays[i];
        var isStart = normalizeDate(st.start_date) === dateStr;
        var pts = parseInt(st.points, 10) || 0;
        var rowCls = 'hotels-day-hotel-row';
        if (hotelsHighlightName && st.hotel_name === hotelsHighlightName) rowCls += ' hotels-day-hotel-row-selected';
        html += '<span class="' + rowCls + '" title="' + esc(st.hotel_name) + '">';
        html += '<span class="hotels-day-dot' + (st.is_credited ? ' hotels-day-dot-credited' : '') + '" style="background:' + hotelsDotColors[i % hotelsDotColors.length] + '"></span>';
        html += '<span class="hotels-day-hotel">' + esc(st.hotel_name) + '</span>';
        if (isStart) {
          html += '<span class="hotels-day-pts' + (st.is_credited ? '' : ' hotels-day-pts-uncredited') + '">' + pts + '分</span>';
          html += '<span class="hotels-day-cred' + (st.is_credited ? ' hotels-day-cred-yes' : '') + '">' + (st.is_credited ? '✓' : '✗') + '</span>';
        } else {
          html += '<span class="hotels-day-cont">续</span>';
        }
        if (i === maxShown - 1 && stays.length > maxShown) {
          html += '<span class="hotels-day-more">+' + (stays.length - maxShown) + '</span>';
        }
        html += '</span>';
      }
    }
    html += '</div>';
  }

  grid.innerHTML = html;
}

async function toggleHotelCredit(id, el) {
  var stay = null;
  for (var i = 0; i < hotelsCache.length; i++) {
    if (hotelsCache[i].id == id) { stay = hotelsCache[i]; break; }
  }
  if (!stay) return;
  var newVal = !stay.is_credited;
  if (el) el.disabled = true;
  try {
    await API.updateHotel(id, { is_credited: newVal });
    stay.is_credited = newVal;
    // 局部更新状态图标与文字，避免重建整个弹窗
    if (el) {
      el.textContent = newVal ? '✓' : '✗';
      el.className = 'hotels-day-list-status ' + (newVal ? 'hotels-status-yes' : 'hotels-status-no');
    }
    var label = document.getElementById('hstLabel_' + id);
    if (label) label.textContent = newVal ? '已到账' : '未到账';
    toast(newVal ? '已标记为到账 ✅' : '已标记为未到账');
  } catch (err) {
    toast('更新失败: ' + err.message, 'error');
  } finally {
    if (el) el.disabled = false;
  }
}

// 当天入住记录弹窗的来源日期：在弹窗内保存/删除后自动回到该列表
var hotelsDayModalSource = null;

// 点击日期方框：打开当天入住记录面板（列表 + 原地新增/编辑，单界面完成全部操作）
function openHotelDayModal(dateStr) {
  hotelsDayModalSource = dateStr;
  renderHotelDayPanel(dateStr);
}

function renderHotelDayPanel(dateStr) {
  var stays = hotelsMapByDate[dateStr] || [];
  // 当日新增积分：只统计当天开始入住的记录（延续记录不重复计积分）
  var totalPoints = 0;
  var hasStartToday = false;
  for (var i = 0; i < stays.length; i++) {
    if (normalizeDate(stays[i].start_date) === dateStr) {
      totalPoints += parseInt(stays[i].points, 10) || 0;
      hasStartToday = true;
    }
  }

  var html = '<div class="hotels-day-panel">';
  html += '<div class="hotels-day-panel-head">';
  html += '<h3>📅 ' + dateStr + ' 入住记录' + (stays.length > 0 ? ' <span class="hotels-day-list-count">共 ' + stays.length + ' 家</span>' : '') + '</h3>';
  html += '<button class="hotels-day-panel-close" onclick="closeModal()" title="关闭">✕</button>';
  html += '</div>';

  if (hasStartToday && totalPoints > 0) html += '<div class="hotels-day-list-total">当日新增 ' + totalPoints + ' 分</div>';

  // 已有记录列表（显示在表单上方）
  if (stays.length > 0) {
    html += '<div class="hotels-day-list">';
    for (var i = 0; i < stays.length; i++) {
      var s = stays[i];
      var pts = parseInt(s.points, 10) || 0;
      var statusCls = s.is_credited ? 'hotels-status-yes' : 'hotels-status-no';
      var statusText = s.is_credited ? '已到账' : '未到账';
      html += '<div class="hotels-day-list-item" id="hstRow_' + s.id + '">';
      html += '<div class="hotels-day-list-info">';
      html += '<div class="hotels-day-list-head">';
      html += '<span class="hotels-day-list-dot" style="background:' + hotelsDotColors[i % hotelsDotColors.length] + '"></span>';
      html += '<span class="hotels-day-list-name">' + esc(s.hotel_name) + '</span>';
      html += '<span class="hotels-day-list-points' + (pts > 0 ? '' : ' hotels-day-list-points-zero') + '">' + (pts > 0 ? pts + '分' : '0分') + '</span>';
      html += '</div>';
      html += '<div class="hotels-day-list-meta">';
      html += '<span class="hotels-day-list-status ' + statusCls + '" id="hstIcon_' + s.id + '" onclick="toggleHotelCredit(' + s.id + ', this)" title="点击切换到账状态">' + (s.is_credited ? '✓' : '✗') + '</span>';
      html += '<span class="hotels-day-list-label" id="hstLabel_' + s.id + '">' + statusText + '</span>';
      html += '<span class="hotels-day-list-dates">📅 ' + normalizeDate(s.start_date) + ' 入住' + ((parseInt(s.duration, 10) || 1) > 1 ? ' · 连住 ' + (parseInt(s.duration, 10) || 1) + ' 天' : '') + '</span>';
      html += '</div>';
      if (s.notes) html += '<div class="hotels-day-list-notes">📝 ' + esc(s.notes) + '</div>';
      html += '</div>';
      html += '<div class="hotels-day-list-actions">';
      html += '<button class="hotels-day-list-edit" onclick="hotelPanelEdit(' + s.id + ')">✏️ 编辑</button>';
      html += '<button class="hotels-day-list-del" onclick="deleteHotelStay(' + s.id + ')">🗑️ 删除</button>';
      html += '</div>';
      html += '</div>';
    }
    html += '</div>';
  }

  // 新增表单：始终显示（列表下方），填写保存后可继续添加
  html += '<div id="hotelPanelAddForm">' + hotelPanelFormHtml(null, dateStr) + '</div>';

  html += '<div class="modal-actions form-group-full"><button class="btn-cancel" onclick="closeModal()">关闭</button></div>';
  html += '</div>';

  openCustomModal(html);
}

// 内联表单 HTML（stay 为 null 表示新增，否则编辑）
function hotelPanelFormHtml(stay, defaultDate) {
  var isEdit = !!stay;
  var nameVal = isEdit ? esc(stay.hotel_name) : '';
  var dateVal = isEdit ? normalizeDate(stay.start_date) : (defaultDate || formatDate(new Date()));
  var durVal = isEdit ? (parseInt(stay.duration, 10) || 1) : 1;
  var ptsVal = isEdit ? (parseInt(stay.points, 10) || 0) : '';
  var credChecked = isEdit && stay.is_credited ? ' checked' : '';
  var notesVal = isEdit ? esc(stay.notes || '') : '';
  var idAttr = isEdit ? stay.id : '';
  var nameOnInput = isEdit ? '' : ' oninput="autoCheckHotel(this.value.trim())"';

  var html = '<div class="hotels-day-form">';
  html += '<div class="hotels-day-form-title">' + (isEdit ? '✏️ 编辑入住记录' : '🏨 新增入住记录') + '</div>';
  html += '<div class="modal-form-grid">';
  html += '<div class="form-group form-group-col"><label>酒店名称</label><input type="text" id="hHotelName" value="' + nameVal + '"' + nameOnInput + ' placeholder="如：全季酒店（北京国贸店）"></div>';
  html += '<div class="form-group form-group-col"><label>入住开始日期</label><input type="date" id="hCheckinDate" value="' + dateVal + '"></div>';
  html += '<div class="form-group form-group-col"><label>连住天数</label><input type="number" id="hDuration" min="1" max="30" value="' + durVal + '"><div class="form-help">连住 N 天，日历将连续标记 N 天</div></div>';
  html += '<div class="form-group form-group-col"><label>积分与到账</label><div class="hotel-points-credit-row">';
  html += '<input type="number" id="hPoints" min="0" value="' + ptsVal + '" placeholder="0" aria-label="积分数量">';
  html += '<label class="hotel-checkbox-inline" title="积分是否已到账"><input type="checkbox" id="hCredited"' + credChecked + '> 已到账</label>';
  html += '</div></div>';
  html += '<div class="form-group form-group-full"><label>备注（可选）</label><textarea id="hNotes" class="hotels-notes-input" rows="2" placeholder="如：华住会App预订，含早餐">' + notesVal + '</textarea></div>';
  html += '<div class="form-group form-group-full" id="hCheckWarning" style="display:none;padding:12px 16px;border-radius:8px;background:rgba(239,83,80,0.08);border:1px solid rgba(239,83,80,0.25);color:#ef5350;font-size:14px;"></div>';
  html += '<div class="modal-actions form-group-full">';
  html += '<button class="btn-cancel" onclick="cancelHotelPanelForm()">取消</button>';
  if (isEdit) html += '<button class="btn-danger" onclick="deleteHotelStay(' + idAttr + ')">删除</button>';
  html += '<button class="btn-submit" onclick="submitHotelPanelForm(' + (isEdit ? idAttr : 'null') + ')">' + (isEdit ? '保存修改' : '保存') + '</button>';
  html += '</div></div></div>';
  return html;
}

// 点击“编辑”：该记录在列表内原地展开编辑表单（同时收起底部新增表单，避免字段冲突）
function hotelPanelEdit(id) {
  var stay = null;
  for (var i = 0; i < hotelsCache.length; i++) {
    if (hotelsCache[i].id == id) { stay = hotelsCache[i]; break; }
  }
  if (!stay) { toast('记录不存在', 'error'); return; }
  var row = document.getElementById('hstRow_' + id);
  if (!row) return;
  var addForm = document.getElementById('hotelPanelAddForm');
  if (addForm) addForm.style.display = 'none';
  row.className = 'hotels-day-list-item hotels-day-list-item-editing';
  row.innerHTML = hotelPanelFormHtml(stay, null);
  setTimeout(function () {
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    var el = document.getElementById('hHotelName');
    if (el) el.focus();
  }, 60);
}

// 取消：收起表单，恢复列表显示
function cancelHotelPanelForm() {
  if (hotelsDayModalSource) renderHotelDayPanel(hotelsDayModalSource);
}

// 内联表单提交（id 为空表示新增，否则编辑）
async function submitHotelPanelForm(id) {
  var hotelNameEl = document.getElementById('hHotelName');
  var dateEl = document.getElementById('hCheckinDate');
  var durationEl = document.getElementById('hDuration');
  var pointsEl = document.getElementById('hPoints');
  var creditedEl = document.getElementById('hCredited');
  var notesEl = document.getElementById('hNotes');
  var hotelName = hotelNameEl ? hotelNameEl.value.trim() : '';
  var checkinDate = dateEl ? dateEl.value : '';
  var duration = durationEl ? (parseInt(durationEl.value, 10) || 1) : 1;
  if (duration < 1) duration = 1;
  var points = pointsEl ? pointsEl.value : '';
  var isCredited = creditedEl ? creditedEl.checked : false;
  var notes = notesEl ? notesEl.value : '';

  if (!hotelName) { toast('请输入酒店名称', 'error'); return; }
  if (!checkinDate) { toast('请选择入住日期', 'error'); return; }
  if (duration > 30) { toast('连住天数不能超过 30 天', 'error'); return; }

  // 新增时提交前检查冷却期
  if (!id) {
    try {
      var checkResult = await API.checkHotel(hotelName);
      if (!checkResult.can_check_in) {
        toast('该酒店在冷却期内（剩余 ' + checkResult.days_remaining + ' 天），无法入住', 'error');
        return;
      }
    } catch (err) {
      toast('检查酒店状态失败: ' + err.message, 'error');
      return;
    }
  }

  try {
    if (id) {
      await API.updateHotel(id, { hotel_name: hotelName, start_date: checkinDate, duration: duration, points: points, is_credited: isCredited, notes: notes });
      toast('入住记录已更新 ✏️');
    } else {
      await API.createHotel({ hotel_name: hotelName, start_date: checkinDate, duration: duration, points: points, is_credited: isCredited, notes: notes });
      toast(duration > 1 ? ('入住记录已添加，连住 ' + duration + ' 天 🏨') : '入住记录已添加 🏨');
    }
    // 保存成功后：刷新日历/统计/标签区，并自动关闭面板回到日历视图
    await loadHotels();
    closeModal();
  } catch (err) {
    // 保存失败：保持面板打开，并在表单内显示红色错误提示，便于修正后重新提交
    var warn = document.getElementById('hCheckWarning');
    if (warn) {
      warn.textContent = (id ? '更新失败: ' : '添加失败: ') + err.message;
      warn.style.display = 'block';
    }
    toast((id ? '更新失败: ' : '添加失败: ') + err.message, 'error');
  }
}

// 板块工具栏“+ 记录入住”：直接新增（默认今天），不回到列表弹窗
function openHotelAddFromToolbar() {
  hotelsDayModalSource = null;
  openHotelFormModal('create', null, null);
}

async function hotelsPrevMonth() {
  hotelsCalendarMonth--;
  if (hotelsCalendarMonth < 1) { hotelsCalendarMonth = 12; hotelsCalendarYear--; }
  renderHotelsCalendar();
  await loadHotels();
}

async function hotelsNextMonth() {
  hotelsCalendarMonth++;
  if (hotelsCalendarMonth > 12) { hotelsCalendarMonth = 1; hotelsCalendarYear++; }
  renderHotelsCalendar();
  await loadHotels();
}

async function hotelsGoToToday() {
  var now = new Date();
  hotelsCalendarYear = now.getFullYear();
  hotelsCalendarMonth = now.getMonth() + 1;
  renderHotelsCalendar();
  await loadHotels();
}

// 统一弹窗：mode = 'create'（新增）| 'edit'（编辑）
function openHotelFormModal(mode, stay, defaultDate) {
  mode = mode || 'create';
  var isEdit = mode === 'edit';
  var title = isEdit ? '✏️ 编辑入住记录' : '🏨 添加入住记录';
  var nameVal = isEdit ? esc(stay.hotel_name) : '';
  var dateVal = isEdit ? normalizeDate(stay.start_date) : (defaultDate || formatDate(new Date()));
  var durVal = isEdit ? (parseInt(stay.duration, 10) || 1) : 1;
  var ptsVal = isEdit ? (parseInt(stay.points, 10) || 0) : '';
  var credChecked = isEdit && stay.is_credited ? ' checked' : '';
  var notesVal = isEdit ? esc(stay.notes || '') : '';
  var idAttr = isEdit ? stay.id : '';

  var html =
    '<h3>' + title + '</h3>' +
    '<div class="modal-form-grid">' +
    '<div class="form-group form-group-col"><label>酒店名称</label><input type="text" id="hHotelName" value="' + nameVal + '" placeholder="如：全季酒店（北京国贸店）"></div>' +
    '<div class="form-group form-group-col"><label>入住开始日期</label><input type="date" id="hCheckinDate" value="' + dateVal + '"></div>' +
    '<div class="form-group form-group-col"><label>连住天数</label><input type="number" id="hDuration" min="1" max="30" value="' + durVal + '"><div class="form-help">连住 N 天，日历将连续标记 N 天</div></div>' +
    '<div class="form-group form-group-col"><label>积分与到账</label>' +
    '<div class="hotel-points-credit-row">' +
    '<input type="number" id="hPoints" min="0" value="' + ptsVal + '" placeholder="0" aria-label="积分数量">' +
    '<label class="hotel-checkbox-inline" title="积分是否已到账"><input type="checkbox" id="hCredited"' + credChecked + '> 已到账</label>' +
    '</div></div>' +
    '<div class="form-group form-group-full"><label>备注（可选）</label><textarea id="hNotes" class="hotels-notes-input" rows="2" placeholder="如：华住会App预订，含早餐">' + notesVal + '</textarea></div>' +
    '<div class="form-group form-group-full" id="hCheckWarning" style="display:none;padding:12px 16px;border-radius:8px;background:rgba(239,83,80,0.08);border:1px solid rgba(239,83,80,0.25);color:#ef5350;font-size:14px;"></div>' +
    '<div class="modal-actions form-group-full">' +
    '<button class="btn-cancel" onclick="closeModal()">取消</button>' +
    (isEdit ? '<button class="btn-danger" onclick="deleteHotelStay(' + idAttr + ')">删除</button>' : '') +
    '<button class="btn-submit" onclick="submitHotelSave(' + (isEdit ? idAttr : 'null') + ')">' + (isEdit ? '保存修改' : '提交入住') + '</button>' +
    '</div></div>';

  openCustomModal(html);
  setTimeout(function () {
    var el = document.getElementById('hHotelName');
    if (el) el.focus();
  }, 100);

  // 酒店名称改变时自动检查冷却期（仅新增时适用，编辑已有记录不提示）
  if (!isEdit) {
    var nameInput = document.getElementById('hHotelName');
    if (nameInput) {
      nameInput.addEventListener('input', function () {
        autoCheckHotel(nameInput.value.trim());
      });
      if (nameVal) autoCheckHotel(nameVal);
    }
  }
}

async function autoCheckHotel(name) {
  var warningEl = document.getElementById('hCheckWarning');
  if (!warningEl || !name) {
    if (warningEl) warningEl.style.display = 'none';
    return;
  }

  try {
    var result = await API.checkHotel(name);
    if (!result.exists) {
      warningEl.style.display = 'none';
    } else if (!result.can_check_in) {
      warningEl.style.display = 'block';
      warningEl.textContent = '⚠️ 该酒店在冷却期内（剩余 ' + result.days_remaining + ' 天），无法入住';
    } else {
      warningEl.style.display = 'block';
      warningEl.style.background = 'rgba(76,175,80,0.08)';
      warningEl.style.borderColor = 'rgba(76,175,80,0.25)';
      warningEl.style.color = '#4caf50';
      warningEl.textContent = '✅ 冷却期已过，可以入住！';
    }
  } catch (e) {
    // 静默处理
  }
}

// 保存：id 为空表示新增，否则为编辑
async function submitHotelSave(id) {
  var hotelNameEl = document.getElementById('hHotelName');
  var dateEl = document.getElementById('hCheckinDate');
  var durationEl = document.getElementById('hDuration');
  var pointsEl = document.getElementById('hPoints');
  var creditedEl = document.getElementById('hCredited');
  var notesEl = document.getElementById('hNotes');
  var hotelName = hotelNameEl ? hotelNameEl.value.trim() : '';
  var checkinDate = dateEl ? dateEl.value : '';
  var duration = durationEl ? (parseInt(durationEl.value, 10) || 1) : 1;
  if (duration < 1) duration = 1;
  var points = pointsEl ? pointsEl.value : '';
  var isCredited = creditedEl ? creditedEl.checked : false;
  var notes = notesEl ? notesEl.value : '';

  if (!hotelName) { toast('请输入酒店名称', 'error'); return; }
  if (!checkinDate) { toast('请选择入住日期', 'error'); return; }
  if (duration > 30) { toast('连住天数不能超过 30 天', 'error'); return; }

  if (!id) {
    // 新增时提交前检查冷却期
    try {
      var checkResult = await API.checkHotel(hotelName);
      if (!checkResult.can_check_in) {
        toast('该酒店在冷却期内（剩余 ' + checkResult.days_remaining + ' 天），无法入住', 'error');
        return;
      }
    } catch (err) {
      toast('检查酒店状态失败: ' + err.message, 'error');
      return;
    }
  }

  try {
    if (id) {
      await API.updateHotel(id, { hotel_name: hotelName, start_date: checkinDate, duration: duration, points: points, is_credited: isCredited, notes: notes });
      toast('入住记录已更新 ✏️');
    } else {
      await API.createHotel({ hotel_name: hotelName, start_date: checkinDate, duration: duration, points: points, is_credited: isCredited, notes: notes });
      toast(duration > 1 ? ('入住记录已添加，连住 ' + duration + ' 天 🏨') : '入住记录已添加 🏨');
    }
    closeModal();
    await loadHotels();
    // 若从当天列表弹窗进入，保存后自动回到该列表
    if (hotelsDayModalSource) openHotelDayModal(hotelsDayModalSource);
  } catch (err) {
    toast((id ? '更新失败: ' : '添加失败: ') + err.message, 'error');
  }
}

async function deleteHotelStay(id) {
  if (!confirm('确定删除这条入住记录？删除后不可恢复。')) return;
  try {
    await API.deleteHotel(id);
    toast('入住记录已删除');
    closeModal();
    await loadHotels();
    // 若从当天列表弹窗进入，删除后自动回到该列表
    if (hotelsDayModalSource) openHotelDayModal(hotelsDayModalSource);
  } catch (err) {
    toast('删除失败: ' + err.message, 'error');
  }
}

async function searchHotel() {
  var input = document.getElementById('hotelSearchInput');
  var resultEl = document.getElementById('hotelSearchResult');
  var name = input.value.trim();

  if (!name) { toast('请输入酒店名称', 'error'); return; }

  try {
    var result = await API.checkHotel(name);
    resultEl.style.display = 'block';

    if (!result.exists) {
      resultEl.innerHTML = '<div class="hotels-search-result-item hotels-search-result-new">' +
        '<div class="hotels-search-result-icon">✅</div>' +
        '<div class="hotels-search-result-text">该酒店尚未入住过，可以预订！</div>' +
        '</div>';
      resultEl.style.background = 'rgba(76,175,80,0.08)';
      resultEl.style.borderColor = 'rgba(76,175,80,0.25)';
    } else if (result.can_check_in) {
      resultEl.innerHTML = '<div class="hotels-search-result-item hotels-search-result-ok">' +
        '<div class="hotels-search-result-icon">✅</div>' +
        '<div class="hotels-search-result-text">最近入住：' + result.last_check_in + (result.last_duration > 1 ? '（连住' + result.last_duration + '天）' : '') + '，<span style="color:#4caf50;font-weight:600;">可入住</span></div>' +
        '</div>';
      resultEl.style.background = 'rgba(76,175,80,0.08)';
      resultEl.style.borderColor = 'rgba(76,175,80,0.25)';
    } else {
      resultEl.innerHTML = '<div class="hotels-search-result-item hotels-search-result-cooling">' +
        '<div class="hotels-search-result-icon">⏳</div>' +
        '<div class="hotels-search-result-text">最近入住：' + result.last_check_in + (result.last_duration > 1 ? '（连住' + result.last_duration + '天）' : '') + '，<span style="color:#ef5350;font-weight:600;">剩余 ' + result.days_remaining + ' 天</span>（冷却期至 ' + result.cooling_until + '）</div>' +
        '</div>';
      resultEl.style.background = 'rgba(239,83,80,0.08)';
      resultEl.style.borderColor = 'rgba(239,83,80,0.25)';
    }
  } catch (err) {
    toast('查询失败: ' + err.message, 'error');
  }
}
