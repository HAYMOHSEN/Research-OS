/* =========================================================
   Research OS — application logic
   Vanilla JS, no dependencies. All data lives in localStorage.
   ========================================================= */
(() => {
  'use strict';

  const APP_VERSION = '1.0.0';
  const STORAGE_KEY = 'researchos.v1';
  const LEGACY_KEY = 'academic_research_os';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ---------------------------------------------------------------- dates
  const pad = (n) => String(n).padStart(2, '0');
  const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const daysBetween = (fromKey, toKey) => Math.round((parseKey(toKey) - parseKey(fromKey)) / 86400000);
  const isDateKey = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(parseKey(s).getTime());
  const LOCALE = (() => {
    try {
      const l = navigator.language || 'en-US';
      return l.toLowerCase().startsWith('en') && Intl.DateTimeFormat.supportedLocalesOf([l]).length ? l : 'en-US';
    } catch (e) { return 'en-US'; }
  })();
  const fmtDate = (key, opts = { month: 'short', day: 'numeric' }) => parseKey(key).toLocaleDateString(LOCALE, opts);

  const uid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  const clamp = (n, lo, hi, fallback) => { n = Number(n); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback; };

  // ---------------------------------------------------------------- state
  const DEFAULT_SETTINGS = {
    name: '', focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longBreakEvery: 4,
    autoStartBreaks: false, autoStartFocus: false, sound: true, notifications: false,
    theme: 'system', welcomeDismissed: false,
  };
  const PRIORITIES = ['high', 'medium', 'low'];
  const PRIORITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };
  const MODE_LABEL = { focus: 'Focus', short: 'Short break', long: 'Long break' };

  const freshState = () => ({
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    tasks: [], habits: [], sessions: [],
    stats: { tasksCompletedTotal: 0 },
    timer: { mode: 'focus', running: false, endAt: null, remainingMs: 25 * 60000, cycle: 0 },
    filter: 'all',
  });

  let state = freshState();
  let saveFailedOnce = false;

  function normalizeState(raw) {
    const s = freshState();
    if (!raw || typeof raw !== 'object') return s;
    const rs = raw.settings || {};
    s.settings = {
      name: typeof rs.name === 'string' ? rs.name.slice(0, 40) : '',
      focusMin: clamp(rs.focusMin, 1, 180, 25),
      shortBreakMin: clamp(rs.shortBreakMin, 1, 60, 5),
      longBreakMin: clamp(rs.longBreakMin, 1, 120, 15),
      longBreakEvery: clamp(rs.longBreakEvery, 1, 12, 4),
      autoStartBreaks: !!rs.autoStartBreaks,
      autoStartFocus: !!rs.autoStartFocus,
      sound: rs.sound !== false,
      notifications: !!rs.notifications,
      theme: ['system', 'light', 'dark'].includes(rs.theme) ? rs.theme : 'system',
      welcomeDismissed: !!rs.welcomeDismissed,
    };
    s.tasks = Array.isArray(raw.tasks) ? raw.tasks.filter(t => t && typeof t.text === 'string' && t.text.trim()).map(t => ({
      id: typeof t.id === 'string' ? t.id : uid(),
      text: t.text.trim().slice(0, 200),
      priority: PRIORITIES.includes(t.priority) ? t.priority : 'medium',
      due: isDateKey(t.due) ? t.due : null,
      done: !!t.done,
      createdAt: Number.isFinite(t.createdAt) ? t.createdAt : Date.now(),
      completedAt: Number.isFinite(t.completedAt) ? t.completedAt : (t.done ? Date.now() : null),
    })) : [];
    s.habits = Array.isArray(raw.habits) ? raw.habits.filter(h => h && typeof h.text === 'string' && h.text.trim()).map(h => ({
      id: typeof h.id === 'string' ? h.id : uid(),
      text: h.text.trim().slice(0, 120),
      history: Array.from(new Set((Array.isArray(h.history) ? h.history : []).filter(isDateKey))).sort(),
      createdAt: Number.isFinite(h.createdAt) ? h.createdAt : Date.now(),
    })) : [];
    s.sessions = Array.isArray(raw.sessions) ? raw.sessions.filter(x => x && isDateKey(x.date)).map(x => ({
      date: x.date, minutes: clamp(x.minutes, 1, 600, 25), endedAt: Number.isFinite(x.endedAt) ? x.endedAt : parseKey(x.date).getTime(),
    })) : [];
    s.stats.tasksCompletedTotal = clamp(raw.stats && raw.stats.tasksCompletedTotal, 0, 1e9, 0);
    const rt = raw.timer || {};
    s.timer = {
      mode: ['focus', 'short', 'long'].includes(rt.mode) ? rt.mode : 'focus',
      running: !!rt.running,
      endAt: Number.isFinite(rt.endAt) ? rt.endAt : null,
      remainingMs: Number.isFinite(rt.remainingMs) ? Math.max(0, rt.remainingMs) : null,
      cycle: clamp(rt.cycle, 0, 1e6, 0),
    };
    if (s.timer.remainingMs === null) s.timer.remainingMs = durationMsFor(s.timer.mode, s.settings);
    s.filter = ['all', 'active', 'done'].includes(raw.filter) ? raw.filter : 'all';
    return s;
  }

  function migrateLegacy(raw) {
    // The original single-file prototype stored data under a different key.
    if (!raw || typeof raw !== 'object') return null;
    const tasks = (raw.tasks || []).map(t => ({ id: String(t.id), text: t.text, done: !!t.done, priority: 'medium', due: null, createdAt: Date.now() }));
    const habits = (raw.habits || []).map(h => ({ id: String(h.id), text: h.text, history: isDateKey(normalizeLooseKey(h.doneDate)) ? [normalizeLooseKey(h.doneDate)] : [] }));
    return { tasks, habits, stats: { tasksCompletedTotal: raw.stats ? raw.stats.tasksCompletedTotal : 0 } };
  }
  function normalizeLooseKey(k) {
    if (typeof k !== 'string') return null;
    const m = k.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    return m ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : null;
  }

  function load() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) { state = normalizeState(JSON.parse(saved)); return; }
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) { state = normalizeState(migrateLegacy(JSON.parse(legacy))); save(); return; }
    } catch (e) { console.warn('Could not read saved data', e); }
    state = freshState();
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      saveFailedOnce = false;
    } catch (e) {
      console.error('Save failed', e);
      if (!saveFailedOnce) {
        saveFailedOnce = true;
        toast({ kind: 'error', title: 'Could not save', text: 'Your changes could not be stored on this device. Check free disk space or browser storage settings.', sticky: true });
      }
    }
  }

  // ---------------------------------------------------------------- helpers
  function durationMsFor(mode, settings = state.settings) {
    const min = mode === 'focus' ? settings.focusMin : mode === 'short' ? settings.shortBreakMin : settings.longBreakMin;
    return min * 60000;
  }
  const fmtMinutes = (m) => {
    m = Math.round(m);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h}h ${r}m` : `${h}h`;
  };
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

  function computeStreak(history) {
    const set = new Set(history);
    const today = dateKey();
    let cursor = set.has(today) ? today : dateKey(addDays(new Date(), -1));
    if (!set.has(cursor)) return 0;
    let n = 0;
    while (set.has(cursor)) { n++; cursor = dateKey(addDays(parseKey(cursor), -1)); }
    return n;
  }
  function longestRun(history) {
    const keys = Array.from(new Set(history)).sort();
    let best = 0, run = 0, prev = null;
    for (const k of keys) {
      run = (prev && daysBetween(prev, k) === 1) ? run + 1 : 1;
      best = Math.max(best, run); prev = k;
    }
    return best;
  }

  function icon(name, cls = 'icon') {
    return `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  }

  // ---------------------------------------------------------------- toasts
  const toastsEl = $('#toasts');
  function toast({ kind = '', title, text = '', sticky = false, timeout = 5000, actions = [], iconName = null }) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`.trim();
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    const ic = iconName || (kind === 'success' ? 'circle-check-big' : kind === 'error' ? 'circle-alert' : kind === 'warn' ? 'triangle-alert' : kind === 'timer' ? 'timer' : 'info');
    el.innerHTML = `${icon(ic)}<div class="toast-body"><div class="toast-title"></div><div class="toast-text"></div></div><button type="button" class="btn-icon toast-close" aria-label="Dismiss">${icon('x')}</button>`;
    $('.toast-title', el).textContent = title;
    const textEl = $('.toast-text', el);
    if (text) textEl.textContent = text; else textEl.remove();
    if (actions.length) {
      const row = document.createElement('div');
      row.className = 'toast-actions';
      for (const a of actions) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = `btn ${a.primary ? 'btn-accent' : ''}`.trim(); b.textContent = a.label;
        b.addEventListener('click', () => { try { a.onClick && a.onClick(); } finally { dismiss(); } });
        row.appendChild(b);
      }
      $('.toast-body', el).appendChild(row);
    }
    const dismiss = () => { if (el.parentNode) el.remove(); };
    $('.toast-close', el).addEventListener('click', dismiss);
    while (toastsEl.children.length >= 4) toastsEl.firstElementChild.remove();
    toastsEl.appendChild(el);
    if (!sticky) setTimeout(dismiss, timeout);
    return dismiss;
  }

  // ---------------------------------------------------------------- confirm dialog
  const confirmDialog = $('#confirm-dialog');
  function confirmAction({ title = 'Are you sure?', message = '', okLabel = 'Confirm', danger = false } = {}) {
    return new Promise((resolve) => {
      $('#confirm-title').textContent = title;
      $('#confirm-message').textContent = message;
      const ok = $('#confirm-ok'), cancel = $('#confirm-cancel');
      ok.textContent = okLabel;
      ok.className = `btn ${danger ? 'btn-danger' : 'btn-accent'}`;
      const done = (v) => { cleanup(); if (confirmDialog.open) confirmDialog.close(); resolve(v); };
      const onOk = () => done(true), onCancel = () => done(false), onCancelEvt = (e) => { e.preventDefault(); done(false); };
      const onClick = (e) => { if (e.target === confirmDialog) done(false); };
      function cleanup() {
        ok.removeEventListener('click', onOk); cancel.removeEventListener('click', onCancel);
        confirmDialog.removeEventListener('cancel', onCancelEvt); confirmDialog.removeEventListener('click', onClick);
      }
      ok.addEventListener('click', onOk); cancel.addEventListener('click', onCancel);
      confirmDialog.addEventListener('cancel', onCancelEvt); confirmDialog.addEventListener('click', onClick);
      confirmDialog.showModal();
      cancel.focus();
    });
  }

  // ---------------------------------------------------------------- theme
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  function resolvedTheme() {
    const t = state.settings.theme;
    return t === 'system' ? (media.matches ? 'dark' : 'light') : t;
  }
  function applyTheme() {
    const t = resolvedTheme();
    document.documentElement.dataset.theme = t;
    $('#meta-theme-color').setAttribute('content', t === 'dark' ? '#202020' : '#f3f3f3');
    $('#theme-icon-use').setAttribute('href', t === 'dark' ? '#i-sun' : '#i-moon');
    const btn = $('#btn-theme');
    const label = t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    btn.title = label; btn.setAttribute('aria-label', label);
    $$('#theme-seg input').forEach(r => { r.checked = r.value === state.settings.theme; });
  }
  media.addEventListener('change', () => { if (state.settings.theme === 'system') applyTheme(); });

  // ---------------------------------------------------------------- greeting & summary
  function renderHeader() {
    const now = new Date();
    const h = now.getHours();
    const part = h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const name = state.settings.name.trim();
    $('#greeting').textContent = name ? `${part}, ${name}` : part;
    $('#today-label').textContent = now.toLocaleDateString(LOCALE, { weekday: 'long', month: 'long', day: 'numeric' });

    const today = dateKey();
    const active = state.tasks.filter(t => !t.done);
    const dueToday = active.filter(t => t.due === today).length;
    const overdue = active.filter(t => t.due && t.due < today).length;
    const habitsDone = state.habits.filter(hb => hb.history.includes(today)).length;
    const parts = [now.toLocaleDateString(LOCALE, { weekday: 'long', month: 'long', day: 'numeric' })];
    if (!state.tasks.length && !state.habits.length) parts.push('Here is your research focus for today.');
    else {
      parts.push(active.length ? plural(active.length, 'open task') : 'All tasks done');
      if (dueToday) parts.push(`${dueToday} due today`);
      if (overdue) parts.push(`${overdue} overdue`);
      if (state.habits.length) parts.push(`${habitsDone} of ${state.habits.length} habits done`);
    }
    $('#summary').textContent = parts.join(' · ');
    $('#welcome').hidden = state.settings.welcomeDismissed;
  }

  // ---------------------------------------------------------------- tasks
  const taskList = $('#task-list');
  let editingId = null;

  function sortedTasks() {
    const w = { high: 0, medium: 1, low: 2 };
    return state.tasks.slice().sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if (a.done) return (b.completedAt || 0) - (a.completedAt || 0);
      if (w[a.priority] !== w[b.priority]) return w[a.priority] - w[b.priority];
      if (a.due !== b.due) { if (!a.due) return 1; if (!b.due) return -1; return a.due < b.due ? -1 : 1; }
      return a.createdAt - b.createdAt;
    });
  }

  function dueInfo(task) {
    if (!task.due) return null;
    const today = dateKey();
    const diff = daysBetween(today, task.due);
    if (task.done) return { label: fmtDate(task.due), cls: '', iconName: 'calendar' };
    if (diff < 0) return { label: `Overdue · ${fmtDate(task.due)}`, cls: 'due-overdue', iconName: 'circle-alert' };
    if (diff === 0) return { label: 'Due today', cls: 'due-today', iconName: 'calendar' };
    if (diff === 1) return { label: 'Tomorrow', cls: '', iconName: 'calendar' };
    const sameYear = parseKey(task.due).getFullYear() === new Date().getFullYear();
    return { label: fmtDate(task.due, sameYear ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }), cls: '', iconName: 'calendar' };
  }

  function taskRow(task) {
    const el = document.createElement('div');
    el.className = `task${task.done ? ' is-done' : ''}`;
    el.setAttribute('role', 'listitem');
    el.dataset.id = task.id;
    if (editingId === task.id) {
      el.innerHTML = `
        <input type="checkbox" class="check" aria-label="Mark as done">
        <div class="task-main">
          <input type="text" class="input task-edit" maxlength="200" aria-label="Task text">
          <div class="task-meta">
            <select class="input prio-select" aria-label="Priority">
              <option value="high">High priority</option><option value="medium">Medium priority</option><option value="low">Low priority</option>
            </select>
            <input type="date" class="input prio-select" aria-label="Due date">
            <button type="button" class="btn btn-accent" data-act="save" style="height:28px">Save</button>
            <button type="button" class="btn btn-subtle" data-act="cancel" style="height:28px">Cancel</button>
          </div>
        </div>`;
      $('.check', el).checked = task.done;
      $('.task-edit', el).value = task.text;
      $('select', el).value = task.priority;
      $('input[type=date]', el).value = task.due || '';
      return el;
    }
    el.innerHTML = `
      <input type="checkbox" class="check" aria-label="Mark as done">
      <div class="task-main">
        <span class="task-text" title="Double-click to edit"></span>
        <div class="task-meta">
          <span class="meta prio"><i class="dot"></i><span class="prio-label"></span></span>
          <span class="meta due" hidden></span>
        </div>
      </div>
      <div class="task-actions">
        <button type="button" class="btn-icon" data-act="edit" title="Edit" aria-label="Edit task">${icon('pencil')}</button>
        <button type="button" class="btn-icon danger" data-act="delete" title="Delete" aria-label="Delete task">${icon('trash-2')}</button>
      </div>`;
    $('.check', el).checked = task.done;
    $('.task-text', el).textContent = task.text;
    $('.dot', el).classList.add(`p-${task.priority}`);
    $('.prio-label', el).textContent = PRIORITY_LABEL[task.priority];
    const due = dueInfo(task);
    if (due) {
      const d = $('.due', el);
      d.hidden = false; d.className = `meta due ${due.cls}`.trim();
      d.innerHTML = `${icon(due.iconName)}<span></span>`;
      $('span', d).textContent = due.label;
    }
    return el;
  }

  function renderTasks() {
    const all = sortedTasks();
    const shown = all.filter(t => state.filter === 'all' || (state.filter === 'active' ? !t.done : t.done));
    taskList.innerHTML = '';
    for (const t of shown) taskList.appendChild(taskRow(t));
    const done = all.filter(t => t.done).length;
    $('#task-progress').textContent = `${done}/${all.length} done`;
    const empty = $('#tasks-empty');
    empty.hidden = shown.length > 0;
    $('#tasks-empty-text').textContent = all.length === 0
      ? 'No tasks yet. Add the first thing you need to get done.'
      : state.filter === 'done' ? 'Nothing completed yet — finish a task and it will appear here.' : 'Everything is done. Enjoy the quiet.';
    const foot = $('#tasks-foot');
    foot.hidden = done === 0;
    $('#tasks-foot-text').textContent = `${plural(done, 'completed task')} · ${plural(state.stats.tasksCompletedTotal, 'task')} completed all-time`;
    $$('#task-filters .chip').forEach(c => { const on = c.dataset.filter === state.filter; c.classList.toggle('is-active', on); c.setAttribute('aria-pressed', String(on)); });
    taskList.classList.toggle('has-scroll', taskList.scrollHeight > taskList.clientHeight);
    const focusEdit = $('.task-edit', taskList);
    if (focusEdit) { focusEdit.focus(); focusEdit.setSelectionRange(focusEdit.value.length, focusEdit.value.length); }
  }

  function addTask(text, priority, due) {
    if (state.filter === 'done') state.filter = 'all';
    state.tasks.push({ id: uid(), text, priority, due: due || null, done: false, createdAt: Date.now(), completedAt: null });
    save(); renderTasks(); renderHeader();
  }
  function toggleTask(id) {
    const t = state.tasks.find(x => x.id === id);
    if (!t) return;
    t.done = !t.done;
    t.completedAt = t.done ? Date.now() : null;
    if (t.done) state.stats.tasksCompletedTotal += 1;
    else state.stats.tasksCompletedTotal = Math.max(0, state.stats.tasksCompletedTotal - 1);
    save(); renderTasks(); renderHeader(); renderInsights();
  }
  function deleteTask(id) {
    state.tasks = state.tasks.filter(x => x.id !== id);
    if (editingId === id) editingId = null;
    save(); renderTasks(); renderHeader();
  }
  function saveEdit(id, row) {
    const t = state.tasks.find(x => x.id === id);
    if (!t) return;
    const text = $('.task-edit', row).value.trim();
    if (!text) { deleteTask(id); return; }
    t.text = text.slice(0, 200);
    t.priority = $('select', row).value;
    const due = $('input[type=date]', row).value;
    t.due = isDateKey(due) ? due : null;
    editingId = null;
    save(); renderTasks(); renderHeader();
  }

  $('#task-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#task-input');
    const text = input.value.trim();
    if (!text) return;
    const priority = ($('#task-form input[name=priority]:checked') || {}).value || 'medium';
    const due = $('#task-due').value;
    addTask(text, PRIORITIES.includes(priority) ? priority : 'medium', isDateKey(due) ? due : null);
    input.value = ''; $('#task-due').value = '';
    $('#task-form input[name=priority][value=medium]').checked = true;
    input.focus();
  });
  taskList.addEventListener('change', (e) => {
    if (e.target.classList.contains('check')) { const row = e.target.closest('.task'); if (row && editingId !== row.dataset.id) toggleTask(row.dataset.id); }
  });
  taskList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const row = btn.closest('.task'); const id = row.dataset.id;
    switch (btn.dataset.act) {
      case 'edit': editingId = id; renderTasks(); break;
      case 'delete': deleteTask(id); break;
      case 'save': saveEdit(id, row); break;
      case 'cancel': editingId = null; renderTasks(); break;
    }
  });
  taskList.addEventListener('dblclick', (e) => {
    const txt = e.target.closest('.task-text'); if (!txt) return;
    editingId = txt.closest('.task').dataset.id; renderTasks();
  });
  taskList.addEventListener('keydown', (e) => {
    const row = e.target.closest('.task'); if (!row || editingId !== row.dataset.id) return;
    if (e.key === 'Enter' && e.target.classList.contains('task-edit')) { e.preventDefault(); saveEdit(row.dataset.id, row); }
    if (e.key === 'Escape') { e.preventDefault(); editingId = null; renderTasks(); }
  });
  $('#task-filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip'); if (!chip) return;
    state.filter = chip.dataset.filter; save(); renderTasks();
  });
  $('#btn-clear-done').addEventListener('click', async () => {
    const n = state.tasks.filter(t => t.done).length;
    if (!n) return;
    if (await confirmAction({ title: 'Clear completed tasks?', message: `${plural(n, 'completed task')} will be removed from the list. Your all-time completed count is kept.`, okLabel: 'Clear' })) {
      state.tasks = state.tasks.filter(t => !t.done); save(); renderTasks(); renderHeader();
    }
  });

  // ---------------------------------------------------------------- habits
  const habitList = $('#habit-list');
  const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function habitCard(habit) {
    const today = dateKey();
    const doneToday = habit.history.includes(today);
    const streak = computeStreak(habit.history);
    const el = document.createElement('div');
    el.className = `habit${doneToday ? ' is-done' : ''}`;
    el.setAttribute('role', 'listitem');
    el.dataset.id = habit.id;
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = addDays(new Date(), -i); const k = dateKey(d);
      const on = habit.history.includes(k);
      days.push(`<i class="day${on ? ' on' : ''}${i === 0 ? ' today' : ''}" title="${DAY_SHORT[d.getDay()]} ${fmtDate(k)}${on ? ' · done' : ''}"></i>`);
    }
    el.innerHTML = `
      <div class="habit-top">
        <span class="habit-name"></span>
        <button type="button" class="btn-icon habit-del" data-act="delete" title="Remove habit" aria-label="Remove habit">${icon('x')}</button>
      </div>
      <div class="habit-days" aria-label="Last 7 days">${days.join('')}</div>
      <div class="habit-bottom">
        <span class="streak${streak >= 3 ? ' hot' : ''}">${icon('flame')}<span></span></span>
        <button type="button" class="habit-check${doneToday ? ' on' : ''}" data-act="toggle" aria-pressed="${doneToday}" title="${doneToday ? 'Done today — click to undo' : 'Mark done for today'}" aria-label="${doneToday ? 'Undo today' : 'Mark done for today'}">${icon('check')}</button>
      </div>`;
    $('.habit-name', el).textContent = habit.text;
    $('.streak span', el).textContent = streak ? `${streak}-day streak` : 'No streak yet';
    return el;
  }

  function renderHabits() {
    habitList.innerHTML = '';
    const sorted = state.habits.slice().sort((a, b) => a.createdAt - b.createdAt);
    for (const h of sorted) habitList.appendChild(habitCard(h));
    const today = dateKey();
    const done = state.habits.filter(h => h.history.includes(today)).length;
    $('#habit-progress').textContent = `${done}/${state.habits.length} today`;
    $('#habits-empty').hidden = state.habits.length > 0;
  }

  $('#habit-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#habit-input');
    const text = input.value.trim();
    if (!text) return;
    state.habits.push({ id: uid(), text: text.slice(0, 120), history: [], createdAt: Date.now() });
    input.value = '';
    save(); renderHabits(); renderHeader(); renderInsights();
  });
  habitList.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const id = btn.closest('.habit').dataset.id;
    const h = state.habits.find(x => x.id === id); if (!h) return;
    if (btn.dataset.act === 'toggle') {
      const today = dateKey();
      if (h.history.includes(today)) h.history = h.history.filter(k => k !== today);
      else { h.history.push(today); h.history.sort(); }
      save(); renderHabits(); renderHeader(); renderInsights();
    } else if (btn.dataset.act === 'delete') {
      const ok = h.history.length === 0 || await confirmAction({ title: 'Remove this habit?', message: `"${h.text}" and its ${plural(h.history.length, 'day')} of history will be removed.`, okLabel: 'Remove', danger: true });
      if (ok) { state.habits = state.habits.filter(x => x.id !== id); save(); renderHabits(); renderHeader(); renderInsights(); }
    }
  });

  // ---------------------------------------------------------------- timer
  const timerModule = $('.timer-module');
  const RING_C = 2 * Math.PI * 100;
  // The countdown is driven by a tiny Web Worker: window timers are heavily
  // throttled when the app is minimised, worker timers are not.
  let ticker = null;
  function startTicking() {
    stopTicking();
    try {
      const blob = new Blob(['setInterval(function(){postMessage(0)},250)'], { type: 'text/javascript' });
      const w = new Worker(URL.createObjectURL(blob));
      w.onmessage = tick;
      ticker = { stop: () => w.terminate() };
    } catch (e) {
      const h = setInterval(tick, 250);
      ticker = { stop: () => clearInterval(h) };
    }
  }
  function stopTicking() { if (ticker) { ticker.stop(); ticker = null; } }
  let lastShownSecond = null;
  const baseTitle = document.title;

  function remainingMs() {
    const t = state.timer;
    return t.running && t.endAt ? Math.max(0, t.endAt - Date.now()) : t.remainingMs;
  }

  function renderTimer() {
    const t = state.timer, s = state.settings;
    const total = durationMsFor(t.mode);
    const rem = remainingMs();
    const secs = Math.ceil(rem / 1000);
    const m = Math.floor(secs / 60), sec = secs % 60;
    $('#timer-display').textContent = `${pad(m)}:${pad(sec)}`;
    $('#timer-mode-label').textContent = MODE_LABEL[t.mode];
    timerModule.classList.remove('mode-focus', 'mode-short', 'mode-long');
    timerModule.classList.add(`mode-${t.mode}`);
    const frac = total > 0 ? Math.min(1, Math.max(0, rem / total)) : 0;
    const ring = $('#ring-fill');
    ring.style.strokeDashoffset = String(RING_C * frac);
    ring.classList.toggle('is-empty', frac >= 0.999);
    $$('#mode-tabs .seg-btn').forEach(b => { const on = b.dataset.mode === t.mode; b.classList.toggle('is-active', on); b.setAttribute('aria-selected', String(on)); });

    const every = s.longBreakEvery;
    let filled = t.cycle % every;
    if (t.cycle > 0 && filled === 0 && t.mode === 'long') filled = every;
    const dots = $('#cycle-dots');
    dots.innerHTML = Array.from({ length: every }, (_, i) => `<i class="${i < filled ? 'on' : ''}"></i>`).join('');
    dots.setAttribute('aria-label', `${filled} of ${every} focus sessions towards a long break`);

    const toggle = $('#btn-toggle');
    toggle.classList.toggle('is-running', t.running);
    $('#play-use').setAttribute('href', t.running ? '#i-pause' : '#i-play');
    toggle.setAttribute('aria-label', t.running ? 'Pause' : 'Start');
    toggle.title = t.running ? 'Pause (Space)' : 'Start (Space)';

    const status = $('#timer-status');
    if (t.running) status.textContent = t.mode === 'focus' ? 'Deep work in progress — stay with it.' : t.mode === 'short' ? 'Short break. Stand up, look away from the screen.' : 'Long break. Step away and recharge.';
    else if (rem < total) status.textContent = 'Paused.';
    else status.textContent = t.mode === 'focus' ? `Ready for ${s.focusMin} minutes of deep work.` : t.mode === 'short' ? `A ${s.shortBreakMin}-minute break is ready.` : `A ${s.longBreakMin}-minute long break is ready.`;

    document.title = t.running ? `${pad(m)}:${pad(sec)} · ${MODE_LABEL[t.mode]} — ${baseTitle}` : baseTitle;
  }

  function tick() {
    const t = state.timer;
    if (!t.running) return;
    const rem = remainingMs();
    const sec = Math.ceil(rem / 1000);
    if (sec !== lastShownSecond) { lastShownSecond = sec; renderTimer(); }
    if (rem <= 0) completeSession({ auto: true });
  }

  function startTimer() {
    const t = state.timer;
    if (t.running) return;
    if (t.remainingMs <= 0) t.remainingMs = durationMsFor(t.mode);
    t.endAt = Date.now() + t.remainingMs;
    t.running = true;
    save();
    warmAudio();
    startTicking();
    lastShownSecond = null;
    renderTimer();
  }
  function pauseTimer() {
    const t = state.timer;
    if (!t.running) return;
    t.remainingMs = remainingMs();
    t.running = false; t.endAt = null;
    stopTicking();
    save(); renderTimer();
  }
  function resetTimer() {
    pauseTimer();
    state.timer.remainingMs = durationMsFor(state.timer.mode);
    save(); renderTimer();
  }
  function setMode(mode) {
    if (state.timer.running) pauseTimer();
    state.timer.mode = mode;
    state.timer.remainingMs = durationMsFor(mode);
    save(); renderTimer();
  }
  function nextModeAfterFocus() {
    return (state.timer.cycle % state.settings.longBreakEvery === 0) ? 'long' : 'short';
  }
  function completeSession({ auto = true, offline = false } = {}) {
    const t = state.timer, s = state.settings;
    const wasFocus = t.mode === 'focus';
    stopTicking();
    if (wasFocus) {
      state.sessions.push({ date: dateKey(new Date(t.endAt || Date.now())), minutes: s.focusMin, endedAt: t.endAt || Date.now() });
      t.cycle += 1;
    }
    const next = wasFocus ? nextModeAfterFocus() : 'focus';
    t.running = false; t.endAt = null; t.mode = next; t.remainingMs = durationMsFor(next);
    save(); renderTimer(); renderInsights();

    const title = wasFocus ? 'Focus session complete' : 'Break is over';
    const body = offline
      ? (wasFocus ? `Your ${s.focusMin}-minute focus session finished while the app was closed — it has been logged.` : 'Your break ended while the app was closed.')
      : (wasFocus ? `${s.focusMin} minutes of deep work logged. Time for a ${next === 'long' ? 'long' : 'short'} break.` : 'Ready to dive back into your research?');
    if (!offline && s.sound) chime();
    toast({ kind: 'timer', title, text: body, sticky: true, actions: [{ label: next === 'focus' ? 'Start focus' : `Start ${next === 'long' ? 'long' : 'short'} break`, primary: true, onClick: () => startTimer() }] });
    if (!offline && s.notifications && !document.hasFocus()) showOSNotification(title, body);

    if (!offline && auto && ((wasFocus && s.autoStartBreaks) || (!wasFocus && s.autoStartFocus))) startTimer();
  }
  function skipSession() {
    const t = state.timer;
    const wasFocus = t.mode === 'focus';
    if (t.running) pauseTimer();
    t.mode = wasFocus ? 'short' : 'focus';
    t.remainingMs = durationMsFor(t.mode);
    save(); renderTimer();
  }

  $('#btn-toggle').addEventListener('click', () => state.timer.running ? pauseTimer() : startTimer());
  $('#btn-reset').addEventListener('click', resetTimer);
  $('#btn-skip').addEventListener('click', skipSession);
  $('#mode-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });

  // ---------------------------------------------------------------- sound
  let audioCtx = null;
  function warmAudio() {
    if (!state.settings.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* no audio */ }
  }
  function chime() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const now = audioCtx.currentTime;
      [659.25, 783.99, 1046.5].forEach((f, i) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        const t0 = now + i * 0.17;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.3);
        o.connect(g).connect(audioCtx.destination);
        o.start(t0); o.stop(t0 + 1.4);
      });
    } catch (e) { /* no audio */ }
  }
  window.addEventListener('pointerdown', warmAudio, { once: true, passive: true });

  // ---------------------------------------------------------------- notifications
  async function showOSNotification(title, body) {
    const opts = { body, icon: './icons/icon-192.png', badge: './icons/badge-96.png', tag: 'researchos-session', renotify: true, silent: !!state.settings.sound };
    try {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg && reg.showNotification) { await reg.showNotification(title, opts); return; }
      }
    } catch (e) { /* fall through */ }
    try { new Notification(title, opts); } catch (e) { /* unsupported */ }
  }
  function notificationHint() {
    if (!('Notification' in window)) return 'Notifications are not available in this environment.';
    if (Notification.permission === 'denied') return 'Notifications are blocked. Allow them for Research OS in Windows Settings › System › Notifications (or in your browser site settings).';
    if (state.settings.notifications && Notification.permission === 'granted') return 'You will be notified when the app is in the background.';
    return '';
  }
  async function setNotifications(on) {
    if (!on) { state.settings.notifications = false; save(); return; }
    if (!('Notification' in window)) { state.settings.notifications = false; save(); return; }
    let p = Notification.permission;
    if (p === 'default') { try { p = await Notification.requestPermission(); } catch (e) { p = 'denied'; } }
    state.settings.notifications = p === 'granted';
    save();
    if (p === 'granted') toast({ kind: 'success', title: 'Notifications on', text: 'You will get a Windows notification when a session ends and the app is in the background.' });
  }

  // ---------------------------------------------------------------- insights
  function renderInsights() {
    const today = dateKey();
    const todays = state.sessions.filter(x => x.date === today);
    $('#stat-sessions-today').textContent = String(todays.length);
    $('#stat-minutes-today').textContent = fmtMinutes(todays.reduce((a, x) => a + x.minutes, 0));
    $('#stat-tasks-total').textContent = String(state.stats.tasksCompletedTotal);
    const best = state.habits.reduce((m, h) => Math.max(m, longestRun(h.history)), 0);
    $('#stat-best-streak').textContent = best ? plural(best, 'day') : '—';

    const days = [];
    for (let i = 6; i >= 0; i--) { const d = addDays(new Date(), -i); days.push({ key: dateKey(d), d }); }
    const byDay = Object.create(null);
    for (const x of state.sessions) byDay[x.date] = (byDay[x.date] || 0) + x.minutes;
    const max = Math.max(1, ...days.map(x => byDay[x.key] || 0));
    const bars = $('#week-bars');
    bars.innerHTML = days.map(({ key, d }, i) => {
      const v = byDay[key] || 0;
      const h = v ? Math.max(6, Math.round((v / max) * 100)) : 0;
      const label = `${DAY_SHORT[d.getDay()]} ${fmtDate(key)} · ${v ? fmtMinutes(v) : 'no focus time'}`;
      return `<div class="bar${i === 6 ? ' today' : ''}${v ? '' : ' zero'}" tabindex="0" role="img" aria-label="${label}"><i style="height:${h}%"></i><span class="tip">${label}</span></div>`;
    }).join('');
    $('#week-days').innerHTML = days.map(({ d }, i) => `<span class="${i === 6 ? 'today' : ''}">${DAY_SHORT[d.getDay()].slice(0, 2)}</span>`).join('');
    const weekTotal = days.reduce((a, x) => a + (byDay[x.key] || 0), 0);
    $('#week-total').textContent = weekTotal ? `${fmtMinutes(weekTotal)} this week` : 'No sessions yet';
  }

  // ---------------------------------------------------------------- settings
  const settingsDialog = $('#settings-dialog');
  function openSettings() {
    const s = state.settings;
    $('#set-name').value = s.name;
    $('#set-focus').value = s.focusMin; $('#set-short').value = s.shortBreakMin; $('#set-long').value = s.longBreakMin; $('#set-every').value = s.longBreakEvery;
    $('#set-autobreak').checked = s.autoStartBreaks; $('#set-autofocus').checked = s.autoStartFocus;
    $('#set-sound').checked = s.sound; $('#set-notify').checked = s.notifications && (!('Notification' in window) || Notification.permission === 'granted');
    $('#notify-hint').textContent = notificationHint();
    $$('#theme-seg input').forEach(r => { r.checked = r.value === s.theme; });
    $('#app-version').textContent = APP_VERSION;
    if (!settingsDialog.open) settingsDialog.showModal();
  }
  function closeSettings() { if (settingsDialog.open) settingsDialog.close(); }
  $('#btn-settings').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', closeSettings);
  settingsDialog.addEventListener('click', (e) => { if (e.target === settingsDialog) closeSettings(); });

  $('#set-name').addEventListener('input', (e) => { state.settings.name = e.target.value.slice(0, 40); save(); renderHeader(); });

  function bindDuration(id, key, lo, hi, mode) {
    $(id).addEventListener('change', (e) => {
      const old = state.settings[key];
      const v = clamp(e.target.value, lo, hi, old);
      e.target.value = v;
      state.settings[key] = v;
      const t = state.timer;
      if (mode && t.mode === mode && !t.running) {
        const oldMs = old * 60000;
        t.remainingMs = (t.remainingMs === oldMs) ? v * 60000 : Math.min(t.remainingMs, v * 60000);
      }
      save(); renderTimer();
    });
  }
  bindDuration('#set-focus', 'focusMin', 1, 180, 'focus');
  bindDuration('#set-short', 'shortBreakMin', 1, 60, 'short');
  bindDuration('#set-long', 'longBreakMin', 1, 120, 'long');
  bindDuration('#set-every', 'longBreakEvery', 1, 12, null);

  $('#set-autobreak').addEventListener('change', (e) => { state.settings.autoStartBreaks = e.target.checked; save(); });
  $('#set-autofocus').addEventListener('change', (e) => { state.settings.autoStartFocus = e.target.checked; save(); });
  $('#set-sound').addEventListener('change', (e) => { state.settings.sound = e.target.checked; save(); if (e.target.checked) { warmAudio(); chime(); } });
  $('#set-notify').addEventListener('change', async (e) => {
    await setNotifications(e.target.checked);
    e.target.checked = state.settings.notifications;
    $('#notify-hint').textContent = notificationHint();
  });
  $('#theme-seg').addEventListener('change', (e) => { if (e.target.name === 'theme') { state.settings.theme = e.target.value; save(); applyTheme(); } });
  $('#btn-theme').addEventListener('click', () => { state.settings.theme = resolvedTheme() === 'dark' ? 'light' : 'dark'; save(); applyTheme(); });

  $('#welcome-dismiss').addEventListener('click', () => { state.settings.welcomeDismissed = true; save(); renderHeader(); });
  $('#welcome-settings').addEventListener('click', () => { state.settings.welcomeDismissed = true; save(); renderHeader(); openSettings(); setTimeout(() => $('#set-name').focus(), 50); });

  // ---------------------------------------------------------------- backup & restore
  function exportBackup() {
    const payload = { app: 'Research OS', version: APP_VERSION, exportedAt: new Date().toISOString(), state: { ...state, timer: undefined } };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `research-os-backup-${dateKey()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast({ kind: 'success', title: 'Backup exported', text: `${plural(state.tasks.length, 'task')}, ${plural(state.habits.length, 'habit')} and ${plural(state.sessions.length, 'session')} saved to your Downloads folder.` });
  }
  async function importBackup(file) {
    let data;
    try { data = JSON.parse(await file.text()); }
    catch (e) { toast({ kind: 'error', title: 'Not a valid backup', text: 'The file could not be read as a Research OS backup.' }); return; }
    const inner = data && data.state && typeof data.state === 'object' ? data.state : data;
    if (!inner || (!Array.isArray(inner.tasks) && !Array.isArray(inner.habits))) {
      toast({ kind: 'error', title: 'Not a valid backup', text: 'This file does not contain Research OS data.' }); return;
    }
    const incoming = normalizeState(inner);
    incoming.timer = state.timer; // keep the live timer
    const when = data.exportedAt ? new Date(data.exportedAt).toLocaleDateString(LOCALE, { year: 'numeric', month: 'short', day: 'numeric' }) : 'an unknown date';
    const ok = await confirmAction({
      title: 'Restore this backup?',
      message: `Backup from ${when}: ${plural(incoming.tasks.length, 'task')}, ${plural(incoming.habits.length, 'habit')}, ${plural(incoming.sessions.length, 'focus session')}. This replaces everything currently in the app.`,
      okLabel: 'Restore', danger: true,
    });
    if (!ok) return;
    if (state.timer.running) pauseTimer();
    state = incoming;
    save(); closeSettings(); renderAll();
    toast({ kind: 'success', title: 'Backup restored' });
  }
  $('#btn-export').addEventListener('click', exportBackup);
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) importBackup(f); e.target.value = ''; });
  $('#btn-reset-all').addEventListener('click', async () => {
    const ok = await confirmAction({ title: 'Erase all data?', message: 'All tasks, habits, focus history and settings on this PC will be deleted. This cannot be undone — export a backup first if you might need it.', okLabel: 'Erase everything', danger: true });
    if (!ok) return;
    if (state.timer.running) pauseTimer();
    try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(LEGACY_KEY); } catch (e) { /* ignore */ }
    state = freshState();
    save(); closeSettings(); renderAll();
    toast({ kind: 'success', title: 'All data erased' });
  });

  // ---------------------------------------------------------------- keyboard
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); settingsDialog.open ? closeSettings() : openSettings(); return; }
    if (typing || settingsDialog.open || confirmDialog.open) return;
    if (e.key === ' ' && tag !== 'button' && tag !== 'a') { e.preventDefault(); state.timer.running ? pauseTimer() : startTimer(); }
    else if (e.key === '/') { e.preventDefault(); $('#task-input').focus(); }
  });

  // ---------------------------------------------------------------- service worker
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
    if (!secure) return;
    window.addEventListener('load', async () => {
      try {
        const reg = await navigator.serviceWorker.register('./sw.js');
        const offerUpdate = (worker) => toast({
          kind: '', iconName: 'refresh-cw', title: 'Update ready', text: 'A new version of Research OS has been downloaded.', sticky: true,
          actions: [{ label: 'Restart now', primary: true, onClick: () => worker.postMessage({ type: 'SKIP_WAITING' }) }, { label: 'Later' }],
        });
        if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing; if (!nw) return;
          nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(nw); });
        });
        // Reload only when an UPDATED worker takes over, not on the very first install (clients.claim()).
        let hadController = !!navigator.serviceWorker.controller;
        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (!hadController) { hadController = true; return; }
          if (refreshing) return;
          refreshing = true; location.reload();
        });
      } catch (e) { console.warn('Service worker registration failed', e); }
    });
  }

  // ---------------------------------------------------------------- boot
  function renderAll() {
    applyTheme(); renderHeader(); renderTasks(); renderHabits(); renderTimer(); renderInsights();
  }

  function resumeTimer() {
    const t = state.timer;
    if (!t.running) return;
    if (t.endAt && t.endAt > Date.now()) {
      startTicking(); lastShownSecond = null;
    } else {
      completeSession({ auto: false, offline: true });
    }
  }

  function handleLaunchAction() {
    const params = new URLSearchParams(location.search);
    const action = params.get('action');
    if (!action) return;
    history.replaceState(null, '', location.pathname);
    if (action === 'focus') { if (!state.timer.running) { if (state.timer.mode !== 'focus') setMode('focus'); startTimer(); } }
    else if (action === 'add-task') { $('#task-input').focus(); }
  }

  load();
  renderAll();
  resumeTimer();
  handleLaunchAction();
  registerServiceWorker();

  // Re-render when the calendar day changes while the app stays open.
  let lastDay = dateKey();
  setInterval(() => { const k = dateKey(); if (k !== lastDay) { lastDay = k; renderAll(); } }, 60000);

  // Expose a tiny debug hook (harmless) for support.
  window.__researchOS = { version: APP_VERSION, export: () => JSON.parse(JSON.stringify(state)) };
})();
