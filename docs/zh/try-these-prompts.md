# s01–s12 试一试 Prompt 汇总

以下 prompt 可直接复制到对应章节的 agent 里试用。

## s01: The Agent Loop (Agent 循环)

文档: [s01-the-agent-loop.md](./s01-the-agent-loop.md)

```sh
cd learn-claude-code
python agents/s01_agent_loop.py
```

1. `创建一个名为 hello.py 的文件，打印 "Hello, World!"`
2. `列出当前目录下所有 Python 文件`
3. `当前 git 分支是什么？`
4. `创建名为 test_output 的目录，并在其中写入 3 个文件`

## s02: Tool Use (工具使用)

文档: [s02-tool-use.md](./s02-tool-use.md)

```sh
cd learn-claude-code
python agents/s02_tool_use.py
```

1. `读取 requirements.txt 文件`
2. `创建名为 greet.py 的文件，包含 greet(name) 函数`
3. `编辑 greet.py，为该函数添加 docstring`
4. `读取 greet.py，确认编辑是否成功`

## s03: TodoWrite (待办写入)

文档: [s03-todo-write.md](./s03-todo-write.md)

```sh
cd learn-claude-code
python agents/s03_todo_write.py
```

1. `重构 hello.py：添加类型注解、docstring 和 main 守卫`
2. `创建一个 Python 包，包含 __init__.py、utils.py 和 tests/test_utils.py`
3. `审查所有 Python 文件并修复风格问题`

## s04: Subagents (Subagent)

文档: [s04-subagent.md](./s04-subagent.md)

```sh
cd learn-claude-code
python agents/s04_subagent.py
```

1. `用子任务查一下这个项目用的什么测试框架`
2. `委派子 agent：读取所有 .py 文件并总结每个文件的作用`
3. `用子任务创建一个新模块，然后在这里验证结果`

## s05: Skills (Skill 加载)

文档: [s05-skill-loading.md](./s05-skill-loading.md)

```sh
cd learn-claude-code
python agents/s05_skill_loading.py
```

1. `有哪些 skill 可用？`
2. `加载 agent-builder skill 并按其说明操作`
3. `我要做代码审查，先加载相关的 skill`
4. `用 mcp-builder skill 构建一个 MCP server`

## s06: Context Compact (上下文压缩)

文档: [s06-context-compact.md](./s06-context-compact.md)

```sh
cd learn-claude-code
python agents/s06_context_compact.py
```

1. `逐个读取 agents/ 目录下的每个 Python 文件`（观察 micro-compact 替换旧结果）
2. `持续读文件，直到自动触发压缩`
3. `使用 compact 工具手动压缩对话`

## s07: Task System (任务系统)

文档: [s07-task-system.md](./s07-task-system.md)

```sh
cd learn-claude-code
python agents/s07_task_system.py
```

1. `创建 3 个任务：「搭建项目」「写代码」「写测试」，按顺序设置依赖关系`
2. `列出所有任务并展示依赖图`
3. `完成任务 1，再列出任务，看任务 2 是否已解除阻塞`
4. `为重构创建任务看板：parse -> transform -> emit -> test，其中 parse 完成后 transform 和 emit 可并行`

## s08: Background Tasks (后台任务)

文档: [s08-background-tasks.md](./s08-background-tasks.md)

```sh
cd learn-claude-code
python agents/s08_background_tasks.py
```

1. `在后台运行 "sleep 5 && echo done"，运行期间创建一个文件`
2. `启动 3 个后台任务："sleep 2"、"sleep 4"、"sleep 6"，并查看状态`
3. `在后台运行 pytest，同时继续处理其他事情`

## s09: Agent Teams (Agent 团队)

文档: [s09-agent-teams.md](./s09-agent-teams.md)

```sh
cd learn-claude-code
python agents/s09_agent_teams.py
```

1. `生成 alice（coder）和 bob（tester），让 alice 给 bob 发一条消息`
2. `向所有队友广播「状态更新：第一阶段已完成」`
3. `检查领导的收件箱是否有新消息`
4. 输入 `/team` 查看团队名册和状态
5. 输入 `/inbox` 手动检查领导的收件箱

## s10: Team Protocols (团队协议)

文档: [s10-team-protocols.md](./s10-team-protocols.md)

```sh
cd learn-claude-code
python agents/s10_team_protocols.py
```

1. `生成 coder 身份的 alice，然后请求关闭她`
2. `列出队友，查看 alice 在关闭获批后的状态`
3. `生成 bob 并分配有风险的重构任务，审查并拒绝他的计划`
4. `生成 charlie，让他提交计划，然后批准`
5. 输入 `/team` 监控状态

## s11: Autonomous Agents (Autonomous Agent)

文档: [s11-autonomous-agents.md](./s11-autonomous-agents.md)

```sh
cd learn-claude-code
python agents/s11_autonomous_agents.py
```

1. `在看板上创建 3 个任务，然后生成 alice 和 bob，观察它们自动认领`
2. `生成一个 coder 队友，让它自己从任务看板找活干`
3. `创建带依赖的任务，观察队友是否遵守 blocked 顺序`
4. 输入 `/tasks` 查看带 owner 的任务看板
5. 输入 `/team` 监控谁在工作、谁在空闲

## s12: Worktree + Task Isolation (Worktree 任务隔离)

文档: [s12-worktree-task-isolation.md](./s12-worktree-task-isolation.md)

```sh
cd learn-claude-code
python agents/s12_worktree_task_isolation.py
```

1. `为后端 auth 和前端登录页创建任务，然后列出任务`
2. `为任务 1 创建 worktree "auth-refactor"，再把任务 2 绑定到新 worktree "ui-login"`
3. `在 worktree "auth-refactor" 中运行 "git status --short"`
4. `保留 worktree "ui-login"，然后列出 worktree 并查看 events`
5. `用 complete_task=true 移除 worktree "auth-refactor"，再列出 tasks/worktrees/events`
