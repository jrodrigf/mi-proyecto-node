const http = require('http');
const WebSocket = require('ws');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');


console.log('🚀 Remote Browser - EVENT-DRIVEN + SAFE CAPTURE + EXTRA FRAME + SCROLL-FRIENDLY');
console.log('===============================================================================');

// ----------------- CONFIGURACIÓN -----------------
const PORT = Number(process.env.REMOTE_PORT || 8080);

// Retardo tras interacción (click/tecla) para enviar frame rápido
const INTERACTION_FRAME_DELAY_MS = Number(process.env.INTERACTION_FRAME_DELAY_MS || 50);

// Retardo extra después de CUALQUIER evento (click/scroll/tecla/nav) para capturar lo que haya cargado
const POST_EVENT_EXTRA_DELAY_MS = Number(process.env.POST_EVENT_EXTRA_DELAY_MS || 1500);

// Retardo tras navegación (reload/back/forward) para dar tiempo a la carga inicial
const NAV_FRAME_DELAY_MS = Number(process.env.NAV_FRAME_DELAY_MS || 300);

// Calidad JPEG por defecto
const SCREENSHOT_QUALITY = Number(process.env.SCREENSHOT_QUALITY || 75);

// Timeout de screenshot (para webs lentas / fuentes)
const SCREENSHOT_TIMEOUT_MS = Number(process.env.SCREENSHOT_TIMEOUT_MS || 5000);

// Cada cuánto se hace sweep de navegadores sin sesiones activas
const BROWSER_SWEEP_INTERVAL_MS = Number(process.env.BROWSER_SWEEP_INTERVAL_MS || 300000);

// Intervalo mínimo entre frames durante scroll continuo
const MIN_SCROLL_FRAME_INTERVAL_MS = Number(process.env.MIN_SCROLL_FRAME_INTERVAL_MS || 120);

// ------------------------------------------------
const userBrowsers = new Map();   // userId -> browser
const activeSessions = new Map(); // sessionKey -> { page, context, browser }

console.log('⚙️  Config:');
console.log(`   - INTERACTION_FRAME_DELAY_MS   = ${INTERACTION_FRAME_DELAY_MS}`);
console.log(`   - POST_EVENT_EXTRA_DELAY_MS    = ${POST_EVENT_EXTRA_DELAY_MS}`);
console.log(`   - NAV_FRAME_DELAY_MS           = ${NAV_FRAME_DELAY_MS}`);
console.log(`   - SCREENSHOT_QUALITY           = ${SCREENSHOT_QUALITY}`);
console.log(`   - SCREENSHOT_TIMEOUT_MS        = ${SCREENSHOT_TIMEOUT_MS}`);
console.log(`   - BROWSER_SWEEP_INTERVAL_MS    = ${BROWSER_SWEEP_INTERVAL_MS}`);
console.log(`   - MIN_SCROLL_FRAME_INTERVAL_MS = ${MIN_SCROLL_FRAME_INTERVAL_MS}`);

