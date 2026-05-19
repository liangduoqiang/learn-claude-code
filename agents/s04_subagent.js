#!/usr/bin/env node
// s04_subagent.js - 子智能体（上下文隔离）
//
// 派生一个子 Agent，它拥有全新的 messages=[]（空上下文）。
// 子 Agent 独立完成工作，共享同一个文件系统，
// 最终只把"摘要"返回给父 Agent。
//
//     父 Agent                          子 Agent
//     +------------------+             +------------------+
//     | messages=[...]   |             | messages=[]      | <-- 全新上下文
//     |                  |  派发       |                  |
//     | 工具: task        | ---------> | while tool_use:  |
//     |   prompt="..."   |            |   调用工具        |
//     |   description="" |            |   追加结果        |
//     |                  |  摘要      |                  |
//     |   result = "..." | <--------- | 返回最后的文本    |
//     +------------------+             +------------------+
//               |
//     父 Agent 上下文保持整洁。
//     子 Agent 上下文执行完毕后丢弃。
//
// 【核心理念】进程隔离 = 上下文隔离。
//             子 Agent 完成探索性任务后，只向父 Agent 汇报结果摘要，
//             不会污染父 Agent 的对话历史。
//             这就像"派一个人去调研，回来给你汇报"，而不是"把整个调研过程塞给你"。

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as dotenv from "dotenv";
import * as process from "process";

dotenv.config({ override: true });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID;

// 父 Agent 提示：鼓励使用 task 工具委托子任务
const SYSTEM = `你是一个工作在 ${WORKDIR} 目录的编程智能体。使用 task 工具委托探索或子任务。`;
// 子 Agent 提示：完成任务并汇报
const SUBAGENT_SYSTEM = `你是一个工作在 ${WORKDIR} 目录的子智能体。完成指定任务，然后总结你的发现。`;

// 路径安全检查（父子 Agent 共用）
function safePath(p) {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR + path.sep) && resolved !== WORKDIR) {
    throw new Error(`路径越界：${p}`);
  }
  return resolved;
}

// 基础工具实现（父子 Agent 共用）
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

function runRead(filePath, limit) {
  try {
    const fp = safePath(filePath);
    const lines = fs.readFileSync(fp, "utf8").split("\n");
    const result =
      limit && limit < lines.length
        ? [...lines.slice(0, limit), `... (还有 ${lines.length - limit} 行)`]
        : lines;
    return result.join("\n").slice(0, 50000);
  } catch (e) {
    return `错误：${e.message}`;
  }
}

function runWrite(filePath, content) {
  try {
    const fp = safePath(filePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf8");
    return `已写入 ${content.length} 字节`;
  } catch (e) {
    return `错误：${e.message}`;
  }
}

function runEdit(filePath, oldText, newText) {
  try {
    const fp = safePath(filePath);
    const content = fs.readFileSync(fp, "utf8");
    if (!content.includes(oldText)) {
      return `错误：在 ${filePath} 中未找到指定文本`;
    }
    fs.writeFileSync(fp, content.replace(oldText, newText), "utf8");
    return `已编辑 ${filePath}`;
  } catch (e) {
    return `错误：${e.message}`;
  }
}

const TOOL_HANDLERS = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path: p, limit }) => runRead(p, limit),
  write_file: ({ path: p, content }) => runWrite(p, content),
  edit_file: ({ path: p, old_text, new_text }) => runEdit(p, old_text, new_text),
};

// 子 Agent 工具集：只有基础工具，没有 task 工具（禁止递归派发）
// 设计原则：子 Agent 不能再创建子 Agent，防止无限递归
const CHILD_TOOLS = [
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
];

// =====================================================================
// 【核心】子 Agent 执行器
//
// 关键特点：
// 1. 全新上下文：subMessages = [{ role: "user", content: prompt }]
//    从空白开始，不继承父 Agent 的任何历史
// 2. 过滤工具：CHILD_TOOLS 不包含 task（防止递归）
// 3. 只返回摘要：只取最后响应的文本块，中间过程全部丢弃
//    父 Agent 只看到结果，不看过程（上下文保持整洁）
// 4. 轮数上限：最多 30 轮，防止子 Agent 陷入死循环
// =====================================================================
async function runSubagent(prompt) {
  const subMessages = [{ role: "user", content: prompt }];  // 全新上下文！
  let response;

  for (let i = 0; i < 30; i++) {  // 最多 30 轮防止死循环
    response = await client.messages.create({
      model: MODEL,
      system: SUBAGENT_SYSTEM,
      messages: subMessages,
      tools: CHILD_TOOLS,     // 子 Agent 只有基础工具
      max_tokens: 8000,
    });
    subMessages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") break;  // 子 Agent 完成了

    const results = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        const output = handler ? handler(block.input) : `未知工具：${block.name}`;
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(output).slice(0, 50000),
        });
      }
    }
    subMessages.push({ role: "user", content: results });
  }

  // 只把最终的文字摘要返回给父 Agent
  // 子 Agent 整个执行过程（subMessages）被丢弃，不会污染父 Agent 的上下文
  const summary = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return summary || "(无摘要)";
}

// 父 Agent 工具集：基础工具 + task 派发工具
const PARENT_TOOLS = [
  ...CHILD_TOOLS,
  {
    name: "task",
    description:
      "派发一个子智能体，它拥有全新的对话上下文，共享文件系统但不继承对话历史。",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        description: {
          type: "string",
          description: "任务的简短描述",
        },
      },
      required: ["prompt"],
    },
  },
];

// 父 Agent 循环：遇到 task 工具时异步派发子 Agent
async function agentLoop(messages) {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: PARENT_TOOLS,
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;

    const results = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        let output;
        if (block.name === "task") {
          // 收到 task 工具调用 → 创建子 Agent 处理
          const desc = block.input.description || "子任务";
          const prompt = block.input.prompt || "";
          console.log(`> task (${desc}): ${prompt.slice(0, 80)}`);
          output = await runSubagent(prompt);  // 子 Agent 完整执行，只返回摘要
        } else {
          const handler = TOOL_HANDLERS[block.name];
          output = handler ? handler(block.input) : `未知工具：${block.name}`;
        }
        console.log(`  ${String(output).slice(0, 200)}`);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(output),
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
      rl.question("\x1b[36ms04 >> \x1b[0m", resolve);
    });

  while (true) {
    let query;
    try {
      query = await ask();
    } catch {
      break;
    }

    if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) break;

    history.push({ role: "user", content: query });
    await agentLoop(history);

    const last = history[history.length - 1];
    if (Array.isArray(last.content)) {
      for (const block of last.content) {
        if (block.type === "text") process.stdout.write(block.text);
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
