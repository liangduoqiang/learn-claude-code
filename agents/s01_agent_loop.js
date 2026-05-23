#!/usr/bin/env node
// s01_agent_loop.js - Agent 循环（核心基础）
//
// AI 编程智能体的全部秘密，只需一个循环模式：
//
//     while 停止原因 == "tool_use":
//         response = LLM(消息列表, 工具列表)
//         执行工具
//         追加工具结果
//
// 数据流图：
//     +----------+      +-------+      +---------+
//     |   用户   | ---> |  LLM  | ---> |  工具   |
//     |  指令    |      |       |      | 执行器  |
//     +----------+      +---+---+      +----+----+
//                           ^               |
//                           |  tool_result  |
//                           +---------------+
//                           （循环继续直到 LLM 不再调用工具）
//
// 【核心理念】整个 Agent 不过就是一个"发请求 → 执行工具 → 把结果喂回去"的循环。
//             只要 LLM 还在请求工具，循环就继续；LLM 停止请求工具时，循环结束。

import { createLlmClient, getModel } from "./llm_client.js";
import { createFlowContext } from "./exec_flow.js";
import { execSync } from "child_process";
import * as readline from "readline";
import * as dotenv from "dotenv";
import * as os from "os";

// 加载 .env 文件中的环境变量
dotenv.config({ override: true });

// OpenAI 兼容 Chat Completions 客户端（见 llm_client.js）
const client = createLlmClient();
const MODEL = getModel();
const flow = createFlowContext("s01");

// 系统提示词：告诉 LLM 它的身份和行为准则
// "Act, don't explain" → 要求 LLM 直接行动，不要废话
const SYSTEM = `你是一个工作在 ${process.cwd()} 目录的编程智能体。使用 bash 工具来完成任务。直接行动，不要解释。`;

// 工具定义：告诉 LLM 可以调用哪些工具
// 本节只有 bash 一个工具，是最简配置
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
];

// 安全执行 bash 命令
// 关键安全措施：屏蔽危险命令、设置超时、限制输出大小
function runBash(command) {
  // 危险命令黑名单，防止 LLM 执行破坏性操作
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "错误：危险命令已被拦截";
  }
  try {
    const output = execSync(command, {
      cwd: process.cwd(),
      timeout: 120000,       // 2 分钟超时，防止命令卡住
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const trimmed = output.trim();
    // 最多返回 50000 字符，防止撑爆 LLM 的上下文窗口
    return trimmed ? trimmed.slice(0, 50000) : "(无输出)";
  } catch (err) {
    if (err.code === "ETIMEDOUT") {
      return "错误：命令超时（120秒）";
    }
    const out = ((err.stdout || "") + (err.stderr || "")).trim();
    return out ? out.slice(0, 50000) : `错误：${err.message}`;
  }
}

// =====================================================================
// 【核心】Agent 循环
// 这是整个 Agent 系统最重要的函数，理解这个循环就理解了 Agent 的本质
// =====================================================================
async function agentLoop(messages) {
  while (true) {
    flow.llmRequest(messages.length, SYSTEM);
    // 1. 调用 LLM，传入完整的对话历史和工具列表
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,           // 完整对话历史（包含之前所有工具调用结果）
      tools: TOOLS,
      max_tokens: 8000,
    });
    flow.llmResponse(response);

    // 2. 将 LLM 的回复追加到消息历史（无论是文本还是工具调用）
    messages.push({ role: "assistant", content: response.content });

    // 3. 检查退出条件：LLM 不再调用工具时，循环结束
    //    stop_reason 可能是 "tool_use"（需要继续）或 "end_turn"（结束）
    if (response.stop_reason !== "tool_use") {
      return;
    }

    // 4. 遍历 LLM 响应中的所有内容块，执行工具调用
    const results = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const output = runBash(block.input.command);
        flow.toolUse(block, output);

        // 构造工具结果，必须包含 tool_use_id 让 LLM 对应上
        results.push({
          type: "tool_result",
          tool_use_id: block.id,    // 关键：与 LLM 请求的工具调用 ID 对应
          content: output,
        });
      }
    }

    // 5. 把所有工具执行结果一起追加到消息历史，供下一轮 LLM 使用
    messages.push({ role: "user", content: results });
    // → 然后循环回到第 1 步，LLM 看到工具结果后决定下一步
  }
}

// 主函数：交互式命令行界面
async function main() {
  // 创建命令行交互接口
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // 对话历史：跨轮次保留，实现多轮对话记忆
  const history = [];

  const ask = () =>
    new Promise((resolve) => {
      rl.question("\x1b[36ms01 >> \x1b[0m", resolve);
    });

  while (true) {
    let query;
    try {
      query = await ask();
    } catch {
      break;
    }

    // 输入 q 或 exit 退出
    if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) {
      break;
    }

    // 用户输入追加到历史
    history.push({ role: "user", content: query });
    flow.userTurn(query);

    // 启动 Agent 循环，处理这个任务（可能调用多轮工具）
    await agentLoop(history);

    // 打印 LLM 最终的文本回复
    const last = history[history.length - 1];
    const responseContent = last.content;
    if (Array.isArray(responseContent)) {
      for (const block of responseContent) {
        if (block.type === "text") {
          process.stdout.write(`LLM 回复：${block.text}`);
        }
      }
    }
    console.log("\n");
  }

  rl.close();
}

main().catch((err) => {
  console.error("程序异常：", err);
  process.exit(1);
});
