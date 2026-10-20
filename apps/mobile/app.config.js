// The web export is served by the server under /app (EXPO_BASE_URL=/app, see the export:web script).
// Native builds and `expo start` keep the root path.
module.exports = ({ config }) =>
  process.env.EXPO_BASE_URL
    ? { ...config, experiments: { ...config.experiments, baseUrl: process.env.EXPO_BASE_URL } }
    : config;
