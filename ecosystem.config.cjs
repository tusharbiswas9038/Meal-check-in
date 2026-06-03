module.exports = {
  apps: [
    {
      name: 'meal-checkin-api',
      cwd: __dirname,
      script: 'server/src/index.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        PORT: '9900',
        DB_PATH: './data/meal-check-in.db',
        TZ: 'Asia/Kolkata'
      },
      max_memory_restart: '300M',
      time: true,
      merge_logs: true,
      out_file: './logs/backend.out.log',
      error_file: './logs/backend.error.log',
      log_file: './logs/backend.combined.log'
    }
  ]
};
