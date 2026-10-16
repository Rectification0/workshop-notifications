import express from 'express';
import { AppError } from './errors.js';
import workshopsRouter from './routes/workshops.js';

export const app = express();

app.use(express.json());
app.use('/workshops', workshopsRouter);

app.use((req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
});

// Express 5 forwards rejected async handlers here, so routes can simply throw.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON body' } });
  }
  console.error('[api] unhandled error:', err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
});