const server = http.createServer((req, res) => {
  try {
    const clientHtml = fs.readFileSync(path.join(__dirname, 'client.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(clientHtml);
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>Remote Browser Simple</h1>');
  }
});

const wss = new WebSocket.Server({ server });

wss.on('connection', async (ws, req) => {
  console.log('🔗 Nueva conexión WebSocket');

  let sessionKey;
  let lastScreenshotHash = null;

  // Flags de captura segura
  let isCapturing = false;
  let pendingCapture = false;
  let lastTimeoutLogTs = 0;

  // Estado específico para scroll
  let lastScrollFrameTs = 0;
  let scrollSettleTimer = null;

  // ===== ENVIAR FRAMES (con dedupe por hash + no paralelo) =====
  async function sendFrame(page, options = { force: false }) {
    try {
      if (!page || page.isClosed()) return;

      if (isCapturing) {
        pendingCapture = true;
        return;
      }
      isCapturing = true;

      const screenshot = await page.screenshot({
        type: 'jpeg',
        quality: SCREENSHOT_QUALITY,
        fullPage: false,
        timeout: SCREENSHOT_TIMEOUT_MS
      });

      const hash = crypto.createHash('md5').update(screenshot).digest('hex');

      if (!options.force && hash === lastScreenshotHash) {
        return;
      }
      lastScreenshotHash = hash;

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(screenshot);
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (msg.includes('Target closed') || msg.includes('closed')) {
        if (sessionKey && activeSessions.has(sessionKey)) {
          activeSessions.delete(sessionKey);
        }
      } else if (msg.includes('Timeout') && msg.includes('page.screenshot')) {
        const now = Date.now();
        // no spamear el mismo timeout cada milisegundo
        if (now - lastTimeoutLogTs > 3000) {
          console.log(`⚠️ Timeout en sendFrame (screenshot): ${msg}`);
          lastTimeoutLogTs = now;
        }
      } else {
        console.log(`⚠️ Error en sendFrame: ${msg}`);
      }
    } finally {
      isCapturing = false;
      if (pendingCapture && page && !page.isClosed()) {
        pendingCapture = false;
        setTimeout(() => {
          sendFrame(page).catch(() => {});
        }, INTERACTION_FRAME_DELAY_MS);
      }
    }
  }

  // ===== SCHEDULES DE FRAMES =====
  function scheduleEventFrames(page, immediateDelay) {
    setTimeout(() => sendFrame(page), immediateDelay);
    setTimeout(() => sendFrame(page), POST_EVENT_EXTRA_DELAY_MS);
  }

  function scheduleNavFrames(page, forceFirst = true) {
    setTimeout(() => sendFrame(page, { force: forceFirst }), NAV_FRAME_DELAY_MS);
    setTimeout(() => sendFrame(page, { force: false }), POST_EVENT_EXTRA_DELAY_MS);
  }

  function scheduleScrollFrames(page) {
    const now = Date.now();

    // Frame "en caliente" durante scroll como máximo cada X ms
    if (now - lastScrollFrameTs > MIN_SCROLL_FRAME_INTERVAL_MS) {
      lastScrollFrameTs = now;
      setTimeout(() => sendFrame(page), INTERACTION_FRAME_DELAY_MS);
    }

    // Frame final cuando el usuario deja de scrollear (se resetea en cada wheel)
    if (scrollSettleTimer) clearTimeout(scrollSettleTimer);
    scrollSettleTimer = setTimeout(() => {
      lastScrollFrameTs = Date.now();
      sendFrame(page).catch(() => {});
    }, POST_EVENT_EXTRA_DELAY_MS);
  }

  function setupInteractionHandler(websocket, page, sKey) {
    websocket.on('message', async (message) => {
      if (!page || page.isClosed()) return;

      try {
        const data = JSON.parse(message);

        switch (data.type) {
          case 'click':
            await page.mouse.click(data.x, data.y, {
              button: data.button || 'left'
            });
            scheduleEventFrames(page, INTERACTION_FRAME_DELAY_MS);
            break;

          case 'scroll': {
            const deltaX = (data.deltaX || 0) * 1.5;
            const deltaY = (data.deltaY || 0) * 1.5;
            await page.mouse.wheel(deltaX, deltaY);
            scheduleScrollFrames(page);
            break;
          }

          case 'key':
            if (data.key) {
              await page.keyboard.press(data.key);
            } else if (data.text) {
              await page.keyboard.type(data.text);
            }
            scheduleEventFrames(page, INTERACTION_FRAME_DELAY_MS);
            break;

          case 'reload':
            await page.reload({ waitUntil: 'domcontentloaded' });
            scheduleNavFrames(page, true);
            break;

          case 'back':
            await page.goBack({ waitUntil: 'domcontentloaded' });
            scheduleNavFrames(page, true);
            break;

          case 'forward':
            await page.goForward({ waitUntil: 'domcontentloaded' });
            scheduleNavFrames(page, true);
            break;
        }
      } catch (err) {
        console.log(`⚠️ Error interacción: ${err.message}`);
      }
    });

    websocket.on('close', () => {
      console.log(`🔌 ${sKey} desconectado`);

      if (scrollSettleTimer) {
        clearTimeout(scrollSettleTimer);
        scrollSettleTimer = null;
      }

      setTimeout(() => {
        if (activeSessions.has(sKey)) {
          const session = activeSessions.get(sKey);
          activeSessions.delete(sKey);
          if (session.context) {
            session.context.close().catch(() => {});
          }
        }
      }, 30000);
    });
  }

  // ===== LÓGICA DE SESIÓN =====
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const params = url.searchParams;

    const userId = params.get('userId') || 'user_' + Date.now();
    const sessionId = params.get('sessionId') || 'session_' + Date.now();
    const targetUrl = params.get('url') || 'https://es.wikipedia.org';

    console.log(`📱 ${userId}/${sessionId} -> ${targetUrl}`);

    sessionKey = `${userId}_${sessionId}`;
    let existingSession = activeSessions.get(sessionKey);

    // REUTILIZAR SESIÓN
    if (existingSession && existingSession.page && !existingSession.page.isClosed()) {
      console.log(`♻️ Reutilizando sesión existente: ${sessionKey}`);
      const { page } = existingSession;

      lastScreenshotHash = null;
      lastScrollFrameTs = 0;
      scrollSettleTimer = null;

      setTimeout(() => sendFrame(page, { force: true }), 100);
      setTimeout(() => sendFrame(page, { force: false }), POST_EVENT_EXTRA_DELAY_MS);

      setupInteractionHandler(ws, page, sessionKey);
      return;
    }

    // CREAR NUEVA SESIÓN
    let browser;
    if (!userBrowsers.has(userId)) {
      console.log(`🆕 Nuevo navegador para ${userId}`);
      browser = await chromium.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,720']
      });
      userBrowsers.set(userId, browser);
    } else {
      browser = userBrowsers.get(userId);
    }

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 }
    });

    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 720 });

    console.log(`🌐 Navegando a ${targetUrl}...`);
    try {
      await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      });
      console.log(`✅ Página cargada: ${await page.title()}`);
    } catch (err) {
      console.log(`⚠️ Error navegación: ${err.message}`);
      await page.goto('about:blank');
    }

    activeSessions.set(sessionKey, { page, context, browser });
    console.log(`✅ ${userId}/${sessionId} listo`);

    lastScreenshotHash = null;
    lastScrollFrameTs = 0;
    scrollSettleTimer = null;

    setTimeout(() => sendFrame(page, { force: true }), 100);
    setTimeout(() => sendFrame(page, { force: false }), POST_EVENT_EXTRA_DELAY_MS);

    setupInteractionHandler(ws, page, sessionKey);
  } catch (error) {
    console.error(`❌ Error crítico: ${error.message}`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  }
});

