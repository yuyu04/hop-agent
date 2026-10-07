import type { CommandDef } from '@/upstream/commands';

/**
 * AI 편집 패널 열기/닫기 이벤트. 패널(AgentSidebar)은 데스크톱(Tauri) 런타임에서만 만들어지므로
 * 명령은 이벤트만 내보내고, 구독자가 없으면(웹) 아무 일도 하지 않는다.
 */
export const AI_PANEL_TOGGLE_EVENT = 'hop-ai-toggle-panel';

export const aiCommands: CommandDef[] = [
  {
    id: 'view:ai-panel',
    label: 'AI 편집 패널',
    shortcutLabel: 'Ctrl+J',
    execute(services) {
      services.eventBus.emit(AI_PANEL_TOGGLE_EVENT);
    },
  },
];
