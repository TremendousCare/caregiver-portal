import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { loadBoards, saveBoard, deleteBoard as deleteBoardStorage, loadBoardCards, saveBoardCard, saveBoardCardsBulk, deleteBoardCard as deleteBoardCardStorage, migrateToMultiBoard } from '../../lib/storage';
import { supabase, isSupabaseConfigured } from '../../lib/supabase';
import { useApp } from './AppContext';

const BoardContext = createContext();

// How long to suppress Realtime echoes for locally-modified records (ms)
const RT_SUPPRESS_WINDOW = 3000;

export function BoardProvider({ children, caregivers }) {
  const { showToast } = useApp();

  const [boards, setBoards] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [migrated, setMigrated] = useState(false);

  // Per-board card caches: boardId → { cards, loaded }
  const [cardCache, setCardCache] = useState({});
  const recentLocalEdits = useRef(new Map());

  // ─── Load boards on mount (with migration check) ───
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        let data = await loadBoards();
        if (!cancelled) {
          // If no boards exist and we have caregivers with board data, migrate
          if (data.length === 0 && caregivers.length > 0) {
            const hasExistingBoardData = caregivers.some((cg) => cg.boardStatus);
            if (hasExistingBoardData) {
              try {
                const defaultBoard = await migrateToMultiBoard(caregivers);
                data = [defaultBoard];
                setMigrated(true);
              } catch (e) {
                console.error('Board migration failed:', e);
              }
            }
          }
          setBoards(data);
          setLoaded(true);
        }
      } catch (err) {
        console.error('loadBoards failed:', err);
        if (!cancelled) setLoaded(true);
      }
    };
    // Wait for caregivers to be loaded before attempting migration
    if (caregivers.length > 0 || loaded) {
      load();
    }
    return () => { cancelled = true; };
  }, [caregivers.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Realtime subscription for board changes ───
  useEffect(() => {
    if (!isSupabaseConfigured()) return;

    const channel = supabase
      .channel('boards-changes')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'boards' },
        () => {
          // Reload all boards on any change
          loadBoards().then(setBoards).catch(console.error);
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  // ─── Board CRUD ───
  const addBoard = useCallback(async (boardData) => {
    const newBoard = {
      id: crypto.randomUUID(),
      ...boardData,
      sortOrder: boards.length,
      createdAt: new Date().toISOString(),
    };
    setBoards((prev) => [...prev, newBoard]);
    try {
      await saveBoard(newBoard);
      showToast(`Board "${newBoard.name}" created!`);
    } catch {
      showToast('Failed to create board');
    }
    return newBoard;
  }, [boards.length, showToast]);

  const updateBoard = useCallback(async (boardId, updates) => {
    let updated;
    setBoards((prev) =>
      prev.map((b) => {
        if (b.id !== boardId) return b;
        updated = { ...b, ...updates };
        return updated;
      })
    );
    if (updated) {
      try {
        await saveBoard(updated);
      } catch {
        showToast('Failed to save board');
      }
    }
  }, [showToast]);

  const removeBoard = useCallback(async (boardId) => {
    setBoards((prev) => prev.filter((b) => b.id !== boardId));
    setCardCache((prev) => {
      const next = { ...prev };
      delete next[boardId];
      return next;
    });
    try {
      await deleteBoardStorage(boardId);
      showToast('Board deleted');
    } catch {
      showToast('Failed to delete board');
    }
  }, [showToast]);

  // ─── Board Cards ───
  const loadCards = useCallback(async (boardId) => {
    if (cardCache[boardId]?.loaded) return cardCache[boardId].cards;
    try {
      const cards = await loadBoardCards(boardId);
      setCardCache((prev) => ({ ...prev, [boardId]: { cards, loaded: true } }));
      return cards;
    } catch (e) {
      console.error('loadBoardCards failed:', e);
      return [];
    }
  }, [cardCache]);

  const getCards = useCallback((boardId) => {
    return cardCache[boardId]?.cards || [];
  }, [cardCache]);

  const updateCard = useCallback(async (boardId, entityId, updates) => {
    setCardCache((prev) => {
      const boardCards = prev[boardId]?.cards || [];
      const updatedCards = boardCards.map((c) => {
        if (c.entityId !== entityId) return c;
        return { ...c, ...updates };
      });
      return { ...prev, [boardId]: { cards: updatedCards, loaded: true } };
    });

    // Find the card and save
    const cards = cardCache[boardId]?.cards || [];
    const card = cards.find((c) => c.entityId === entityId);
    if (card) {
      recentLocalEdits.current.set(card.id, Date.now());
      const updated = { ...card, ...updates };
      saveBoardCard(updated).catch((e) => console.error('Save board card failed:', e));
    }
  }, [cardCache]);

  const addCard = useCallback(async (boardId, entityId, entityType = 'caregiver', columnId = null) => {
    const newCard = {
      id: crypto.randomUUID(),
      boardId,
      entityType,
      entityId,
      columnId,
      sortOrder: 0,
      labels: [],
      checklists: [],
      dueDate: null,
      description: null,
      pinnedNote: null,
      movedAt: columnId ? new Date().toISOString() : null,
      createdAt: new Date().toISOString(),
    };

    setCardCache((prev) => {
      const boardCards = prev[boardId]?.cards || [];
      return { ...prev, [boardId]: { cards: [...boardCards, newCard], loaded: true } };
    });

    try {
      await saveBoardCard(newCard);
    } catch {
      showToast('Failed to add card');
    }
    return newCard;
  }, [showToast]);

  const removeCard = useCallback(async (boardId, cardId) => {
    setCardCache((prev) => {
      const boardCards = prev[boardId]?.cards || [];
      return { ...prev, [boardId]: { cards: boardCards.filter((c) => c.id !== cardId), loaded: true } };
    });
    try {
      await deleteBoardCardStorage(cardId);
    } catch {
      showToast('Failed to remove card');
    }
  }, [showToast]);

  // ─── Realtime subscription for board card changes ───
  useEffect(() => {
    if (!isSupabaseConfigured()) return;

    const channel = supabase
      .channel('board-cards-changes')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'board_cards' },
        (payload) => {
          const row = payload.new || payload.old;
          if (!row?.board_id) return;
          const editedAt = recentLocalEdits.current.get(row.id);
          if (editedAt && Date.now() - editedAt < RT_SUPPRESS_WINDOW) return;
          // Reload cards for this board
          loadBoardCards(row.board_id).then((cards) => {
            setCardCache((prev) => ({ ...prev, [row.board_id]: { cards, loaded: true } }));
          }).catch(console.error);
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  return (
    <BoardContext.Provider value={{
      boards, loaded, migrated,
      addBoard, updateBoard, removeBoard,
      loadCards, getCards, updateCard, addCard, removeCard,
    }}>
      {children}
    </BoardContext.Provider>
  );
}

export function useBoards() {
  const ctx = useContext(BoardContext);
  if (!ctx) throw new Error('useBoards must be used within BoardProvider');
  return ctx;
}
