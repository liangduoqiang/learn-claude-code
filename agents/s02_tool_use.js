#!/usr/bin/env node
// s02_tool_use.js - 工具扩展
//
// s01 的 Agent 循环完全没有改变。我们只是向工具数组里增加了更多工具，
// 并引入了一个"派发表（dispatch map）"来路由不同的工具调用。
//
//     +----------+      +-------+      +------------------+
//     |   用户   | ---> |  LLM  | ---> | 工具派发表       |
//     |  指令    |      |       |      | {                |
//     +----------+      +---+---+      |   bash: runBash  |
//                           ^          |   read: runRead  |
//                           |          |   write: runWrite|
//                           +----------+   edit: runEdit  |
//                           工具结果   | }                |
//                                      +------------------+
//
// 【核心理念】循环根本没有改变。我只是增加了工具而已。
//             工具越多，Agent 能力越强；派发表让代码保持整洁。

import { createLlmClient, getModel } from "./llm_client.js";
import { createFlowContext } from "./exec_flow.js";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as dotenv from "dotenv";

dotenv.config({ override: true });

const WORKDIR = process.cwd();
const client = createLlmClient();
const MODEL = getModel();
const flow = createFlowContext("s02");

const SYSTEM = `你是一个工作在 ${WORKDIR} 目录的编程智能体。使用工具完成任务。直接行动，不要解释。`;

// 路径安全检查：防止 LLM 访问工作区之外的文件（目录穿越攻击防护）
function safePath(p) {
  const resolved = path.resolve(WORKDIR, p);
  // 确保解析后的路径在工作目录之内
  if (!resolved.startsWith(WORKDIR + path.sep) && resolved !== WORKDIR) {
    throw new Error(`路径越界：${p}`);
  }
  return resolved;
}

// 工具实现：执行 bash 命令（同 s01）
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
    if (err.code === "ETIMEDOUT") {
      return "错误：命令超时（120秒）";
    }
    const out = ((err.stdout || "") + (err.stderr || "")).trim();
    return out ? out.slice(0, 50000) : `错误：${err.message}`;
  }
}

// 工具实现：读取文件内容
// limit 参数可以限制返回行数，避免读取超大文件时撑爆上下文
function runRead(filePath, limit) {
  try {
    const resolved = safePath(filePath);
    const text = fs.readFileSync(resolved, "utf8");
    const lines = text.split("\n");
    const truncated =
      limit && limit < lines.length
        ? [...lines.slice(0, limit), `... (还有 ${lines.length - limit} 行)`]
        : lines;
    return truncated.join("\n").slice(0, 50000);
  } catch (err) {
    return `错误：${err.message}`;
  }
}

// 工具实现：写入文件（自动创建目录）
function runWrite(filePath, content) {
  try {
    const resolved = safePath(filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf8");
    return `已写入 ${content.length} 字节到 ${filePath}`;
  } catch (err) {
    return `错误：${err.message}`;
  }
}

// 工具实现：精确字符串替换（编辑文件）
// 这比直接重写整个文件更安全，LLM 只需指定要替换的旧文本和新文本
function runEdit(filePath, oldText, newText) {
  try {
    const resolved = safePath(filePath);
    const content = fs.readFileSync(resolved, "utf8");
    if (!content.includes(oldText)) {
      return `错误：在 ${filePath} 中未找到指定文本`;
    }
    fs.writeFileSync(resolved, content.replace(oldText, newText), "utf8");
    return `已编辑 ${filePath}`;
  } catch (err) {
    return `错误：${err.message}`;
  }
}

// =====================================================================
// 【关键设计】工具派发表（dispatch map）
// 将工具名称映射到对应的处理函数，避免大量 if-else 判断
// 新增工具时只需在这里添加一行 + 在 TOOLS 数组中添加描述
// =====================================================================
const TOOL_HANDLERS = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path: p, limit }) => runRead(p, limit),
  write_file: ({ path: p, content }) => runWrite(p, content),
  edit_file: ({ path: p, old_text, new_text }) => runEdit(p, old_text, new_text),
};

// 工具描述：LLM 通过这些描述了解每个工具的用途和参数格式
// JSON Schema 格式的输入规范确保 LLM 传入正确类型的参数
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
        limit: { type: "integer" },   // 可选：限制返回行数
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
        old_text: { type: "string" },  // 要被替换的原文本
        new_text: { type: "string" },  // 替换后的新文本
      },
      required: ["path", "old_text", "new_text"],
    },
  },
];

// Agent 循环（与 s01 完全相同，只是使用了派发表来路由工具）
async function agentLoop(messages) {
  while (true) {
    flow.llmRequest(messages.length, SYSTEM);
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });
    flow.llmResponse(response);

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        // 通过派发表查找处理函数
        const handler = TOOL_HANDLERS[block.name];
        const output = handler
          ? handler(block.input)
          : `未知工具：${block.name}`;   // 未知工具时返回错误信息而非抛出异常
        flow.toolUse(block, output);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }
    messages.push({ role: "user", content: results });
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
      rl.question("\x1b[36ms02 >> \x1b[0m", resolve);
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
    flow.userTurn(query);
    await agentLoop(history);

    const last = history[history.length - 1];
    const responseContent = last.content;
    if (Array.isArray(responseContent)) {
      for (const block of responseContent) {
        if (block.type === "text") {
          process.stdout.write(`LLM 回复：${block.text}`);
        }
      }
    }
    console.log();
  }

  rl.close();
}

main().catch((err) => {
  console.error("程序异常：", err);
  process.exit(1);
});
