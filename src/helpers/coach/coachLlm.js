// Model transport for the meeting coach. Speed matters more than depth here —
// a suggestion that lands after ME already answered is useless — so each
// provider defaults to its fastest capable model. Plain fetch; usable from
// the main process and from scripts/coach-replay.js.

const { extractJson } = require("./coachPrompts");

const PROVIDERS = {
  anthropic: {
    keyEnv: "ANTHROPIC_API_KEY",
    defaultModel: "claude-haiku-5-5",
    // Older accounts/regions may not serve the newest id yet
    fallbackModel: "claude-haiku-4-5",
  },
  openai: {
    keyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-4.1-mini",
    url: "https://api.openai.com/v1/chat/completions",
  },
  groq: {
    keyEnv: "GROQ_API_KEY",
    defaultModel: "openai/gpt-oss-120b",
    url: "https://api.groq.com/openai/v1/chat/completions",
    modelsUrl: "https://api.groq.com/openai/v1/models",
    // Groq retires models often (llama-3.3-70b-versatile vanished from
    // accounts in 2026). When the configured one 404s, the first of these the
    // account still serves is used instead.
    preferredModels: [
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "qwen/qwen3.8-27b",
      "qwen/qwen3-32b",
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
    ],
  },
  gemini: {
    keyEnv: "GEMINI_API_KEY",
    defaultModel: "gemini-2.5-flash-lite",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  },
};

const AUTO_ORDER = ["anthropic", "openai", "groq", "gemini"];

class CoachConfigError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "CoachConfigError";
    this.code = code;
  }
}

/**
 * Pick provider + model + key. "auto" takes the first provider with a key,
 * fastest-first. Throws CoachConfigError when nothing usable is configured.
 */
function resolveCoachProvider(preferred, model, getKey) {
  const candidates =
    preferred && preferred !== "auto" && PROVIDERS[preferred] ? [preferred] : AUTO_ORDER;
  for (const provider of candidates) {
    const apiKey = (getKey(PROVIDERS[provider].keyEnv) || "").trim();
    if (apiKey) {
      return {
        provider,
        model: (model || "").trim() || PROVIDERS[provider].defaultModel,
        apiKey,
      };
    }
  }
  if (candidates.length === 1) {
    throw new CoachConfigError(`No ${candidates[0]} API key is configured`, "missing_key");
  }
  throw new CoachConfigError(
    "No Anthropic, OpenAI, Groq or Gemini API key is configured",
    "missing_key"
  );
}

async function readError(response, label) {
  const text = await response.text().catch(() => "");
  let message = text;
  try {
    const parsed = JSON.parse(text);
    message = parsed?.error?.message || parsed?.error || parsed?.message || text;
  } catch {}
  const err = new Error(`${label} error ${response.status}: ${String(message).slice(0, 300)}`);
  err.status = response.status;
  const retryAfter = parseFloat(response.headers?.get?.("retry-after") || "");
  if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = retryAfter * 1000;
  return err;
}

// Per-model request tweaks. Reasoning models must keep reasoning short (it
// costs latency) and need token headroom, since hidden reasoning counts
// against the completion limit — otherwise the JSON gets cut off.
function modelRequestOptions(modelId) {
  if (/gpt-oss/i.test(modelId)) return { extra: { reasoning_effort: "low" }, extraTokens: 700 };
  if (/qwen3/i.test(modelId)) return { extra: { reasoning_effort: "none" }, extraTokens: 0 };
  return { extra: {}, extraTokens: 0 };
}

const NON_CHAT_MODEL = /whisper|guard|safeguard|orpheus|tts|embed|allam/i;

