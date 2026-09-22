import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  resolveProviderHttpRequestConfig,
  postJsonRequest,
  assertOkOrThrowHttpError,
} from "openclaw/plugin-sdk/provider-http";

/**
 * StepFun Vision — OpenClaw media understanding provider (OpenAI Responses API).
 *
 * Registers StepFun vision models as `describeImage` / `describeVideo`
 * providers for the OpenClaw media understanding pipeline.
 *
 * ── Protocol (2.0.0 — breaking) ───────────────────────────────────────
 * This plugin speaks the **OpenAI Responses API**, not chat completions:
 *   - endpoint: POST {baseUrl}/responses
 *   - body:     { model, max_output_tokens, input: [{ role: "user", content: [...] }] }
 *   - parts:    { type: "input_text",  text }
 *               { type: "input_image", image_url: { url: <data URL>, detail } }
 *               { type: "input_video", video_url: { url: <data URL> } }
 *   - text out: data.output[].type === "message"
 *                 -> .content[].type === "output_text"
 *                 -> .text
 *
 * Rejected by StepFun on /responses (verified 2026-09-22):
 *   - `max_tokens`         -> 400 unknown_parameter (use `max_output_tokens`)
 *   - flat `reasoning_effort` -> 400 unknown_parameter (use `reasoning: { effort }`)
 * Not sent by this plugin, but worth knowing.
 *
 * ── Models ────────────────────────────────────────────────────────────
 *   - `step-5-preview` — flagship multimodal (text + image + video),
 *       1M context / 64k max output, reasoning-capable. Available on the
 *       Step Plan surface (verified live against /step_plan/v1 on 2026-09-22
 *       for text, image and video input). Default for the `plan` surface.
 *   - `step-3.7-flash` — cheaper multimodal model, available on BOTH
 *       surfaces. Recommended as the fallback tier.
 *   - `step-1o-turbo-vision` — fast image/video understanding.
 *       Only available on the STANDARD API surface (pay-per-use).
 *       Against /step_plan/v1 it returns 404 model_invalid.
 *
 * ── Surfaces & endpoints ──────────────────────────────────────────────
 *   plan (default): Step Plan / token-plan subscription
 *       Standard endpoint is NOT usable; a plan-only key returns
 *       402 quota_exceeded on /v1.
 *       CN:   https://api.stepfun.com/step_plan/v1
 *       INTL: https://api.stepfun.ai/step_plan/v1
 *   api: standard pay-per-use API
 *       CN:   https://api.stepfun.com/v1
 *       INTL: https://api.stepfun.ai/v1
 *
 * Set `plugins.entries.stepfun-vision.config.surface` to "plan" or "api"
 * (default: "plan"). The surface controls the default model and the default
 * base URL used when nothing else is configured.
 *
 * The API key is read from `STEPFUN_API_KEY` (env), or from
 * `models.providers.stepfun-vision.apiKey` in openclaw.json (supports
 * `${ENV_VAR}` / `secretref-env:VAR` markers). The base URL is read from
 * `models.providers.stepfun-vision.baseUrl`, `STEPFUN_BASE_URL` (env), or the
 * surface default above.
 *
 * ── Priority / fallback in OpenClaw ──────────────────────────────────
 * When multiple models are configured under `tools.media.<image|video>.models`,
 * the array order is the attempt order: the first provider/model that returns
 * a successful description wins, and failures fall through to the next entry.
 * In auto-discovery mode (no explicit `tools.media` entries) the
 * `mediaUnderstandingProviderMetadata.autoPriority` values are used instead
 * (lower number = higher priority).
 */

const PROVIDER_ID = "stepfun-vision";

// Model ids
const MODEL_5_PREVIEW = "step-5-preview";
const MODEL_1O_TURBO_VISION = "step-1o-turbo-vision";
const MODEL_3_7_FLASH = "step-3.7-flash";

// Base URLs (CN / INTL) per surface
const PLAN_CN_BASE_URL = "https://api.stepfun.com/step_plan/v1";
const PLAN_INTL_BASE_URL = "https://api.stepfun.ai/step_plan/v1";
const API_CN_BASE_URL = "https://api.stepfun.com/v1";
const API_INTL_BASE_URL = "https://api.stepfun.ai/v1";

const DEFAULT_PROMPT =
  "请详细描述这个媒体内容，包括所有可见信息（画面、动作、文字、场景等）。";
// StepFun counts reasoning tokens against max_output_tokens: at 512 a real
// call came back status:"incomplete" with no message text at all. 4096 leaves
// enough headroom for the reasoning trace plus the description.
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_IMAGE_DETAIL = "high";

const ENV_API_KEY = "STEPFUN_API_KEY";
const ENV_BASE_URL = "STEPFUN_BASE_URL";
const ENV_IMAGE_DETAIL = "STEPFUN_IMAGE_DETAIL";

