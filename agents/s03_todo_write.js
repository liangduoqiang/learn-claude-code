#!/usr/bin/env node
// s03_todo_write.js - 待办列表（自我进度追踪）
//
// 模型通过 TodoManager 工具追踪自己的执行进度。
// 一个"催促提醒"机制保证模型不会忘记更新状态。
//
//     +----------+      +-------+      +---------+
//     |   用户   | ---> |  LLM  | ---> |  工具   |
//     |  指令    |      |       |      | + todo  |
//     +----------+      +---+---+      +----+----+
//                           ^               |
//                           |   工具结果    |
//                           +---------------+
//                                   |
//               +-----------+-----------+
//               | TodoManager 状态      |
//               | [ ] 任务 A            |
//               | [>] 任务 B <- 进行中  |
//               | [x] 任务 C            |
//               +-----------------------+
//                                   |
//               如果 3 轮没有调用 todo 工具：
//                 注入 <reminder>更新待办列表</reminder>
//
// 【核心理念】Agent 可以追踪自己的进度——而且我们人类也能看到。
//             这解决了 LLM 做复杂任务时"忘记步骤"的问题。

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
const flow = createFlowContext("s03");

// 系统提示中明确要求使用 todo 工具规划多步任务
const SYSTEM = `你是一个工作在 ${WORKDIR} 目录的编程智能体。
使用 todo 工具规划多步任务。开始前标记为 in_progress，完成后标记为 completed。
优先使用工具，而不是长篇解释。`;

// =====================================================================
// 【TodoManager】LLM 可写入的结构化状态管理器
//
// 状态机：pending → in_progress → completed
// 约束：同一时刻只允许一个任务处于 in_progress 状态
//       （强制 LLM 专注于当前任务，不要并行处理）
// =====================================================================
class TodoManager {
  constructor() {
    this.items = [];
  }

  // 更新整个待办列表（LLM 每次调用 todo 工具时传入完整列表）
  update(items) {
    if (items.length > 20) {
      throw new Error("待办列表最多 20 条");
    }
    const validated = [];
    let inProgressCount = 0;
    items.forEach((item, i) => {
      const text = String(item.text ?? "").trim();
      const status = String(item.status ?? "pending").toLowerCase();
      const id = String(item.id ?? i + 1);
      if (!text) throw new Error(`条目 ${id}：text 不能为空`);
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`条目 ${id}：状态 '${status}' 无效`);
      }
      if (status === "in_progress") inProgressCount++;
      validated.push({ id, text, status });
    });
    // 约束：不允许同时有多个进行中的任务
    if (inProgressCount > 1) {
      throw new Error("同一时刻只允许一个任务处于 in_progress 状态");
    }
    this.items = validated;
    return this.render();
  }

  // 渲染可读的待办列表文本（反馈给 LLM 和用户）
  render() {
    if (this.items.length === 0) return "暂无待办事项。";
    const markers = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
    const lines = this.items.map(
      (item) => `${markers[item.status]} #${item.id}: ${item.text}`
    );
    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} 已完成)`);
    return lines.join("\n");
  }
}

const TODO = new TodoManager();

// 路径安全检查
function safePath(p) {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR + path.sep) && resolved !== WORKDIR) {
    throw new Error(`路径越界：${p}`);
  }
  return resolved;
}

// 工具实现（同 s02）
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
    const sliced =
      limit && limit < lines.length
        ? [...lines.slice(0, limit), `... (还有 ${lines.length - limit} 行)`]
        : lines;
    return sliced.join("\n").slice(0, 50000);
  } catch (e) {
    return `错误：${e.message}`;
  }
}

function runWrite(filePath, content) {
  try {
    const fp = safePath(filePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf8");
    return `已写入 ${Buffer.byteLength(content, "utf8")} 字节`;
  } catch (e) {
    return `错误：${e.message}`;
  }
}

function runEdit(filePath, oldText, newText) {
  try {
    const fp = safePath(filePath);
    const content = fs.readFileSync(fp, "utf8");
    if (!content.includes(oldText)) return `错误：在 ${filePath} 中未找到指定文本`;
    fs.writeFileSync(fp, content.replace(oldText, newText), "utf8");
    return `已编辑 ${filePath}`;
  } catch (e) {
    return `错误：${e.message}`;
  }
}

// 工具派发表（新增 todo 工具）
const TOOL_HANDLERS = {
  bash: (input) => runBash(input.command),
  read_file: (input) => runRead(input.path, input.limit),
  write_file: (input) => runWrite(input.path, input.content),
  edit_file: (input) => runEdit(input.path, input.old_text, input.new_text),
  todo: (input) => TODO.update(input.items),   // LLM 通过这个工具更新进度
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
    name: "todo",
    description: "更新任务列表。用于追踪多步骤任务的进度。",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["id", "text", "status"],
          },
        },
      },
      required: ["items"],
    },
  },
];

// =====================================================================
// 【改进点】带"催促提醒"机制的 Agent 循环
//
// roundsSinceTodo 计数器追踪上次调用 todo 工具到现在经过了几轮。
// 如果超过 3 轮没有更新待办列表，就向 LLM 注入一个提醒消息。
// 这是一种"行为纠正"技术：通过消息注入来引导 LLM 的行为。
// =====================================================================
async function agentLoop(messages) {
  let roundsSinceTodo = 0;  // 上次更新 todo 后经过的轮数

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

    if (response.stop_reason !== "tool_use") return;

    const results = [];
    let usedTodo = false;  // 本轮是否调用了 todo 工具

    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        let output;
        try {
          output = handler ? handler(block.input) : `未知工具：${block.name}`;
        } catch (e) {
          output = `错误：${e.message}`;
        }
        const outStr = String(output);
        flow.toolUse(block, outStr);
        if (block.name === "todo") {
          flow.infra("待办状态", { items: TODO.items.length });
        }
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(output),
        });
        if (block.name === "todo") usedTodo = true;  // 标记本轮用了 todo
      }
    }

    // 更新计数器：用了就重置，没用就累加
    roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;

    // 超过 3 轮没更新 todo → 注入催促提醒
    // 这条提醒会成为对话历史的一部分，LLM 下轮会看到它
    if (roundsSinceTodo >= 3) {
      flow.infra("todo 催促", { roundsSinceTodo });
      results.push({ type: "text", text: "<reminder>请更新你的待办列表。</reminder>" });
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
    new Promise((resolve) => rl.question("\x1b[36ms03 >> \x1b[0m", resolve));

  while (true) {
    let query;
    try {
      query = await ask();
    } catch {
      break;
    }

    if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) break;

    history.push({ role: "user", content: query });
    flow.userTurn(query);
    await agentLoop(history);

    if (TODO.items.length > 0) {
      flow.infra("回合结束待办快照", { plan: TODO.render() });
    }

    const last = history[history.length - 1];
    if (Array.isArray(last.content)) {
      for (const block of last.content) {
        if (block.type === "text") process.stdout.write(`LLM 回复：${block.text}`);
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
