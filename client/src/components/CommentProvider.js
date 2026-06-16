import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getComments, createComment, updateComment, deleteComment } from '../utils/api';

const CommentContext = createContext(null);

export function CommentProvider({ pageKey, children }) {
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!pageKey) return;
    setLoading(true);
    try {
      const rows = await getComments(pageKey);
      setComments(Array.isArray(rows) ? rows : []);
    } catch (e) {
      console.warn('[comments] load failed', e);
      setComments([]);
    } finally {
      setLoading(false);
    }
  }, [pageKey]);

  useEffect(() => { reload(); }, [reload]);

  const byTarget = useMemo(() => {
    const map = new Map();
    for (const c of comments) {
      const k = `${c.target_type}::${c.target_key}`;
      if (!map.has(k)) map.set(k, c);
    }
    return map;
  }, [comments]);

  const getForTarget = useCallback((targetType, targetKey) => {
    return byTarget.get(`${targetType}::${targetKey}`) || null;
  }, [byTarget]);

  const saveComment = useCallback(async (targetType, targetKey, commentText, existing, options = {}) => {
    const { visibility = 'team' } = options;
    let result;
    if (existing?.id) {
      result = await updateComment(existing.id, { comment_text: commentText, visibility });
    } else {
      result = await createComment({
        page_key: pageKey,
        target_type: targetType,
        target_key: targetKey,
        comment_text: commentText,
        visibility,
      });
    }
    setComments((prev) => {
      const next = prev.filter((c) => c.id !== result.id && !(c.target_type === targetType && c.target_key === targetKey));
      return [result, ...next];
    });
    return result;
  }, [pageKey]);

  const removeComment = useCallback(async (id) => {
    await deleteComment(id);
    setComments((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const value = useMemo(() => ({
    pageKey,
    loading,
    reload,
    getForTarget,
    saveComment,
    removeComment,
  }), [pageKey, loading, reload, getForTarget, saveComment, removeComment]);

  return (
    <CommentContext.Provider value={value}>
      {children}
    </CommentContext.Provider>
  );
}

export function useComments() {
  const ctx = useContext(CommentContext);
  return ctx;
}
