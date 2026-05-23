#!/usr/bin/env node
// s05_skill_loading.js - 技能加载（按需注入知识）
//
// 两层技能注入方案，避免将所有内容塞入系统提示词：
//
//     第一层（廉价）：在系统提示词中列出技能名称（每个技能约 100 token）
//     第二层（按需）：在 tool_result 中返回完整的技能内容
//
//     skills/
//       pdf/
//         SKILL.md          <-- 含 YAML frontmatter（name、description）+ 正文
//       code-review/
//         SKILL.md
//
//     系统提示词：
//     +--------------------------------------+
//     | 你是一个编程智能体。                  |
//     | 可用技能：                            |
//     |   - pdf: 处理 PDF 文件...            |  <-- 第一层：仅元数据
//     |   - code-review: 代码审查...         |
//     +--------------------------------------+
//
//     当模型调用 load_skill("pdf") 时：
//     +--------------------------------------+
//     | tool_result:                         |
//     | <skill>                              |
//     |   完整的 PDF 处理说明                 |  <-- 第二层：完整内容
//     |   步骤 1: ...                        |
//     |   步骤 2: ...                        |
//     | </skill>                             |
//     +--------------------------------------+
//
// 【核心理念】不要把所有内容放进系统提示词。按需加载。
//             只有模型真正需要某个技能时，才把技能内容注入上下文。
//             这节省了大量 token，也让系统提示词保持简洁。

import { createLlmClient, getModel } from "./llm_client.js";
import { createFlowContext } from "./exec_flow.js";
import { execSync } from "child_process";
import * as readline from "readline";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config({ override: true });

const WORKDIR = process.cwd();
const client = createLlmClient();
const MODEL = getModel();
const flow = createFlowContext("s05");
const SKILLS_DIR = path.join(WORKDIR, "skills");


// =====================================================================
// 【SkillLoader】扫描并管理技能目录
//
// 技能文件格式（SKILL.md）：
//   ---
//   name: pdf
//   description: 处理 PDF 文件
//   tags: document
//   ---
//   （技能的详细内容...）
//
// 两层访问接口：
//   getDescriptions() → 所有技能的名称+描述（注入系统提示词，轻量）
//   getContent(name)  → 指定技能的完整内容（注入 tool_result，按需加载）
// =====================================================================
class SkillLoader {
  constructor(skillsDir) {
    this.skillsDir = skillsDir;
    this.skills = {};
    this._loadAll();
  }

  // 启动时扫描所有技能文件
  _loadAll() {
    if (!fs.existsSync(this.skillsDir)) return;
    this._findSkillFiles(this.skillsDir).sort().forEach((filePath) => {
      const text = fs.readFileSync(filePath, "utf8");
      const { meta, body } = this._parseFrontmatter(text);
      const name = meta.name || path.basename(path.dirname(filePath));
      this.skills[name] = { meta, body, path: filePath };
    });
  }

  // 递归查找所有 SKILL.md 文件
  _findSkillFiles(dir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this._findSkillFiles(full));
      } else if (entry.name === "SKILL.md") {
        results.push(full);
      }
    }
    return results;
  }

  // 解析 YAML frontmatter（--- 分隔符之间的键值对）
  // 只处理简单的 key: value 格式（不需要完整的 YAML 解析器）
  _parseFrontmatter(text) {
    const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)/);
    if (!match) return { meta: {}, body: text };
    const meta = {};
    for (const line of match[1].split("\n")) {
      const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
      if (kv) meta[kv[1]] = kv[2].trim();
    }
    return { meta, body: match[2].trim() };
  }

  // 第一层：返回所有技能的简短描述（注入系统提示词）
  getDescriptions() {
    if (Object.keys(this.skills).length === 0) return "(暂无可用技能)";
    return Object.entries(this.skills)
      .map(([name, skill]) => {
        const desc = skill.meta.description || "无描述";
        const tags = skill.meta.tags || "";
        return tags ? `  - ${name}: ${desc} [${tags}]` : `  - ${name}: ${desc}`;
      })
      .join("\n");
  }

  // 第二层：返回指定技能的完整内容（通过 tool_result 按需注入）
  getContent(name) {
    const skill = this.skills[name];
    if (!skill) {
      return `错误：未知技能 '${name}'。可用技能：${Object.keys(this.skills).join(", ")}`;
    }
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}

const SKILL_LOADER = new SkillLoader(SKILLS_DIR);

// 第一层：技能元数据注入系统提示词（每次请求都携带，但体积小）
const SYSTEM = `你是一个工作在 ${WORKDIR} 目录的编程智能体。
在处理不熟悉的话题前，使用 load_skill 工具加载相关的专业知识。

可用技能：
${SKILL_LOADER.getDescriptions()}`;


// 路径安全检查
function safePath(p) {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR + path.sep) && resolved !== WORKDIR) {
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
    const lines = fs.readFileSync(safePath(filePath), "utf8").split("\n");
    const truncated =
      limit && limit < lines.length
        ? [...lines.slice(0, limit), `... (还有 ${lines.length - limit} 行)`]
        : lines;
    return truncated.join("\n").slice(0, 50000);
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
    if (!content.includes(oldText)) return `错误：在 ${filePath} 中未找到指定文本`;
    fs.writeFileSync(fp, content.replace(oldText, newText), "utf8");
    return `已编辑 ${filePath}`;
  } catch (e) {
    return `错误：${e.message}`;
  }
}

// 工具派发表（新增 load_skill）
const TOOL_HANDLERS = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path: p, limit }) => runRead(p, limit),
  write_file: ({ path: p, content }) => runWrite(p, content),
  edit_file: ({ path: p, old_text, new_text }) => runEdit(p, old_text, new_text),
  load_skill: ({ name }) => SKILL_LOADER.getContent(name),  // 第二层按需加载
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
    name: "load_skill",
    description: "按名称加载专业知识技能。",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "要加载的技能名称" },
      },
      required: ["name"],
    },
  },
];


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
        if (block.name === "load_skill") {
          flow.infra("技能按需加载", { name: block.input?.name });
        }
        flow.toolUse(block, output);
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
      rl.question("\x1b[36ms05 >> \x1b[0m", resolve);
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
    flow.userTurn(query);
    await agentLoop(history);

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
