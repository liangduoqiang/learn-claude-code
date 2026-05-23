// OpenAI Chat Completions API（兼容 agents 内 Anthropic 风格 messages/tools 调用）
import OpenAI from "openai";
import { randomUUID } from "crypto";

export function getModel() {
  const model = process.env.MODEL_NAME || process.env.MODEL_ID;
  if (!model) {
    throw new Error("缺少 MODEL_NAME（或 MODEL_ID）环境变量");
  }
  return model;
}

function anthropicToolsToOpenAI(tools) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {} },
    },
  }));
}

function anthropicMessagesToOpenAI(messages, system) {
  const out = [];
  if (system) {
    out.push({ role: "system", content: system });
  }

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        out.push({ role: "user", content: msg.content });
        continue;
      }
      if (Array.isArray(msg.content)) {
        if (msg.content.every((b) => b.type === "tool_result")) {
          for (const tr of msg.content) {
            out.push({
              role: "tool",
              tool_call_id: tr.tool_use_id,
              content:
                typeof tr.content === "string"
                  ? tr.content
                  : JSON.stringify(tr.content),
            });
          }
          continue;
        }
        const text = msg.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        out.push({
          role: "user",
          content: text || JSON.stringify(msg.content),
        });
        continue;
      }
    }

    if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        out.push({ role: "assistant", content: msg.content });
        continue;
      }
      if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter((b) => b.type === "text")
          .map((b) => b.text);
        const reasoningParts = msg.content
          .filter((b) => b.type === "reasoning")
          .map((b) => b.text);
        const toolUses = msg.content.filter((b) => b.type === "tool_use");
        const assistantMsg = {
          role: "assistant",
          content: textParts.length ? textParts.join("\n") : null,
        };
        if (reasoningParts.length) {
          assistantMsg.reasoning_content = reasoningParts.join("\n");
        }
        if (toolUses.length) {
          assistantMsg.tool_calls = toolUses.map((tu) => ({
            id: tu.id,
            type: "function",
            function: {
              name: tu.name,
              arguments: JSON.stringify(tu.input ?? {}),
            },
          }));
        }
        out.push(assistantMsg);
      }
    }
  }

  return out;
}

function openAIChoiceToAnthropic(choice) {
  const msg = choice.message;
  const content = [];

  if (msg.reasoning_content) {
    content.push({ type: "reasoning", text: msg.reasoning_content });
  }
  if (msg.content) {
    content.push({ type: "text", text: msg.content });
  }

  for (const tc of msg.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(tc.function?.arguments || "{}");
    } catch {
      input = {};
    }
    content.push({
      type: "tool_use",
      id: tc.id || `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      name: tc.function.name,
      input,
    });
  }

  const stop_reason =
    choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn";

  return { content, stop_reason };
}

export function createLlmClient(options = {}) {
  const apiKey =
    options.apiKey ??
    options.api_key ??
    process.env.OPENAI_API_KEY;
  const baseURL =
    options.baseURL ??
    options.baseUrl ??
    process.env.OPENAI_BASE_URL;

  if (!apiKey) {
    throw new Error("缺少 OPENAI_API_KEY 环境变量");
  }

  const openai = new OpenAI({ apiKey, baseURL: baseURL || undefined });

  return {
    messages: {
      async create({ model, system, messages, tools, max_tokens }) {
        const response = await openai.chat.completions.create({
          model: model || getModel(),
          messages: anthropicMessagesToOpenAI(messages, system),
          tools: anthropicToolsToOpenAI(tools),
          max_tokens: max_tokens ?? 4096,
        });

        const choice = response.choices[0];
        if (!choice) {
          throw new Error("LLM 返回空响应");
        }
        return openAIChoiceToAnthropic(choice);
      },
    },
  };
}
