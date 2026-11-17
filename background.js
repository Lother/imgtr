// 背景服務：負責抓圖、呼叫 Gemini、回傳文字區塊座標。
// 內容腳本不直接碰 API key，也避開跨網域限制。

const DEFAULTS = {
  apiKey: '',
  model: 'gemini-3.5-flash-lite',
  targetLang: '繁體中文',
  auto: false,
  minSize: 140
};

const SUPPORTED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'
]);

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'imgtr-translate',
    title: '翻譯這張圖片',
    contexts: ['image']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'imgtr-translate' && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'translate-src', src: info.srcUrl });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-auto') {
    const { auto } = await chrome.storage.sync.get({ auto: false });
    await chrome.storage.sync.set({ auto: !auto });
    return;
  }
  if (command === 'translate-hovered') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'translate-hovered' });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'diagnose') {
    diagnose()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, message: err.message || String(err) }));
    return true;
  }
  if (msg?.type !== 'translate') return;
  translate(msg.src)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message || String(err) }));
  return true; // 保持通道開啟以便非同步回覆
});

// 檢查金鑰能不能用、設定的模型還在不在
async function diagnose() {
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  if (!cfg.apiKey) return { ok: false, message: '還沒填入 API 金鑰' };

  const res = await withTimeout(15000, '模型列表', (signal) =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(cfg.apiKey)}`, { signal }));
  if (!res.ok) return { ok: false, message: describeError(res.status, await res.text()) };

  const names = (await res.json()).models
    ?.map((m) => m.name.replace('models/', '')) || [];

  if (cfg.model.endsWith('-latest')) return { ok: true, message: `金鑰正常，${names.length} 個模型可用` };
  if (!names.includes(cfg.model)) {
    const flash = names.filter((n) => n.includes('flash') && !n.includes('image')).slice(0, 3);
    return { ok: false, message: `模型不可用，改填：${flash.join('、') || '見官方模型列表'}` };
  }
  return { ok: true, message: '金鑰與模型都正常' };
}

// 任何一步卡住都要有結果，不然內容腳本會一直等不到回覆
async function withTimeout(ms, label, run) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await run(ctrl.signal);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`${label}超過 ${Math.round(ms / 1000)} 秒沒回應。`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function translate(src) {
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  if (!cfg.apiKey) throw new Error('還沒設定 API 金鑰，請點擴充功能圖示填入。');

  console.log('[圖片即譯] 1/3 抓圖', src);
  const image = await loadImage(src);
  console.log('[圖片即譯] 2/3 圖片就緒', Math.round(image.data.length * 0.75 / 1024), 'KB，呼叫', cfg.model);

  const raw = await callGemini(image, cfg);
  const blocks = normalize(raw);
  console.log('[圖片即譯] 3/3 完成，', blocks.length, '個區塊');
  return { blocks };
}

async function loadImage(src) {
  let res;
  try {
    res = await withTimeout(20000, '圖片下載', (signal) =>
      fetch(src, { credentials: 'omit', signal }));
  } catch (e) {
    if (/秒沒回應/.test(e.message)) throw e;
    throw new Error('抓不到這張圖片，可能需要登入或已失效。');
  }
  if (!res.ok) throw new Error(`圖片下載失敗（HTTP ${res.status}）`);

  const declared = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (declared === 'image/svg+xml') throw new Error('SVG 向量圖不支援。');
  const mime = SUPPORTED_MIME.has(declared) ? declared : 'image/jpeg';

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > 6 * 1024 * 1024) throw new Error('圖片超過 6MB，太大了。');

  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return { mime, data: btoa(binary) };
}

function prompt(targetLang) {
  return [
    `你是圖片文字翻譯引擎。找出圖片中所有可讀的文字，翻成${targetLang}。`,
    '每個文字區塊輸出一個物件，欄位固定為 box、src、dst：',
    'box 是該段文字的外框，正規化到 0-1000，順序必須是 [ymin, xmin, ymax, xmax]，要緊貼文字。',
    'src 放原文，dst 放譯文。',
    '規則：',
    '- 同一個氣泡、同一段落、同一句話合併成一個區塊，不要逐字或逐行拆開。',
    `- 原文已經是${targetLang}的區塊直接略過。`,
    '- 浮水印、帳號名稱（@handle）、網址、logo、純裝飾字略過。',
    '- 譯文長度盡量貼近原文，避免加註解或括號說明。',
    '- 圖片中沒有需要翻譯的文字時，輸出 []。'
  ].join('\n');
}

function buildBody(image, cfg, lowThinking) {
  const generationConfig = {
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          box: { type: 'ARRAY', items: { type: 'INTEGER' } },
          src: { type: 'STRING' },
          dst: { type: 'STRING' }
        },
        required: ['box', 'src', 'dst'],
        propertyOrdering: ['box', 'src', 'dst']
      }
    },
    maxOutputTokens: 4096
  };
  if (lowThinking) generationConfig.thinkingConfig = { thinkingLevel: 'low' };

  return {
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: image.mime, data: image.data } },
        { text: prompt(cfg.targetLang) }
      ]
    }],
    generationConfig,
    safetySettings: [
      'HARM_CATEGORY_HARASSMENT',
      'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      'HARM_CATEGORY_DANGEROUS_CONTENT'
    ].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' }))
  };
}

async function post(endpoint, apiKey, body) {
  const url = `${endpoint}?key=${encodeURIComponent(apiKey)}`;
  try {
    return await withTimeout(120000, '模型回應', (signal) => fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal
    }));
  } catch (e) {
    if (/秒沒回應/.test(e.message)) {
      throw new Error(`${e.message} 這個模型太慢，改填 gemini-3.5-flash-lite 試試。`);
    }
    throw new Error('連不上 Gemini，檢查一下網路。');
  }
}

async function callGemini(image, cfg) {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`;

  // 這是抽取任務，不需要長時間推理；思考開到最低可以省掉幾十秒
  let res = await post(endpoint, cfg.apiKey, buildBody(image, cfg, true));

  if (res.status === 400) {
    const text = await res.clone().text();
    if (/thinking/i.test(text)) {
      console.warn('[圖片即譯] 這個模型不吃 thinkingConfig，改用預設值重送');
      res = await post(endpoint, cfg.apiKey, buildBody(image, cfg, false));
    }
  }

  if (!res.ok) throw new Error(describeError(res.status, await res.text()));

  const json = await res.json();
  const candidate = json.candidates?.[0];
  const finish = candidate?.finishReason;
  const CATEGORY_LABELS = {
    HARM_CATEGORY_HARASSMENT: '騷擾',
    HARM_CATEGORY_HATE_SPEECH: '仇恨言論',
    HARM_CATEGORY_SEXUALLY_EXPLICIT: '性內容',
    HARM_CATEGORY_DANGEROUS_CONTENT: '危險內容'
  };

  if (['SAFETY', 'PROHIBITED_CONTENT', 'IMAGE_SAFETY'].includes(finish)) {
    const flagged = (candidate.safetyRatings || [])
      .filter((r) => r.probability === 'MEDIUM' || r.probability === 'HIGH')
      .map((r) => CATEGORY_LABELS[r.category] || r.category);
    console.warn('[圖片即譯] 遭 Google 政策攔截：', candidate.finishMessage || finish);
    throw new Error(
      `Google 拒絕處理這張圖${flagged.length ? `（${flagged.join('、')}）` : ''}。` +
      '這是伺服器端的政策判定，不是擴充功能的設定問題。'
    );
  }
  if (json.promptFeedback?.blockReason) throw new Error('這張圖在送出階段就被 Google 擋下了。');

  const text = (candidate?.content?.parts || [])
    .map((p) => p.text || '')
    .join('')
    .trim();

  if (!text) {
    // Gemini 3.x 會先花 token 思考，額度不夠就回空的
    if (finish === 'MAX_TOKENS') throw new Error('模型輸出被截斷，試試 gemini-3.5-flash-lite。');
    throw new Error(`模型沒有回傳內容（finishReason: ${finish || '未知'}）。`);
  }

  try {
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    console.log('[圖片即譯] 模型回傳：', text.slice(0, 400));
    return parsed;
  } catch {
    console.warn('[圖片即譯] 無法解析為 JSON：', text.slice(0, 400));
    throw new Error('回傳格式怪怪的，再試一次或換個模型。');
  }
}

