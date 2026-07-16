module.exports = {
  apps: [
    {
      name: "ecoSystemServer",
      script: "server.js",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      env: {
        NODE_ENV: "production",
        PORT: 5054
      }
    },
    {
      name: "ecoSystemWorker",
      script: "queueWorker.js",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};