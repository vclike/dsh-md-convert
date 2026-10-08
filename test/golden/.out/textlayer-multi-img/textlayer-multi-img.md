# textlayer-multi-img

<!--PAGE:01-->

# Agent 进化火山方舟 

版权所有 © 北京火山引擎科技有限公司

<!--/PAGE:01-->

<!--PAGE:02-->

法律声明 

Agent 进化 

## 法律声明 

本《火山方舟》的所有内容，包括但不限于文字、商标、架构、图示、图片、页面布局等 , 其知识产权（著作权、商标权、专利权、商业秘密等）归属于北京火山引擎科技有限公司及其关联公司（火山引擎），非经火山引擎书面同意，任何个人和组织不得复制、使用、修改、转发或以任何违反本《火山方舟》所承载的目的进行传播。 

本《火山方舟》陈述内容仅作为产品的通用性介绍和参考性指引，火山引擎保留按“现状”和“当前可用”的形式提供产品和服务的权利。火山引擎不对本《火山方舟》中所载的产品功能、性质、质量、标准等内容进行明示或默示的保证和承诺，最终以您与火山引擎实际签署的协议为准。 

如您发现本《火山方舟》有任何错误或歧义，或发现有对本《火山方舟》、产品本身的侵权行为，请与火山引擎取得联系。 

联系方式： service@volcengine.com ， 400-850-0030 

（周一至周五 10:00-18:00 ） 

版权所有 © 北京火山引擎科技有限公司 

1

<!--/PAGE:02-->

<!--PAGE:03-->

Agent 进化 

目录 

## 目录 

法律声 ~~明 1~~ 目 ~~录 1~~ 1. Agent 进 ~~化 1~~ 

版权所有 © 北京火山引擎科技有限公司 

1

<!--/PAGE:03-->

<!--PAGE:04-->

Agent 进化 

1. Agent 进化 

## 1. Agent 进化 

Agent 进化（Agent Evolve，以下简称 Evolve）是面向 Claude Code、OpenClaw、TraeCode 等 AI 工具的持续进化能力。Evolve 学习 Agent 的近期会话，识别当前运行时中可优化的指令文件，并生成改进建议。建议经您确认后，Evolve 会将其写入 CLAUDE.md、AGENTS.md 等运行时文件，帮助 Agent 在后续任务中持续改进。 

### 能力介绍 

Evolve 以 Agent 的会话日志为学习来源，从真实会话中提取优化证据（evidence），在云端生成可直接落地的优化建议（proposal），形成“会话学习—生成建议—确认应用”的进化闭环；通过连接器（connector）机制适配 Claude Code、OpenClaw、TraeCode 等 Agent，帮助您降低手动维护指令文件的成本。 

支持的核心能力如下： 

- 能力面发现：自动扫描运行时根目录，将 CLAUDE.md、AGENTS.md 等指令文件及 Skills 识别为可进化的能力面（capability），各 Agent 运行时的支持范围见下表。 

- 会话学习：读取近期 Agent 会话日志（JSONL 格式），将其中的有效经验和问题提取为优化证据（evidence），支持指定会话范围与导入数量。 

   - 优化建议：基于优化证据结合云端基因库生成优化建议（proposal），每条附带修改原因、来源会话证据、风险值（risk）与置信度（confidence），支持按 not_applied <mark>、</mark> applied 等状态筛选。 

- 

- 云端基因库：根据不同模型（model）在不同 Agent 上的运行效果，通过大数据提取出云端基因库，用于指导 Agent 的优化方向，更准确地生成优化建议（proposal）。 

- 受控应用：应用前渲染 unified diff 预览，默认仅在您确认后写入运行时文件；支持按能力面（capability）开启自动应用（Auto Apply），无需逐条确认。 

当前支持的 Agent 运行时如下： 

|运行时|Connector|可优化的指令文件|
|---|---|---|
|||项目级 CLAUDE.md、|
|Claude Code|claude_code|CLAUDE.local.md，用户级<br>~/.claude/CLAUDE.md|
|OpenClaw|openclaw|AGENTS.md、SOUL.md、<br>IDENTITY.md、USER.md、<br>TOOLS.md、<br>BOOTSTRAP.md、<br>HEARTBEAT.md、<br>MEMORY.md 及 skills/ 目录|
|TraeCode|trae|项目级 AGENTS.md|



### 使用限制 

- 当前环境需安装 Python 3.9 及以上版本和 pip，使用 conda、venv、uv 等环境均可。 

   - 开发机需可访问公网，以连接 Evolve 后端服务。 

- 

- 使用 Evolve 需要有效的方舟 API Key。Evolve 通过 API Key 识别当前账号，无需额外配置账号 ID 或用户名。 

