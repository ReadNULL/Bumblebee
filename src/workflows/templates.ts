/**
 * 工作流模板
 *
 * 预定义的常用工作流模板
 */

import { Workflow } from './types.js'

// PR 审查工作流
export const PR_REVIEW_WORKFLOW: Workflow = {
  id: 'pr-review',
  name: 'PR 自动审查',
  description: '自动审查 Pull Request，生成审查报告',
  version: '1.0.0',
  trigger: {
    type: 'webhook',
    config: {
      path: '/api/webhook/pr',
      method: 'POST'
    }
  },
  agents: [
    {
      id: 'code-reviewer',
      name: 'Code Reviewer',
      capabilities: ['review', 'analyze'],
      role: { roleId: 'code-reviewer' }
    },
    {
      id: 'security-auditor',
      name: 'Security Auditor',
      capabilities: ['audit', 'scan'],
      role: { roleId: 'security-auditor' }
    },
    {
      id: 'test-writer',
      name: 'Test Writer',
      capabilities: ['test', 'coverage'],
      role: { roleId: 'test-writer' }
    }
  ],
  steps: [
    {
      id: 'fetch-pr',
      name: '获取 PR 信息',
      action: 'fetch',
      input: {
        fromContext: {
          prId: 'payload.prId',
          repo: 'payload.repo'
        }
      },
      output: 'prInfo'
    },
    {
      id: 'code-review',
      name: '代码审查',
      agentId: 'code-reviewer',
      action: 'review',
      input: {
        fromSteps: {
          code: 'fetch-pr.files'
        }
      },
      output: 'reviewResult',
      dependsOn: ['fetch-pr']
    },
    {
      id: 'security-scan',
      name: '安全扫描',
      agentId: 'security-auditor',
      action: 'audit',
      input: {
        fromSteps: {
          code: 'fetch-pr.files'
        }
      },
      output: 'securityResult',
      dependsOn: ['fetch-pr']
    },
    {
      id: 'generate-report',
      name: '生成报告',
      action: 'generate',
      input: {
        fromSteps: {
          review: 'code-review',
          security: 'security-scan'
        },
        template: {
          title: 'PR #{{context.payload.prId}} 审查报告'
        }
      },
      output: 'report',
      dependsOn: ['code-review', 'security-scan']
    }
  ],
  config: {
    timeout: 300000,
    errorHandling: 'skip'
  },
  metadata: {
    author: 'Bumblebee',
    tags: ['pr', 'review', 'automation']
  }
}

// Issue 分析工作流
export const ISSUE_TRIAGE_WORKFLOW: Workflow = {
  id: 'issue-triage',
  name: 'Issue 自动分类',
  description: '自动分析和分类 Issue',
  version: '1.0.0',
  trigger: {
    type: 'webhook',
    config: {
      path: '/api/webhook/issue',
      method: 'POST'
    }
  },
  agents: [
    {
      id: 'architect',
      name: 'Architect',
      capabilities: ['analyze', 'classify'],
      role: { roleId: 'architect' }
    }
  ],
  steps: [
    {
      id: 'analyze-issue',
      name: '分析 Issue',
      agentId: 'architect',
      action: 'analyze',
      input: {
        fromContext: {
          title: 'payload.title',
          body: 'payload.body',
          labels: 'payload.labels'
        }
      },
      output: 'analysis'
    },
    {
      id: 'classify',
      name: '分类',
      action: 'classify',
      input: {
        fromSteps: {
          analysis: 'analyze-issue'
        }
      },
      output: 'classification',
      dependsOn: ['analyze-issue']
    },
    {
      id: 'assign',
      name: '分配',
      action: 'assign',
      input: {
        fromSteps: {
          classification: 'classify'
        }
      },
      output: 'assignment',
      dependsOn: ['classify']
    }
  ],
  config: {
    timeout: 60000
  },
  metadata: {
    author: 'Bumblebee',
    tags: ['issue', 'triage', 'automation']
  }
}

