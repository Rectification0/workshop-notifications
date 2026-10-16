import { Router } from 'express';
import { pool } from '../db.js';
import { AppError } from '../errors.js';

const router = Router();

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

const toWorkshop = (row) => ({
  id: row.id,
  title: row.title,
  organizerId: row.organizer_id,
  status: row.status,
  createdAt: row.created_at,
});

// FR-1: create a workshop (status 'active').
router.post('/', async (req, res) => {
  const { title, organizerId } = req.body ?? {};
  if (!isNonEmptyString(title)) throw new AppError(400, 'VALIDATION_ERROR', 'title must be a non-empty string');
  if (!isNonEmptyString(organizerId)) throw new AppError(400, 'VALIDATION_ERROR', 'organizerId must be a non-empty string');

  const { rows } = await pool.query(
    `INSERT INTO workshops (title, organizer_id) VALUES ($1, $2)
     RETURNING id, title, organizer_id, status, created_at`,
    [title.trim(), organizerId.trim()],
  );
  res.status(201).json(toWorkshop(rows[0]));
});

export default router;
