const cron = require('node-cron');
const { runWeather } = require('./weather');

// Every day at 08:00 Copenhagen time (handles DST automatically)
cron.schedule('0 8 * * *', () => {
  runWeather().catch(err => console.error(`[${new Date().toISOString()}] Weather job failed:`, err.message));
}, { timezone: 'Europe/Copenhagen' });

console.log(`[${new Date().toISOString()}] Weather scheduler started — posts daily at 08:00 Copenhagen time`);