// 发布工作流
export const RELEASE_WORKFLOW: Workflow = {
  id: 'release',
  name: '自动发布',
  description: '自动执行发布流程',
  version: '1.0.0',
  trigger: {
    type: 'manual'
  },
  agents: [
    {
      id: 'code-reviewer',
      name: 'Code Reviewer',
      capabilities: ['review'],
      role: { roleId: 'code-reviewer' }
    },
    {
      id: 'test-writer',
      name: 'Test Writer',
      capabilities: ['test'],
      role: { roleId: 'test-writer' }
    },
    {
      id: 'doc-generator',
      name: 'Doc Generator',
      capabilities: ['document'],
      role: { roleId: 'doc-generator' }
    }
  ],
  steps: [
    {
      id: 'validate',
      name: '验证代码',
      agentId: 'code-reviewer',
      action: 'validate',
      input: {
        fromContext: {
          version: 'version',
          branch: 'branch'
        }
      },
      output: 'validation'
    },
    {
      id: 'run-tests',
      name: '运行测试',
      agentId: 'test-writer',
      action: 'test',
      input: {
        static: {
          coverage: true
        }
      },
      output: 'testResults',
      dependsOn: ['validate'],
      retry: {
        maxAttempts: 2,
        delay: 5000
      }
    },
    {
      id: 'generate-changelog',
      name: '生成更新日志',
      agentId: 'doc-generator',
      action: 'document',
      input: {
        fromContext: {
          version: 'version'
        },
        fromSteps: {
          changes: 'validate'
        }
      },
      output: 'changelog',
      dependsOn: ['run-tests']
    },
    {
      id: 'build',
      name: '构建',
      action: 'build',
      input: {
        fromContext: {
          version: 'version'
        }
      },
      output: 'buildResult',
      dependsOn: ['run-tests'],
      timeout: 600000
    },
    {
      id: 'publish',
      name: '发布',
      action: 'publish',
      input: {
        fromSteps: {
          build: 'build',
          changelog: 'generate-changelog'
        }
      },
      output: 'publishResult',
      dependsOn: ['build', 'generate-changelog'],
      condition: {
        context: {
          key: 'dryRun',
          operator: 'neq',
          value: true
        }
      }
    }
  ],
  config: {
    timeout: 900000,
    errorHandling: 'stop'
  },
  metadata: {
    author: 'Bumblebee',
    tags: ['release', 'ci-cd']
  }
}

// 代码质量检查工作流
export const CODE_QUALITY_WORKFLOW: Workflow = {
  id: 'code-quality',
  name: '代码质量检查',
  description: '全面的代码质量检查',
  version: '1.0.0',
  trigger: {
    type: 'manual'
  },
  agents: [
    {
      id: 'code-reviewer',
      name: 'Code Reviewer',
      capabilities: ['review'],
      role: { roleId: 'code-reviewer' }
    },
    {
      id: 'security-auditor',
      name: 'Security Auditor',
      capabilities: ['audit'],
      role: { roleId: 'security-auditor' }
    },
    {
      id: 'optimizer',
      name: 'Optimizer',
      capabilities: ['optimize'],
      role: { roleId: 'optimizer' }
    }
  ],
  steps: [
    {
      id: 'style-check',
      name: '代码风格检查',
      agentId: 'code-reviewer',
      action: 'check-style',
      input: {
        fromContext: {
          files: 'files'
        }
      },
      output: 'styleResult'
    },
    {
      id: 'security-check',
      name: '安全检查',
      agentId: 'security-auditor',
      action: 'audit',
      input: {
        fromContext: {
          files: 'files'
        }
      },
      output: 'securityResult'
    },
    {
      id: 'performance-check',
      name: '性能检查',
      agentId: 'optimizer',
      action: 'analyze',
      input: {
        fromContext: {
          files: 'files'
        }
      },
      output: 'performanceResult'
    },
    {
      id: 'generate-report',
      name: '生成报告',
      action: 'report',
      input: {
        fromSteps: {
          style: 'style-check',
          security: 'security-check',
          performance: 'performance-check'
        }
      },
      output: 'report',
      dependsOn: ['style-check', 'security-check', 'performance-check']
    }
  ],
  config: {
    timeout: 300000
  },
  metadata: {
    author: 'Bumblebee',
    tags: ['quality', 'analysis']
  }
}

// 所有模板
export const WORKFLOW_TEMPLATES: Record<string, Workflow> = {
  'pr-review': PR_REVIEW_WORKFLOW,
  'issue-triage': ISSUE_TRIAGE_WORKFLOW,
  'release': RELEASE_WORKFLOW,
  'code-quality': CODE_QUALITY_WORKFLOW
}

// 获取工作流模板
export function getWorkflowTemplate(templateId: string): Workflow | undefined {
  return WORKFLOW_TEMPLATES[templateId]
}

// 获取所有模板 ID
export function getWorkflowTemplateIds(): string[] {
  return Object.keys(WORKFLOW_TEMPLATES)
}

// 基于模板创建工作流
export function createWorkflowFromTemplate(
  templateId: string,
  overrides?: Partial<Workflow>
): Workflow {
  const template = WORKFLOW_TEMPLATES[templateId]
  if (!template) {
    throw new Error(`工作流模板不存在: ${templateId}`)
  }

  return {
    ...template,
    ...overrides,
    id: overrides?.id || template.id,
    metadata: {
      ...template.metadata,
      ...overrides?.metadata
    }
  }
}
