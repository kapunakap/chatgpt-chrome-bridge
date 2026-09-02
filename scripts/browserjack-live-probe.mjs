export function requireChromeBackend(backends) {
  if (!Array.isArray(backends) || backends.length === 0) {
    throw new Error("No browser backends are connected");
  }
  const chrome = backends.find((backend) => backend?.family === "chrome");
  if (!chrome) throw new Error("Chrome backend is not connected");
  return chrome;
}