/** Marker OpenClaw sets on `apiKey` when auth resolution is "none". */
const CUSTOM_LOCAL_AUTH_MARKER = "custom-local";

// ── 运行时状态(register 时根据 surface 初始化) ─────────────────────────

let surface = "plan"; // "plan" | "api"
let defaultModel = MODEL_5_PREVIEW;
let defaultBaseUrl = PLAN_CN_BASE_URL;

function resolveSurfaceFromPluginConfig(api) {
  const cfg =
    api.pluginConfig ?? api.config?.plugins?.entries?.[PROVIDER_ID]?.config;
  const raw =
    typeof cfg?.surface === "string" ? cfg.surface.trim().toLowerCase() : "";
  return raw === "api" ? "api" : "plan";
}

function applySurface() {
  if (surface === "api") {
    defaultModel = MODEL_1O_TURBO_VISION;
    defaultBaseUrl = API_CN_BASE_URL;
  } else {
    defaultModel = MODEL_5_PREVIEW;
    defaultBaseUrl = PLAN_CN_BASE_URL;
  }
}

// ── 小工具 ────────────────────────────────────────────────────────────

function resolveParam(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

const MIME_BY_EXT = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
};

function guessMime(fileName, fallback) {
  if (!fileName) return fallback;
  const ext = fileName.split(".").pop()?.toLowerCase();
  return MIME_BY_EXT[ext] || fallback;
}

/**
 * Expand provider-config API key markers to concrete secrets:
 *   - `${ENV_VAR}`         -> process.env.ENV_VAR
 *   - `secretref-env:VAR`  -> process.env.VAR
 *   - plain value          -> returned as-is
 */
function expandSecret(value) {
  if (typeof value !== "string" || !value.trim()) return value;
  const trimmed = value.trim();
  const envMatch = trimmed.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (envMatch) return process.env[envMatch[1]] || undefined;
  const refPrefix = "secretref-env:";
  if (trimmed.startsWith(refPrefix)) {
    return process.env[trimmed.slice(refPrefix.length)] || undefined;
  }
  return trimmed;
}

/**
 * Resolve the StepFun API key.
 *
 * Order: runtime-injected auth (video path) -> runtime apiKey compat field
 * -> `models.providers.<id>.apiKey` from cfg (image path) -> STEPFUN_API_KEY.
 */
function resolveApiKey(req) {
  if (req.auth?.kind === "api-key" && req.auth.apiKey) return req.auth.apiKey;
  if (
    typeof req.apiKey === "string" &&
    req.apiKey &&
    req.apiKey !== CUSTOM_LOCAL_AUTH_MARKER
  ) {
    return req.apiKey;
  }
  const providerCfg = req.cfg?.models?.providers?.[PROVIDER_ID];
  const cfgKey = expandSecret(providerCfg?.apiKey);
  if (cfgKey) return cfgKey;
  return process.env[ENV_API_KEY] || undefined;
}

/**
 * Resolve the StepFun base URL.
 *
 * Order: runtime-injected baseUrl (video path) -> `models.providers.<id>.baseUrl`
 * from cfg (image path) -> STEPFUN_BASE_URL env -> surface default.
 */
function resolveBaseUrl(req) {
  const cfgBaseUrl = req.cfg?.models?.providers?.[PROVIDER_ID]?.baseUrl;
  return (
    resolveParam(req.baseUrl) ||
    resolveParam(cfgBaseUrl) ||
    resolveParam(process.env[ENV_BASE_URL]) ||
    defaultBaseUrl
  );
}

function resolveMaxTokens(req) {
  if (typeof req.maxTokens === "number" && req.maxTokens > 0) return req.maxTokens;
  const cfgMax = req.cfg?.tools?.media?.image?.maxTokens;
  if (typeof cfgMax === "number" && cfgMax > 0) return cfgMax;
  const pluginCfg = req.cfg?.plugins?.entries?.[PROVIDER_ID]?.config;
  if (typeof pluginCfg?.maxTokens === "number" && pluginCfg.maxTokens > 0) {
    return pluginCfg.maxTokens;
  }
  return DEFAULT_MAX_TOKENS;
}

function resolveImageDetail(req) {
  const pluginCfg = req.cfg?.plugins?.entries?.[PROVIDER_ID]?.config;
  return (
    resolveParam(pluginCfg?.imageDetail) ||
    resolveParam(process.env[ENV_IMAGE_DETAIL]) ||
    DEFAULT_IMAGE_DETAIL
  );
}

function resolvePrompt(req) {
  const pluginCfg = req.cfg?.plugins?.entries?.[PROVIDER_ID]?.config;
  return (
    resolveParam(pluginCfg?.defaultPrompt) ||
    resolveParam(req.prompt) ||
    DEFAULT_PROMPT
  );
}

