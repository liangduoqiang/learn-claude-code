#!/usr/bin/env node
// s08_background_tasks.js - 后台任务（异步并行执行）
//
// 在后台（异步）执行命令。通知队列在每次 LLM 调用前被消费，
// 将后台结果注入对话。
//
//     主循环                      后台（异步）
//     +-----------------+        +-----------------+
//     | Agent 循环      |        | 命令在执行中     |
//     | ...             |        | ...             |
//     | [LLM 调用] <---+------- | enqueue(结果)   |
//     |  ^消费通知队列  |        +-----------------+
//     +-----------------+
//
//     时间线：
//     Agent ----[启动A]----[启动B]----[做其他事]----
//                  |              |
//                  v              v
//               [A运行]      [B运行]        （并行执行）
//                  |              |
//                  +-- 通知队列 --> [结果注入对话]
//
// 【核心理念】"发射后不管" —— Agent 不会阻塞等待命令完成。
//             后台任务和 Agent 的思考可以并行进行。
//             这就像给 Agent 赋予了"多任务处理"能力。
//
// 【关键区别】
//   bash（同步）：Agent 等待命令完成才能继续 → 串行
//   background_run（异步）：Agent 立即得到 task_id → 并行
//
// 【实现原理】Node.js 的 exec() 是异步的（非阻塞）
//             命令完成时回调函数把结果推入通知队列
//             下一次 LLM 调用前消费队列，把结果作为消息注入

import { createLlmClient, getModel } from "./llm_client.js";
import { createFlowContext } from "./exec_flow.js";
import { execSync, exec } from "child_process";  // exec 是异步版本！
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as dotenv from "dotenv";
import { randomUUID } from "crypto";

dotenv.config({ override: true });

const WORKDIR = process.cwd();
const client = createLlmClient();
const MODEL = getModel();

const SYSTEM = `你是一个工作在 ${WORKDIR} 目录的编程智能体。对长时间运行的命令使用 background_run 工具。`;


// =====================================================================
// 【BackgroundManager】后台任务管理器
//
// 核心机制：
// - tasks: 任务状态字典 {task_id → {status, result, command}}
// - _notificationQueue: 完成通知队列（完成时推入，LLM 调用前消费）
//
// 工作流程：
// 1. run(command) → 生成 task_id，调用 exec()（非阻塞），立即返回 task_id
// 2. 命令在 Node.js 事件循环的后台运行
// 3. 命令完成时，回调函数把结果推入通知队列
// 4. agentLoop 每轮开始时 drainNotifications() 取出所有通知，注入对话
// =====================================================================
class BackgroundManager {
  constructor() {
    this.tasks = {};               // 所有后台任务的状态
    this._notificationQueue = [];  // 已完成但未通知 LLM 的结果
  }

  // 启动后台命令，立即返回 task_id（非阻塞）
  run(command) {
    const taskId = randomUUID().slice(0, 8);  // 生成简短的唯一 ID
    this.tasks[taskId] = { status: "running", result: null, command };
    flow.infra("后台任务创建", { taskId, command: command.slice(0, 200) });
    this._execute(taskId, command);  // 异步执行，不等待
    return `后台任务 ${taskId} 已启动：${command.slice(0, 80)}`;
  }

  // 使用 exec() 异步执行命令（不阻塞主线程）
  _execute(taskId, command) {
    exec(command, { cwd: WORKDIR, timeout: 300000 }, (error, stdout, stderr) => {
      // 此回调在命令完成时被 Node.js 事件循环调用
      let output, status;
      if (error && error.killed) {
        output = "错误：命令超时（300秒）";
        status = "timeout";
      } else if (error) {
        const out = ((stdout || "") + (stderr || "")).trim();
        output = out || `错误：${error.message}`;
        status = "completed";
      } else {
        output = (stdout + stderr).trim().slice(0, 50000);
        status = "completed";
      }
      this.tasks[taskId].status = status;
      this.tasks[taskId].result = output || "(无输出)";
      flow.infra("后台任务完成", {
        taskId,
        status,
        resultPreview: (output || "(无输出)").slice(0, 200),
      });

      // 把完成通知推入队列（等待 LLM 下次调用前消费）
      this._notificationQueue.push({
        task_id: taskId,
        status,
        command: command.slice(0, 80),
        result: (output || "(无输出)").slice(0, 500),  // 通知中只放摘要
      });
    });
  }