function describeError(status, raw) {
  let detail = '';
  try { detail = JSON.parse(raw)?.error?.message || ''; } catch { /* 保持空白 */ }

  if (status === 400 && /API key/i.test(detail)) return 'API 金鑰無效，請重新確認。';
  if (status === 403) return '這把金鑰沒有存取權限，確認 Gemini API 已在該專案啟用。';
  if (status === 404) return detail || '找不到這個模型，請在設定裡換一個模型名稱。';
  if (status === 429) return '超過免費額度或呼叫太密集，等一下再試。';
  if (status >= 500) return 'Gemini 伺服器忙碌中，稍後再試。';
  return detail || `呼叫失敗（HTTP ${status}）`;
}

function normalize(raw) {
  // 模型偶爾會包一層物件，或改用 box_2d 這類慣用欄位名
  const items = Array.isArray(raw)
    ? raw
    : (Object.values(raw || {}).find(Array.isArray) || []);

  const out = [];
  for (const item of items) {
    const box = item?.box || item?.box_2d || item?.bbox || item?.boundingBox;
    const dst = String(item?.dst ?? item?.translation ?? item?.translated ?? '').trim();
    if (!Array.isArray(box) || box.length !== 4 || !dst) continue;

    const clamp = (n) => Math.min(1000, Math.max(0, Number(n) || 0));
    const top = clamp(box[0]), left = clamp(box[1]);
    const bottom = clamp(box[2]), right = clamp(box[3]);
    const height = bottom - top, width = right - left;
    if (width < 8 || height < 6) continue;

    out.push({
      top: top / 10,
      left: left / 10,
      width: width / 10,
      height: height / 10,
      src: String(item?.src ?? item?.original ?? '').trim(),
      dst
    });
  }

  if (!out.length && items.length) {
    console.warn('[圖片即譯] 無法解析的回傳格式：', JSON.stringify(items[0]));
    throw new Error(`模型回傳 ${items.length} 筆，但格式對不上（見 Service Worker 主控台）。`);
  }
  return out;
}
