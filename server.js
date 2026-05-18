require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// CONFIGURACIÓN (desde .env)
// ============================================================
const CONFIG = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID:   process.env.TELEGRAM_CHAT_ID,
  HOUSE_LAT:          parseFloat(process.env.HOUSE_LAT   || '-34.6037'),
  HOUSE_LNG:          parseFloat(process.env.HOUSE_LNG   || '-58.3816'),
  ALLOWED_RADIUS:     parseInt(process.env.ALLOWED_RADIUS_METERS || '100'),
  PORT:               parseInt(process.env.PORT || '3000'),
  SERVER_URL:         process.env.SERVER_URL || 'http://localhost:3000',
  HOME_NAME:          process.env.HOME_NAME || 'Mi Casa',
};

// ============================================================
// ESTADO EN MEMORIA
// ============================================================
let lastRingTime = null;
let ringCount = 0;
let lastRings = []; // historial de las últimas 10 llamadas

// ============================================================
// RATE LIMITING — máximo 1 llamada cada 30 segundos por IP
// ============================================================
const ringLimiter = rateLimit({
  windowMs: 30 * 1000, // 30 segundos
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Espera unos segundos antes de volver a tocar el timbre.',
    code: 'RATE_LIMIT'
  }
});

// ============================================================
// FUNCIÓN: Calcular distancia entre dos coordenadas (Haversine)
// Retorna la distancia en metros
// ============================================================
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Radio de la Tierra en metros
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ============================================================
// FUNCIÓN: Enviar notificación a Telegram
// ============================================================
async function sendTelegramNotification(distanceMeters) {
  const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;

  const now = new Date();
  const hora = now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  const fecha = now.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });

  const mensaje =
    `🔔 *¡Alguien está en la puerta!*\n\n` +
    `🏠 *${CONFIG.HOME_NAME}*\n` +
    `🕐 ${hora} — ${fecha}\n` +
    `📍 A ${Math.round(distanceMeters)} metros de la puerta\n\n` +
    `_Escaneó el QR del timbre_`;

  const response = await axios.post(url, {
    chat_id: CONFIG.TELEGRAM_CHAT_ID,
    text: mensaje,
    parse_mode: 'Markdown'
  });

  return response.data.ok;
}

// ============================================================
// RUTAS DE LA API
// ============================================================

// POST /ring — El visitante toca el timbre
app.post('/ring', ringLimiter, async (req, res) => {
  const { lat, lng } = req.body;

  // Validar que se enviaron coordenadas
  if (lat === undefined || lng === undefined || isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({
      success: false,
      error: 'No se pudo obtener tu ubicación. Asegurate de permitir el acceso al GPS.',
      code: 'NO_LOCATION'
    });
  }

  // Calcular distancia
  const distance = haversineDistance(CONFIG.HOUSE_LAT, CONFIG.HOUSE_LNG, lat, lng);
  console.log(`[RING] Visitante a ${Math.round(distance)}m de la puerta | Coords: ${lat}, ${lng}`);

  // Verificar si está dentro del radio permitido
  if (distance > CONFIG.ALLOWED_RADIUS) {
    console.log(`[BLOCKED] Demasiado lejos: ${Math.round(distance)}m > ${CONFIG.ALLOWED_RADIUS}m`);
    return res.status(403).json({
      success: false,
      error: `Estás a ${Math.round(distance)} metros de la puerta. El timbre solo funciona desde la entrada.`,
      distance: Math.round(distance),
      allowedRadius: CONFIG.ALLOWED_RADIUS,
      code: 'TOO_FAR'
    });
  }

  // Enviar notificación Telegram
  try {
    const sent = await sendTelegramNotification(distance);

    if (sent) {
      lastRingTime = new Date();
      ringCount++;

      // Guardar en historial (máximo 10)
      lastRings.unshift({
        time: lastRingTime.toISOString(),
        distance: Math.round(distance),
        ip: req.ip
      });
      if (lastRings.length > 10) lastRings.pop();

      console.log(`[OK] Notificación enviada. Total: ${ringCount}`);
      return res.json({
        success: true,
        message: '¡Notificación enviada! El dueño de casa ya sabe que estás en la puerta.',
        distance: Math.round(distance)
      });
    } else {
      throw new Error('Telegram API retornó ok: false');
    }
  } catch (err) {
    console.error('[ERROR] Telegram:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Hubo un error enviando la notificación. Intentá de nuevo.',
      code: 'TELEGRAM_ERROR'
    });
  }
});

// GET /status — Estado del servidor (para el panel admin)
app.get('/status', (req, res) => {
  res.json({
    online: true,
    homeName: CONFIG.HOME_NAME,
    houseCoords: { lat: CONFIG.HOUSE_LAT, lng: CONFIG.HOUSE_LNG },
    allowedRadius: CONFIG.ALLOWED_RADIUS,
    ringCount,
    lastRingTime,
    lastRings,
    serverUrl: CONFIG.SERVER_URL,
    telegramConfigured: !!CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.TELEGRAM_BOT_TOKEN !== '1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi'
  });
});

// GET /qr — Genera el QR como imagen PNG
app.get('/qr', async (req, res) => {
  const ringUrl = `${CONFIG.SERVER_URL}/`;
  try {
    const qrBuffer = await QRCode.toBuffer(ringUrl, {
      type: 'png',
      width: 400,
      margin: 2,
      color: {
        dark: '#1a1a2e',
        light: '#ffffff'
      },
      errorCorrectionLevel: 'H'
    });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache');
    res.send(qrBuffer);
  } catch (err) {
    res.status(500).json({ error: 'Error generando QR' });
  }
});

// GET /qr-data — URL que contiene el QR (para el frontend)
app.get('/qr-data', async (req, res) => {
  const ringUrl = `${CONFIG.SERVER_URL}/`;
  try {
    const dataUrl = await QRCode.toDataURL(ringUrl, {
      width: 400,
      margin: 2,
      color: {
        dark: '#1a1a2e',
        light: '#ffffff'
      },
      errorCorrectionLevel: 'H'
    });
    res.json({ qr: dataUrl, url: ringUrl });
  } catch (err) {
    res.status(500).json({ error: 'Error generando QR' });
  }
});

// ============================================================
// INICIO DEL SERVIDOR
// ============================================================
app.listen(CONFIG.PORT, () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║        🔔 TIMBRE QR — SERVIDOR           ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\n📡 Servidor corriendo en: http://localhost:${CONFIG.PORT}`);
  console.log(`🏠 Casa: ${CONFIG.HOME_NAME}`);
  console.log(`📍 Coordenadas: ${CONFIG.HOUSE_LAT}, ${CONFIG.HOUSE_LNG}`);
  console.log(`📏 Radio permitido: ${CONFIG.ALLOWED_RADIUS} metros`);
  console.log(`\n🔗 Panel de Admin:  http://localhost:${CONFIG.PORT}/admin.html`);
  console.log(`🔗 Página visitante: http://localhost:${CONFIG.PORT}/`);
  console.log(`\n⚠️  URL pública configurada: ${CONFIG.SERVER_URL}`);

  if (!CONFIG.TELEGRAM_BOT_TOKEN || CONFIG.TELEGRAM_BOT_TOKEN.includes('ABCDEF')) {
    console.log('\n⛔  ADVERTENCIA: Token de Telegram no configurado.');
    console.log('    Editá el archivo .env con tu token real.');
  } else {
    console.log('\n✅ Telegram configurado correctamente.');
  }
  console.log('\n' + '─'.repeat(44) + '\n');
});
