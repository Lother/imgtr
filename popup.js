const DEFAULTS = {
  apiKey: '',
  model: 'gemini-3.5-flash-lite',
  targetLang: '繁體中文',
  auto: false,
  minSize: 140,
  chipPos: 'tl'
};

const els = {
  apiKey: document.getElementById('apiKey'),
  model: document.getElementById('model'),
  targetLang: document.getElementById('targetLang'),
  minSize: document.getElementById('minSize'),
  chipPos: document.getElementById('chipPos'),
  auto: document.getElementById('auto'),
  save: document.getElementById('save'),
  status: document.getElementById('status'),
  test: document.getElementById('test'),
  keyLink: document.getElementById('keyLink')
};

chrome.storage.sync.get(DEFAULTS, (cfg) => {
  els.apiKey.value = cfg.apiKey;
  els.model.value = cfg.model;
  els.targetLang.value = cfg.targetLang;
  els.minSize.value = cfg.minSize;
  els.chipPos.value = cfg.chipPos;
  els.auto.setAttribute('aria-checked', String(cfg.auto));
});

// 按鈕位置立即生效
els.chipPos.addEventListener('change', () => {
  chrome.storage.sync.set({ chipPos: els.chipPos.value });
  say(els.chipPos.value === 'off' ? '已隱藏按鈕，改用 Alt+Q 或右鍵選單' : '按鈕位置已更新', 'ok');
});

// 自動翻譯是開關，按了就生效，不用等儲存
els.auto.addEventListener('click', () => {
  const next = els.auto.getAttribute('aria-checked') !== 'true';
  els.auto.setAttribute('aria-checked', String(next));
  chrome.storage.sync.set({ auto: next });
  say(next ? '自動翻譯已開啟' : '自動翻譯已關閉', 'ok');
});

els.save.addEventListener('click', () => {
  const apiKey = els.apiKey.value.trim();
  const model = els.model.value.trim() || DEFAULTS.model;
  const minSize = clamp(parseInt(els.minSize.value, 10) || DEFAULTS.minSize, 60, 600);

  if (!apiKey) { say('填入 API 金鑰才能開始翻譯', 'bad'); els.apiKey.focus(); return; }

  els.minSize.value = minSize;
  chrome.storage.sync.set(
    { apiKey, model, minSize, targetLang: els.targetLang.value },
    () => say('已儲存，重新整理分頁後生效', 'ok')
  );
});

els.test.addEventListener('click', () => {
  say('檢查中…', '');
  els.test.disabled = true;
  chrome.runtime.sendMessage({ type: 'diagnose' }, (res) => {
    els.test.disabled = false;
    const err = chrome.runtime.lastError?.message;
    if (err || !res) { say(err || '無法連線到背景服務', 'bad'); return; }
    say(res.message, res.ok ? 'ok' : 'bad');
  });
});

els.keyLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://aistudio.google.com/apikey' });
});

function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

let timer = 0;
function say(message, tone) {
  els.status.textContent = message;
  els.status.dataset.tone = tone;
  clearTimeout(timer);
  timer = setTimeout(() => { els.status.textContent = ''; }, 6000);
}
