import { acceptCompletion, autocompletion, closeBrackets } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, foldGutter, indentOnInput, indentUnit } from '@codemirror/language';
import { searchKeymap } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  scrollPastEnd,
  showTooltip,
  tooltips,
  type Tooltip,
} from '@codemirror/view';
import { memo, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { Theme } from '~/types/theme';
import { classNames } from '~/utils/classNames';
import { debounce } from '~/utils/debounce';
import { createScopedLogger, renderLogger } from '~/utils/logger';
import { isFileLocked, getCurrentChatId } from '~/utils/fileLocks';
import { BinaryContent } from './BinaryContent';
import { getTheme, reconfigureTheme } from './cm-theme';
import { indentKeyBinding } from './indent';
import { getLanguage } from './languages';
import { createEnvMaskingExtension } from './EnvMasking';

const logger = createScopedLogger('CodeMirrorEditor');

// Create a module-level reference to the current document for use in tooltip functions
let currentDocRef: EditorDocument | undefined;

export interface EditorDocument {
  value: string;
  isBinary: boolean;
  filePath: string;
  scroll?: ScrollPosition;
}

export interface EditorSettings {
  fontSize?: string;
  gutterFontSize?: string;
  tabSize?: number;
}

type TextEditorDocument = EditorDocument & {
  value: string;
};

export interface ScrollPosition {
  top?: number;
  left?: number;
  line?: number;
  column?: number;
}

export interface EditorUpdate {
  selection: EditorSelection;
  content: string;
}

export type OnChangeCallback = (update: EditorUpdate) => void;
export type OnScrollCallback = (position: ScrollPosition) => void;
export type OnSaveCallback = () => void;

interface Props {
  theme: Theme;
  id?: unknown;
  doc?: EditorDocument;
  editable?: boolean;
  debounceChange?: number;
  debounceScroll?: number;
  autoFocusOnDocumentChange?: boolean;
  onChange?: OnChangeCallback;
  onScroll?: OnScrollCallback;
  onSave?: OnSaveCallback;
  className?: string;
  settings?: EditorSettings;
}

type EditorStates = Map<string, EditorState>;

const readOnlyTooltipStateEffect = StateEffect.define<boolean>();

const editableTooltipField = StateField.define<readonly Tooltip[]>({
  create: () => [],
  update(_tooltips, transaction) {
    if (!transaction.state.readOnly) {
      return [];
    }

    for (const effect of transaction.effects) {
      if (effect.is(readOnlyTooltipStateEffect) && effect.value) {
        return getReadOnlyTooltip(transaction.state);
      }
    }

    return [];
  },
  provide: (field) => {
    return showTooltip.computeN([field], (state) => state.field(field));
  },
});

const editableStateEffect = StateEffect.define<boolean>();

const editableStateField = StateField.define<boolean>({
  create() {
    return true;
  },
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(editableStateEffect)) {
        return effect.value;
      }
    }

    return value;
  },
});

