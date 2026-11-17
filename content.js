// 頁面端：偵測圖片、顯示翻譯按鈕、把譯文疊回原圖位置。
(() => {
  const DEFAULTS = { auto: false, minSize: 140, chipPos: 'tl' };

  let cfg = { ...DEFAULTS };
  const cache = new Map();   // src -> blocks
  const failed = new Map();  // src -> 錯誤訊息
  const layers = new Map();  // img -> layer 元素
  const busy = new Set();    // 正在翻譯的 src

  let hovered = null;
  let chip = null;
  let ticking = false;
  let observer = null;
  const queue = [];
  let draining = false;

  chrome.storage.sync.get(DEFAULTS, (s) => {
    cfg = s;
    if (cfg.auto) startAuto();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const key of Object.keys(changes)) cfg[key] = changes[key].newValue;
    if ('chipPos' in changes) { if (cfg.chipPos === 'off') hideChip(); else place(); }
    if ('auto' in changes) {
      cfg.auto ? startAuto() : stopAuto();
      toast(cfg.auto ? '自動翻譯：開' : '自動翻譯：關');
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'translate-hovered' && hovered) toggle(hovered);
    if (msg.type === 'translate-src') {
      const img = findBySrc(msg.src);
      if (img) toggle(img);
      else toast('找不到那張圖片，改用滑鼠移上去按 Alt+Q。');
    }
  });

  // ---------- 滑鼠懸停按鈕 ----------

  document.addEventListener('mouseover', (e) => {
    const img = e.target instanceof Element ? e.target.closest('img') : null;
    if (!img || img === hovered) return;
    if (cfg.chipPos === 'off' || img.clientWidth < 80 || img.clientHeight < 60) { hideChip(); return; }
    hovered = img;
    showChip(img);
  }, true);

  document.addEventListener('mouseout', (e) => {
    if (!chip) return;
    const to = e.relatedTarget;
    if (to === chip || (to instanceof Node && chip.contains(to))) return;
    if (hovered && to instanceof Node && hovered.contains(to)) return;
    hideChip();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && layers.size) clearAll();
  });

  function showChip(img) {
    if (!chip) {
      chip = document.createElement('button');
      chip.className = 'imgtr-chip';
      chip.type = 'button';
      chip.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (hovered) toggle(hovered);
      });
      document.body.appendChild(chip);
    }
    const src = srcOf(img);
    chip.dataset.state = layers.has(img) ? 'on' : (failed.has(src) ? 'error' : 'idle');
    chip.textContent = layers.has(img) ? '原' : '譯';
    chip.title = failed.get(src) || (layers.has(img) ? '顯示原圖（Alt+Q）' : '翻譯這張圖片（Alt+Q）');
    chip.style.display = 'block';
    place();
    startTicking();
  }

  function hideChip() {
    hovered = null;
    if (chip) chip.style.display = 'none';
  }

  // ---------- 翻譯流程 ----------

  function toggle(img) {
    if (layers.has(img)) { removeLayer(img); if (hovered === img) showChip(img); return; }
    request(img);
  }

  function request(img) {
    const src = srcOf(img);
    if (!src) return;

    if (cache.has(src)) { render(img, cache.get(src)); return; }
    if (busy.has(src)) return;

    busy.add(src);
    log('送出翻譯請求', src);
    if (hovered === img && chip) { chip.dataset.state = 'loading'; chip.textContent = '···'; }

    try {
      let settled = false;
      const watchdog = setTimeout(() => {
        if (settled) return;
        settled = true;
        busy.delete(src);
        log('背景服務逾時未回覆');
        if (hovered === img) showChip(img);
        toast('背景服務沒有回應，請看 chrome://extensions 的 Service Worker 主控台。');
      }, 100000);

      chrome.runtime.sendMessage({ type: 'translate', src }, (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        busy.delete(src);
        const err = chrome.runtime.lastError?.message;
        if (err || !res || res.error) {
          const message = res?.error || err || '翻譯失敗';
          log('失敗', message);
          failed.set(src, message);
          if (hovered === img) showChip(img);
          toast(message);
          return;
        }
        log('取得', res.blocks.length, '個文字區塊');
        failed.delete(src);
        cache.set(src, res.blocks);
        render(img, res.blocks);
      });
    } catch (e) {
      // 重新載入擴充功能後，舊分頁的連線會失效
      busy.delete(src);
      log('連線失效', e);
      toast('擴充功能已更新，請重新整理這個分頁。');
    }
  }

  function render(img, blocks) {
    if (!img.isConnected) return;
    removeLayer(img);

    if (!blocks.length) {
      toast('這張圖沒有偵測到需要翻譯的文字。');
      if (hovered === img) showChip(img);
      return;
    }

    const layer = document.createElement('div');
    layer.className = 'imgtr-layer';

    for (const b of blocks) {
      const box = document.createElement('div');
      box.className = 'imgtr-box';
      box.style.top = b.top + '%';
      box.style.left = b.left + '%';
      box.style.width = b.width + '%';
      box.style.height = b.height + '%';

      const span = document.createElement('span');
      span.className = 'imgtr-text';
      span.textContent = b.dst;
      box.appendChild(span);

      if (b.src) {
        box.title = b.src;
        box.dataset.showing = 'dst';
        box.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const showSrc = box.dataset.showing === 'dst';
          box.dataset.showing = showSrc ? 'src' : 'dst';
          span.textContent = showSrc ? b.src : b.dst;
          fit(box, span);
        });
      }
      layer.appendChild(box);
    }

    document.body.appendChild(layer);
    layers.set(img, layer);
    position(img, layer);
    for (const box of layer.children) fit(box, box.firstElementChild);
    startTicking();
    if (hovered === img) showChip(img);
  }

  function removeLayer(img) {
    const layer = layers.get(img);
    if (layer) { layer.remove(); layers.delete(img); }
  }

  function clearAll() {
    for (const layer of layers.values()) layer.remove();
    layers.clear();
    if (hovered) showChip(hovered);
  }

  // ---------- 版面定位 ----------

  function position(img, layer) {
    const r = img.getBoundingClientRect();
    const offscreen = r.bottom < 0 || r.top > window.innerHeight ||
                      r.right < 0 || r.left > window.innerWidth;
    if (r.width < 8 || r.height < 8 || offscreen) { layer.style.display = 'none'; return; }
    layer.style.display = '';
    layer.style.width = r.width + 'px';
    layer.style.height = r.height + 'px';
    layer.style.transform = `translate(${r.left}px, ${r.top}px)`;
  }

  function place() {
    if (!chip || !hovered) return;
    const r = hovered.getBoundingClientRect();
    const size = 20, gap = 4;
    const pos = cfg.chipPos || 'tl';
    const x = pos.endsWith('r') ? r.right - size - gap : r.left + gap;
    const y = pos.startsWith('b') ? r.bottom - size - gap : r.top + gap;
    chip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  function startTicking() {
    if (ticking) return;
    ticking = true;
    const step = () => {
      for (const [img, layer] of layers) {
        if (!img.isConnected) { layer.remove(); layers.delete(img); continue; }
        position(img, layer);
      }
      if (chip && chip.style.display !== 'none') place();
      if (!layers.size && (!chip || chip.style.display === 'none')) { ticking = false; return; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function fit(box, span) {
    const limit = box.clientHeight;
    let size = Math.max(9, Math.min(limit * 0.78, 32));
    span.style.fontSize = size + 'px';
    let guard = 48;
    while (guard-- > 0 && size > 8 &&
      (span.scrollHeight > limit + 1 || span.scrollWidth > box.clientWidth + 1)) {
      size -= 1;
      span.style.fontSize = size + 'px';
    }
  }

  // ---------- 自動模式 ----------

  function startAuto() {
    if (observer) return;
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) enqueue(entry.target);
      }
    }, { rootMargin: '100px' });

    scan(document);
    new MutationObserver((records) => {
      if (!cfg.auto) return;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1) scan(node);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  function stopAuto() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
    queue.length = 0;
  }

  function scan(root) {
    if (!observer) return;
    const imgs = root instanceof Element && root.tagName === 'IMG'
      ? [root]
      : root.querySelectorAll?.('img') || [];
    for (const img of imgs) observer.observe(img);
  }

  function enqueue(img) {
    if (!cfg.auto || layers.has(img)) return;
    if (img.clientWidth < cfg.minSize || img.clientHeight < cfg.minSize) return;
    const src = srcOf(img);
    if (!src || failed.has(src) || busy.has(src)) return;
    if (cache.has(src)) { render(img, cache.get(src)); return; }
    if (queue.includes(img)) return;
    queue.push(img);
    drain();
  }

  // 一次只送一張、間隔 500ms，免費額度比較撐得住
  async function drain() {
    if (draining) return;
    draining = true;
    while (queue.length && cfg.auto) {
      const img = queue.shift();
      if (img.isConnected) request(img);
      await new Promise((r) => setTimeout(r, 500));
    }
    draining = false;
  }

  // ---------- 小工具 ----------

  function srcOf(img) {
    const raw = img.currentSrc || img.src || '';
    if (!raw || raw.startsWith('data:')) return raw;
    try {
      const url = new URL(raw, location.href);
      // X 的縮圖畫質太差，換成大圖再送出去辨識
      if (url.hostname === 'pbs.twimg.com' && url.searchParams.has('name')) {
        url.searchParams.set('name', 'large');
      }
      return url.href;
    } catch {
      return raw;
    }
  }

  function findBySrc(src) {
    for (const img of document.images) {
      if (img.currentSrc === src || img.src === src || srcOf(img) === src) return img;
    }
    return null;
  }

  let toastEl = null, toastTimer = 0;

  function log(...args) {
    console.log('%c[圖片即譯]', 'color:#f5d24c', ...args);
  }

  function toast(message) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'imgtr-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.dataset.on = 'true';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.dataset.on = 'false'; }, 3200);
  }
})();
