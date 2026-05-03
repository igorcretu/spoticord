const cron = require('node-cron');
const { runWeather } = require('./weather');

let running = false;

async function runWeatherJob() {
  if (running) {
    console.log(`[${new Date().toISOString()}] Weather job skipped (previous run still in progress)`);
    return;
  }

  running = true;
  try {
    await runWeather();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Weather job failed:`, err.message);
  } finally {
    running = false;
  }
}

// Every 10 minutes
cron.schedule('*/10 * * * *', () => {
  runWeatherJob();
});

// Run once immediately on startup
runWeatherJob();

console.log(`[${new Date().toISOString()}] Weather scheduler started — updates every 10 minutes`);