function toDataUrl(req, kind) {
  const mime = resolveParam(
    req.mime,
    guessMime(req.fileName, kind === "video" ? "video/mp4" : "image/jpeg"),
  );
  return `data:${mime};base64,${req.buffer.toString("base64")}`;
}

// ── 请求 / 响应 ───────────────────────────────────────────────────────

function buildResponsesBody({ model, prompt, mediaBlocks, maxTokens }) {
  return {
    model,
    max_output_tokens: maxTokens,
    input: [
      {
        role: "user",
        // StepFun recommends media before the instruction for best results.
        content: [...mediaBlocks, { type: "input_text", text: prompt }],
      },
    ],
  };
}

/** Extract the assistant text from an OpenAI Responses API payload. */
function extractResponsesText(data) {
  const items = Array.isArray(data?.output) ? data.output : [];
  const parts = [];
  for (const item of items) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (block?.type === "output_text" && block.text) parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}

async function callStepFunVision(req, { capability, mediaBlocks }) {
  const fetchFn = req.fetchFn ?? fetch;
  const model = resolveParam(req.model, defaultModel);
  const prompt = resolvePrompt(req);
  const maxTokens = resolveMaxTokens(req);
  const apiKey = resolveApiKey(req);
  if (!apiKey) {
    throw new Error(
      `StepFun vision: missing API key. Set ${ENV_API_KEY} in your environment, or configure models.providers.${PROVIDER_ID}.apiKey in openclaw.json.`,
    );
  }

  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: resolveBaseUrl(req),
      defaultBaseUrl,
      headers: req.headers,
      request: req.request,
      defaultHeaders: apiKey
        ? { "content-type": "application/json", authorization: `Bearer ${apiKey}` }
        : undefined,
      provider: PROVIDER_ID,
      api: "openai-responses",
      capability,
      transport: "media-understanding",
    });

  const url = `${baseUrl.replace(/\/+$/, "")}/responses`;

  const { response: res, release } = await postJsonRequest({
    url,
    headers,
    body: buildResponsesBody({ model, prompt, mediaBlocks, maxTokens }),
    timeoutMs: req.timeoutMs,
    fetchFn,
    allowPrivateNetwork,
    dispatcherPolicy,
  });

  try {
    await assertOkOrThrowHttpError(res, "StepFun vision description failed");
    const data = await res.json();
    const text = extractResponsesText(data);
    if (!text) {
      throw new Error("StepFun vision API returned no text content");
    }
    return { text, model: data.model || model };
  } finally {
    release();
  }
}

// ── 插件入口 ──────────────────────────────────────────────────────────

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "StepFun Vision",
  description:
    "Registers StepFun vision models as image & video understanding providers via " +
    "the OpenAI Responses API: step-5-preview for Step Plan users, " +
    "step-1o-turbo-vision for standard API users, step-3.7-flash as fallback.",

  register(api) {
    surface = resolveSurfaceFromPluginConfig(api);
    applySurface();

    const defaultModels = {
      image: defaultModel,
      video: defaultModel,
    };

    api.registerMediaUnderstandingProvider({
      id: PROVIDER_ID,
      capabilities: ["image", "video"],
      defaultModels,
      autoPriority: { image: 10, video: 10 },

      // Resolve the API key for the media-understanding execution path so the
      // provider works even without a models.providers.stepfun-vision entry.
      resolveSyntheticAuth: ({ providerConfig }) => {
        const cfgKey = expandSecret(providerConfig?.apiKey);
        if (cfgKey) {
          return {
            apiKey: cfgKey,
            source: `models.providers.${PROVIDER_ID}.apiKey`,
            mode: "api-key",
          };
        }
        const envKey = process.env[ENV_API_KEY];
        if (envKey) {
          return { apiKey: envKey, source: `env: ${ENV_API_KEY}`, mode: "api-key" };
        }
        return null;
      },

      describeImage: (req) =>
        callStepFunVision(req, {
          capability: "image",
          mediaBlocks: [
            {
              type: "input_image",
              image_url: {
                url: toDataUrl(req, "image"),
                detail: resolveImageDetail(req),
              },
            },
          ],
        }),

      describeImages: (req) => {
        const blocks = (req.images ?? []).map((img) => ({
          type: "input_image",
          image_url: {
            url: `data:${resolveParam(
              img.mime,
              guessMime(img.fileName, "image/jpeg"),
            )};base64,${img.buffer.toString("base64")}`,
            detail: resolveImageDetail(req),
          },
        }));
        if (blocks.length === 0) {
          throw new Error("StepFun vision: no images supplied");
        }
        return callStepFunVision(req, { capability: "image", mediaBlocks: blocks });
      },

      describeVideo: (req) =>
        callStepFunVision(req, {
          capability: "video",
          mediaBlocks: [
            {
              type: "input_video",
              video_url: { url: toDataUrl(req, "video") },
            },
          ],
        }),
    });
  },
});
