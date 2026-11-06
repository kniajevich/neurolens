/**
 * NeuroLens — Two-Tier Web-to-Markdown LLM Gateway
 * Cloudflare Worker + D1 SQL + Deno Readability Fallback + Token Limiter
 */

const LANDING_HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NeuroLens — Focus Web for LLMs</title>
  <style>
    :root {
      --bg: #090a10;
      --card-bg: rgba(22, 27, 46, 0.7);
      --accent: #00f2fe;
      --accent-grad: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
      --text: #f1f5f9;
      --text-dim: #94a3b8;
      --border: rgba(255, 255, 255, 0.1);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body {
      background-color: var(--bg);
      background-image: 
        radial-gradient(at 0% 0%, rgba(79, 172, 254, 0.15) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(0, 242, 254, 0.12) 0px, transparent 50%),
        linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
      background-size: 100% 100%, 100% 100%, 30px 30px, 30px 30px;
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .glass-card {
      background: var(--card-bg);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 40px;
      max-width: 520px;
      width: 100%;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6), 0 0 40px rgba(0, 242, 254, 0.1);
    }
    .header-tag {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      color: var(--accent);
      margin-bottom: 16px;
    }
    .header-tag::before {
      content: "";
      width: 8px;
      height: 8px;
      background: var(--accent);
      border-radius: 50%;
      box-shadow: 0 0 10px var(--accent);
    }
    h1 { font-size: 28px; font-weight: 800; line-height: 1.25; margin-bottom: 12px; }
    p { font-size: 14px; line-height: 1.6; color: var(--text-dim); margin-bottom: 24px; }
    .input-group { display: flex; flex-direction: column; gap: 12px; margin-bottom: 24px; }
    input {
      width: 100%;
      padding: 14px 16px;
      border-radius: 12px;
      background: rgba(10, 15, 30, 0.8);
      border: 1px solid var(--border);
      color: #fff;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus { border-color: var(--accent); }
    button {
      padding: 14px;
      border-radius: 12px;
      background: var(--accent-grad);
      border: none;
      color: #050b14;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: transform 0.1s, box-shadow 0.2s;
    }
    button:hover {
      box-shadow: 0 0 20px rgba(0, 242, 254, 0.4);
      transform: translateY(-1px);
    }
    .api-hint {
      background: rgba(0, 0, 0, 0.3);
      border-radius: 12px;
      padding: 16px;
      border: 1px dashed rgba(255, 255, 255, 0.15);
      font-family: monospace;
      font-size: 12px;
      color: var(--text-dim);
      word-break: break-all;
    }
    .api-hint b { color: var(--accent); }
  </style>
</head>
<body>
  <div class="glass-card">
    <div class="header-tag">NeuroLens • Edge Gateway</div>
    <h1>Фокус веба для нейросетей</h1>
    <p>Мгновенный стриппинг HTML-мусора в чистый токеносберегающий Markdown с защитой и кэшированием в D1 SQL.</p>
    
    <div class="input-group">
      <input type="text" id="targetUrl" placeholder="https://habr.com/ru/articles/..." value="https://habr.com/ru/articles/869506/">
      <input type="text" id="tokenInput" placeholder="API токен (X-API-Key)">
      <button onclick="go()">Фокусировать ▶</button>
    </div>

    <div class="api-hint">
      <b>PREF-API:</b><br>
      curl -H "X-API-Key: &lt;TOKEN&gt;" "https://neurolens.goldman-ao.workers.dev/https://example.com"
    </div>
  </div>

  <script>
    function go() {
      const url = document.getElementById('targetUrl').value.trim();
      const token = document.getElementById('tokenInput').value.trim();
      if (!url) return;
      let target = '/' + url;
      if (token) target += '?token=' + encodeURIComponent(token);
      window.location.href = target;
    }
  </script>
</body>
</html>`;

/**
 * Валидация токена и учет суточных лимитов в базе D1
 */
async function authenticateToken(request, db) {
  const url = new URL(request.url);

  let token = request.headers.get("X-API-Key");
  if (!token) {
    const authHeader = request.headers.get("Authorization") || "";
    if (authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7).trim();
    }
  }
  if (!token) {
    token = url.searchParams.get("token");
  }

  if (!token) {
    return { 
      ok: false, 
      status: 401, 
      error: "Missing API token. Provide header 'X-API-Key' or '?token=' param." 
    };
  }

  // Поиск токена в таблице D1
  const record = await db
    .prepare("SELECT * FROM api_tokens WHERE token = ?")
    .bind(token)
    .first();

  if (!record) {
    return { ok: false, status: 403, error: "Invalid API token." };
  }

  // Мастер-токен без ограничений
  if (record.is_master === 1) {
    return { ok: true, isMaster: true, owner: record.owner };
  }

  // Проверка суточного лимита (по UTC)
  const today = new Date().toISOString().slice(0, 10);
  let currentCount = record.requests_today;

  if (record.last_reset_date !== today) {
    currentCount = 0;
    await db
      .prepare("UPDATE api_tokens SET requests_today = 1, last_reset_date = ? WHERE token = ?")
      .bind(today, token)
      .run();
    return { ok: true, isMaster: false, remaining: record.daily_limit - 1 };
  }

  if (currentCount >= record.daily_limit) {
    return { 
      ok: false, 
      status: 429, 
      error: `Daily limit reached (${record.daily_limit} req/day). Resets at 00:00 UTC.` 
    };
  }

  await db
    .prepare("UPDATE api_tokens SET requests_today = requests_today + 1 WHERE token = ?")
    .bind(token)
    .run();

  return { ok: true, isMaster: false, remaining: record.daily_limit - (currentCount + 1) };
}

/**
 * Быстрый парсер Edge HTML -> Markdown
 */
function fastCleanHtmlToMarkdown(html, pageUrl) {
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "")
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "")
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, "")
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, "");

  const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "Без заголовка";

  text = text.replace(/<h1[^>]*>(.*?)<\/h1>/gi, "\n# $1\n");
  text = text.replace(/<h2[^>]*>(.*?)<\/h2>/gi, "\n## $1\n");
  text = text.replace(/<h3[^>]*>(.*?)<\/h3>/gi, "\n### $1\n");
  text = text.replace(/<a\s+(?:[^>]*?\s+)?href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)");
  text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, "\n* $1");
  text = text.replace(/<p[^>]*>(.*?)<\/p>/gi, "\n\n$1\n\n");
  text = text.replace(/<br\s*[\/]?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");

  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/g, "/")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();

  const finalMarkdown = `# ${title}\n\n*Источник: [${pageUrl}](${pageUrl})*\n\n---\n\n${text}`;
  return { title, markdown: finalMarkdown };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 1. Главная страница (витрина отдается свободно)
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(LANDING_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // 2. Валидация API-токена
    const auth = await authenticateToken(request, env.DB);
    if (!auth.ok) {
      return new Response(JSON.stringify({ error: auth.error }), {
        status: auth.status,
        headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders },
      });
    }

    // 3. Извлечение целевого адреса
    let targetUrl = url.pathname.slice(1);
    if (url.searchParams.has("url")) {
      targetUrl = url.searchParams.get("url");
    }

    try {
      targetUrl = decodeURIComponent(targetUrl);
    } catch (_) {}

    if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
      return new Response(
        JSON.stringify({ error: "Укажите корректный URL: /https://example.com" }),
        { status: 400, headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders } }
      );
    }

    // 4. Проверка кэша D1
    try {
      const cached = await env.DB
        .prepare("SELECT title, markdown, tokens_estimate, tokens_saved FROM cache WHERE url = ?")
        .bind(targetUrl)
        .first();

      if (cached) {
        return new Response(
          JSON.stringify({
            title: cached.title,
            url: targetUrl,
            markdown: cached.markdown,
            tokens_estimate: cached.tokens_estimate,
            tokens_saved: cached.tokens_saved,
            cached: true,
            engine: "edge-d1-cache",
          }),
          { headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders } }
        );
      }
    } catch (_) {}

    // 5. Запрос целевого сайта и парсинг
    try {
      const response = await fetch(targetUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 NeuroLens/1.0",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const html = await response.text();
      let { title, markdown } = fastCleanHtmlToMarkdown(html, targetUrl);
      let engine = "edge-fast";

      // Если разметка слишком короткая — передаем Deno Heavy
      if (markdown.length < 500 && env.DENO_FALLBACK_URL) {
        try {
          const denoRes = await fetch(`${env.DENO_FALLBACK_URL}/${encodeURIComponent(targetUrl)}`);
          if (denoRes.ok) {
            const denoData = await denoRes.json();
            if (denoData.markdown) {
              markdown = denoData.markdown;
              title = denoData.title || title;
              engine = "deno-heavy-readability";
            }
          }
        } catch (_) {}
      }

      const rawTokens = Math.ceil(html.length / 4);
      const cleanTokens = Math.ceil(markdown.length / 4);
      const savedTokens = Math.max(0, rawTokens - cleanTokens);

      // Фоновое сохранение в D1
      ctx.waitUntil(
        env.DB.prepare(
          "INSERT OR REPLACE INTO cache (url, title, markdown, tokens_estimate, tokens_saved, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
        )
        .bind(targetUrl, title, markdown, cleanTokens, savedTokens)
        .run()
        .catch(() => {})
      );

      return new Response(
        JSON.stringify({
          title,
          url: targetUrl,
          markdown,
          tokens_estimate: cleanTokens,
          tokens_saved: savedTokens,
          cached: false,
          engine,
        }),
        { headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders } }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message, engine: "error-handler" }),
        { status: 502, headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders } }
      );
    }
  },
};
