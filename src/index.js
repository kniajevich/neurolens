export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 1. ИЗВЛЕЧЕНИЕ ЦЕЛЕВОГО URL (ПРЕФИКСНЫЙ ИЛИ QUERY)
    let targetUrl = null;
    const rawPath = url.pathname.slice(1) + url.search;

    if (rawPath.startsWith("http://") || rawPath.startsWith("https://")) {
      targetUrl = rawPath;
    } else if (url.searchParams.has("url")) {
      targetUrl = url.searchParams.get("url");
    }

    // 2. ГЛАВНАЯ СТРАНИЦА-ВИТРИНА (ЕСЛИ НЕТ URL)
    if (!targetUrl && url.pathname === "/") {
      return handleLanding(request, corsHeaders);
    }

    if (!targetUrl) {
      return new Response(JSON.stringify({ error: "Укажите целевой URL. Пример: /https://habr.com/ru/articles/12345/" }), {
        status: 400,
        headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders }
      });
    }

    // Валидация URL
    try {
      new URL(targetUrl);
    } catch {
      return new Response(JSON.stringify({ error: "Некорректный формат целевого URL." }), {
        status: 400,
        headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders }
      });
    }

    // 3. ПРОВЕРКА КЭША В D1 SQL
    const cacheKey = targetUrl;
    if (env.DB) {
      await initD1(env.DB);
      try {
        const cached = await env.DB.prepare(
          "SELECT * FROM cache WHERE url = ? AND created_at > datetime('now', '-24 hours')"
        ).bind(cacheKey).first();

        if (cached) {
          return formatOutput(request, {
            title: cached.title,
            url: cached.url,
            markdown: cached.markdown,
            tokens_estimate: cached.tokens_estimate,
            tokens_saved: cached.tokens_saved,
            cached: true,
            engine: "edge-d1-cache"
          }, corsHeaders);
        }
      } catch (err) {
        console.error("Ошибка чтения D1 кэша:", err);
      }
    }

    // 4. FAST-PATH: ПАРСИНГ НА CLOUDFLARE WORKER
    try {
      const response = await fetch(targetUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 NeuroLens/1.0",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
        },
        cf: { cacheTtl: 3600 }
      });

      if (!response.ok) {
        throw new Error(`Целевой сайт вернул статус ${response.status}`);
      }

      const rawHtml = await response.text();

      // Детекция пустого SPA каркаса или Cloudflare Turnstile защиты
      const isSpaOrProtected = (rawHtml.length < 1500 && rawHtml.includes("id=\"root\"")) || 
                               rawHtml.includes("Just a moment...") || 
                               rawHtml.includes("cf-turnstile");

      if (isSpaOrProtected && env.DENO_FALLBACK_URL) {
        // Прозрачная переадресация на спасательный круг Deno Deploy
        return fetch(`${env.DENO_FALLBACK_URL}/${encodeURIComponent(targetUrl)}`, { headers: request.headers });
      }

      const extracted = parseHtmlToMarkdown(rawHtml, targetUrl);

      // Сохраняем в D1 SQL
      if (env.DB) {
        try {
          await env.DB.prepare(`
            INSERT INTO cache (url, title, markdown, tokens_estimate, tokens_saved, created_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(url) DO UPDATE SET
              title=excluded.title,
              markdown=excluded.markdown,
              tokens_estimate=excluded.tokens_estimate,
              tokens_saved=excluded.tokens_saved,
              created_at=datetime('now');
          `).bind(
            targetUrl,
            extracted.title,
            extracted.markdown,
            extracted.tokens_estimate,
            extracted.tokens_saved
          ).run();
        } catch (err) {
          console.error("Ошибка сохранения в D1:", err);
        }
      }

      return formatOutput(request, {
        title: extracted.title,
        url: targetUrl,
        markdown: extracted.markdown,
        tokens_estimate: extracted.tokens_estimate,
        tokens_saved: extracted.tokens_saved,
        cached: false,
        engine: "edge-fast"
      }, corsHeaders);

    } catch (err) {
      // Fallback на Deno, если Cloudflare словил тайм-аут или ошибку сети
      if (env.DENO_FALLBACK_URL) {
        return fetch(`${env.DENO_FALLBACK_URL}/${encodeURIComponent(targetUrl)}`, { headers: request.headers });
      }

      return new Response(JSON.stringify({ error: err.message, engine: "edge-fast-error" }), {
        status: 502,
        headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders }
      });
    }
  }
};

