import type { AskConversation } from '../core/ask-conversation-types.js';
import type { ProjectGroupState } from './project-group-store.js';
import type { ProjectCoordinatorAction } from './project-coordinator.js';

/** Project presentation is a projection of the same delivered Ask/inbox. */
export function conversationProjectAction(ask: AskConversation, project: ProjectGroupState): ProjectCoordinatorAction | undefined {
  if (project.chatId !== ask.identity.chatId || project.status !== 'active'
    || project.userAction && project.userAction.requestId !== ask.identity.requestId) return;
  if (['applied', 'cancelled', 'superseded'].includes(ask.lifecycle)) {
    return project.userAction ? { action: 'update', userAction: null, expectedUserActionId: ask.identity.requestId } : undefined;
  }
  const waiting = ask.nextActor === 'human' && ask.lifecycle === 'open' && !!ask.anchors.cardMessageId
    && ask.inbox.length === ask.consumedThrough;
  const question = ask.question.snapshot.map(q => q.prompt).join('\n').slice(0, 2000);
  const documentUrl = question.match(/https:\/\/[^\s<>]+/)?.[0];
  const userAction = { requestId: ask.identity.requestId, summary: ask.title, question,
    state: waiting ? 'pending' as const : ask.lastError ? 'delivery_failed' as const
      : ask.inbox.length ? 'processing' as const : 'preparing' as const,
    ...(documentUrl ? { documentUrl } : {}) };
  if (JSON.stringify(project.userAction) === JSON.stringify(userAction)) return;
  return { action: 'update', userAction, ...(project.userAction ? { expectedUserActionId: ask.identity.requestId } : {}) };
}
