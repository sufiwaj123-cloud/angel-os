/**
 * PROJECT ANGEL — PHASE 1 CLIENT-SIDE ENGINE
 * Pure vanilla ES6 module handling GIS OAuth, Drive v3 REST, Speech, and Gemini.
 */

// ---------------------------------------------------------------------------
// 1. STATE & SCHEMA
// ---------------------------------------------------------------------------
const APP_STORAGE_KEY = 'angel_local_meta';
const DRIVE_FILENAME = 'angel_data.json';

const defaultMemoryState = {
  version: '1.0',
  updatedAt: new Date().toISOString(),
  settings: {
    geminiApiKey: '',
    voiceName: '',
    wakeWordEnabled: true,
    clientId: ''
  },
  memory: {
    notes: [],
    tasks: [],
    research: [],
    conversations: []
  }
};

let appState = JSON.parse(JSON.stringify(defaultMemoryState));
let driveFileId = null;
let googleAccessToken = null;
let tokenClient = null;

// Speech Synthesis & Recognition handles
let recognition = null;
let synth = window.speechSynthesis;
let isListening = false;
let isHardwareMuted = false;
let selectedVoice = null;

// ---------------------------------------------------------------------------
// 2. DOM ELEMENT REFERENCES
// ---------------------------------------------------------------------------
const dom = {
  // Nav
  navBtns: document.querySelectorAll('.nav-btn'),
  views: document.querySelectorAll('.view-panel'),
  clock: document.getElementById('current-clock'),
  date: document.getElementById('system-date'),
  authBtn: document.getElementById('auth-btn'),
  quickMuteBtn: document.getElementById('quick-mute-btn'),
  mobileMicBtn: document.getElementById('mobile-mic-btn'),

  // Status badges
  driveStatusBadge: document.getElementById('drive-status-badge'),
  micStatusBadge: document.getElementById('mic-status-badge'),
  hudVoiceState: document.getElementById('hud-voice-state'),
  hudPulse: document.getElementById('hud-pulse'),

  // Telemetry
  statTasksCount: document.getElementById('stat-tasks-count'),
  statNotesCount: document.getElementById('stat-notes-count'),
  statSyncTime: document.getElementById('stat-sync-time'),
  homeTasksPreview: document.getElementById('home-tasks-preview'),

  // Notes
  noteTitle: document.getElementById('note-title-input'),
  noteContent: document.getElementById('note-content-input'),
  saveNoteBtn: document.getElementById('save-note-btn'),
  notesList: document.getElementById('notes-list-container'),
  notesSearch: document.getElementById('notes-search-input'),

  // Tasks
  taskTitle: document.getElementById('task-title-input'),
  taskPriority: document.getElementById('task-priority-input'),
  saveTaskBtn: document.getElementById('save-task-btn'),
  tasksList: document.getElementById('tasks-list-container'),
  taskFilterBtns: document.querySelectorAll('.filter-pill'),

  // Console
  consoleStream: document.getElementById('console-stream'),
  consoleInput: document.getElementById('manual-console-input'),
  sendConsoleBtn: document.getElementById('send-console-btn'),
  clearConsoleBtn: document.getElementById('clear-console-btn'),

  // Settings
  clientIdInput: document.getElementById('g-client-id-input'),
  saveClientIdBtn: document.getElementById('save-client-id-btn'),
  geminiKeyInput: document.getElementById('gemini-key-input'),
  saveGeminiKeyBtn: document.getElementById('save-gemini-key-btn'),
  voicePicker: document.getElementById('voice-picker-select'),
  wakeWordToggle: document.getElementById('wake-word-toggle'),
  manualSyncBtn: document.getElementById('manual-sync-btn')
};

// ---------------------------------------------------------------------------
// 3. INITIALIZATION & PWA LIFECYCLE
// ---------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  initClock();
  initPWA();
  loadLocalCache();
  initVoices();
  initSpeechRecognition();
  bindUIEvents();
  renderAll();
});

function initPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js')
      .then(() => logToConsole('[PWA] ServiceWorker registered.', 'sys'))
      .catch((err) => logToConsole(`[PWA] Worker error: ${err}`, 'err'));
  }
}

