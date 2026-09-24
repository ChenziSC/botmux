import { parseProjectCoordinatorAction } from '../src/services/project-coordinator.js';
import { describe, expect, it } from 'vitest';
import { buildProjectGroupCard } from '../src/im/lark/project-group-card.js';
import type { ProjectGroupState } from '../src/services/project-group-store.js';

function makeProject(overrides: Partial<ProjectGroupState> = {}): ProjectGroupState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    revision: 1,
    chatId: 'oc_test',
    larkAppId: 'cli_test',
    coordinatorSessionId: 'sess-1',
    title: '测试项目',
    goal: '目标',
    phase: '进行中',
    focus: '当前焦点',
    status: 'in_progress',
    blockers: [],
    workstreams: [{
      dispatchRoot: 'om_root',
      title: '子任务一',
      purpose: '需要换行的较长子任务说明'.repeat(10),
      owners: [],
      status: 'in_progress',
      progress: 0,
      createdAt: now,
      updatedAt: now,
    }],
    milestones: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('buildProjectGroupCard workstream table', () => {
  it('auto-sizes rows with the shared cap while keeping its own blue header style', () => {
    const card = buildProjectGroupCard(makeProject()) as any;
    const table = card.body.elements.find((e: any) => e.tag === 'table');
    expect(table).toBeTruthy();

    // 行高封顶复用共享片段（回归：该表原本只有 row_height:'auto'，
    // 仍吃组件默认 124px 上限，长 purpose 会被裁）。
    expect(table.row_height).toBe('auto');
    expect(table.row_max_height).toBe('300px');

    // 蓝底表头是该卡自有样式，不能被共享灰底表头片段（含 lines:2）覆盖。
    expect(table.header_style).toMatchObject({
      text_align: 'left',
      background_style: 'blue-50',
      text_color: 'blue',
      bold: true,
    });
    expect(table.header_style).not.toHaveProperty('lines');
  });

  it('omits the table when there are no workstreams', () => {
    const card = buildProjectGroupCard(makeProject({ workstreams: [] })) as any;
    expect(card.body.elements.some((e: any) => e.tag === 'table')).toBe(false);
  });
});

  it.each(['status-dashboard', 'compact-list'] as const)('keeps user action and document visible in %s', templateId => {
    const card = buildProjectGroupCard(makeProject({ status: 'active', phase: 'awaiting_confirmation',
      userAction: { requestId: 'revision-5', summary: '方案已完成', question: '请确认 revision 5',
        documentUrl: 'https://example.com/doc', state: 'delivery_failed' },
    }), 'feishu', { templateId, sections: [] } as any) as any;
    expect(card.header.text_tag_list[0].text.content).toBe('需要你');
    expect(card.header.template).toBe('orange');
    expect(card.body.elements[0].content).toContain('[技术方案](https://example.com/doc)');
    expect(card.body.elements[0].content).toContain('受阻');
    expect(card.config.summary.content).toContain('需要你');
  });
  it('recognizes legacy confirmation waits but never treats internal blockers as user input', () => {
    const card = (p: Partial<ProjectGroupState>) => buildProjectGroupCard(makeProject(p)) as any;
    expect(card({ phase: 'awaiting_confirmation' }).header.text_tag_list[0].text.content).toBe('需要你');
    expect(card({ blockers: ['部署仍在运行'] }).header.text_tag_list[0].text.content).toBe('进行中');
    expect(card({ status: 'completed', phase: 'awaiting_confirmation' }).header.text_tag_list[0].text.content).toBe('已完成');
  });

it('validates action documents and explicit clears at the API boundary', () => {
  const action = { requestId: 'req', summary: 'Ready', question: 'Review?', state: 'pending' };
  for (const documentUrl of ['javascript:alert(1)', 'http://example.com', 'https://user:password@example.com', 'not-a-url']) {
    expect(parseProjectCoordinatorAction({ action: 'update', userAction: { ...action, documentUrl } })).toBeUndefined();
  }
  expect(parseProjectCoordinatorAction({ action: 'update', userAction: null, expectedUserActionId: 'req' }))
    .toMatchObject({ userAction: null, expectedUserActionId: 'req' });
});
