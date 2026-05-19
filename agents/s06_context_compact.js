#!/usr/bin/env node
// s06_context_compact.js - 上下文压缩（无限工作）
//
// 三层压缩流水线，让 Agent 可以永久运行而不会超出 LLM 的上下文窗口：
//
//     每轮执行后：
//     +------------------+
//     | 工具调用结果      |
//     +------------------+
//             |
//             v
//     [第一层: micro_compact]        （静默，每轮都执行）
//       把 3 轮之前的工具结果（非文件读取）替换为占位符
//       "[Previous: used {tool_name}]"
//             |
//             v
//     [检查: token 数 > 50000？]
//        |               |
//        否              是
//        |               |
//        v               v
//     继续      [第二层: auto_compact]
//                 保存完整对话记录到 .transcripts/
//                 让 LLM 总结对话
//                 用[摘要]替换所有消息
//                       |
//                       v
//               [第三层: compact 工具]
//                 模型主动调用 compact → 立即触发摘要
//                 与 auto 相同，但由模型主动触发
//
// 【核心理念】Agent 可以"选择性遗忘"来永久工作。
//             重要的是区分什么该保留（文件内容）、什么可以丢弃（命令输出历史）。

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import * as readline from "readline";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import * as process from "process";

dotenv.config({ override: true });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID;

const SYSTEM = `你是一个工作在 ${WORKDIR} 目录的编程智能体。使用工具完成任务。`;

const THRESHOLD = 50000;          // 触发自动压缩的 token 估计阈值
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");  // 完整对话存档目录
const KEEP_RECENT = 3;            // 保留最近 N 条工具结果不压缩
// 这些工具的结果不会被压缩（因为是有价值的参考内容）
const PRESERVE_RESULT_TOOLS = new Set(["read_file"]);

// Token 数量估算：用 JSON 字符串长度除以 4（粗略估计）
function estimateTokens(messages) {
  return JSON.stringify(messages).length / 4;
}

// =====================================================================
// 【第一层】micro_compact（微型压缩，每轮静默执行）
//
// 策略：保留最近 3 条工具结果，把更早的命令输出压缩为占位符
// 保留例外：read_file 的结果（文件内容是有价值的参考）
//
// 效果：每次执行后，旧的命令输出被替换为轻量占位符，
//       节省大量 token，但 LLM 仍然知道"曾经做了什么"
// =====================================================================
function microCompact(messages) {
  // 收集所有工具调用结果的位置
  const toolResults = [];
  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (let partIdx = 0; partIdx < msg.content.length; partIdx++) {
        const part = msg.content[partIdx];
        if (part && typeof part === "object" && part.type === "tool_result") {
          toolResults.push({ msgIdx, partIdx, part });
        }
      }
    }
  }

  // 如果工具结果总数 <= 保留数量，无需压缩
  if (toolResults.length <= KEEP_RECENT) {
    return messages;
  }

  // 构建"工具ID → 工具名称"的映射（从 assistant 的 tool_use 块中获取）
  const toolNameMap = {};
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && block.type === "tool_use") {
          toolNameMap[block.id] = block.name;
        }
      }
    }
  }

  // 压缩早期的工具结果（跳过最近的 KEEP_RECENT 条）
  const toClear = toolResults.slice(0, -KEEP_RECENT);
  for (const { part } of toClear) {
    // 跳过：内容本就很短 / 是 read_file 的结果（文件内容保留）
    if (typeof part.content !== "string" || part.content.length <= 100) {
      continue;
    }
    const toolId = part.tool_use_id || "";
    const toolName = toolNameMap[toolId] || "unknown";
    if (PRESERVE_RESULT_TOOLS.has(toolName)) {
      continue;  // read_file 结果不压缩
    }
    // 替换为轻量占位符
    part.content = `[上一步：使用了 ${toolName}]`;
  }
  return messages;
}

// =====================================================================
// 【第二层】auto_compact（自动全量压缩）
//
// 当 token 估计超过阈值时触发：
// 1. 把完整对话存档到 .transcripts/（用于审计/恢复）
// 2. 让 LLM 总结整个对话
// 3. 用摘要替换所有消息（messages 从一条摘要重新开始）
//
// 摘要包含：已完成的工作、当前状态、重要决策
// =====================================================================
async function autoCompact(messages) {
  // 保存完整对话记录（每行一条消息的 JSON）
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  const lines = messages.map((msg) => JSON.stringify(msg)).join("\n");
  fs.writeFileSync(transcriptPath, lines, "utf8");
  console.log(`[对话记录已保存：${transcriptPath}]`);

  // 取最后 80000 字符（防止摘要请求本身超出限制）
  const conversationText = JSON.stringify(messages).slice(-80000);
  const response = await client.messages.create({
    model: MODEL,
    messages: [{
      role: "user",
      content:
        "为了保持工作连贯性，请总结以下对话。包含：" +
        "1) 已完成的工作，2) 当前状态，3) 重要决策。" +
        "简洁但保留关键细节。\n\n" + conversationText,
    }],
    max_tokens: 2000,
  });

  const summaryBlock = response.content.find((b) => b.type === "text");
  const summary = summaryBlock ? summaryBlock.text : "未能生成摘要。";

  // 返回只含一条摘要消息的数组，替换原来所有消息
  return [{
    role: "user",
    content: `[对话已压缩。记录文件：${transcriptPath}]\n\n${summary}`,
  }];
}

