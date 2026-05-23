// 统一执行流程日志（s01–s12）。设置 EXEC_FLOW=0 可关闭。
const ENABLED = process.env.EXEC_FLOW !== "0";

const DIM = "\x1b[90m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";

/** 按角色名稳定映射，避免多 agent 日志颜色撞车 */
const ROLE_COLORS = [
  "\x1b[36m",
  "\x1b[33m",
  "\x1b[32m",
  "\x1b[35m",
  "\x1b[34m",
  "\x1b[91m",
  "\x1b[92m",
  "\x1b[93m",
  "\x1b[94m",
  "\x1b[95m",
  "\x1b[96m",
  "\x1b[31m",
];

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

function colorForRole(roleKey) {
  return ROLE_COLORS[hashString(String(roleKey)) % ROLE_COLORS.length];
}

function roleKeyFromTag(tag) {
  let m = tag.match(/:worker:(.+)$/);
  if (m) return m[1];
  m = tag.match(/:teammate:(.+)$/);
  if (m) return m[1];
  if (/:subagent$/.test(tag)) return "subagent";
  if (/:lead$/.test(tag)) return "lead";
  const parts = tag.split(":");
  return parts.length > 1 ? parts[parts.length - 1] : tag;
}

function flowPrefix(tag) {
  const c = colorForRole(roleKeyFromTag(tag));
  return `${DIM}[FLOW ${c}${tag}${RESET}${DIM}`;
}

function preview(value, max = 240) {
  const s =
    typeof value === "string" ? value : JSON.stringify(value ?? null);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function toolNamesFromContent(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b.type === "tool_use")
    .map((b) => b.name);
}

/**
 * @param {string} tag 如 s01、s04:subagent
 */
export function createFlowContext(tag) {
  let round = 0;
  const defaultRoleKey = roleKeyFromTag(tag);
  const defaultRoleColor = colorForRole(defaultRoleKey);

  function line(kind, detail) {
    if (!ENABLED) return;
    console.log(`${flowPrefix(tag)} ${kind}]${RESET} ${detail}`);
  }

  function actorPrefix(extra = {}) {
    if (!extra.actor) return "";
    const c = colorForRole(extra.actor);
    return `${c}[${extra.actor}]${RESET} `;
  }

  return {
    tag,
    userTurn(query) {
      line("用户", `${CYAN}${preview(query, 120)}${RESET}`);
    },
    llmRequest(messageCount, system) {
      round += 1;
    
      line(
        `轮次#${round}`,
        `${defaultRoleColor}→ LLM 请求（历史消息条数=${messageCount}）${RESET}`
      );
    },
    llmResponse(response) {
      const tools = toolNamesFromContent(response.content);
      const text = Array.isArray(response.content)
        ? response.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
        : "";
      line(
        `轮次#${round}`,
        `${defaultRoleColor}← LLM 返回=${response.stop_reason}${RESET}` +
          (tools.length ? ` 工具=[${tools.join(", ")}]` : "") +
          (text ? ` 文本=${preview(text, 100)}` : "")
      );
    },
    toolUse(block, output, extra = {}) {
      const c = colorForRole(extra.actor || defaultRoleKey);
      const actor = actorPrefix(extra);
      line(
        `轮次#${round}`,
        `${actor}${c}工具 ${block.name}${RESET} ` +
          ` 参数=${preview(block.input, 100)}`
      );
      line(
        `轮次#${round}`,
        `${actor}结果 ${block.name}: ${preview(String(output), 300)}`
      );
    },
    /** 基础设施事件：团队、线程、收件箱、任务、工作树、压缩等 */
    infra(event, data = {}) {
      line("基础设施", `${MAGENTA}${event}${RESET} ${preview(data, 500)}`);
    },
    phase(label, detail) {
      line("阶段", `${GREEN}${label}${RESET} ${detail}`);
    },
    getRound() {
      return round;
    },
  };
}

/** 单次日志（无轮次上下文） */
export function flowOnce(tag, kind, detail) {
  if (!ENABLED) return;
  console.log(`${flowPrefix(tag)} ${kind}]${RESET} ${preview(detail, 500)}`);
}
