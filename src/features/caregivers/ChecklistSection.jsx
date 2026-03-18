import { useState } from 'react';
import { getChecklistProgress } from '../../lib/checklistUtils';
import kb from './KanbanBoard.module.css';

// ─── Single Checklist ────────────────────────────────────────
function Checklist({ checklist, onUpdate, onDelete, currentUserName }) {
  const [hideChecked, setHideChecked] = useState(false);
  const [newItemText, setNewItemText] = useState('');
  const { checked, total, pct } = getChecklistProgress(checklist);

  const toggleItem = (idx) => {
    const items = checklist.items.map((item, i) => {
      if (i !== idx) return item;
      return item.checked
        ? { text: item.text, checked: false }
        : { text: item.text, checked: true, checkedAt: Date.now(), checkedBy: currentUserName };
    });
    onUpdate({ ...checklist, items });
  };

  const addItem = () => {
    if (!newItemText.trim()) return;
    const items = [...checklist.items, { text: newItemText.trim(), checked: false }];
    onUpdate({ ...checklist, items });
    setNewItemText('');
  };

  const deleteItem = (idx) => {
    const items = checklist.items.filter((_, i) => i !== idx);
    onUpdate({ ...checklist, items });
  };

  const visibleItems = hideChecked
    ? checklist.items.filter((item) => !item.checked)
    : checklist.items;

  const checkedCount = checklist.items.filter((i) => i.checked).length;

  return (
    <div className={kb.checklist}>
      <div className={kb.checklistHeader}>
        <span className={kb.checklistIcon}>&#9745;</span>
        <span className={kb.checklistName}>{checklist.name}</span>
        <span className={kb.checklistPct}>{pct}%</span>
        <button className={kb.checklistDeleteBtn} onClick={onDelete} title="Delete checklist">&#10005;</button>
      </div>
      <div className={kb.checklistProgressBar}>
        <div
          className={kb.checklistProgressFill}
          style={{ width: `${pct}%`, background: pct === 100 ? '#16A34A' : '#29BEE4' }}
        />
      </div>

      <div className={kb.checklistItems}>
        {visibleItems.map((item) => {
          const originalIdx = checklist.items.indexOf(item);
          return (
            <div key={originalIdx} className={kb.checklistItem}>
              <button
                className={`${kb.checklistCheckbox} ${item.checked ? kb.checklistCheckboxChecked : ''}`}
                onClick={() => toggleItem(originalIdx)}
                title={item.checked ? 'Uncheck' : 'Check'}
              >
                {item.checked && <span>&#10003;</span>}
              </button>
              <span className={item.checked ? kb.checklistItemTextChecked : kb.checklistItemText}>
                {item.text}
              </span>
              <button
                className={kb.checklistItemDelete}
                onClick={() => deleteItem(originalIdx)}
                title="Remove item"
              >
                &#10005;
              </button>
            </div>
          );
        })}
      </div>

      <div className={kb.checklistAddItem}>
        <input
          className={kb.checklistAddInput}
          value={newItemText}
          onChange={(e) => setNewItemText(e.target.value)}
          placeholder="Add an item"
          onKeyDown={(e) => { if (e.key === 'Enter') addItem(); }}
        />
        <button className={kb.checklistAddBtn} onClick={addItem}>Add</button>
      </div>

      {checkedCount > 0 && (
        <button
          className={kb.checklistToggleHide}
          onClick={() => setHideChecked(!hideChecked)}
        >
          {hideChecked ? `Show checked items (${checkedCount})` : 'Hide checked items'}
        </button>
      )}
    </div>
  );
}

// ─── Add Checklist Dropdown ──────────────────────────────────
function AddChecklistDropdown({ templates, onCreateBlank, onCreateFromTemplate, onClose }) {
  const [name, setName] = useState('');
  const [showTemplates, setShowTemplates] = useState(false);

  const handleCreate = () => {
    onCreateBlank(name.trim() || 'Checklist');
    onClose();
  };

  if (showTemplates) {
    return (
      <div className={kb.addChecklistPanel}>
        <div className={kb.addChecklistPanelTitle}>
          <button className={kb.addChecklistBack} onClick={() => setShowTemplates(false)}>&larr;</button>
          Copy from template
        </div>
        {templates.length === 0 && (
          <div className={kb.addChecklistEmpty}>No templates yet. Create a checklist and save it as a template.</div>
        )}
        {templates.map((tpl) => (
          <button
            key={tpl.id}
            className={kb.addChecklistTemplateBtn}
            onClick={() => { onCreateFromTemplate(tpl); onClose(); }}
          >
            <span className={kb.addChecklistTemplateName}>{tpl.name}</span>
            <span className={kb.addChecklistTemplateCount}>{tpl.items.length} items</span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className={kb.addChecklistPanel}>
      <div className={kb.addChecklistPanelTitle}>Add Checklist</div>
      <div className={kb.addChecklistField}>
        <label className={kb.addChecklistLabel}>Name</label>
        <input
          className={kb.addChecklistInput}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Onboarding"
          onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
          autoFocus
        />
      </div>
      <div className={kb.addChecklistActions}>
        <button className={kb.addChecklistCreateBtn} onClick={handleCreate}>Create</button>
        {templates.length > 0 && (
          <button className={kb.addChecklistFromTplBtn} onClick={() => setShowTemplates(true)}>
            Copy from template...
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Main Export: ChecklistSection ───────────────────────────
export default function ChecklistSection({ caregiver, onUpdateChecklists, templates, onSaveTemplate, currentUserName }) {
  const [showAddDropdown, setShowAddDropdown] = useState(false);
  const checklists = caregiver.boardChecklists || [];

  const updateChecklist = (updatedCl) => {
    const updated = checklists.map((cl) => cl.id === updatedCl.id ? updatedCl : cl);
    onUpdateChecklists(caregiver.id, updated);
  };

  const deleteChecklist = (clId) => {
    onUpdateChecklists(caregiver.id, checklists.filter((cl) => cl.id !== clId));
  };

  const createBlank = (name) => {
    const newCl = {
      id: 'cl_' + Date.now().toString(36),
      name,
      items: [],
      createdAt: Date.now(),
      createdBy: currentUserName,
    };
    onUpdateChecklists(caregiver.id, [...checklists, newCl]);
  };

  const createFromTemplate = (tpl) => {
    const newCl = {
      id: 'cl_' + Date.now().toString(36),
      name: tpl.name,
      items: tpl.items.map((text) => ({ text, checked: false })),
      createdAt: Date.now(),
      createdBy: currentUserName,
    };
    onUpdateChecklists(caregiver.id, [...checklists, newCl]);
  };

  const saveAsTemplate = (cl) => {
    const tpl = {
      id: 'tpl_' + Date.now().toString(36),
      name: cl.name,
      items: cl.items.map((i) => i.text),
      createdAt: Date.now(),
      createdBy: currentUserName,
    };
    onSaveTemplate(tpl);
  };

  return (
    <div>
      {checklists.map((cl) => (
        <div key={cl.id} className={kb.checklistWrapper}>
          <Checklist
            checklist={cl}
            onUpdate={updateChecklist}
            onDelete={() => deleteChecklist(cl.id)}
            currentUserName={currentUserName}
          />
          {cl.items.length > 0 && (
            <button
              className={kb.checklistSaveTemplate}
              onClick={() => saveAsTemplate(cl)}
              title="Save this checklist as a reusable template"
            >
              Save as template
            </button>
          )}
        </div>
      ))}

      <div className={kb.addChecklistContainer}>
        <button
          className={kb.addChecklistTrigger}
          onClick={() => setShowAddDropdown(!showAddDropdown)}
        >
          &#9745; Add Checklist
        </button>
        {showAddDropdown && (
          <AddChecklistDropdown
            templates={templates}
            onCreateBlank={createBlank}
            onCreateFromTemplate={createFromTemplate}
            onClose={() => setShowAddDropdown(false)}
          />
        )}
      </div>
    </div>
  );
}
