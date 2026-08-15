/**
 * PM2 process definition for OmniReach.
 *
 *   pm2 start ecosystem.config.js --env production
 *   pm2 save && pm2 startup          survive a server reboot
 *   pm2 logs omnireach               follow the log
 *   pm2 reload omnireach             zero-downtime restart after a deploy
 *
 * Run from the repository root. Secrets are NOT here: they come from the environment of the shell
 * PM2 was started in, or from web/backend/.env on the server. Putting them in a committed file is
 * how credentials end up in a repository.
 */
module.exports = {
  apps: [{
    name: 'omnireach',
    script: 'server.js',
    cwd: './web/backend',

    // ONE instance, not a cluster. Two things in this app are single-writer by design: the
    // scheduler fires on its own 30-second timer, and the store rewrites whole tables on save.
    // Running several copies would fire each scheduled campaign once per copy, so the same
    // customers get rung two or three times, and the copies would overwrite each other's writes.
    // Scale by making the machine bigger, not by adding instances.
    instances: 1,
    exec_mode: 'fork',

    autorestart: true,
    max_restarts: 10,
    min_uptime: '30s',          // a crash inside 30s counts as a failed start, not a healthy restart
    restart_delay: 4000,
    max_memory_restart: '600M',

    // Timestamped, merged, and kept out of git.
    error_file: './logs/omnireach-error.log',
    out_file: './logs/omnireach-out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

    // Never watch files in production: a log write or a data file touch would restart the app
    // mid-call.
    watch: false,

    env: {
      NODE_ENV: 'development',
      PORT: 3002
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: process.env.PORT || 3002,
      // Behind nginx or a load balancer, which is the normal PM2 deployment. Without this every
      // request appears to come from the proxy, so the per-IP sign-in limits treat the whole
      // internet as one client and access requests all record the server's own location.
      TRUST_PROXY: 'true'
    }
  }]
};