版权所有 © 北京火山引擎科技有限公司 

1/6

<!--/PAGE:04-->

<!--PAGE:05-->

Agent 进化 

1. Agent 进化 

- 当前不提供独立的回滚命令。已应用变更的撤销方式参见常见问题。 

### 使用 **Evolve Skill** 

#### 步骤一：订阅套餐并开通 **Agent** 进化 

1. 在开通管理-Agent Plan 页面购买 Agent Plan 个人版套餐。套餐说明参见套餐概览。 

2. 在控制台单击Harness，开启 Agent 进化的抵扣开关。 

Agent 进化 New 首次上线 Skill/CLI 

AIAgent的进化基础设施，它可以学习Agent的近期会话，识别当前运行时中可优化的指令文件，并生成改进建议，持续提升Agent在运行过程中的效果和能力抵扣说明:根据实际分析过程中消耗的算力抵扣AFP，2500AFP/百万token，详见AFP抵扣说明开启抵扣 

3. 获取 Agent Plan 的专属 API Key，用于在工具中完成 Skill 或 MCP 的配置。我的订阅退订 

订阅管理使用配置用量详情 Harness 实践案例 CLI 快速配置日使用指南展开 

###### 专属 APIKey 

AgentPlan个人版专属APIKey是访问火山方舟大模型服务的重要凭证，长期有效。请妥善保管并定期更换密钥，避免公开共享，以防安全风险和资金损失 ********************************回 0 

#### 步骤二：安装 **Evolve Skill** 

可将以下命令交给 Agent 执行，由 Agent 自动完成 Evolve Skill 和 CLI 的配置。 

###### Bash 

curl -fsSL "https://ark-self-evolve.tos-cn-beijing.volces.com/evolve_skill/latest/install.sh" | bash 

也可以按不同运行时手动安装对应的 Skill 包。每个安装包均包含对应运行时的 SKILL.md、预构建的 Evolve CLI，以及 Agent 使用的共享指令文件。 

##### Claude Code 

1. 安装并配置 Claude Code，具体步骤见 Claude Code 。 

2. 在此链接下载Evolve Skill包：evolve-setup-claude_code.zip ，解压后放入 ~/.claude/skills/ 即可完成配置。 

3. 安装完成后，执 <mark>行</mark> claude <mark>命</mark> 令启动 Claude Code，即可继续配置方舟 API Key 并使用 Evolve。 

##### OpenClaw 

1. 安装并配置 OpenClaw，具体步骤见 OpenClaw 。 

版权所有 © 北京火山引擎科技有限公司 

2/6

<!--/PAGE:05-->

<!--PAGE:06-->

Agent 进化 

1. Agent 进化 

2. 在此链接下载Evolve Skill包：evolve-setup-openclaw.zip ，解压后放入 ~/.openclaw/workspace/ skills/ 即可完成配置。 

3. 安装完成后，执 <mark>行</mark> openclaw tui <mark>命</mark> 令启动 OpenClaw，即可继续配置方舟 API Key 并使用 Evolve。 

##### TraeCode 

1. 安装并配置 TraeCode，具体步骤见 TraeCode 。 

2. 在此链接下载Evolve Skill包：evolve-setup-trae.zip ，解压后放入 ~/.trae/skills/ 即可完成配置。 

3. 安装完成后，通过 TraeCode 打开对应的项目，即可继续配置方舟 API Key 并使用 Evolve。 

说明 

首次运行时，Agent 会自动安装所需 CLI，无需单独执行 pip install <mark>。</mark> 

#### 步骤三：配置 **Agent Plan** 专属 **API Key** 

在终端执行以下命令，也可以将命令交给 Agent 完成配置。其中 <ARK_API_KEY> 需替换为您的 Agent Plan 专属 API Key ，非方舟统一API Key。 

Bash 

export EVOLVE_API_KEY=<ARK_API_KEY> 

#### 步骤四：完成首次设置 

安装完成后，启动对应的 AI 工具，并对 Agent 说： 

Text 

Set me up for evolve 

Agent 会检查 Evolve 是否已完成设置。若尚未初始化，Agent 会识别当前运行时中的可优化文件，并在获得您的确认后完成初始化。 

初始化后，Evolve 会保存当前运行时与可优化目标的绑定关系，后续使用时通常无需重复设置。可执行以下命令查看当前设置，返回结果中 capability_synced 为 True 即表示初始化成功。 

Bash 

python3 -m evolve_cli status 

#### 步骤五：在工具中使用 **Evolve** 

完成初始化后，直接通过自然语言与 Agent 对话即可使用 Evolve。常见的对话指令如下： 