function createCoachLlm({ provider, model, apiKey, fetchImpl = globalThis.fetch, onModelChange = () => {} }) {
  const config = PROVIDERS[provider];
  if (!config) throw new CoachConfigError(`Unknown coach provider: ${provider}`, "bad_provider");
  let activeModel = model;

  async function callAnthropic({ system, user, maxTokens, signal, documents }) {
    const content = [];
    for (const doc of documents || []) {
      content.push({
        type: "document",
        source: { type: "base64", media_type: doc.mediaType, data: doc.data },
        title: doc.name,
      });
    }
    content.push({ type: "text", text: user });

    const send = (modelId) =>
      fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: maxTokens,
          temperature: 0.2,
          system,
          messages: [{ role: "user", content }],
        }),
        signal,
      });

    let response = await send(activeModel);
    if (
      response.status === 404 &&
      config.fallbackModel &&
      activeModel === config.defaultModel &&
      activeModel !== config.fallbackModel
    ) {
      activeModel = config.fallbackModel;
      response = await send(activeModel);
    }
    if (!response.ok) throw await readError(response, "Anthropic");
    const data = await response.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    return text;
  }

  // Ask the provider which models this key can use; pick the best available
  async function discoverModel(signal) {
    if (!config.modelsUrl || !config.preferredModels) return null;
    const response = await fetchImpl(config.modelsUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (!response.ok) return null;
    const data = await response.json();
    const available = new Set((data.data || []).map((m) => m.id));
    const preferred = config.preferredModels.find((id) => available.has(id) && id !== activeModel);
    if (preferred) return preferred;
    return [...available].find((id) => !NON_CHAT_MODEL.test(id) && id !== activeModel) || null;
  }

  async function callOpenAiCompatible({ system, user, maxTokens, signal, documents }) {
    if (documents && documents.length) {
      throw new CoachConfigError(
        "PDF prep files need an Anthropic key — paste the text instead",
        "pdf_unsupported"
      );
    }
    let jsonMode = true;
    let useExtras = true;
    const send = () => {
      const { extra, extraTokens } = modelRequestOptions(activeModel);
      return fetchImpl(config.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: activeModel,
          max_tokens: maxTokens + extraTokens,
          temperature: 0.2,
          ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
          ...(useExtras ? extra : {}),
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal,
      });
    };

    let response = await send();
    // Retired / unavailable model: switch once to what the account offers
    if (response.status === 404) {
      const replacement = await discoverModel(signal).catch(() => null);
      if (replacement) {
        const previous = activeModel;
        activeModel = replacement;
        onModelChange({ from: previous, to: replacement });
        response = await send();
      }
    }
    // Some models reject JSON mode or the reasoning knob — retry plain
    if (response.status === 400) {
      const body = await response.clone().text().catch(() => "");
      if (/response_format|json_object|json mode/i.test(body)) {
        jsonMode = false;
        response = await send();
      } else if (/reasoning_effort|reasoning/i.test(body)) {
        useExtras = false;
        response = await send();
      }
    }
    if (!response.ok) throw await readError(response, provider);
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  }

  /** Send one prompt, parse the JSON reply. Rejects on timeout. */
  async function completeJson({ system, user, maxTokens = 400, timeoutMs = 12000, documents }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const call = provider === "anthropic" ? callAnthropic : callOpenAiCompatible;
      const text = await call({ system, user, maxTokens, signal: controller.signal, documents });
      return extractJson(text);
    } catch (err) {
      if (err.name === "AbortError") {
        const timeout = new Error(`Coach model timed out after ${Math.round(timeoutMs / 1000)}s`);
        timeout.code = "timeout";
        throw timeout;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    provider,
    get model() {
      return activeModel;
    },
    completeJson,
  };
}

/**
 * Local model behind an OpenAI-compatible llama-server. `getBaseUrl` starts
 * the server on first use (seconds), so the first call is slow and later
 * ones take ~1-4 s for an 8B model.
 */
function createLocalCoachLlm({ modelName, getBaseUrl, fetchImpl = globalThis.fetch }) {
  async function completeJson({ system, user, maxTokens = 400, timeoutMs = 20000, documents }) {
    if (documents && documents.length) {
      throw new CoachConfigError(
        "PDF prep files need an Anthropic key — paste the text instead",
        "pdf_unsupported"
      );
    }
    const baseUrl = await getBaseUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelName,
          max_tokens: maxTokens,
          temperature: 0.2,
          response_format: { type: "json_object" },
          // Qwen3 "thinking" adds seconds of hidden reasoning — off for coaching
          chat_template_kwargs: { enable_thinking: false },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw await readError(response, "Local model");
      const data = await response.json();
      return extractJson(data.choices?.[0]?.message?.content || "");
    } catch (err) {
      if (err.name === "AbortError") {
        const timeout = new Error(`Local coach model timed out after ${Math.round(timeoutMs / 1000)}s`);
        timeout.code = "timeout";
        throw timeout;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  return { provider: "local", model: modelName, completeJson };
}

// How long to stay on the fallback after the primary fails. Rate limits
// honour Retry-After; transient errors retry soon; auth/config errors are
// permanent for the session.
function primaryCooldownMs(err) {
  if (err.status === 429) return Math.min(Math.max(err.retryAfterMs || 60000, 15000), 10 * 60000);
  if (err.status >= 500 || err.code === "timeout" || err.name === "TypeError") return 30000;
  return Infinity;
}

/**
 * Primary cloud model with an automatic local fallback. On any primary
 * failure the same request is retried on the fallback, and the primary is
 * skipped until its cooldown passes — then it is tried again.
 */
function createFallbackCoachLlm({ primary, fallback, now = Date.now, onSwitch = () => {} }) {
  let cooldownUntil = 0;
  let reason = null;
  const onFallback = () => now() < cooldownUntil;

  return {
    get provider() {
      return onFallback() ? fallback.provider : primary.provider;
    },
    get model() {
      return onFallback() ? fallback.model : primary.model;
    },
    status() {
      return {
        primary: primary.provider,
        fallback: fallback.provider,
        fallbackActive: onFallback(),
        reason: onFallback() ? reason : null,
      };
    },
    async completeJson(request) {
      if (!onFallback()) {
        try {
          const result = await primary.completeJson(request);
          if (reason) {
            reason = null;
            onSwitch({ to: "primary" });
          }
          return result;
        } catch (err) {
          if (err instanceof CoachConfigError && err.code === "pdf_unsupported") throw err;
          cooldownUntil = now() + primaryCooldownMs(err);
          reason = err.status === 429 ? "rate_limited" : err.status === 401 || err.status === 403 ? "auth" : "error";
          onSwitch({ to: "fallback", reason, error: err.message, cooldownMs: cooldownUntil - now() });
        }
      }
      // Local models need longer, especially on the first (cold-start) call
      return fallback.completeJson({ ...request, timeoutMs: Math.max(request.timeoutMs || 0, 20000) });
    },
  };
}

module.exports = {
  createLocalCoachLlm,
  createFallbackCoachLlm,
  PROVIDERS,
  CoachConfigError,
  resolveCoachProvider,
  createCoachLlm,
};
