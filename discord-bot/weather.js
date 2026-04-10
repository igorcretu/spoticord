// ============================================================
//  Discord Weather Webhook — Open-Meteo (no API key needed)
//  Posts weather for multiple locations in one message
//  Usage: node weather-webhook.js
// ============================================================

const WEBHOOK_URL = process.env.WEATHER_WEBHOOK_URL;

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

// ── Build one embed per location ─────────────────────────────
function buildEmbed(data, locationName, color) {
  const c = data.current;
  const d = data.daily;

  const wmo      = WMO_CODES[c.weather_code] ?? { label: "Unknown", emoji: "🌡️" };
  const windDesc = describeWind(c.wind_speed_10m);

  const dirs  = ["N","NE","E","SE","S","SW","W","NW"];
  const arrow = dirs[Math.round(c.wind_direction_10m / 45) % 8];

  const forecastFields = d.time.slice(1, 4).map((dateStr, i) => {
    const day = new Date(dateStr).toLocaleDateString("en-GB", {
      weekday: "short", month: "short", day: "numeric",
    });
    const w = WMO_CODES[d.weather_code[i + 1]] ?? { emoji: "🌡️", label: "" };
    return {
      name:   `${w.emoji} ${day}`,
      value:  `↑ **${d.temperature_2m_max[i + 1]}°C** · ↓ ${d.temperature_2m_min[i + 1]}°C\n🌧 ${d.precipitation_sum[i + 1]} mm`,
      inline: true,
    };
  });

  const now = new Date().toLocaleString("en-GB", {
    timeZone:  data.timezone,
    dateStyle: "full",
    timeStyle: "short",
  });

  return {
    title:       `${wmo.emoji}  Weather in ${locationName}`,
    description: `**${wmo.label}** — ${now}`,
    color,
    fields: [
      {
        name:   "🌡️ Temperature",
        value:  `**${c.temperature_2m}°C** (feels like ${c.apparent_temperature}°C)`,
        inline: true,
      },
      {
        name:   "💧 Humidity",
        value:  `${c.relative_humidity_2m}%`,
        inline: true,
      },
      {
        name:   "🌧️ Precipitation",
        value:  `${c.precipitation} mm`,
        inline: true,
      },
      {
        name:   "💨 Wind",
        value:  `${c.wind_speed_10m} km/h ${arrow} — ${windDesc}`,
        inline: true,
      },
      { name: "\u200b", value: "**3-Day Forecast**", inline: false },
      ...forecastFields,
    ],
    footer: {
      text: "Powered by Open-Meteo • open-meteo.com",
    },
    timestamp: new Date().toISOString(),
  };
}

// ── Post all embeds in a single Discord message ───────────────
async function postToDiscord(embeds) {
  const payload = {
    username:   "Weather Bot",
    avatar_url: "https://cdn-icons-png.flaticon.com/512/1163/1163624.png",
    embeds,
  };

  const res = await fetch(WEBHOOK_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord error ${res.status}: ${text}`);
  }
  console.log("✅ Weather posted to Discord successfully.");
}

// ── Main ─────────────────────────────────────────────────────
async function runWeather() {
  console.log(`📡 Fetching weather for ${LOCATIONS.length} locations...`);

  const results = await Promise.all(
    LOCATIONS.map(loc => fetchWeather(loc))
  );

  const embeds = results.map((data, i) =>
    buildEmbed(data, LOCATIONS[i].name, EMBED_COLORS[i])
  );

  await postToDiscord(embeds);
}

module.exports = { runWeather };

// Run directly if invoked as a script
if (require.main === module) {
  runWeather().catch(err => {
    console.error("❌ Failed:", err.message);
    process.exit(1);
  });
}