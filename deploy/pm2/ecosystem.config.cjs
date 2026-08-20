const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "../..");

module.exports = {
  apps: [
    {
      name: "sourcenerve-backend",
      cwd: repositoryRoot,
      script: path.join(repositoryRoot, "target/release/sourcenerve"),
      interpreter: "none",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      restart_delay: 2000,
      max_restarts: 10,
      min_uptime: 10000,
      time: true,
    },
  ],
};
