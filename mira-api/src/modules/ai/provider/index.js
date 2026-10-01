const registry = new Map();

function registerProvider(name, impl) {
  registry.set(name, impl);
}

function getProvider(name) {
  const impl = registry.get(name || "gemini");
  if (!impl) {
    const err = new Error(`Proveedor IA desconocido: ${name}`);
    err.code = "UNKNOWN_PROVIDER";
    throw err;
  }
  return impl;
}

registerProvider("gemini", require("./gemini"));

module.exports = { registerProvider, getProvider };