export const CodeMirrorEditor = memo(
  ({
    id,
    doc,
    debounceScroll = 100,
    debounceChange = 150,
    autoFocusOnDocumentChange = false,
    editable = true,
    onScroll,
    onChange,
    onSave,
    theme,
    settings,
    className = '',
  }: Props) => {
    renderLogger.trace('CodeMirrorEditor');

    const [languageCompartment] = useState(new Compartment());

    // Add a compartment for the env masking extension
    const [envMaskingCompartment] = useState(new Compartment());

    const containerRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView>();
    const themeRef = useRef<Theme>();
    const docRef = useRef<EditorDocument>();
    const editorStatesRef = useRef<EditorStates>();
    const onScrollRef = useRef(onScroll);
    const onChangeRef = useRef(onChange);
    const onSaveRef = useRef(onSave);

    /**
     * This effect is used to avoid side effects directly in the render function
     * and instead the refs are updated after each render.
     */
    useEffect(() => {
      onScrollRef.current = onScroll;
      onChangeRef.current = onChange;
      onSaveRef.current = onSave;
      docRef.current = doc;

      // Update the module-level reference for use in tooltip functions
      currentDocRef = doc;
      themeRef.current = theme;
    });

    useEffect(() => {
      if (!viewRef.current || !doc || doc.isBinary) {
        return;
      }

      if (typeof doc.scroll?.line === 'number') {
        const line = doc.scroll.line;
        const column = doc.scroll.column ?? 0;

        try {
          // Check if the line number is valid for the current document
          const totalLines = viewRef.current.state.doc.lines;

          // Only proceed if the line number is within the document's range
          if (line < totalLines) {
            const linePos = viewRef.current.state.doc.line(line + 1).from + column;
            viewRef.current.dispatch({
              selection: { anchor: linePos },
              scrollIntoView: true,
            });
            viewRef.current.focus();
          } else {
            logger.warn(`Invalid line number ${line + 1} in ${totalLines}-line document`);
          }
        } catch (error) {
          logger.error('Error scrolling to line:', error);
        }
      } else if (typeof doc.scroll?.top === 'number' || typeof doc.scroll?.left === 'number') {
        viewRef.current.scrollDOM.scrollTo(doc.scroll.left ?? 0, doc.scroll.top ?? 0);
      }
    }, [doc?.scroll?.line, doc?.scroll?.column, doc?.scroll?.top, doc?.scroll?.left]);

    useEffect(() => {
      const onUpdate = debounce((update: EditorUpdate) => {
        onChangeRef.current?.(update);
      }, debounceChange);

      const view = new EditorView({
        parent: containerRef.current!,
        dispatchTransactions(transactions) {
          const previousSelection = view.state.selection;

          view.update(transactions);

          const newSelection = view.state.selection;

          const selectionChanged =
            newSelection !== previousSelection &&
            (newSelection === undefined || previousSelection === undefined || !newSelection.eq(previousSelection));

          if (docRef.current && (transactions.some((transaction) => transaction.docChanged) || selectionChanged)) {
            onUpdate({
              selection: view.state.selection,
              content: view.state.doc.toString(),
            });

            editorStatesRef.current!.set(docRef.current.filePath, view.state);
          }
        },
      });

      viewRef.current = view;

      return () => {
        viewRef.current?.destroy();
        viewRef.current = undefined;
      };
    }, []);

    useEffect(() => {
      if (!viewRef.current) {
        return;
      }

      viewRef.current.dispatch({
        effects: [reconfigureTheme(theme)],
      });
    }, [theme]);

    useEffect(() => {
      editorStatesRef.current = new Map<string, EditorState>();
    }, [id]);

    useEffect(() => {
      const editorStates = editorStatesRef.current!;
      const view = viewRef.current!;
      const theme = themeRef.current!;

      if (!doc) {
        const state = newEditorState('', theme, settings, onScrollRef, debounceScroll, onSaveRef, [
          languageCompartment.of([]),
          envMaskingCompartment.of([]),
        ]);

        view.setState(state);

        setNoDocument(view);

        return;
      }

      if (doc.isBinary) {
        return;
      }

      if (doc.filePath === '') {
        logger.warn('File path should not be empty');
      }

      let state = editorStates.get(doc.filePath);

      if (!state) {
        state = newEditorState(doc.value, theme, settings, onScrollRef, debounceScroll, onSaveRef, [
          languageCompartment.of([]),
          envMaskingCompartment.of([createEnvMaskingExtension(() => docRef.current?.filePath)]),
        ]);

        editorStates.set(doc.filePath, state);
      }

      view.setState(state);

      setEditorDocument(
        view,
        theme,
        editable,
        languageCompartment,
        autoFocusOnDocumentChange,
        doc as TextEditorDocument,
      );

      // Check if the file is locked and update the editor state accordingly
      const currentChatId = getCurrentChatId();
      const { locked } = isFileLocked(doc.filePath, currentChatId);

      if (locked) {
        view.dispatch({
          effects: [editableStateEffect.of(false)],
        });
      }
    }, [doc?.value, editable, doc?.filePath, autoFocusOnDocumentChange]);

    return (
      <div className={classNames('relative h-full', className)}>
        {doc?.isBinary && <BinaryContent />}
        <div className="h-full overflow-hidden" ref={containerRef} />
      </div>
    );
  },
);

export default CodeMirrorEditor;

CodeMirrorEditor.displayName = 'CodeMirrorEditor';