版权所有 © 北京火山引擎科技有限公司 

3/6

<!--/PAGE:06-->

<!--PAGE:07-->

Agent 进化 

1. Agent 进化 

|对话示例|Evolve会做什么|
|---|---|
|Is evolve set up?|检查 Evolve 是否已设置，以及是否存在待处理<br>建议|
|Learn from my recent sessions|导入近期会话并生成优化建议|
|What suggestions are there?|查看当前可用建议|
|Explain that proposal|解释建议的目标文件、修改原因、证据、风险<br>和 diff|
|Show me the diff|预览某项建议将带来的文件变更|
|Apply this proposal|先展示 diff；在你明确确认后应用变更|
|Which surfaces are evolvable?|查看当前哪些运行时文件可以被 Evolve 优化|



###### 注意 

Evolve 在执行初始化、导入会话和应用建议前，都会请求确认。应用建议时，Evolve 会先展示 diff，仅在您明确确认后才将内容写入运行时文件。 

### **CLI** 接入方式 

除通过 Skill 使用外，也可以直接调用 Evolve CLI，适用于脚本化调用、CI 流程或需要检查底层执行结果的场景。CLI 已包含在 Skill 安装包中。 

Bash 

_# 查看完整帮助_ python3 -m evolve_cli --help 

常用命令如下： 

_# 查看当前设置和待处理建议_ python3 -m evolve_cli status _# 导入近期会话_ python3 -m evolve_cli import --limit 5 _# 查看建议_ python3 -m evolve_cli proposals _# 查看某项建议_ python3 -m evolve_cli proposal <proposal_id> 

版权所有 © 北京火山引擎科技有限公司 

4/6

<!--/PAGE:07-->

<!--PAGE:08-->

Agent 进化 

1. Agent 进化 

_# 预览变更_ Bash 

python3 -m evolve_cli apply <proposal_id> --dry-run 

_# 应用变更_ 

python3 -m evolve_cli apply <proposal_id> 

###### 说明 

初始化命令 init 通常由 Agent 在首次设置流程中代为执行，无需手动运行。应用建议前，建议先使用 --dry-run 查看 diff，确认无误后再执行实际应用。 

### 常见问题 

- 初始化后暂时没有建议，是否正常？ 

正常。刚部署的环境、会话样本较少，或云端尚未积累足够经验时，导入会话后可能暂时没有可用建议。完成更多实际任务后，可再次让 Agent 学习近期会话。 

- Evolve 会自动修改我的文件吗？ 

默认不会。Evolve 会先展示 diff，仅在您明确确认后才将建议写入运行时文件。若您为某个能力面开启了自动应用（Auto Apply），该能力面的后续建议会在生成后自动应用，无需逐条确认。 

- 如何撤销已应用的建议？ 

以追加方式应用的内容会写入带有标记的代码块中，例如： 

Text 

<!-- evolvor:chg_<id> --> ... <!-- /evolvor:chg_<id> --> 

删除对应标记块即可撤销该次变更。以替换方式应用的变更不包括标记块，如需恢复，可参考应用前的 diff 预览手动还原。 

- 提示找不到可优化文件怎么办？ 

请确认初始化时选择的目录正确，并且目录中存在对应运行时的指令文件。例如： 

- 

   - Claude Code：CLAUDE.md 

   - OpenClaw：AGENTS.md、SOUL.md 或相关 Skills 

   - TraeCode：AGENTS.md 完整的可优化文件列表参见能力介绍中的运行时表格。 

- 初始化或导入会话失败怎么办？请依次检查： 

   - 方舟 API Key 是否有效； 

   - 当前网络是否可以访问 Evolve 后端； 

   - 当前运行时目录是否正确； 

   - 本机是否安装 Python 3.9 或更高版本，以及 pip。 

版权所有 © 北京火山引擎科技有限公司 

5/6

<!--/PAGE:08-->

<!--PAGE:09-->

Agent 进化 

1. Agent 进化 

###### 如何卸载 Evolve Skill？ 

- 

对 Agent 说 please delete self evolve skill <mark>，</mark> 由 Agent 完成 Skill 的删除。 

   - 如何计费？ 

- 如何计费？进化服务会调用云端的Agent分析日志，并生成进化方案，调用仅根据tokens消耗计费，tokens直接转换为AFP扣费，无其他额外服务计费。 

版权所有 © 北京火山引擎科技有限公司 

6/6

<!--/PAGE:09-->


<!-- 源文件: textlayer-multi-img.pdf | 链路: pymupdf4llm(段落合并直提) | dsh-md-convert | 2026-10-08T17:55:25.437Z -->