// Инициализация таблицы D1
async function initD1(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS cache (
      url TEXT PRIMARY KEY,
      title TEXT,
      markdown TEXT,
      tokens_estimate INTEGER,
      tokens_saved INTEGER,
      created_at TEXT
    );
  `).run();
}

// Легковесный Markdown-экстрактор
function parseHtmlToMarkdown(html, pageUrl) {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "Без заголовка";

  let body = html;
  body = body.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  body = body.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
  body = body.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "");
  body = body.replace(/<(nav|footer|header|aside|noscript|iframe)[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Заголовки
  body = body.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n\n# $1\n\n");
  body = body.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n\n## $1\n\n");
  body = body.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n\n### $1\n\n");
  body = body.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n\n#### $1\n\n");

  // Блоки и списки
  body = body.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n* $1");
  body = body.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n\n$1\n\n");
  body = body.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n");
  body = body.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // Ссылки и форматирование
  body = body.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  body = body.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  body = body.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");

  // Вычищаем оставшиеся HTML теги
  body = body.replace(/<[^>]+>/g, "");

  // Чистка переносов и пробелов
  body = body
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n\s*\n\s*\n/g, "\n\n")
    .trim();

  const finalMarkdown = `# ${title}\n\n*Источник: [${pageUrl}](${pageUrl})*\n\n---\n\n${body}`;

  const rawTokens = Math.ceil(html.length / 4);
  const cleanTokens = Math.ceil(finalMarkdown.length / 4);
  const savedTokens = Math.max(0, rawTokens - cleanTokens);

  return {
    title,
    markdown: finalMarkdown,
    tokens_estimate: cleanTokens,
    tokens_saved: savedTokens
  };
}

// Форматирование ответа (Markdown vs JSON)
function formatOutput(request, data, cors) {
  const accept = request.headers.get("Accept") || "";
  const userAgent = request.headers.get("User-Agent") || "";
  const isTerminal = userAgent.includes("curl") || userAgent.includes("Wget");

  if (accept.includes("text/markdown") || isTerminal) {
    return new Response(data.markdown, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "X-Engine": data.engine,
        "X-Tokens-Estimate": String(data.tokens_estimate),
        "X-Tokens-Saved": String(data.tokens_saved),
        ...cors
      }
    });
  }

  return new Response(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors }
  });
}

