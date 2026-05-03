/**
 * PM2 ecosystem config — for production deployment.
 *
 * Usage:
 *   sudo npm install -g pm2
 *   pm2 start ecosystem.config.js --env production
 *   pm2 save                     # persist on reboot
 *   pm2 startup                  # generate startup script (one-time)
 *   pm2 logs nobl                # tail logs
 *   pm2 restart nobl             # apply code changes after git pull
 *   pm2 status                   # check it's running
 *
 * The "killall -HUP" and crash-restart behavior comes for free from PM2.
 */
module.exports = {
  apps: [{
    name:        'nobl',
    script:      'server/index.js',
    cwd:         __dirname,
    instances:   1,                  // single instance (DB has its own pool)
    exec_mode:   'fork',
    autorestart: true,
    watch:       false,              // never watch in prod — use git pull + pm2 restart
    max_memory_restart: '1G',        // restart if it leaks past 1GB
    max_restarts: 10,                // give up after 10 crashes in a row
    min_uptime:   '30s',             // restart counter resets after 30s of stability
    restart_delay: 3000,             // wait 3s between restarts
    kill_timeout:  10000,            // give the process 10s to clean up before SIGKILL
    env: {
      NODE_ENV: 'production',
      PORT:     3001,
    },
    env_production: {
      NODE_ENV: 'production',
      PORT:     3001,
    },
    error_file: './data/pm2-error.log',
    out_file:   './data/pm2-out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  }],
};
