import { editCommands as upstreamEditCommands } from '@/upstream/commands';
import type { CommandDef, CommandServices } from '@/upstream/commands';
import type { DocumentPosition } from '@/upstream/core';
import {
  prepareRhwpInternalClipboardHtml,
  writeTextHtmlToClipboard,
} from '@/upstream/clipboard';
import { replaceUpstreamCommands } from '../replace-upstream-commands';

type ClipboardInputHandler = {
  getSelection?: () => { start: DocumentPosition; end: DocumentPosition } | null;
  performCopy?: () => void;
  performCut?: () => void;
  performDelete?: () => void;
  performPaste?: () => boolean | void | Promise<boolean | void>;
};

type ClipboardAction = 'copy' | 'cut';

function overrideExecute(
  id: string,
  execute: CommandDef['execute'],
): CommandDef {
  const upstreamCommand = upstreamEditCommands.find((command) => command.id === id);
  if (!upstreamCommand) throw new Error(`Missing upstream edit command: ${id}`);
  return { ...upstreamCommand, execute };
}

function copyCellSelectionToWasm(
  services: CommandServices,
  start: DocumentPosition,
  end: DocumentPosition,
): string {
  services.wasm.copySelectionInCell(
    start.sectionIndex,
    start.parentParaIndex!,
    start.controlIndex!,
    start.cellIndex!,
    start.cellParaIndex!,
    start.charOffset,
    end.cellParaIndex!,
    end.charOffset,
  );
  try {
    return services.wasm.exportSelectionInCellHtml(
      start.sectionIndex,
      start.parentParaIndex!,
      start.controlIndex!,
      start.cellIndex!,
      start.cellParaIndex!,
      start.charOffset,
      end.cellParaIndex!,
      end.charOffset,
    );
  } catch {
    return '';
  }
}

function copyBodySelectionToWasm(
  services: CommandServices,
  start: DocumentPosition,
  end: DocumentPosition,
): string {
  services.wasm.copySelection(
    start.sectionIndex,
    start.paragraphIndex,
    start.charOffset,
    end.paragraphIndex,
    end.charOffset,
  );
  try {
    return services.wasm.exportSelectionHtml(
      start.sectionIndex,
      start.paragraphIndex,
      start.charOffset,
      end.paragraphIndex,
      end.charOffset,
    );
  } catch {
    return '';
  }
}

function copySelectionToWasm(
  services: CommandServices,
  start: DocumentPosition,
  end: DocumentPosition,
): string {
  return start.parentParaIndex !== undefined
    ? copyCellSelectionToWasm(services, start, end)
    : copyBodySelectionToWasm(services, start, end);
}

function serializeSelection(selection: { start: DocumentPosition; end: DocumentPosition }): string {
  const keyForPosition = (position: DocumentPosition) => ({
    sectionIndex: position.sectionIndex,
    paragraphIndex: position.paragraphIndex,
    charOffset: position.charOffset,
    parentParaIndex: position.parentParaIndex,
    controlIndex: position.controlIndex,
    cellIndex: position.cellIndex,
    cellParaIndex: position.cellParaIndex,
    cellPath: position.cellPath,
    isTextBox: position.isTextBox,
  });
  return JSON.stringify({
    start: keyForPosition(selection.start),
    end: keyForPosition(selection.end),
  });
}

async function writeSelectedText(
  services: CommandServices,
  inputHandler: ClipboardInputHandler,
): Promise<string | null> {
  const selection = inputHandler.getSelection?.();
  if (!selection) return null;

  const html = copySelectionToWasm(services, selection.start, selection.end);
  const text = services.wasm.getClipboardText();
  const markedHtml = prepareRhwpInternalClipboardHtml(inputHandler, html, text);
  await writeTextHtmlToClipboard(text, markedHtml);
  return serializeSelection(selection);
}

function executeClipboardAction(
  services: CommandServices,
  action: ClipboardAction,
): void {
  const inputHandler = services.getInputHandler() as ClipboardInputHandler | null;
  if (!inputHandler) return;

  const context = services.getContext();
  if (context.inPictureObjectSelection || context.inTableObjectSelection) {
    if (action === 'cut') inputHandler.performCut?.();
    else inputHandler.performCopy?.();
    return;
  }

  void writeSelectedText(services, inputHandler)
    .then((copiedSelection) => {
      const currentSelection = inputHandler.getSelection?.();
      if (
        action === 'cut' &&
        copiedSelection !== null &&
        currentSelection &&
        copiedSelection === serializeSelection(currentSelection)
      ) {
        inputHandler.performDelete?.();
      }
    })
    .catch((error) => {
      console.warn(`[edit:${action}] ${action === 'cut' ? '오려 두기' : '복사하기'} 실패:`, error);
    });
}

const hopEditCommands: CommandDef[] = [
  overrideExecute('edit:cut', (services) => executeClipboardAction(services, 'cut')),
  overrideExecute('edit:copy', (services) => executeClipboardAction(services, 'copy')),
  overrideExecute('edit:paste', (services) => {
    const pending = (services.getInputHandler() as ClipboardInputHandler | null)?.performPaste?.();
    if (pending) {
      void Promise.resolve(pending).catch((error) => {
        console.warn('[edit:paste] 붙이기 실패:', error);
      });
    }
  }),
];

export const editCommands = replaceUpstreamCommands(upstreamEditCommands, hopEditCommands);
