/**
 * Mock de @google/generative-ai para tests (CommonJS).
 * Debe cargarse ANTES de require("../src/app").
 *
 * Uso:
 *   const g = require("./helpers/mockGemini"); // ya instala el mock
 *   g.resetGemini();
 *   g.setGeminiHandler((payload) => ({ text: "..." }));          // o { calls: [{name,args}] }
 *   g.queueGemini({ text: "a" }, { calls: [{ name: "x" }] });    // respuestas en cola
 *   g.geminiCalls();  // [{ model, system, tools, contents }]
 */
const Module = require("module");

const calls = [];
let queue = [];
let handler = null;

function resetGemini() {
  calls.length = 0;
  queue = [];
  handler = null;
}

function queueGemini(...specs) {
  queue.push(...specs);
}

function setGeminiHandler(fn) {
  handler = fn;
}

function geminiCalls() {
  return calls.slice();
}

function toResponse(spec) {
  const parts = [];
  if (spec.text) parts.push({ text: spec.text });
  for (const c of spec.calls || []) parts.push({ functionCall: { name: c.name, args: c.args || {} } });
  if (!parts.length) parts.push({ text: "" });
  return { response: { candidates: [{ content: { role: "model", parts } }] } };
}

class GoogleGenerativeAI {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  getGenerativeModel(config) {
    return {
      generateContent: async (payload) => {
        const functionDeclarations =
          (payload && payload.tools && payload.tools[0] && payload.tools[0].functionDeclarations) || [];
        calls.push({
          model: config.model,
          system: (config && config.systemInstruction) || "",
          tools: functionDeclarations.map((d) => d.name),
          contents: (payload && payload.contents) || [],
        });
        let spec;
        if (handler) spec = await handler(payload, config);
        else if (queue.length) spec = queue.shift();
        else spec = { text: "OK" };
        if (!spec) spec = { text: "OK" };
        return toResponse(spec);
      },
    };
  }
}

function installGeminiMock() {
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === "@google/generative-ai") {
      return { GoogleGenerativeAI, __isMockGemini: true };
    }
    return originalLoad.apply(this, arguments);
  };
}

installGeminiMock();

module.exports = { installGeminiMock, resetGemini, queueGemini, setGeminiHandler, geminiCalls };
