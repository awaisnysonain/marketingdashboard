const express = require('express');
const router = express.Router();
const { pgQuery, pgRun } = require('../db/postgres');
const { effectiveUserId, effectiveUserName } = require('../auth');

const VISIBILITY = new Set(['team', 'private']);

function rowWithEditFlag(row, userId) {
  if (!row) return null;
  return {
    ...row,
    can_edit: Number(row.user_id) === Number(userId),
  };
}

async function resolveAuthorName(req) {
  const fromSession = effectiveUserName(req);
  if (fromSession) return fromSession;
  const userId = effectiveUserId(req);
  if (userId == null) return 'Unknown';
  const r = await pgQuery('SELECT name FROM app_users WHERE id = $1', [userId]);
  return r.rows[0]?.name || 'Unknown';
}

function normalizeVisibility(v) {
  return VISIBILITY.has(v) ? v : 'team';
}

// GET /api/comments?page_key=nobl-topline
router.get('/', async (req, res) => {
  const userId = effectiveUserId(req);
  if (userId == null) return res.status(401).json({ error: 'Not authenticated' });

  const { page_key: pageKey } = req.query;
  if (!pageKey) return res.status(400).json({ error: 'page_key required' });

  const r = await pgQuery(
    `SELECT * FROM dashboard_comments
     WHERE page_key = $1
       AND (visibility = 'team' OR user_id = $2)
     ORDER BY updated_at DESC`,
    [pageKey, userId]
  );
  res.json(r.rows.map((row) => rowWithEditFlag(row, userId)));
});

// POST /api/comments
router.post('/', async (req, res) => {
  const userId = effectiveUserId(req);
  if (userId == null) return res.status(401).json({ error: 'Not authenticated' });

  const { page_key, target_type, target_key, comment_text, visibility } = req.body || {};
  if (!page_key || !target_type || !target_key || !comment_text?.trim()) {
    return res.status(400).json({ error: 'page_key, target_type, target_key, comment_text required' });
  }

  const vis = normalizeVisibility(visibility);
  const authorName = await resolveAuthorName(req);

  const existing = await pgQuery(
    `SELECT * FROM dashboard_comments
     WHERE page_key = $1 AND target_type = $2 AND target_key = $3`,
    [page_key, target_type, target_key]
  );

  let row;
  if (existing.rows[0]) {
    if (Number(existing.rows[0].user_id) !== Number(userId)) {
      return res.status(403).json({ error: 'Only the comment author can edit this note' });
    }
    const u = await pgQuery(
      `UPDATE dashboard_comments
       SET comment_text = $1, visibility = $2, author_name = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [comment_text.trim(), vis, authorName, existing.rows[0].id]
    );
    row = u.rows[0];
  } else {
    const ins = await pgQuery(
      `INSERT INTO dashboard_comments
         (user_id, page_key, target_type, target_key, comment_text, visibility, author_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [userId, page_key, target_type, target_key, comment_text.trim(), vis, authorName]
    );
    row = ins.rows[0];
  }

  res.json(rowWithEditFlag(row, userId));
});

// PUT /api/comments/:id
router.put('/:id', async (req, res) => {
  const userId = effectiveUserId(req);
  if (userId == null) return res.status(401).json({ error: 'Not authenticated' });

  const { comment_text, visibility } = req.body || {};
  if (!comment_text?.trim()) return res.status(400).json({ error: 'comment_text required' });

  const vis = visibility != null ? normalizeVisibility(visibility) : null;
  const authorName = await resolveAuthorName(req);

  const r = await pgQuery(
    `UPDATE dashboard_comments
     SET comment_text = $1,
         visibility = COALESCE($2, visibility),
         author_name = $3,
         updated_at = NOW()
     WHERE id = $4 AND user_id = $5
     RETURNING *`,
    [comment_text.trim(), vis, authorName, req.params.id, userId]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Comment not found' });
  res.json(rowWithEditFlag(r.rows[0], userId));
});

// DELETE /api/comments/:id
router.delete('/:id', async (req, res) => {
  const userId = effectiveUserId(req);
  if (userId == null) return res.status(401).json({ error: 'Not authenticated' });

  const r = await pgRun(
    'DELETE FROM dashboard_comments WHERE id = $1 AND user_id = $2',
    [req.params.id, userId]
  );
  if (!r.rowCount) return res.status(404).json({ error: 'Comment not found' });
  res.json({ ok: true });
});

module.exports = router;