  // 查询后台任务状态
  check(taskId = null) {
    if (taskId) {
      const t = this.tasks[taskId];
      if (!t) return `错误：未知任务 ${taskId}`;
      return `[${t.status}] ${t.command.slice(0, 60)}\n${t.result || "(运行中)"}`;
    }
    // 列出所有任务
    const lines = Object.entries(this.tasks).map(
      ([tid, t]) => `${tid}: [${t.status}] ${t.command.slice(0, 60)}`
    );
    return lines.length ? lines.join("\n") : "暂无后台任务。";
  }

  // 消费所有待处理的通知（每次 LLM 调用前调用）
  drainNotifications() {
    const notifs = [...this._notificationQueue];
    this._notificationQueue.length = 0;  // 清空队列
    return notifs;
  }
}

const BG = new BackgroundManager();
const flow = createFlowContext("s08");


// 路径安全检查
function safePath(p) {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`路径越界：${p}`);
  }
  return resolved;
}

// 基础工具实现
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
    return output.trim().slice(0, 50000) || "(无输出)";
  } catch (e) {
    const out = ((e.stdout || "") + (e.stderr || "")).trim();
    if (e.signal === "SIGTERM") return "错误：命令超时（120秒）";
    return out.slice(0, 50000) || `错误：${e.message}`;
  }
}

function runRead(filePath, limit = null) {
  try {
    const lines = fs.readFileSync(safePath(filePath), "utf8").split("\n");
    const result = limit && limit < lines.length
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


// 工具派发表（增加了 background_run 和 check_background）
const TOOL_HANDLERS = {
  bash:             ({ command }) => runBash(command),
  read_file:        ({ path: p, limit }) => runRead(p, limit),
  write_file:       ({ path: p, content }) => runWrite(p, content),
  edit_file:        ({ path: p, old_text, new_text }) => runEdit(p, old_text, new_text),
  background_run:   ({ command }) => BG.run(command),       // 非阻塞启动
  check_background: ({ task_id } = {}) => BG.check(task_id), // 查询状态
};

const TOOLS = [
  {
    name: "bash",
    description: "执行 shell 命令（阻塞，等待完成）。",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
  {
    name: "read_file",
    description: "读取文件内容。",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "将内容写入文件。",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "精确替换文件中的指定文本。",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "background_run",
    description: "在后台执行命令，立即返回 task_id（非阻塞）。",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
  {
    name: "check_background",
    description: "查询后台任务状态。省略 task_id 则列出所有任务。",
    input_schema: { type: "object", properties: { task_id: { type: "string" } } },
  },
];


// =====================================================================
// 【改进版 Agent 循环】在每次 LLM 调用前注入后台任务通知
//
// 关键改进：
//   每次 LLM 调用前，先消费通知队列，把后台完成的结果注入对话。
//   这样 LLM 就能"感知"后台任务的完成，并据此做出决策。
// =====================================================================
async function agentLoop(messages) {
  while (true) {
    // 消费后台任务通知队列，注入为用户消息
    const notifs = BG.drainNotifications();
    if (notifs.length > 0 && messages.length > 0) {
      flow.infra("后台通知注入", { count: notifs.length, notifs });
      const notifText = notifs
        .map((n) => `[后台:${n.task_id}] ${n.status}: ${n.result}`)
        .join("\n");
      // 用 XML 标签包裹，让 LLM 清楚地识别这是后台任务结果
      messages.push({
        role: "user",
        content: `<background-results>\n${notifText}\n</background-results>`,
      });
    }

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
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        let output;
        try {
          output = handler ? handler(block.input) : `未知工具：${block.name}`;
        } catch (e) {
          output = `错误：${e.message}`;
        }
        if (block.name === "bash_background") {
          flow.infra("bash_background 调用", block.input);
        }
        flow.toolUse(block, output);
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
      }
    }
    messages.push({ role: "user", content: results });
  }
}


const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const history = [];

function prompt() {
  rl.question("\x1b[36ms08 >> \x1b[0m", async (query) => {
    if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) {
      rl.close();
      return;
    }
    history.push({ role: "user", content: query });
    flow.userTurn(query);
    await agentLoop(history);
    const last = history[history.length - 1].content;
    if (Array.isArray(last)) {
      for (const block of last) {
        if (block.text) console.log(`LLM 回复：${block.text}`);
      }
    }
    console.log();
    prompt();
  });
}

rl.on("close", () => process.exit(0));
prompt();
