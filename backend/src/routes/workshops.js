import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { AppError } from '../errors.js';

const router = Router();

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const workshopNotFound = () => new AppError(404, 'WORKSHOP_NOT_FOUND', 'Workshop not found');

// A malformed id can never match a workshop, so it is reported as not found.
function requireWorkshopId(id) {
  if (!UUID_RE.test(id)) throw workshopNotFound();
  return id;
}

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

// FR-2..FR-5: register a member. The registration and its confirmation outbox row commit
// together, and every failure path throws before COMMIT, so a failed registration never
// leaves a confirmation behind. No call to the notification service is made here (FR-4).
router.post('/:id/registrations', async (req, res) => {
  const workshopId = requireWorkshopId(req.params.id);
  const { memberId, email } = req.body ?? {};
  if (!isNonEmptyString(memberId)) throw new AppError(400, 'VALIDATION_ERROR', 'memberId must be a non-empty string');
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    throw new AppError(400, 'VALIDATION_ERROR', 'email must be a valid email address');
  }

  const result = await withTransaction(async (client) => {
    // FOR SHARE conflicts with the FOR UPDATE taken by cancel, so a registration either
    // commits before the cancel (and is notified) or sees the workshop as cancelled.
    const { rows: [workshop] } = await client.query(
      'SELECT id, title, status FROM workshops WHERE id = $1 FOR SHARE',
      [workshopId],
    );
    if (!workshop) throw workshopNotFound();
    if (workshop.status === 'cancelled') throw new AppError(409, 'WORKSHOP_CANCELLED', 'Workshop has been cancelled');

    let registration;
    try {
      ({ rows: [registration] } = await client.query(
        `INSERT INTO registrations (workshop_id, member_id, email) VALUES ($1, $2, $3)
         RETURNING id, workshop_id, member_id, email, created_at`,
        [workshopId, memberId.trim(), email.trim()],
      ));
    } catch (err) {
      if (err.code === '23505' && err.constraint === 'uq_registration_member') {
        throw new AppError(409, 'ALREADY_REGISTERED', 'Member is already registered for this workshop');
      }
      throw err;
    }

    // The outbox id doubles as the Idempotency-Key, so it is generated here to embed in the payload.
    const notificationId = randomUUID();
    const payload = {
      notificationId,
      type: 'registration_confirmation',
      memberId: registration.member_id,
      email: registration.email,
      workshopId,
      message: `You are registered for "${workshop.title}".`,
    };
    await client.query(
      `INSERT INTO notifications (id, type, registration_id, workshop_id, member_id, email, payload)
       VALUES ($1, 'registration_confirmation', $2, $3, $4, $5, $6)`,
      [notificationId, registration.id, workshopId, registration.member_id, registration.email, payload],
    );
    return { registration, notificationId };
  });

  const { registration, notificationId } = result;
  res.status(201).json({
    registration: {
      id: registration.id,
      workshopId: registration.workshop_id,
      memberId: registration.member_id,
      email: registration.email,
      createdAt: registration.created_at,
    },
    confirmation: { notificationId, status: 'pending' },
  });
});

// FR-9: cancel a workshop and queue one cancellation notice per registered member,
// all in the same transaction as the status change.
router.post('/:id/cancel', async (req, res) => {
  const workshopId = requireWorkshopId(req.params.id);

  const result = await withTransaction(async (client) => {
    // FOR UPDATE waits for in-flight registrations (FOR SHARE) to commit and blocks new
    // ones until we commit, so the INSERT ... SELECT below sees every registered member.
    const { rows: [workshop] } = await client.query(
      'SELECT id, title, status FROM workshops WHERE id = $1 FOR UPDATE',
      [workshopId],
    );
    if (!workshop) throw workshopNotFound();
    if (workshop.status === 'cancelled') {
      throw new AppError(409, 'WORKSHOP_ALREADY_CANCELLED', 'Workshop is already cancelled');
    }

    const { rows: [cancelled] } = await client.query(
      `UPDATE workshops SET status = 'cancelled', cancelled_at = now() WHERE id = $1
       RETURNING id, status, cancelled_at`,
      [workshopId],
    );

    // The inner SELECT generates one id per registration (a volatile function in a subquery's
    // target list is evaluated per row), so each payload carries its own row id as notificationId.
    const { rowCount } = await client.query(
      `INSERT INTO notifications (id, type, registration_id, workshop_id, member_id, email, payload)
       SELECT r.nid, 'workshop_cancelled', r.id, r.workshop_id, r.member_id, r.email,
              jsonb_build_object(
                'notificationId', r.nid,
                'type', 'workshop_cancelled',
                'memberId', r.member_id,
                'email', r.email,
                'workshopId', r.workshop_id,
                'message', $2::text)
       FROM (SELECT gen_random_uuid() AS nid, id, workshop_id, member_id, email
             FROM registrations WHERE workshop_id = $1) r`,
      [workshopId, `Workshop "${workshop.title}" has been cancelled.`],
    );
    return { cancelled, notificationsQueued: rowCount };
  });

  const { cancelled, notificationsQueued } = result;
  res.status(200).json({
    id: cancelled.id,
    status: cancelled.status,
    cancelledAt: cancelled.cancelled_at,
    notificationsQueued,
  });
});

export default router;