// Sweep periódico: sesiones + navegadores inactivos
setInterval(async () => {
  console.log(`🧹 Sweep: ${activeSessions.size} sesiones activas, ${userBrowsers.size} navegadores`);

  for (const [userId, browser] of userBrowsers) {
    const stillUsed = [...activeSessions.values()].some(s => s.browser === browser);
    if (!stillUsed) {
      console.log(`🧹 Cerrando navegador sin sesiones para userId=${userId}`);
      try {
        await browser.close();
      } catch (e) {
        console.log(`⚠️ Error al cerrar browser de ${userId}: ${e.message}`);
      }
      userBrowsers.delete(userId);
    }
  }
}, BROWSER_SWEEP_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`✅ Servidor: http://localhost:${PORT}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}`);
  console.log('\n🎯 Características:');
  console.log('- Repintado SOLO por eventos (click, scroll, teclado, navegación)');
  console.log('- Scroll con máximo ~8 fps (MIN_SCROLL_FRAME_INTERVAL_MS) + frame final de estabilización');
  console.log('- Frame extra 1.5s después de cada evento (POST_EVENT_EXTRA_DELAY_MS)');
  console.log('- Capturas no paralelas + dedupe por hash');
  console.log('- Timeouts de screenshot controlados (reduce spam y evita bloqueos visuales)');
});