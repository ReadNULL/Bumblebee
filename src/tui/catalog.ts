export interface TuiCommandCatalogItem {
  name: string
  description: string
}

export interface TuiToolCatalogItem {
  name: string
  description: string
}

export const BUMBLEBEE_COMMANDS: TuiCommandCatalogItem[] = [
  { name: 'roles', description: '列出所有可用角色' },
  { name: 'switch', description: '切换角色' },
  { name: 'role', description: '显示当前角色详情' },
  { name: 'personality', description: '显示人格状态' },
  { name: 'memory', description: '记忆管理' },
  { name: 'knowledge', description: '知识图谱管理' },
  { name: 'context', description: '显示当前项目上下文' },
  { name: 'learn', description: '学习系统管理' },
  { name: 'channels', description: '渠道管理' },
  { name: 'agents', description: 'Agent 管理' },
  { name: 'workflows', description: '工作流管理' },
  { name: 'dashboard', description: '显示仪表盘状态' },
  { name: 'collab', description: '协作管理' },
  { name: 'voice', description: '语音管理' },
  { name: 'help', description: '显示 Bumblebee 命令和常用 pi 会话命令' },
  { name: 'status', description: '显示系统健康状态概览' },
  { name: 'perf', description: '显示 Agent 任务性能指标' },
]

export const BUMBLEBEE_TOOLS: TuiToolCatalogItem[] = [
  { name: 'switch_role', description: '切换 Bumblebee 到指定角色' },
  { name: 'list_roles', description: '列出所有可用 Bumblebee 角色' },
  { name: 'get_role_info', description: '获取当前或指定角色详情' },
  { name: 'list_agents', description: '列出所有已注册 Agent' },
  { name: 'execute_agent_task', description: '在指定 Agent 上执行任务' },
  { name: 'orchestrate_agents', description: '使用多 Agent 编排执行任务' },
  { name: 'list_workflows', description: '列出所有已注册工作流' },
  { name: 'trigger_workflow', description: '触发执行一个工作流' },
  { name: 'get_collaboration_status', description: '获取实时协作状态' },
  { name: 'send_collaboration_message', description: '向协作房间发送消息' },
  { name: 'voice_status', description: '获取语音引擎状态' },
]
