const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

// ── DATABASE ──────────────────────────────────────────────────────────────────
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' })); // large limit for base64 images

// Health check
app.get('/', (req, res) => res.json({ status: 'Tenderable API running' }));

// ── AUTH ──────────────────────────────────────────────────────────────────────

// Register
app.post('/auth/register', async (req, res) => {
    try {
        const { name, pin, role, company, categories } = req.body;
        if (!name || !pin || !role) return res.status(400).json({ error: 'Name, PIN and role required' });
        if (!['buyer', 'supplier', 'stakeholder'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

        // Check name not already taken
        const existing = await pool.query('SELECT id FROM users WHERE LOWER(name) = LOWER($1)', [name]);
        if (existing.rows.length > 0) return res.status(409).json({ error: 'Name already taken' });

        const id = 'user-' + Date.now();
        const pinHash = await bcrypt.hash(pin, 10);
        await pool.query(
            'INSERT INTO users (id, name, pin_hash, role, company, categories) VALUES ($1, $2, $3, $4, $5, $6)',
            [id, name, pinHash, role, company || '', categories || []]
        );
        res.json({ id, name, role, company: company || '', categories: categories || [] });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Login
app.post('/auth/login', async (req, res) => {
    try {
        const { name, pin } = req.body;
        if (!name || !pin) return res.status(400).json({ error: 'Name and PIN required' });

        const result = await pool.query('SELECT * FROM users WHERE LOWER(name) = LOWER($1)', [name]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'Name not found' });

        const user = result.rows[0];
        const valid = await bcrypt.compare(pin, user.pin_hash);
        if (!valid) return res.status(401).json({ error: 'Incorrect PIN' });

        res.json({
            id: user.id,
            name: user.name,
            role: user.role,
            company: user.company,
            categories: user.categories || []
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ── DEVELOPMENTS ──────────────────────────────────────────────────────────────

app.get('/developments', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM developments ORDER BY created_at DESC');
        // Also fetch comments for each
        const devs = result.rows;
        const devIds = devs.map(d => d.id);
        let comments = {};
        if (devIds.length > 0) {
            const cResult = await pool.query(
                'SELECT * FROM dev_comments WHERE dev_id = ANY($1) ORDER BY created_at ASC',
                [devIds]
            );
            cResult.rows.forEach(c => {
                if (!comments[c.dev_id]) comments[c.dev_id] = [];
                comments[c.dev_id].push({
                    id: c.id, devId: c.dev_id,
                    author: c.author_name, authorType: c.author_type,
                    text: c.text, timestamp: c.created_at
                });
            });
        }
        res.json({ developments: devs.map(d => formatDev(d)), devComments: comments });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/developments', async (req, res) => {
    try {
        const d = req.body;
        await pool.query(
            `INSERT INTO developments (id,brand,category,description,season_code,fabric,price_target,order_qty,lead_time_target,labelling_reqs,files,specs_files,products,created_by,created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [d.id, d.brand, d.category, d.description, d.seasonCode, d.fabric,
             d.priceTarget, d.orderQty, d.leadTimeTarget, d.labellingReqs,
             JSON.stringify(d.files||[]), JSON.stringify(d.specsFiles||[]),
             JSON.stringify(d.products||[]), d.createdBy, d.createdAt || new Date()]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.put('/developments/:id', async (req, res) => {
    try {
        const d = req.body;
        await pool.query(
            `UPDATE developments SET brand=$1,category=$2,description=$3,season_code=$4,fabric=$5,
             price_target=$6,order_qty=$7,lead_time_target=$8,labelling_reqs=$9,
             files=$10,specs_files=$11,products=$12,edited_at=NOW() WHERE id=$13`,
            [d.brand, d.category, d.description, d.seasonCode, d.fabric,
             d.priceTarget, d.orderQty, d.leadTimeTarget, d.labellingReqs,
             JSON.stringify(d.files||[]), JSON.stringify(d.specsFiles||[]),
             JSON.stringify(d.products||[]), req.params.id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/developments/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM developments WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Dev comments
app.post('/developments/:id/comments', async (req, res) => {
    try {
        const { id, author, authorType, text, timestamp } = req.body;
        await pool.query(
            'INSERT INTO dev_comments (id,dev_id,author_name,author_type,text,created_at) VALUES ($1,$2,$3,$4,$5,$6)',
            [id, req.params.id, author, authorType, text, timestamp || new Date()]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ── TENDERS ───────────────────────────────────────────────────────────────────

app.get('/tenders', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM tenders ORDER BY created_at DESC');
        res.json({ tenders: result.rows.map(t => formatTender(t)) });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/tenders', async (req, res) => {
    try {
        const t = req.body;
        await pool.query(
            `INSERT INTO tenders (id,brand,category,description,season_code,fabric,price_target,order_qty,lead_time_target,deadline,deadline_date,labelling_reqs,files,specs_files,products,sent_from_dev,created_by,created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
            [t.id, t.brand, t.category, t.description, t.seasonCode, t.fabric,
             t.priceTarget, t.orderQty, t.leadTimeTarget, t.deadline, t.deadlineDate,
             t.labellingReqs, JSON.stringify(t.files||[]), JSON.stringify(t.specsFiles||[]),
             JSON.stringify(t.products||[]), t.sentFromDev||null, t.createdBy, t.createdAt||new Date()]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.put('/tenders/:id', async (req, res) => {
    try {
        const t = req.body;
        await pool.query(
            `UPDATE tenders SET brand=$1,category=$2,description=$3,season_code=$4,fabric=$5,
             price_target=$6,order_qty=$7,lead_time_target=$8,labelling_reqs=$9,
             files=$10,specs_files=$11,products=$12,edited_at=NOW() WHERE id=$13`,
            [t.brand, t.category, t.description, t.seasonCode, t.fabric,
             t.priceTarget, t.orderQty, t.leadTimeTarget, t.labellingReqs,
             JSON.stringify(t.files||[]), JSON.stringify(t.specsFiles||[]),
             JSON.stringify(t.products||[]), req.params.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/tenders/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM tenders WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ── BIDS ──────────────────────────────────────────────────────────────────────

app.get('/bids', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM bids ORDER BY created_at DESC');
        res.json({ bids: result.rows.map(b => formatBid(b)) });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/bids', async (req, res) => {
    try {
        const b = req.body;
        await pool.query(
            `INSERT INTO bids (id,tender_id,supplier_id,supplier_name,price,lead_time,status,is_multi_product,product_bids,negotiation_history,created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [b.id, b.tenderId, b.supplierId, b.supplierName, b.price||null,
             b.leadTime, b.status||'submitted', b.isMultiProduct||false,
             JSON.stringify(b.productBids||[]), JSON.stringify(b.negotiationHistory||[]),
             b.createdAt||new Date()]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.put('/bids/:id', async (req, res) => {
    try {
        const b = req.body;
        await pool.query(
            `UPDATE bids SET price=$1,counter_price=$2,status=$3,is_multi_product=$4,
             product_bids=$5,negotiation_history=$6,updated_at=NOW() WHERE id=$7`,
            [b.price||null, b.counterPrice||null, b.status,
             b.isMultiProduct||false,
             JSON.stringify(b.productBids||[]),
             JSON.stringify(b.negotiationHistory||[]),
             req.params.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Archive all bids for a tender (when tender is edited)
app.post('/bids/archive-for-tender/:tenderId', async (req, res) => {
    try {
        await pool.query(
            "UPDATE bids SET status='archived' WHERE tender_id=$1 AND status != 'accepted'",
            [req.params.tenderId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ── MESSAGES ──────────────────────────────────────────────────────────────────

app.get('/messages', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM messages ORDER BY created_at ASC');
        res.json({ messages: result.rows.map(m => formatMessage(m)) });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/messages', async (req, res) => {
    try {
        const m = req.body;
        await pool.query(
            'INSERT INTO messages (id,bid_id,sender_id,sender_name,sender_type,message,read_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
            [m.id, m.bidId, m.sender, m.senderName, m.senderType,
             m.message, m.readBy||[], m.timestamp||new Date()]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.put('/messages/:id/read', async (req, res) => {
    try {
        const { userId } = req.body;
        await pool.query(
            'UPDATE messages SET read_by = array_append(read_by, $1) WHERE id=$2 AND NOT ($1 = ANY(read_by))',
            [userId, req.params.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Mark all messages in a bid as read by a user
app.post('/messages/mark-read', async (req, res) => {
    try {
        const { bidId, userId } = req.body;
        await pool.query(
            'UPDATE messages SET read_by = array_append(read_by, $1) WHERE bid_id=$2 AND NOT ($1 = ANY(read_by))',
            [userId, bidId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ── FORMAT HELPERS ────────────────────────────────────────────────────────────
function formatDev(d) {
    return {
        id: d.id, brand: d.brand, category: d.category,
        description: d.description, seasonCode: d.season_code,
        fabric: d.fabric, priceTarget: parseFloat(d.price_target)||0,
        orderQty: d.order_qty, leadTimeTarget: d.lead_time_target,
        labellingReqs: d.labelling_reqs,
        files: d.files||[], specsFiles: d.specs_files||[],
        products: d.products||[], status: 'development',
        createdBy: d.created_by, createdAt: d.created_at, editedAt: d.edited_at
    };
}
function formatTender(t) {
    return {
        id: t.id, brand: t.brand, category: t.category,
        description: t.description, seasonCode: t.season_code,
        fabric: t.fabric, priceTarget: parseFloat(t.price_target)||0,
        orderQty: t.order_qty, leadTimeTarget: t.lead_time_target,
        deadline: t.deadline, deadlineDate: t.deadline_date,
        labellingReqs: t.labelling_reqs,
        files: t.files||[], specsFiles: t.specs_files||[],
        products: t.products||[], sentFromDev: t.sent_from_dev,
        createdBy: t.created_by, createdAt: t.created_at, editedAt: t.edited_at
    };
}
function formatBid(b) {
    return {
        id: b.id, tenderId: b.tender_id,
        supplierId: b.supplier_id, supplierName: b.supplier_name,
        price: parseFloat(b.price)||0,
        counterPrice: b.counter_price ? parseFloat(b.counter_price) : null,
        leadTime: b.lead_time, status: b.status,
        isMultiProduct: b.is_multi_product,
        productBids: b.product_bids||[],
        negotiationHistory: b.negotiation_history||[],
        createdAt: b.created_at, updatedAt: b.updated_at
    };
}
function formatMessage(m) {
    return {
        id: m.id, bidId: m.bid_id,
        sender: m.sender_id, senderName: m.sender_name,
        senderType: m.sender_type, message: m.message,
        readBy: m.read_by||[], timestamp: m.created_at
    };
}

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Tenderable API running on port ${PORT}`));
