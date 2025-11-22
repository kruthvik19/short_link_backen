require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto'); // For random code generation

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet());
app.use(cors({ 
  origin: [
    'http://localhost:3000',     
    'https://shortlink19.netlify.app' 
  ],
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],  // Explicitly allow these
  allowedHeaders: ['Content-Type', 'Authorization'],  // If using auth/custom headers
  credentials: true  // Only if your app sends cookies/auth; otherwise, omit
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// PostgreSQL Pool
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: true  // Enable SSL for Neon (equivalent to sslmode=require)
});

// Helper: Generate random short code (5 chars, alphanumeric)
function generateShortCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 5); // e.g., 'D2FD3'
}

// Helper: Format timestamp for frontend (e.g., 'Nov 22, 2025 16:12')
function formatTimestamp(ts) {
  if (!ts) return null;
  return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// API Routes

// POST /api/links - Create a short link
app.post('/api/links', async (req, res) => {
  const { target_url, custom_code } = req.body;
  if (!target_url || typeof target_url !== 'string' || !target_url.startsWith('http')) {
    return res.status(400).json({ error: 'Valid target_url is required' });
  }

  const code = custom_code || generateShortCode();
  if (code.length > 8 || !/^[a-zA-Z0-9]+$/.test(code)) {
    return res.status(400).json({ error: 'Custom code must be 1-8 alphanumeric chars' });
  }

  try {
    // Check if code is unique
    const checkQuery = 'SELECT id FROM links WHERE code = $1';
    const checkResult = await pool.query(checkQuery, [code]);
    if (checkResult.rows.length > 0) {
      return res.status(409).json({ error: 'Code already exists. Try another.' });
    }

    // Insert new link
    const insertQuery = `
      INSERT INTO links (code, target_url, created_at, updated_at)
      VALUES ($1, $2, NOW(), NOW())
      RETURNING id, code, target_url, clicks, last_clicked_at, created_at, updated_at
    `;
    const result = await pool.query(insertQuery, [code, target_url]);
    const link = result.rows[0];

    res.status(201).json({
      ...link,
      short_url: `${process.env.BASE_URL}/${code}`,
      last_clicked: formatTimestamp(link.last_clicked_at),
      created_date: new Date(link.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create link' });
  }
});

// GET /api/links - List all links (with optional search)
app.get('/api/links', async (req, res) => {
  const { search } = req.query;
  let query = `
    SELECT id, code, target_url, clicks, last_clicked_at, created_at, updated_at
    FROM links
    ORDER BY created_at DESC
  `;
  const params = [];

  if (search) {
    query = `
      SELECT id, code, target_url, clicks, last_clicked_at, created_at, updated_at
      FROM links
      WHERE LOWER(code) LIKE $1 OR LOWER(target_url) LIKE $1
      ORDER BY created_at DESC
    `;
    params.push(`%${search.toLowerCase()}%`);
  }

  try {
    const result = await pool.query(query, params);
    const links = result.rows.map(link => ({
      ...link,
      lastClicked: formatTimestamp(link.last_clicked_at) || 'Never',
    }));
    res.json(links);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch links' });
  }
});

// GET /api/links/:code - Get single link stats
app.get('/api/links/:code', async (req, res) => {
  const { code } = req.params;

  try {
    const query = `
      SELECT id, code, target_url, clicks, last_clicked_at, created_at, updated_at
      FROM links WHERE code = $1
    `;
    const result = await pool.query(query, [code]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Link not found' });
    }

    const link = result.rows[0];
    res.json({
      shortCode: link.code,
      shortUrl: `${process.env.BASE_URL}/${link.code}`,
      targetUrl: link.target_url,
      totalClicks: link.clicks,
      lastClicked: formatTimestamp(link.last_clicked_at),
      createdDate: new Date(link.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch link stats' });
  }
});

// DELETE /api/links/:code - Delete a link
app.delete('/api/links/:code', async (req, res) => {
  const { code } = req.params;

  try {
    const query = 'DELETE FROM links WHERE code = $1 RETURNING id';
    const result = await pool.query(query, [code]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Link not found' });
    }
    res.json({ message: 'Link deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete link' });
  }
});

// GET /:code - Redirect handler (increment clicks on visit)
app.get('/:code', async (req, res) => {
  const { code } = req.params;

  try {
    const query = `
      UPDATE links
      SET clicks = clicks , last_clicked_at = NOW(), updated_at = NOW()
      WHERE code = $1
      RETURNING target_url
    `;
    const result = await pool.query(query, [code]);
    
    if (result.rows.length === 0) {
      return res.status(404).send('Link not found');
    }

    const { target_url } = result.rows[0];
    
    // Add no-cache headers to prevent browser caching
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    
    res.redirect(302, target_url);
  } catch (err) {
    console.error(err);
    res.status(500).send('Redirect failed');
  }
});

// Add this endpoint to server.js (after the existing /api/links routes)
// POST /api/increment/:code - Increment clicks (non-atomic, for demonstration)
app.post('/api/increment/:code', async (req, res) => {
  const { code } = req.params;

  try {
    // First get the current link (equivalent to Supabase select)
    const selectQuery = 'SELECT clicks FROM links WHERE code = $1';
    const selectResult = await pool.query(selectQuery, [code]);
    if (selectResult.rows.length === 0) {
      return res.status(404).json({ error: 'Link not found' });
    }

    const currentClicks = selectResult.rows[0].clicks;

    // Update clicks and last_clicked_at (equivalent to Supabase update)
    const updateQuery = `
      UPDATE links
      SET clicks = $1, last_clicked_at = NOW(), updated_at = NOW()
      WHERE code = $2
      RETURNING id
    `;
    const updateResult = await pool.query(updateQuery, [currentClicks + 1, code]);
    if (updateResult.rows.length === 0) {
      return res.status(404).json({ error: 'Link not found' });
    }

    res.json({ message: 'Clicks incremented successfully', newClicks: currentClicks + 1 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to increment clicks' });
  }
});
// Health check
app.get('/health', (req, res) => res.json({ status: 'OK' }));

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  pool.end();
  process.exit(0);
});



