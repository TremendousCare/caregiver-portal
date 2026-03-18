import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { useState, useEffect, useRef } from 'react';
import kb from './KanbanBoard.module.css';

function ToolbarButton({ onClick, active, children, title }) {
  return (
    <button
      type="button"
      className={`${kb.editorToolBtn} ${active ? kb.editorToolBtnActive : ''}`}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}

export default function DescriptionEditor({ value, onChange }) {
  const [editing, setEditing] = useState(false);
  const saveTimer = useRef(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: kb.editorLink },
      }),
      Placeholder.configure({
        placeholder: 'Add a description...',
      }),
    ],
    content: value || '',
    editable: editing,
    onUpdate: ({ editor: ed }) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const html = ed.getHTML();
        const isEmpty = html === '<p></p>' || html === '';
        onChange(isEmpty ? null : html);
      }, 500);
    },
  });

  // Sync editable state
  useEffect(() => {
    if (editor) editor.setEditable(editing);
  }, [editing, editor]);

  // Sync external value changes when not editing
  useEffect(() => {
    if (editor && !editing) {
      const current = editor.getHTML();
      const incoming = value || '';
      if (current !== incoming) {
        editor.commands.setContent(incoming);
      }
    }
  }, [value, editor, editing]);

  if (!editor) return null;

  const hasContent = value && value !== '<p></p>';

  // View mode — show rendered HTML or placeholder
  if (!editing) {
    return (
      <div className={kb.descriptionSection}>
        <div className={kb.descriptionHeader}>
          <span className={kb.descriptionIcon}>&#9776;</span>
          <span className={kb.descriptionTitle}>Description</span>
          <button className={kb.descriptionEditBtn} onClick={() => setEditing(true)}>
            Edit
          </button>
        </div>
        {hasContent ? (
          <div
            className={kb.descriptionView}
            onClick={() => setEditing(true)}
            dangerouslySetInnerHTML={{ __html: value }}
          />
        ) : (
          <div className={kb.descriptionPlaceholder} onClick={() => setEditing(true)}>
            Add a more detailed description...
          </div>
        )}
      </div>
    );
  }

  // Edit mode — toolbar + editor
  return (
    <div className={kb.descriptionSection}>
      <div className={kb.descriptionHeader}>
        <span className={kb.descriptionIcon}>&#9776;</span>
        <span className={kb.descriptionTitle}>Description</span>
      </div>
      <div className={kb.editorToolbar}>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBold().run()}
          active={editor.isActive('bold')}
          title="Bold"
        >
          <strong>B</strong>
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleItalic().run()}
          active={editor.isActive('italic')}
          title="Italic"
        >
          <em>I</em>
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleStrike().run()}
          active={editor.isActive('strike')}
          title="Strikethrough"
        >
          <s>S</s>
        </ToolbarButton>
        <span className={kb.editorToolDivider} />
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          active={editor.isActive('heading', { level: 2 })}
          title="Heading"
        >
          H
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          active={editor.isActive('bulletList')}
          title="Bullet List"
        >
          &#8226;
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          active={editor.isActive('orderedList')}
          title="Numbered List"
        >
          1.
        </ToolbarButton>
        <span className={kb.editorToolDivider} />
        <ToolbarButton
          onClick={() => {
            const url = window.prompt('Enter URL:');
            if (url) editor.chain().focus().setLink({ href: url }).run();
          }}
          active={editor.isActive('link')}
          title="Insert Link"
        >
          &#128279;
        </ToolbarButton>
      </div>
      <div className={kb.editorWrapper}>
        <EditorContent editor={editor} />
      </div>
      <div className={kb.editorActions}>
        <button
          className={kb.editorSaveBtn}
          onClick={() => setEditing(false)}
        >
          Save
        </button>
        <button
          className={kb.editorCancelBtn}
          onClick={() => {
            editor.commands.setContent(value || '');
            setEditing(false);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