// Витрина NeuroLens
function handleLanding(request, cors) {
  const origin = new URL(request.url).origin;
  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>NeuroLens // Фокусирующий Markdown-ридер для LLM</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Space+Grotesk:wght@600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #030712;
      --card-bg: rgba(15, 23, 42, 0.45);
      --card-border: rgba(255, 255, 255, 0.16);
      --cyan: #00f2fe;
      --green: #10b981;
      --purple: #b829ff;
      --text: #f8fafc;
      --muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%; min-height: 100%;
      background-color: var(--bg);
      color: var(--text);
      font-family: 'Space Grotesk', sans-serif;
      overflow-x: hidden; position: relative;
    }
    body { padding: 20px 16px; display: flex; flex-direction: column; align-items: center; justify-content: center; }

    #lava-canvas {
      position: fixed; top: 0; left: 0;
      width: 100vw; height: 100vh;
      z-index: 0; pointer-events: none;
      filter: contrast(1.25) saturate(1.3);
    }
    .frosted-backdrop {
      position: fixed; top: 0; left: 0;
      width: 100vw; height: 100vh;
      background: rgba(3, 7, 18, 0.68);
      backdrop-filter: blur(48px) saturate(220%);
      -webkit-backdrop-filter: blur(48px) saturate(220%);
      pointer-events: none; z-index: 1;
    }
    .grid-overlay {
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background-image: 
        linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
      background-size: 32px 32px; pointer-events: none; z-index: 2;
    }
    .container { width: 100%; max-width: 620px; position: relative; z-index: 3; }

    .hero-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
      border-radius: 24px; padding: 28px;
      box-shadow: 0 24px 55px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.22);
      display: flex; flex-direction: column; gap: 18px;
    }
    .hero-top { display: flex; justify-content: space-between; align-items: center; }
    .badge {
      font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; font-weight: 700;
      padding: 4px 10px; border-radius: 20px;
      background: rgba(0, 242, 254, 0.15); border: 1px solid rgba(0, 242, 254, 0.4);
      color: var(--cyan); letter-spacing: 0.8px;
    }
    h1 { font-size: 1.8rem; letter-spacing: 1.5px; font-weight: 700; }
    p.desc { font-size: 0.88rem; color: var(--muted); line-height: 1.5; font-family: 'Space Grotesk', sans-serif; }

    .input-group {
      display: flex; gap: 10px; margin-top: 8px; flex-wrap: wrap;
    }
    input[type="text"] {
      flex: 1; min-width: 240px;
      background: rgba(0, 0, 0, 0.5);
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 12px; padding: 14px 16px;
      color: #fff; font-family: 'JetBrains Mono', monospace; font-size: 0.88rem;
      outline: none; transition: border-color 0.2s;
    }
    input[type="text"]:focus { border-color: var(--cyan); }
    button.btn-extract {
      background: linear-gradient(135deg, #00f2fe, #4facfe);
      border: none; border-radius: 12px; padding: 14px 22px;
      color: #000; font-weight: 700; font-family: 'Space Grotesk', sans-serif;
      font-size: 0.88rem; cursor: pointer; transition: transform 0.15s, opacity 0.15s;
    }
    button.btn-extract:active { transform: scale(0.97); }

    .api-preview {
      margin-top: 10px; background: rgba(0, 0, 0, 0.45);
      border: 1px dashed rgba(255, 255, 255, 0.12);
      border-radius: 12px; padding: 14px;
      font-family: 'JetBrains Mono', monospace; font-size: 0.78rem;
      color: #94a3b8; display: flex; flex-direction: column; gap: 6px;
    }
    .api-preview span.cmd { color: #38bdf8; word-break: break-all; }
  </style>
</head>
<body>
  <canvas id="lava-canvas"></canvas>
  <div class="frosted-backdrop"></div>
  <div class="grid-overlay"></div>

  <div class="container">
    <div class="hero-card">
      <div class="hero-top">
        <div style="display: flex; align-items: center; gap: 10px;">
          <div style="width: 12px; height: 12px; border-radius: 50%; background: var(--cyan); box-shadow: 0 0 16px var(--cyan);"></div>
          <span style="font-size: 1.1rem; font-weight: 700;">NEUROLENS</span>
        </div>
        <div class="badge">EDGE PARSER</div>
      </div>

      <h1>Фокус веба для нейросетей</h1>
      <p class="desc">
        Сервис сдирает рекламу, скрипты, навигацию и куки-баннеры, превращая любую страницу в чистый, токеносберегающий Markdown.
      </p>

      <div class="input-group">
        <input type="text" id="target-input" placeholder="https://habr.com/ru/articles/..." />
        <button class="btn-extract" onclick="handleRun()">Фокусировать ▶</button>
      </div>

      <div class="api-preview">
        <div><strong>ПРЕФИКСНЫЙ API ДЛЯ LLM / CURL:</strong></div>
        <span class="cmd" id="example-cmd">curl -s "${origin}/https://example.com"</span>
      </div>
    </div>
  </div>

  <script>
    const canvas = document.getElementById('lava-canvas');
    const ctx = canvas.getContext('2d');
    function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
    window.addEventListener('resize', resize);
    resize();

    const mouse = { x: -9999, y: -9999, active: false };
    function setPointer(e) {
      mouse.x = e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : -9999);
      mouse.y = e.clientY || (e.touches && e.touches[0] ? e.touches[0].clientY : -9999);
      mouse.active = true;
    }
    window.addEventListener('pointermove', setPointer);
    window.addEventListener('pointerdown', setPointer);
    window.addEventListener('touchmove', setPointer, { passive: true });
    window.addEventListener('touchstart', setPointer, { passive: true });
    window.addEventListener('pointerleave', () => { mouse.active = false; mouse.x = -9999; mouse.y = -9999; });
    window.addEventListener('touchend', () => { mouse.active = false; mouse.x = -9999; mouse.y = -9999; });

    const PALETTE = [
      { core: '#00f7ff', border: '#70fdff', rgb: '0, 247, 255' },
      { core: '#b829ff', border: '#df85ff', rgb: '184, 41, 255' },
      { core: '#ff1493', border: '#ff77c2', rgb: '255, 20, 147' }
    ];

    class NeonBubble {
      constructor() { this.reset(true); }
      reset(init = false) {
        this.x = Math.random() * canvas.width;
        this.y = init ? Math.random() * canvas.height : canvas.height + 160;
        this.baseRadius = 65 + Math.random() * 55;
        this.speed = 0.55 + Math.random() * 0.85;
        this.vx = 0; this.vy = 0;
        this.theme = PALETTE[Math.floor(Math.random() * PALETTE.length)];
        this.points = 8;
        this.wobblePhase = Math.random() * Math.PI * 2;
        this.wobbleSpeed = 0.02 + Math.random() * 0.02;
        this.drift = (Math.random() - 0.5) * 0.45;
      }
      update() {
        this.y -= this.speed; this.x += this.drift;
        this.wobblePhase += this.wobbleSpeed;
        if (mouse.active) {
          const dx = this.x - mouse.x, dy = this.y - mouse.y;
          const dist = Math.hypot(dx, dy);
          const maxDist = this.baseRadius + 140;
          if (dist < maxDist && dist > 0) {
            const force = (1 - dist / maxDist) * 7.5;
            this.vx += (dx / dist) * force;
            this.vy += (dy / dist) * force;
          }
        }
        this.x += this.vx; this.y += this.vy;
        this.vx *= 0.88; this.vy *= 0.88;
        if (this.y < -this.baseRadius * 2) this.reset(false);
      }
      draw() {
        ctx.save();
        ctx.beginPath();
        for (let i = 0; i <= this.points; i++) {
          const angle = (i / this.points) * Math.PI * 2;
          const wobble = Math.sin(this.wobblePhase + i * 1.5) * (this.baseRadius * 0.2);
          const r = this.baseRadius + wobble;
          const px = this.x + Math.cos(angle) * r, py = this.y + Math.sin(angle) * r * 1.12;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        const fillGrad = ctx.createRadialGradient(
          this.x - this.baseRadius * 0.25, this.y - this.baseRadius * 0.25, 2,
          this.x, this.y, this.baseRadius * 1.05
        );
        fillGrad.addColorStop(0, '#ffffff');
        fillGrad.addColorStop(0.3, this.theme.border);
        fillGrad.addColorStop(0.85, this.theme.core);
        fillGrad.addColorStop(1, this.theme.core);
        ctx.fillStyle = fillGrad; ctx.fill();
        ctx.globalCompositeOperation = 'lighter';
        ctx.shadowColor = 'rgb(' + this.theme.rgb + ')';
        ctx.shadowBlur = 80;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 5; ctx.stroke();
        ctx.restore();
      }
    }

    const bubbles = Array.from({ length: 8 }, () => new NeonBubble());
    function render() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      bubbles.forEach(b => { b.update(); b.draw(); });
      requestAnimationFrame(render);
    }
    render();

    function handleRun() {
      const val = document.getElementById('target-input').value.trim();
      if (!val) return;
      window.location.href = '/' + val;
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", ...cors }
  });
}
