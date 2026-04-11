// ============================================================
//  Discord Weather Webhook — Open-Meteo (no API key needed)
//  Updates one persistent message in place
// ============================================================

const fs = require('fs');
const path = require('path');

const WEBHOOK_URL = process.env.WEATHER_WEBHOOK_URL || '';
const WEATHER_USERNAME = process.env.WEATHER_WEBHOOK_USERNAME || 'Serii Meteoroloh';
const WEATHER_AVATAR_URL = process.env.WEATHER_WEBHOOK_AVATAR_URL || 'https://cdn.discordapp.com/avatars/1492208491191078912/f4ddf7f6e9a1d0867d7cb7786ad47bba.webp?size=160';
const WEATHER_STATE_FILE = process.env.WEATHER_STATE_FILE || '/data/weather_message_state.json';

const LOCATIONS = [
  { name: "Copenhagen, Denmark",  latitude: 55.6761,  longitude: 12.5683  },
  { name: "Horsens, Denmark",     latitude: 55.8607,  longitude: 9.8502   },
  { name: "Paris, France",        latitude: 48.8566,  longitude: 2.3522   },
  { name: "Chișinău, Moldova",    latitude: 47.0105,  longitude: 28.8638  },
];

// ── Weather code → label + emoji ─────────────────────────────
const WMO_CODES = {
  0:  { label: "Clear sky",           emoji: "☀️" },
  1:  { label: "Mainly clear",        emoji: "🌤️" },
  2:  { label: "Partly cloudy",       emoji: "⛅" },
  3:  { label: "Overcast",            emoji: "☁️" },
  45: { label: "Foggy",               emoji: "🌫️" },
  48: { label: "Icy fog",             emoji: "🌫️" },
  51: { label: "Light drizzle",       emoji: "🌦️" },
  53: { label: "Moderate drizzle",    emoji: "🌦️" },
  55: { label: "Dense drizzle",       emoji: "🌧️" },
  61: { label: "Slight rain",         emoji: "🌧️" },
  63: { label: "Moderate rain",       emoji: "🌧️" },
  65: { label: "Heavy rain",          emoji: "🌧️" },
  71: { label: "Slight snow",         emoji: "🌨️" },
  73: { label: "Moderate snow",       emoji: "❄️" },
  75: { label: "Heavy snow",          emoji: "❄️" },
  80: { label: "Slight showers",      emoji: "🌦️" },
  81: { label: "Moderate showers",    emoji: "🌧️" },
  82: { label: "Violent showers",     emoji: "⛈️" },
  95: { label: "Thunderstorm",        emoji: "⛈️" },
  99: { label: "Thunderstorm + hail", emoji: "⛈️" },
};

// ── Embed color per location (in order) ──────────────────────
const EMBED_COLORS = [0x5865f2, 0x57f287, 0xfee75c, 0xed4245];

function describeWind(speed) {
  if (speed < 1)  return "Calm";
  if (speed < 6)  return "Light air";
  if (speed < 12) return "Light breeze";
  if (speed < 20) return "Gentle breeze";
  if (speed < 29) return "Moderate breeze";
  if (speed < 39) return "Fresh breeze";
  if (speed < 50) return "Strong breeze";
  return "Near gale or stronger";
}

// ── Fetch weather from Open-Meteo ────────────────────────────
async function fetchWeather({ latitude, longitude }) {
  const params = new URLSearchParams({
    latitude,
    longitude,
    current: [
      "temperature_2m",
      "apparent_temperature",
      "relative_humidity_2m",
      "wind_speed_10m",
      "wind_direction_10m",
      "weather_code",
      "precipitation",
    ].join(","),
    daily: [
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_sum",
      "weather_code",
    ].join(","),
    timezone: "auto",
    forecast_days: 4,
  });

  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`Open-Meteo error: ${res.status}`);
  return res.json();
}