function newEditorState(
  content: string,
  theme: Theme,
  settings: EditorSettings | undefined,
  onScrollRef: MutableRefObject<OnScrollCallback | undefined>,
  debounceScroll: number,
  onFileSaveRef: MutableRefObject<OnSaveCallback | undefined>,
  extensions: Extension[],
) {
  return EditorState.create({
    doc: content,
    extensions: [
      EditorView.domEventHandlers({
        scroll: debounce((event, view) => {
          if (event.target !== view.scrollDOM) {
            return;
          }

          onScrollRef.current?.({ left: view.scrollDOM.scrollLeft, top: view.scrollDOM.scrollTop });
        }, debounceScroll),
        keydown: (event, view) => {
          if (view.state.readOnly) {
            view.dispatch({
              effects: [readOnlyTooltipStateEffect.of(event.key !== 'Escape')],
            });

            return true;
          }

          return false;
        },
        // Enhanced touch support
        touchstart: (event, view) => {
          // Prevent default touch behavior that might interfere with text selection
          if (event.touches.length === 1) {
            return false;
          }
          return false;
        },
        touchend: (event, view) => {
          // Handle touch end events for better mobile experience
          return false;
        },
        // Better focus handling
        focus: (event, view) => {
          view.dom.classList.add('cm-focused');
          return false;
        },
        blur: (event, view) => {
          view.dom.classList.remove('cm-focused');
          return false;
        },
      }),
      getTheme(theme, settings),
      history(),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        { key: 'Tab', run: acceptCompletion },
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onFileSaveRef.current?.();
            return true;
          },
        },
        {
          key: 'Mod-f',
          run: () => {
            // Open search dialog
            return false;
          },
        },
        {
          key: 'Mod-g',
          run: () => {
            // Open go to line dialog
            return false;
          },
        },
        {
          key: 'Mod-Enter',
          run: (view) => {
            // Insert new line at cursor
            view.dispatch({
              changes: { from: view.state.selection.main.head, insert: '\n' },
            });
            return true;
          },
        },
        {
          key: 'Mod-Shift-k',
          run: (view) => {
            // Delete current line
            const line = view.state.doc.lineAt(view.state.selection.main.head);
            view.dispatch({
              changes: { from: line.from, to: line.to },
            });
            return true;
          },
        },
        {
          key: 'Mod-Shift-d',
          run: (view) => {
            // Duplicate current line
            const line = view.state.doc.lineAt(view.state.selection.main.head);
            const lineText = view.state.doc.sliceString(line.from, line.to);
            view.dispatch({
              changes: { from: line.to, insert: '\n' + lineText },
            });
            return true;
          },
        },
        indentKeyBinding,
      ]),
      indentUnit.of('\t'),
      autocompletion({
        closeOnBlur: false,
        activateOnTyping: true,
        maxRenderedOptions: 10,
        defaultKeymap: true,
        closeOnBlurDelay: 200,
        addToOptions: [
          {
            label: 'snippet',
            type: 'snippet',
            info: 'Code snippet',
          },
        ],
        override: [
          (context) => {
            // Enhanced autocompletion for better touch experience
            const word = context.matchBefore(/\w*/);
            if (word && word.from === word.to && !context.explicit) {
              return null;
            }
            return {
              from: word ? word.from : context.pos,
              options: [],
            };
          },
        ],
      }),
      tooltips({
        position: 'absolute',
        parent: document.body,
        tooltipSpace: (view) => {
          const rect = view.dom.getBoundingClientRect();
          const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
          const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

          return {
            top: rect.top + scrollTop - 50,
            left: rect.left + scrollLeft,
            bottom: rect.bottom + scrollTop,
            right: rect.right + scrollLeft + 10,
          };
        },
        // Enhanced tooltip positioning for better touch experience
        hideOnChange: true,
        hideOnBlur: true,
        hideOnScroll: true,
      }),
      closeBrackets(),
      lineNumbers(),
      scrollPastEnd(),
      dropCursor(),
      drawSelection(),
      bracketMatching(),
      EditorState.tabSize.of(settings?.tabSize ?? 2),
      indentOnInput(),
      EditorView.lineWrapping,
      EditorView.editable.of(editable),
      EditorView.theme({
        '&': {
          fontSize: settings?.fontSize || '13px',
          fontFamily: settings?.fontFamily || 'Fira Code, JetBrains Mono, Cascadia Code, SF Mono, Monaco, Inconsolata, Roboto Mono, Source Code Pro, monospace',
          lineHeight: '1.5',
          letterSpacing: '0.01em',
        },
        '&.cm-focused': {
          outline: 'none',
        },
        '.cm-content': {
          padding: '8px',
          minHeight: '100px',
          caretColor: 'var(--cm-cursor-backgroundColor)',
        },
        '.cm-scroller': {
          fontFamily: 'inherit',
          lineHeight: 'inherit',
        },
        '.cm-line': {
          padding: '0 4px',
        },
        '.cm-selectionBackground': {
          background: 'var(--cm-selection-backgroundColorFocused) !important',
          opacity: 'var(--cm-selection-backgroundOpacityFocused)',
        },
        '.cm-cursor': {
          borderLeft: 'var(--cm-cursor-width) solid var(--cm-cursor-backgroundColor)',
          marginLeft: '-1px',
          animation: 'cm-blink 1s infinite',
        },
        '@keyframes cm-blink': {
          '0%, 50%': { opacity: '1' },
          '51%, 100%': { opacity: '0' },
        },
        // Enhanced mobile touch support
        '.cm-editor': {
          touchAction: 'pan-y',
        },
        '.cm-content': {
          touchAction: 'pan-y',
        },
        // Better selection styling
        '.cm-selectionBackground': {
          background: 'var(--cm-selection-backgroundColorFocused) !important',
          opacity: 'var(--cm-selection-backgroundOpacityFocused)',
        },
        // Enhanced gutter styling
        '.cm-gutters': {
          background: 'var(--cm-gutter-backgroundColor)',
          borderRight: '1px solid var(--bolt-elements-borderColor)',
          minWidth: '3ch',
        },
        '.cm-lineNumbers .cm-gutterElement': {
          padding: '0 8px 0 4px',
          minWidth: '2ch',
          textAlign: 'right',
          color: 'var(--cm-gutter-textColor)',
          fontSize: '12px',
          lineHeight: '1.5',
        },
        '.cm-activeLineGutter': {
          background: 'var(--cm-activeLineBackgroundColor)',
          color: 'var(--cm-gutter-activeLineTextColor)',
          fontWeight: '600',
        },
        // Enhanced fold gutter
        '.cm-foldGutter': {
          width: '16px',
          cursor: 'pointer',
        },
        '.cm-foldGutter .cm-gutterElement': {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: 'var(--cm-foldGutter-textColor)',
          transition: 'color 0.2s ease',
        },
        '.cm-foldGutter .cm-gutterElement:hover': {
          color: 'var(--cm-foldGutter-textColorHover)',
        },
        // Enhanced active line highlighting
        '.cm-activeLine': {
          background: 'var(--cm-activeLineBackgroundColor)',
        },
        // Better bracket matching
        '.cm-matchingBracket': {
          background: 'var(--cm-matching-bracket)',
          borderRadius: '2px',
          fontWeight: '600',
        },
        '.cm-nonmatchingBracket': {
          background: 'rgba(255, 0, 0, 0.2)',
          borderRadius: '2px',
        },
        // Enhanced search styling
        '.cm-searchMatch': {
          background: 'var(--cm-searchMatch-backgroundColor)',
          borderRadius: '2px',
          padding: '0 2px',
        },
        '.cm-searchMatch.cm-searchMatch-selected': {
          background: 'var(--cm-selection-backgroundColorFocused)',
          opacity: 'var(--cm-selection-backgroundOpacityFocused)',
        },
        // Enhanced tooltip styling
        '.cm-tooltip': {
          background: 'var(--cm-tooltip-backgroundColor)',
          color: 'var(--cm-tooltip-textColor)',
          border: '1px solid var(--cm-tooltip-borderColor)',
          borderRadius: '6px',
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
          fontSize: '12px',
          maxWidth: '300px',
          zIndex: '1000',
        },
        '.cm-tooltip.cm-tooltip-autocomplete': {
          background: 'var(--cm-tooltip-backgroundColor)',
          border: '1px solid var(--cm-tooltip-borderColor)',
        },
        '.cm-tooltip-autocomplete .cm-completionIcon': {
          marginRight: '8px',
          width: '16px',
          height: '16px',
        },
        '.cm-tooltip-autocomplete .cm-completionLabel': {
          fontWeight: '500',
        },
        '.cm-tooltip-autocomplete .cm-completionDetail': {
          color: 'var(--bolt-elements-textSecondary)',
          fontSize: '11px',
          marginLeft: '8px',
        },
        // Read-only tooltip styling
        '.cm-readonly-tooltip': {
          background: 'var(--bolt-elements-item-backgroundDanger)',
          color: 'var(--bolt-elements-item-contentDanger)',
          padding: '8px 12px',
          borderRadius: '6px',
          fontSize: '12px',
          fontWeight: '500',
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
          border: '1px solid var(--bolt-elements-borderColor)',
        },
        // Enhanced scrollbar styling
        '.cm-scroller': {
          scrollbarWidth: 'thin',
          scrollbarColor: 'var(--bolt-elements-textTertiary) transparent',
        },
        '.cm-scroller::-webkit-scrollbar': {
          width: '8px',
          height: '8px',
        },
        '.cm-scroller::-webkit-scrollbar-track': {
          background: 'transparent',
        },
        '.cm-scroller::-webkit-scrollbar-thumb': {
          background: 'var(--bolt-elements-textTertiary)',
          borderRadius: '4px',
          border: '2px solid transparent',
          backgroundClip: 'content-box',
        },
        '.cm-scroller::-webkit-scrollbar-thumb:hover': {
          background: 'var(--bolt-elements-textSecondary)',
          backgroundClip: 'content-box',
        },
        '.cm-scroller::-webkit-scrollbar-corner': {
          background: 'transparent',
        },
      }),
      editableTooltipField,
      editableStateField,
      EditorState.readOnly.from(editableStateField, (editable) => !editable),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      foldGutter({
        markerDOM: (open) => {
          const icon = document.createElement('div');
          icon.className = `fold-icon ${open ? 'i-ph-caret-down-bold' : 'i-ph-caret-right-bold'}`;
          icon.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: center;
            width: 16px;
            height: 16px;
            cursor: pointer;
            transition: color 0.2s ease;
            color: var(--cm-foldGutter-textColor);
          `;
          icon.addEventListener('mouseenter', () => {
            icon.style.color = 'var(--cm-foldGutter-textColorHover)';
          });
          icon.addEventListener('mouseleave', () => {
            icon.style.color = 'var(--cm-foldGutter-textColor)';
          });
          return icon;
        },
      }),
      ...extensions,
    ],
  });
}

function setNoDocument(view: EditorView) {
  view.dispatch({
    selection: { anchor: 0 },
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: '',
    },
  });

  view.scrollDOM.scrollTo(0, 0);
}

function setEditorDocument(
  view: EditorView,
  theme: Theme,
  editable: boolean,
  languageCompartment: Compartment,
  autoFocus: boolean,
  doc: TextEditorDocument,
) {
  if (doc.value !== view.state.doc.toString()) {
    view.dispatch({
      selection: { anchor: 0 },
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: doc.value,
      },
    });
  }

  // Check if the file is locked
  const currentChatId = getCurrentChatId();
  const { locked } = isFileLocked(doc.filePath, currentChatId);

  // Set editable state based on both the editable prop and the file's lock state
  view.dispatch({
    effects: [editableStateEffect.of(editable && !doc.isBinary && !locked)],
  });

  getLanguage(doc.filePath).then((languageSupport) => {
    if (!languageSupport) {
      return;
    }

    view.dispatch({
      effects: [languageCompartment.reconfigure([languageSupport]), reconfigureTheme(theme)],
    });

    requestAnimationFrame(() => {
      const currentLeft = view.scrollDOM.scrollLeft;
      const currentTop = view.scrollDOM.scrollTop;
      const newLeft = doc.scroll?.left ?? 0;
      const newTop = doc.scroll?.top ?? 0;

      if (typeof doc.scroll?.line === 'number') {
        const line = doc.scroll.line;
        const column = doc.scroll.column ?? 0;

        try {
          // Check if the line number is valid for the current document
          const totalLines = view.state.doc.lines;

          // Only proceed if the line number is within the document's range
          if (line < totalLines) {
            const linePos = view.state.doc.line(line + 1).from + column;
            view.dispatch({
              selection: { anchor: linePos },
              scrollIntoView: true,
            });
            view.focus();
          } else {
            logger.warn(`Invalid line number ${line + 1} in ${totalLines}-line document`);
          }
        } catch (error) {
          logger.error('Error scrolling to line:', error);
        }

        return;
      }

      const needsScrolling = currentLeft !== newLeft || currentTop !== newTop;

      if (autoFocus && editable) {
        if (needsScrolling) {
          view.scrollDOM.addEventListener(
            'scroll',
            () => {
              view.focus();
            },
            { once: true },
          );
        } else {
          view.focus();
        }
      }

      view.scrollDOM.scrollTo(newLeft, newTop);
    });
  });
}

function getReadOnlyTooltip(state: EditorState) {
  if (!state.readOnly) {
    return [];
  }

  // Get the current document from the module-level reference
  const currentDoc = currentDocRef;
  let tooltipMessage = 'Cannot edit file while AI response is being generated';

  // If we have a current document, check if it's locked
  if (currentDoc?.filePath) {
    const currentChatId = getCurrentChatId();
    const { locked } = isFileLocked(currentDoc.filePath, currentChatId);

    if (locked) {
      tooltipMessage = 'This file is locked and cannot be edited';
    }
  }

  return state.selection.ranges
    .filter((range) => {
      return range.empty;
    })
    .map((range) => {
      return {
        pos: range.head,
        above: true,
        strictSide: true,
        arrow: true,
        create: () => {
          const divElement = document.createElement('div');
          divElement.className = 'cm-readonly-tooltip';
          divElement.textContent = tooltipMessage;

          return { dom: divElement };
        },
      };
    });
}
