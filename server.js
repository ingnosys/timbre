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
  // WhatsApp via CallMeBot (gratis para uso personal)
  // Activación: enviar "I allow callmebot to send me messages" al +34 644 60 49 16
  WHATSAPP_PHONE: process.env.WHATSAPP_PHONE,    // Ej: '5491112345678' (código país sin +)
  WHATSAPP_APIKEY: process.env.WHATSAPP_APIKEY,  // API key que te manda CallMeBot
  HOUSE_LAT: parseFloat(process.env.HOUSE_LAT || '-34.9132165'),
  HOUSE_LNG: parseFloat(process.env.HOUSE_LNG || '-57.9760482'),
  ALLOWED_RADIUS: parseInt(process.env.ALLOWED_RADIUS_METERS || '100'),
  PORT: parseInt(process.env.PORT || '3000'),
  SERVER_URL: process.env.SERVER_URL || 'http://localhost:3000',
  HOME_NAME: process.env.HOME_NAME || '35 # 1130 1/2 Depto. 4',
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
// FUNCIÓN: Texto del mensaje de notificación
// ============================================================
function buildMessage(distanceMeters) {
  const now = new Date();
  const hora = now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  const fecha = now.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  return { hora, fecha };
}


// ============================================================
// FUNCIÓN: Enviar notificación a WhatsApp (CallMeBot - gratis)
// Documentación: https://www.callmebot.com/blog/free-api-whatsapp-messages/
// ============================================================
async function sendWhatsAppNotification(distanceMeters) {
  if (!CONFIG.WHATSAPP_PHONE || !CONFIG.WHATSAPP_APIKEY) {
    console.log('[WHATSAPP] No configurado, omitiendo.');
    return false;
  }

  const { hora, fecha } = buildMessage(distanceMeters);

  const mensaje =
    `🔔 ¡Alguien está en la puerta!\n\n` +
    `🏠 ${CONFIG.HOME_NAME}\n` +
    `🕐 ${hora} — ${fecha}\n` +
    `📍 A ${Math.round(distanceMeters)} metros de la puerta\n` +
    `(Escaneó el QR del timbre)`;

  const params = new URLSearchParams({
    phone: CONFIG.WHATSAPP_PHONE,
    text: mensaje,
    apikey: CONFIG.WHATSAPP_APIKEY
  });

  const url = `https://api.callmebot.com/whatsapp.php?${params.toString()}`;
  const response = await axios.get(url, { timeout: 10000 });

  // CallMeBot devuelve texto plano con "Message queued" si fue exitoso
  const success = response.status === 200;
  console.log(`[WHATSAPP] Respuesta CallMeBot: ${response.status} — ${String(response.data).substring(0, 80)}`);
  return success;
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

  // Enviar notificaciones en paralelo (Telegram + WhatsApp)
  try {
    const [telegramSent, whatsappSent] = await Promise.allSettled([
      sendWhatsAppNotification(distance)
    ]);

    const whatsappOk = whatsappSent.status === 'fulfilled' && whatsappSent.value === true;

    if (whatsappSent.status === 'rejected') {
      console.error('[ERROR] WhatsApp:', whatsappSent.reason?.message);
    }

    // Considerar éxito si al menos UN canal funcionó
    // Guardar en historial (máximo 10)
    lastRings.unshift({
      time: lastRingTime.toISOString(),
      distance: Math.round(distance),
      ip: req.ip
    });
    if (lastRings.length > 10) lastRings.pop();

    console.log(`[OK] Notificación enviada | WhatsApp: ${whatsappOk} | Total: ${ringCount}`);
    return res.json({
      success: true,
      message: '¡Notificación enviada! El dueño de casa ya sabe que estás en la puerta.',
      distance: Math.round(distance),
      channels: { whatsapp: whatsappOk }
    });
  } catch (err) {
    console.error('[ERROR] Notificación:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Hubo un error enviando la notificación. Intentá de nuevo.',
      code: 'NOTIFICATION_ERROR'
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
    whatsappConfigured: !!CONFIG.WHATSAPP_PHONE && !!CONFIG.WHATSAPP_APIKEY
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

  if (!CONFIG.WHATSAPP_PHONE || !CONFIG.WHATSAPP_APIKEY) {
    console.log('⚠️  WhatsApp: no configurado (opcional)');
    console.log('    Para activarlo: enviar "I allow callmebot to send me messages"');
    console.log('    al número +34 644 60 49 16 en WhatsApp, luego agregá al .env:');
    console.log('    WHATSAPP_PHONE=5495456981');
    console.log('    WHATSAPP_APIKEY=6435685');
  } else {
    console.log('✅ WhatsApp (CallMeBot) configurado correctamente.');
  }
  console.log('\n' + '─'.repeat(44) + '\n');
});
