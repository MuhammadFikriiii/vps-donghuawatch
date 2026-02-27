module.exports = {
    apps: [{
        name: 'donghuawatch-api',
        script: 'index.js',
        instances: 1,
        autorestart: true,
        watch: false,
        max_memory_restart: '400M',
        env: {
            NODE_ENV: 'production',
            PORT: 3000
        },
        // Logging
        error_file: '/var/log/donghuawatch/error.log',
        out_file: '/var/log/donghuawatch/output.log',
        log_date_format: 'YYYY-MM-DD HH:mm:ss',
        merge_logs: true,
        // Restart policy
        exp_backoff_restart_delay: 100,
        max_restarts: 10,
        restart_delay: 3000
    }]
};