function initClock() {
  const update = () => {
    const now = new Date();
    dom.clock.textContent = now.toTimeString().split(' ')[0];
    dom.date.textContent = now.toISOString().split('T')[0];
  };
  setInterval(update, 1000);
  update();
}

// ---------------------------------------------------------------------------
// 4. GOOGLE AUTH & DRIVE REST API V3 INTEGRATION
// ---------------------------------------------------------------------------
function initGISClient() {
  const clientId = appState.settings.clientId || dom.clientIdInput.value.trim();
  if (!clientId || !window.google) return;

  try {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: async (tokenResponse) => {
        if (tokenResponse && tokenResponse.access_token) {
          googleAccessToken = tokenResponse.access_token;
          dom.authBtn.textContent = 'DISCONNECT';
          dom.driveStatusBadge.classList.add('connected');
          dom.driveStatusBadge.querySelector('.text').textContent = 'Drive: Synced';
          logToConsole('[AUTH] Access token acquired. Syncing with Drive...', 'sys');
          await syncWithDrive();
        }
      }
    });
  } catch (err) {
    logToConsole(`[GIS] Initialization error: ${err.message}`, 'err');
  }
}

async function syncWithDrive() {
  if (!googleAccessToken) return;
  try {
    // 1. Search for existing angel_data.json
    const query = encodeURIComponent(`name = '${DRIVE_FILENAME}' and trashed = false`);
    const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`, {
      headers: { Authorization: `Bearer ${googleAccessToken}` }
    });
    const searchData = await searchRes.json();

    if (searchData.files && searchData.files.length > 0) {
      driveFileId = searchData.files[0].id;
      // Download contents
      const fileRes = await fetch(`https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`, {
        headers: { Authorization: `Bearer ${googleAccessToken}` }
      });
      const driveJson = await fileRes.json();
      appState = driveJson;
      saveLocalCache();
      renderAll();
      logToConsole('[DRIVE] Remote memory profile synchronized.', 'sys');
    } else {
      // Create new file
      await uploadToDrive(true);
      logToConsole('[DRIVE] Primary angel_data.json profile created on Drive.', 'sys');
    }
    dom.statSyncTime.textContent = new Date().toLocaleTimeString();
  } catch (err) {
    logToConsole(`[DRIVE] Sync failure: ${err.message}`, 'err');
  }
}

async function uploadToDrive(isNew = false) {
  if (!googleAccessToken) return;

  appState.updatedAt = new Date().toISOString();
  const boundary = '-------314159265358979323846';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const metadata = {
    name: DRIVE_FILENAME,
    mimeType: 'application/json'
  };

  const multipartRequestBody =
    delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    delimiter +
    'Content-Type: application/json\r\n\r\n' +
    JSON.stringify(appState, null, 2) +
    closeDelimiter;

  const url = isNew || !driveFileId
    ? 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart'
    : `https://www.googleapis.com/upload/drive/v3/files/${driveFileId}?uploadType=multipart`;

  const method = isNew || !driveFileId ? 'POST' : 'PATCH';

  try {
    const res = await fetch(url, {
      method: method,
      headers: {
        Authorization: `Bearer ${googleAccessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body: multipartRequestBody
    });
    const data = await res.json();
    if (data.id) driveFileId = data.id;
    saveLocalCache();
    dom.statSyncTime.textContent = new Date().toLocaleTimeString();
  } catch (err) {
    logToConsole(`[DRIVE] Upload failed: ${err.message}`, 'err');
  }
}

function saveLocalCache() {
  localStorage.setItem(APP_STORAGE_KEY, JSON.stringify(appState));
}

function loadLocalCache() {
  const cached = localStorage.getItem(APP_STORAGE_KEY);
  if (cached) {
    try {
      appState = JSON.parse(cached);
    } catch {
      appState = JSON.parse(JSON.stringify(defaultMemoryState));
    }
  }
  dom.clientIdInput.value = appState.settings.clientId || '';
  dom.geminiKeyInput.value = appState.settings.geminiApiKey || '';
  dom.wakeWordToggle.checked = appState.settings.wakeWordEnabled ?? true;
}

// ---------------------------------------------------------------------------
// 5. WEB SPEECH ENGINE: RECOGNITION & SYNTHESIS
// ---------------------------------------------------------------------------
function initVoices() {
  const populate = () => {
    const voices = synth.getVoices();
    dom.voicePicker.innerHTML = '';
    voices.forEach((v) => {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = `${v.name} (${v.lang})`;
      if (appState.settings.voiceName === v.name || (!appState.settings.voiceName && v.lang.startsWith('en'))) {
        opt.selected = true;
        selectedVoice = v;
      }
      dom.voicePicker.appendChild(opt);
    });
  };
  populate();
  if (speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = populate;
  }
}

function speak(text) {
  if (isHardwareMuted || !text) return;
  synth.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  if (selectedVoice) utterance.voice = selectedVoice;
  utterance.rate = 1.05;
  utterance.pitch = 1.0;

  utterance.onstart = () => {
    dom.hudPulse.classList.add('speaking');
    dom.hudVoiceState.textContent = 'OUTPUT MATRIX TRANSMITTING';
  };
  utterance.onend = () => {
    dom.hudPulse.classList.remove('speaking');
    dom.hudVoiceState.textContent = 'STANDBY FOR "ANGEL"';
  };
  synth.speak(utterance);
}

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    logToConsole('[SPEECH] Browser does not support Web Speech Recognition.', 'err');
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = 'en-US';

  recognition.onstart = () => {
    isListening = true;
    updateMicVisualState();
  };

  recognition.onerror = (e) => {
    if (e.error !== 'no-speech') {
      logToConsole(`[SPEECH ERROR] ${e.error}`, 'err');
    }
  };

  recognition.onend = () => {
    isListening = false;
    updateMicVisualState();
    // Continuous loop if not manually muted
    if (!isHardwareMuted && appState.settings.wakeWordEnabled) {
      try { recognition.start(); } catch {}
    }
  };

  recognition.onresult = (event) => {
    const transcript = event.results[event.results.length - 1][0].transcript.trim();
    handleIncomingVoice(transcript);
  };

  startContinuousListening();
}

function startContinuousListening() {
  if (!recognition || isHardwareMuted) return;
  try {
    recognition.start();
  } catch {}
}

function updateMicVisualState() {
  if (isHardwareMuted) {
    dom.micStatusBadge.classList.remove('connected', 'active');
    dom.micStatusBadge.querySelector('.text').textContent = 'Mic: Hardware Mute';
    dom.hudPulse.classList.remove('listening');
    dom.quickMuteBtn.textContent = 'MIC MUTED';
    dom.mobileMicBtn.classList.remove('active');
  } else if (isListening) {
    dom.micStatusBadge.classList.add('active');
    dom.micStatusBadge.querySelector('.text').textContent = 'Mic: Listening';
    dom.hudPulse.classList.add('listening');
    dom.quickMuteBtn.textContent = 'MIC ACTIVE';
    dom.mobileMicBtn.classList.add('active');
  } else {
    dom.micStatusBadge.classList.remove('active');
    dom.micStatusBadge.querySelector('.text').textContent = 'Mic: Standby';
    dom.hudPulse.classList.remove('listening');
    dom.mobileMicBtn.classList.remove('active');
  }
}

// ---------------------------------------------------------------------------
// 6. VOICE COMMAND ROUTING & GEMINI INTELLIGENCE
// ---------------------------------------------------------------------------
async function handleIncomingVoice(rawText) {
  logToConsole(`User: ${rawText}`, 'user');

  const lower = rawText.toLowerCase().trim();
  const wakeWord = 'angel';
  const hasWake = lower.startsWith(wakeWord);

  if (appState.settings.wakeWordEnabled && !hasWake) {
    return; // Ignore background chatter if wake word missing
  }

  // Strip wake word
  const cleanCommand = lower.replace(/^angel[,\s]*/, '').trim();

  // 1. Direct Regex Parsing for CRUD Operations
  const saveNoteMatch = cleanCommand.match(/^save note\s+(.*)/i);
  if (saveNoteMatch) {
    const noteBody = cleanCommand.replace(/^save note\s+/i, '');
    addNote('Voice Log', noteBody);
    speak('Note saved to your drive, Sir.');
    return;
  }

  if (cleanCommand === 'show notes' || cleanCommand === 'show note') {
    switchView('notes');
    const latest = appState.memory.notes[0];
    speak(latest ? `Displaying notes. Latest is: ${latest.title}` : 'Your memory store has no notes.');
    return;
  }

  const addTaskMatch = cleanCommand.match(/^add task\s+(.+?)(\s+with priority\s+(high|medium|low))?$/i);
  if (addTaskMatch) {
    const title = addTaskMatch[1];
    const priority = addTaskMatch[3] ? addTaskMatch[3].toLowerCase() : 'medium';
    addTask(title, priority);
    speak(`Task added with ${priority} priority.`);
    return;
  }

  // 2. Fallback to Cognitive Layer: Google Gemini API
  await queryGeminiCore(rawText);
}

async function queryGeminiCore(userQuery) {
  const apiKey = appState.settings.geminiApiKey;
  if (!apiKey) {
    const msg = 'Gemini API Key missing. Please provide it in Core Config.';
    logToConsole(`[ANGEL] ${msg}`, 'err');
    speak(msg);
    return;
  }

  dom.hudVoiceState.textContent = 'COGNITIVE MATRIX QUERYING';
  logToConsole('Angel: Processing through cognitive core...', 'sys');

  // Dynamic context injection: active tasks and top notes
  const activeTasks = appState.memory.tasks.filter((t) => !t.completed).map((t) => `[${t.priority.toUpperCase()}] ${t.title}`).join('; ');
  const recentNotes = appState.memory.notes.slice(0, 3).map((n) => `${n.title}: ${n.content}`).join(' | ');

  const systemPrompt = `You are Angel, an advanced personal AI operating system. You are sharp, polite, competent, and concise. Address the user respectfully and keep spoken replies brief and impactful.
Current Active Directives: ${activeTasks || 'None'}
Recent Persistent Memory: ${recentNotes || 'None'}`;

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: `${systemPrompt}\n\nUser statement: "${userQuery}"` }]
      }
    ]
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (data.candidates && data.candidates[0].content.parts.length > 0) {
      const reply = data.candidates[0].content.parts[0].text.trim();
      logToConsole(`Angel: ${reply}`, 'angel');
      speak(reply);

      // Save to conversations
      appState.memory.conversations.push({
        role: 'user',
        text: userQuery,
        timestamp: new Date().toISOString()
      });
      appState.memory.conversations.push({
        role: 'model',
        text: reply,
        timestamp: new Date().toISOString()
      });
      uploadToDrive(false);
    } else {
      throw new Error(data.error?.message || 'Empty candidate response');
    }
  } catch (err) {
    logToConsole(`[GEMINI ERROR] ${err.message}`, 'err');
    speak('Cognitive module encountered an error processing your statement.');
  } finally {
    dom.hudVoiceState.textContent = 'STANDBY FOR "ANGEL"';
  }
}

// ---------------------------------------------------------------------------
// 7. MODULE CRUD LOGIC
// ---------------------------------------------------------------------------
function addNote(title, content) {
  const note = {
    id: crypto.randomUUID(),
    title: title || 'Untitled Log',
    content: content || '',
    createdAt: new Date().toISOString(),
    tags: []
  };
  appState.memory.notes.unshift(note);
  uploadToDrive(false);
  renderNotes();
}

function deleteNote(id) {
  appState.memory.notes = appState.memory.notes.filter((n) => n.id !== id);
  uploadToDrive(false);
  renderNotes();
}

function addTask(title, priority = 'medium') {
  const task = {
    id: crypto.randomUUID(),
    title: title,
    priority: priority,
    completed: false,
    createdAt: new Date().toISOString()
  };
  appState.memory.tasks.unshift(task);
  uploadToDrive(false);
  renderTasks();
}

function toggleTask(id) {
  const task = appState.memory.tasks.find((t) => t.id === id);
  if (task) {
    task.completed = !task.completed;
    uploadToDrive(false);
    renderTasks();
  }
}

function deleteTask(id) {
  appState.memory.tasks = appState.memory.tasks.filter((t) => t.id !== id);
  uploadToDrive(false);
  renderTasks();
}

// ---------------------------------------------------------------------------
// 8. UI RENDERING & EVENT ATTACHMENTS
// ---------------------------------------------------------------------------
function renderAll() {
  renderHomeStats();
  renderNotes();
  renderTasks();
}

function renderHomeStats() {
  dom.statTasksCount.textContent = appState.memory.tasks.filter((t) => !t.completed).length;
  dom.statNotesCount.textContent = appState.memory.notes.length;

  dom.homeTasksPreview.innerHTML = '';
  const pending = appState.memory.tasks.filter((t) => !t.completed).slice(0, 4);
  if (pending.length === 0) {
    dom.homeTasksPreview.innerHTML = '<p class="placeholder-text">All directives complete.</p>';
  } else {
    pending.forEach((t) => {
      const el = document.createElement('div');
      el.className = 'item-card';
      el.innerHTML = `
        <div class="item-details">
          <span class="item-title">${escapeHtml(t.title)}</span>
          <span class="item-meta"><span class="priority-tag ${t.priority}">${t.priority.toUpperCase()}</span></span>
        </div>`;
      dom.homeTasksPreview.appendChild(el);
    });
  }
}

function renderNotes() {
  const query = dom.notesSearch.value.toLowerCase();
  dom.notesList.innerHTML = '';

  const filtered = appState.memory.notes.filter(
    (n) => n.title.toLowerCase().includes(query) || n.content.toLowerCase().includes(query)
  );

  filtered.forEach((n) => {
    const card = document.createElement('div');
    card.className = 'item-card';
    card.innerHTML = `
      <div class="item-details">
        <strong class="item-title">${escapeHtml(n.title)}</strong>
        <p class="item-meta">${escapeHtml(n.content)}</p>
        <span class="item-meta">${new Date(n.createdAt).toLocaleDateString()}</span>
      </div>
      <div class="item-actions">
        <button class="item-del-btn" data-id="${n.id}">✕</button>
      </div>`;
    dom.notesList.appendChild(card);
  });

  dom.notesList.querySelectorAll('.item-del-btn').forEach((btn) => {
    btn.onclick = () => deleteNote(btn.dataset.id);
  });
}

function renderTasks(filter = 'all') {
  dom.tasksList.innerHTML = '';

  let list = appState.memory.tasks;
  if (filter === 'high') list = list.filter((t) => t.priority === 'high');
  if (filter === 'pending') list = list.filter((t) => !t.completed);

  list.forEach((t) => {
    const card = document.createElement('div');
    card.className = `item-card ${t.completed ? 'completed' : ''}`;
    card.innerHTML = `
      <input type="checkbox" ${t.completed ? 'checked' : ''} data-id="${t.id}" class="task-check" style="width: 24px; min-height: 24px;">
      <div class="item-details">
        <span class="item-title">${escapeHtml(t.title)}</span>
        <span class="item-meta">
          <span class="priority-tag ${t.priority}">${t.priority.toUpperCase()}</span>
          ${new Date(t.createdAt).toLocaleDateString()}
        </span>
      </div>
      <div class="item-actions">
        <button class="item-del-btn" data-id="${t.id}">✕</button>
      </div>`;
    dom.tasksList.appendChild(card);
  });

  dom.tasksList.querySelectorAll('.task-check').forEach((chk) => {
    chk.onchange = () => toggleTask(chk.dataset.id);
  });
  dom.tasksList.querySelectorAll('.item-del-btn').forEach((btn) => {
    btn.onclick = () => deleteTask(btn.dataset.id);
  });
}

function switchView(target) {
  dom.navBtns.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.target === target);
  });
  dom.views.forEach((v) => {
    v.classList.toggle('active', v.id === `view-${target}`);
  });
}

function logToConsole(message, type = 'sys') {
  const el = document.createElement('div');
  el.className = `log-entry ${type}`;
  el.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  dom.consoleStream.appendChild(el);
  dom.consoleStream.scrollTop = dom.consoleStream.scrollHeight;
}

function bindUIEvents() {
  // Navigation
  dom.navBtns.forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.target));
  });

  // Notes Search & Create
  dom.notesSearch.addEventListener('input', renderNotes);
  dom.saveNoteBtn.addEventListener('click', () => {
    const title = dom.noteTitle.value.trim();
    const body = dom.noteContent.value.trim();
    if (title || body) {
      addNote(title, body);
      dom.noteTitle.value = '';
      dom.noteContent.value = '';
      speak('Note committed to memory.');
    }
  });

  // Task Filter & Create
  dom.taskFilterBtns.forEach((b) => {
    b.addEventListener('click', () => {
      dom.taskFilterBtns.forEach((btn) => btn.classList.remove('active'));
      b.classList.add('active');
      renderTasks(b.dataset.filter);
    });
  });

  dom.saveTaskBtn.addEventListener('click', () => {
    const title = dom.taskTitle.value.trim();
    if (title) {
      addTask(title, dom.taskPriority.value);
      dom.taskTitle.value = '';
      speak('Directive registered.');
    }
  });

  // Terminal manual inputs
  dom.sendConsoleBtn.addEventListener('click', () => {
    const cmd = dom.consoleInput.value.trim();
    if (cmd) {
      dom.consoleInput.value = '';
      handleIncomingVoice(cmd);
    }
  });
  dom.consoleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') dom.sendConsoleBtn.click();
  });
  dom.clearConsoleBtn.addEventListener('click', () => {
    dom.consoleStream.innerHTML = '';
  });

  // Hardware Mute Button
  dom.quickMuteBtn.addEventListener('click', () => {
    isHardwareMuted = !isHardwareMuted;
    if (isHardwareMuted) {
      if (recognition) recognition.stop();
      synth.cancel();
    } else {
      startContinuousListening();
    }
    updateMicVisualState();
  });

  // Mobile Floating Mic (Touch PTT and single tap toggle)
  dom.mobileMicBtn.addEventListener('click', () => {
    if (isHardwareMuted) {
      isHardwareMuted = false;
      startContinuousListening();
    } else {
      if (!isListening && recognition) {
        try { recognition.start(); } catch {}
      }
    }
    updateMicVisualState();
  });

  // Desktop Global Hotkey: Spacebar Push-To-Talk when not editing inputs
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
      e.preventDefault();
      if (!isListening && recognition && !isHardwareMuted) {
        try { recognition.start(); } catch {}
      }
    }
  });

  // Settings Actions
  dom.saveClientIdBtn.addEventListener('click', () => {
    appState.settings.clientId = dom.clientIdInput.value.trim();
    saveLocalCache();
    initGISClient();
    logToConsole('[CONFIG] Google OAuth Client ID saved.', 'sys');
  });

  dom.saveGeminiKeyBtn.addEventListener('click', () => {
    appState.settings.geminiApiKey = dom.geminiKeyInput.value.trim();
    uploadToDrive(false);
    logToConsole('[CONFIG] Gemini API Key saved.', 'sys');
    speak('Cognitive matrix key persisted.');
  });

  dom.voicePicker.addEventListener('change', () => {
    appState.settings.voiceName = dom.voicePicker.value;
    const voices = synth.getVoices();
    selectedVoice = voices.find((v) => v.name === dom.voicePicker.value);
    uploadToDrive(false);
  });

  dom.wakeWordToggle.addEventListener('change', () => {
    appState.settings.wakeWordEnabled = dom.wakeWordToggle.checked;
    uploadToDrive(false);
  });

  dom.manualSyncBtn.addEventListener('click', syncWithDrive);

  dom.authBtn.addEventListener('click', () => {
    if (googleAccessToken) {
      googleAccessToken = null;
      dom.authBtn.textContent = 'CONNECT DRIVE';
      dom.driveStatusBadge.classList.remove('connected');
      dom.driveStatusBadge.querySelector('.text').textContent = 'Drive: Disconnected';
      logToConsole('[AUTH] User session revoked.', 'sys');
    } else {
      if (!tokenClient) initGISClient();
      if (tokenClient) {
        tokenClient.requestAccessToken({ prompt: 'consent' });
      } else {
        alert('Please save a valid Google OAuth Client ID in Settings first.');
        switchView('settings');
      }
    }
  });
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}