// 基础工具实现
function safePath(p) {
  const resolved = path.resolve(WORKDIR, p);
  if (resolved !== WORKDIR && !resolved.startsWith(WORKDIR + path.sep)) {
    throw new Error(`路径越界：${p}`);
  }
  return resolved;
}

function runBash(command) {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "错误：危险命令已被拦截";
  }
  try {
    const output = execSync(command, {
      cwd: WORKDIR,
      timeout: 120000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const trimmed = output.trim();
    return trimmed ? trimmed.slice(0, 50000) : "(无输出)";
  } catch (err) {
    if (err.code === "ETIMEDOUT") return "错误：命令超时（120秒）";
    const out = ((err.stdout || "") + (err.stderr || "")).trim();
    return out ? out.slice(0, 50000) : `错误：${err.message}`;
  }
}

function runRead(p, limit) {
  try {
    const lines = fs.readFileSync(safePath(p), "utf8").split("\n");
    const result =
      limit && limit < lines.length
        ? [...lines.slice(0, limit), `... (还有 ${lines.length - limit} 行)`]
        : lines;
    return result.join("\n").slice(0, 50000);
  } catch (e) {
    return `错误：${e.message}`;
  }
}

function runWrite(p, content) {
  try {
    const fp = safePath(p);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf8");
    return `已写入 ${Buffer.byteLength(content)} 字节`;
  } catch (e) {
    return `错误：${e.message}`;
  }
}

function runEdit(p, oldText, newText) {
  try {
    const fp = safePath(p);
    const content = fs.readFileSync(fp, "utf8");
    if (!content.includes(oldText)) {
      return `错误：在 ${p} 中未找到指定文本`;
    }
    fs.writeFileSync(fp, content.replace(oldText, newText), "utf8");
    return `已编辑 ${p}`;
  } catch (e) {
    return `错误：${e.message}`;
  }
}

const TOOL_HANDLERS = {
  bash:       ({ command }) => runBash(command),
  read_file:  ({ path: p, limit }) => runRead(p, limit),
  write_file: ({ path: p, content }) => runWrite(p, content),
  edit_file:  ({ path: p, old_text, new_text }) => runEdit(p, old_text, new_text),
  compact:    () => "正在手动压缩...",   // 触发第三层（实际压缩在循环末尾执行）
};

const TOOLS = [
  {
    name: "bash",
    description: "执行 shell 命令。",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "读取文件内容。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "将内容写入文件。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "精确替换文件中的指定文本。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "compact",
    description: "手动触发对话压缩（上下文整理）。",
    input_schema: {
      type: "object",
      properties: {
        focus: { type: "string", description: "压缩摘要中需要保留的重点内容" },
      },
    },
  },
];

// =====================================================================
// 【改进版 Agent 循环】集成三层压缩
//
// 执行顺序（每轮）：
// 1. micro_compact（第一层：静默清理旧工具结果）
// 2. 检查 token 数量 → 触发 auto_compact（第二层）
// 3. 调用 LLM
// 4. 执行工具
// 5. 检查是否调用了 compact 工具 → 触发 auto_compact（第三层）
// =====================================================================
async function agentLoop(messages) {
  while (true) {
    // 第一层：每轮都静默执行微型压缩
    microCompact(messages);

    // 第二层：token 估计超过阈值时触发自动全量压缩
    if (estimateTokens(messages) > THRESHOLD) {
      console.log("[自动压缩已触发]");
      const compacted = await autoCompact(messages);
      // 就地替换 messages 数组的所有内容（保留引用）
      messages.splice(0, messages.length, ...compacted);
    }

    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results = [];
    let manualCompact = false;  // 本轮是否调用了 compact 工具

    for (const block of response.content) {
      if (block.type === "tool_use") {
        let output;
        if (block.name === "compact") {
          manualCompact = true;  // 标记需要手动压缩
          output = "正在压缩...";
        } else {
          const handler = TOOL_HANDLERS[block.name];
          try {
            output = handler ? handler(block.input) : `未知工具：${block.name}`;
          } catch (e) {
            output = `错误：${e.message}`;
          }
        }
        console.log(`> ${block.name}:`);
        console.log(String(output).slice(0, 200));
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(output),
        });
      }
    }

    messages.push({ role: "user", content: results });

    // 第三层：模型主动调用 compact 工具时触发手动压缩
    if (manualCompact) {
      console.log("[手动压缩]");
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
      return;  // 压缩后结束本轮，等待下一次用户输入
    }
  }
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const history = [];

  const ask = () =>
    new Promise((resolve) => {
      rl.question("\x1b[36ms06 >> \x1b[0m", resolve);
    });

  while (true) {
    let query;
    try {
      query = await ask();
    } catch {
      break;
    }

    if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) {
      break;
    }

    history.push({ role: "user", content: query });
    await agentLoop(history);

    const last = history[history.length - 1];
    if (Array.isArray(last.content)) {
      for (const block of last.content) {
        if (block.type === "text") {
          process.stdout.write(block.text);
        }
      }
    }
    console.log();
  }

  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