// ── Build one inline field per location ──────────────────────
function buildLocationField(data, locationName) {
  const c = data.current;
  const d = data.daily;

  const wmo      = WMO_CODES[c.weather_code] ?? { label: "Unknown", emoji: "🌡️" };
  const windDesc = describeWind(c.wind_speed_10m);

  const dirs  = ["N","NE","E","SE","S","SW","W","NW"];
  const arrow = dirs[Math.round(c.wind_direction_10m / 45) % 8];

  const forecast = d.time.slice(1, 4).map((dateStr, i) => {
    const day = new Date(dateStr).toLocaleDateString("en-GB", {
      weekday: "short", month: "short", day: "numeric",
    });
    const w = WMO_CODES[d.weather_code[i + 1]] ?? { emoji: "🌡️", label: "" };
    return `${w.emoji} ${day}: ↑${d.temperature_2m_max[i + 1]}° ↓${d.temperature_2m_min[i + 1]}° · 🌧${d.precipitation_sum[i + 1]}mm`;
  });

  return {
    name: `${wmo.emoji} ${locationName}`,
    value: [
      `**${wmo.label}**`,
      `🌡 **${c.temperature_2m}°C** (feels ${c.apparent_temperature}°C)`,
      `💧 ${c.relative_humidity_2m}% · 🌧 ${c.precipitation} mm`,
      `💨 ${c.wind_speed_10m} km/h ${arrow} (${windDesc})`,
      `**3-day:** ${forecast.join(' | ')}`,
    ].join('\n'),
    inline: true,
  };
}

function buildEmbed(locationFields) {
  return {
    title: '🌦 Weather Update',
    description: 'Auto-refresh every 10 minutes',
    color: EMBED_COLORS[0],
    fields: locationFields,
    footer: {
      text: 'Powered by Open-Meteo • open-meteo.com',
    },
    timestamp: new Date().toISOString(),
  };
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(WEATHER_STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(data) {
  fs.mkdirSync(path.dirname(WEATHER_STATE_FILE), { recursive: true });
  fs.writeFileSync(WEATHER_STATE_FILE, JSON.stringify(data, null, 2));
}

function webhookUrlWithWait() {
  const u = new URL(WEBHOOK_URL);
  u.searchParams.set('wait', 'true');
  return u.toString();
}

function webhookMessageUrl(messageId) {
  const base = WEBHOOK_URL.replace(/\/$/, '');
  return `${base}/messages/${messageId}`;
}

async function createWeatherMessage(embed) {
  const payload = {
    username: WEATHER_USERNAME,
    avatar_url: WEATHER_AVATAR_URL,
    embeds: [embed],
  };

  const res = await fetch(webhookUrlWithWait(), {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord error ${res.status}: ${text}`);
  }
  const created = await res.json();
  if (created?.id) {
    writeState({ messageId: created.id });
  }
  console.log('✅ Weather message created successfully.');
}

async function updateWeatherMessage(messageId, embed) {
  const payload = {
    username: WEATHER_USERNAME,
    avatar_url: WEATHER_AVATAR_URL,
    embeds: [embed],
  };

  const res = await fetch(webhookMessageUrl(messageId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (res.status === 404) return false;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord update error ${res.status}: ${text}`);
  }

  console.log('✅ Weather message updated successfully.');
  return true;
}

async function postToDiscord(embed) {
  if (!WEBHOOK_URL) {
    throw new Error('WEATHER_WEBHOOK_URL is not set.');
  }

  const state = readState();
  if (state.messageId) {
    const updated = await updateWeatherMessage(state.messageId, embed);
    if (updated) return;
  }

  await createWeatherMessage(embed);
}

// ── Main ─────────────────────────────────────────────────────
async function runWeather() {
  console.log(`📡 Fetching weather for ${LOCATIONS.length} locations...`);

  const results = await Promise.all(
    LOCATIONS.map(loc => fetchWeather(loc))
  );

  const fields = results.map((data, i) =>
    buildLocationField(data, LOCATIONS[i].name)
  );

  await postToDiscord(buildEmbed(fields));
}

module.exports = { runWeather };

// Run directly if invoked as a script
if (require.main === module) {
  runWeather().catch(err => {
    console.error("❌ Failed:", err.message);
    process.exit(1);
  });
}