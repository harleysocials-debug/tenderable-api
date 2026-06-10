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
app.use(cors({
    origin: '*',
    methods: ['GET','POST','PUT','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization','X-User-Id','X-User-Name','X-User-Role','X-User-Company']
}));
app.options('*', cors()); // handle preflight
app.use(express.json({ limit: '50mb' })); // large limit for base64 images

// Health check
app.get('/', (req, res) => res.json({ status: 'Tenderable API running' }));

// ── AUTO SETUP — creates all tables if they don't exist ──────────────────────
app.get('/setup', async (req, res) => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(50) PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                pin_hash VARCHAR(100) NOT NULL,
                role VARCHAR(20) NOT NULL CHECK (role IN ('buyer', 'supplier', 'stakeholder')),
                company VARCHAR(100),
                categories TEXT[],
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS developments (
                id VARCHAR(50) PRIMARY KEY,
                brand VARCHAR(100),
                category VARCHAR(50),
                description TEXT,
                season_code VARCHAR(20),
                fabric TEXT,
                price_target NUMERIC(10,2),
                order_qty INTEGER,
                lead_time_target INTEGER,
                labelling_reqs TEXT,
                files JSONB DEFAULT '[]',
                specs_files JSONB DEFAULT '[]',
                products JSONB DEFAULT '[]',
                created_by VARCHAR(50),
                created_at TIMESTAMP DEFAULT NOW(),
                edited_at TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS dev_comments (
                id VARCHAR(50) PRIMARY KEY,
                dev_id VARCHAR(50) REFERENCES developments(id) ON DELETE CASCADE,
                author_name VARCHAR(100),
                author_type VARCHAR(20),
                text TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS tenders (
                id VARCHAR(50) PRIMARY KEY,
                brand VARCHAR(100),
                category VARCHAR(50),
                description TEXT,
                season_code VARCHAR(20),
                fabric TEXT,
                price_target NUMERIC(10,2),
                order_qty INTEGER,
                lead_time_target INTEGER,
                deadline INTEGER,
                deadline_date TIMESTAMP,
                labelling_reqs TEXT,
                files JSONB DEFAULT '[]',
                specs_files JSONB DEFAULT '[]',
                products JSONB DEFAULT '[]',
                sent_from_dev VARCHAR(50),
                invited_suppliers JSONB DEFAULT '[]',
                created_by VARCHAR(50),
                created_at TIMESTAMP DEFAULT NOW(),
                edited_at TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bids (
                id VARCHAR(50) PRIMARY KEY,
                tender_id VARCHAR(50) REFERENCES tenders(id) ON DELETE CASCADE,
                supplier_id VARCHAR(50),
                supplier_name VARCHAR(100),
                price NUMERIC(10,2),
                counter_price NUMERIC(10,2),
                lead_time INTEGER,
                status VARCHAR(20) DEFAULT 'submitted',
                is_multi_product BOOLEAN DEFAULT FALSE,
                product_bids JSONB DEFAULT '[]',
                negotiation_history JSONB DEFAULT '[]',
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id VARCHAR(50) PRIMARY KEY,
                bid_id VARCHAR(50) REFERENCES bids(id) ON DELETE CASCADE,
                sender_id VARCHAR(50),
                sender_name VARCHAR(100),
                sender_type VARCHAR(20),
                message TEXT NOT NULL,
                read_by TEXT[] DEFAULT '{}',
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_tenders_category ON tenders(category)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_bids_tender_id ON bids(tender_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_bids_supplier_id ON bids(supplier_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_bid_id ON messages(bid_id)`);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS comp_shops (
                id VARCHAR(100) PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                trip_date DATE,
                location VARCHAR(200),
                company VARCHAR(200),
                created_by VARCHAR(100),
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS comp_shop_images (
                id VARCHAR(100) PRIMARY KEY,
                shop_id VARCHAR(100) NOT NULL,
                image_data TEXT,
                store VARCHAR(200),
                category VARCHAR(200),
                colour VARCHAR(200),
                price VARCHAR(50),
                fabric VARCHAR(200),
                type VARCHAR(200),
                theme VARCHAR(200),
                notes TEXT,
                action_flag VARCHAR(100) DEFAULT 'reference',
                sort_order INTEGER DEFAULT 0,
                company VARCHAR(200),
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ecom_styling (
                id VARCHAR(200) PRIMARY KEY,
                dev_id VARCHAR(100) NOT NULL,
                product_idx INTEGER NOT NULL DEFAULT 0,
                model VARCHAR(200),
                shot_type VARCHAR(50),
                styling_notes TEXT,
                props JSONB DEFAULT '[]',
                status VARCHAR(50) DEFAULT 'unstyled',
                styling_with JSONB DEFAULT '[]',
                company VARCHAR(200),
                created_at TIMESTAMP DEFAULT NOW(),
                edited_at TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS packs (
                id VARCHAR(100) PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                shoot_date DATE,
                location VARCHAR(200),
                season VARCHAR(50),
                shoot_type VARCHAR(50),
                trade_deadline DATE,
                samples_ready_by DATE,
                brand VARCHAR(100),
                status VARCHAR(50) DEFAULT 'draft',
                looks JSONB DEFAULT '[]',
                created_by VARCHAR(100),
                created_at TIMESTAMP DEFAULT NOW(),
                edited_at TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS direct_messages (
                id VARCHAR(100) PRIMARY KEY,
                from_user_id VARCHAR(100) NOT NULL,
                from_user_name VARCHAR(200),
                to_user_id VARCHAR(100) NOT NULL,
                to_user_name VARCHAR(200),
                message TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT NOW(),
                read_at TIMESTAMP
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_dev_comments_dev_id ON dev_comments(dev_id)`);

        // Add status column to existing users table if it doesn't exist
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending'`);
        // Add invited_suppliers to tenders
        await pool.query(`ALTER TABLE tenders ADD COLUMN IF NOT EXISTS invited_suppliers JSONB DEFAULT '[]'`);
        // Make sure Harley's account is approved if it exists
        await pool.query(`UPDATE users SET status = 'approved' WHERE LOWER(name) = 'harley killingsworth'`);

        res.json({ 
            success: true, 
            message: 'All tables created successfully! You can now register and use Tenderable.',
            tables: ['users', 'developments', 'dev_comments', 'tenders', 'bids', 'messages']
        });
    } catch (err) {
        console.error('Setup error:', err);
        res.status(500).json({ error: err.message });
    }
});

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
        // Harley is auto-approved admin
        const isAdmin = name.toLowerCase() === 'harley killingsworth';
        const status = isAdmin ? 'approved' : 'pending';
        await pool.query(
            'INSERT INTO users (id, name, pin_hash, role, company, categories, status) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [id, name, pinHash, role, company || '', categories || [], status]
        );
        if (!isAdmin) {
            return res.json({ pending: true, message: 'Account created! Waiting for Harley to approve your account.' });
        }
        res.json({ id, name, role, company: company || '', categories: categories || [], isAdmin: true });
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

        if (user.status === 'pending') {
            return res.status(403).json({ error: 'Your account is awaiting approval from Harley Killingsworth.' });
        }
        if (user.status === 'rejected') {
            return res.status(403).json({ error: 'Your account request was not approved. Please contact Harley.' });
        }

        const isAdmin = user.name.toLowerCase() === 'harley killingsworth';
        res.json({
            id: user.id,
            name: user.name,
            role: user.role,
            company: user.company,
            categories: user.categories || [],
            isAdmin: isAdmin,
            status: user.status
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ── SUPPLIERS ────────────────────────────────────────────────────────────────

// Get all approved supplier companies
app.get('/suppliers', async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT DISTINCT company, categories FROM users WHERE role = 'supplier' AND status = 'approved' AND company IS NOT NULL AND company != '' ORDER BY company ASC"
        );
        res.json({ suppliers: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ── ADMIN ────────────────────────────────────────────────────────────────────

// Get all pending users (admin only)
app.get('/admin/pending', async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT id, name, role, company, categories, status, created_at FROM users WHERE status = 'pending' ORDER BY created_at ASC"
        );
        res.json({ users: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Get all users grouped by company (admin only)
app.get('/admin/users', async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT id, name, role, company, categories, status, created_at FROM users ORDER BY company ASC, created_at DESC"
        );
        res.json({ users: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Approve user
app.post('/admin/approve/:userId', async (req, res) => {
    try {
        await pool.query("UPDATE users SET status = 'approved' WHERE id = $1", [req.params.userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Reject user
app.post('/admin/reject/:userId', async (req, res) => {
    try {
        await pool.query("UPDATE users SET status = 'rejected' WHERE id = $1", [req.params.userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete user
app.delete('/admin/users/:userId', async (req, res) => {
    try {
        await pool.query("DELETE FROM users WHERE id = $1", [req.params.userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ── DEVELOPMENTS ──────────────────────────────────────────────────────────────

app.get('/developments', async (req, res) => {
    try {
        const { company, role } = req.query;
        let query = 'SELECT * FROM developments ORDER BY created_at DESC';
        let params = [];
        if ((role === 'buyer' || role === 'stakeholder') && company && company.trim() !== '') {
            // Include devs where created_by matches a user in same company
            // OR where created_by doesn't match any user (orphaned devs — still show them)
            query = `SELECT d.* FROM developments d
                     LEFT JOIN users u ON d.created_by = u.id
                     WHERE LOWER(COALESCE(u.company,'')) = LOWER($1)
                        OR u.id IS NULL
                        OR d.created_by IS NULL
                     ORDER BY d.created_at DESC`;
            params = [company];
        }
        const result = await pool.query(query, params);
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
                    userName: c.author_name, authorType: c.author_type,
                    comment: c.text, createdAt: c.created_at
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
        const id = d.id || ('dev-' + Date.now());
        await pool.query(
            `INSERT INTO developments (id,brand,category,description,season_code,fabric,price_target,order_qty,lead_time_target,labelling_reqs,files,specs_files,products,created_by,created_at,stage,store_grade,department,supplier_allocation,theme,company,block)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
            [id, d.brand, d.category, d.description, d.seasonCode, d.fabric,
             d.priceTarget||0, d.orderQty||0, d.leadTimeTarget, d.labellingReqs,
             JSON.stringify(d.files||[]), JSON.stringify(d.specsFiles||[]),
             JSON.stringify(d.products||[]),
             req.headers['x-user-id'] || d.createdBy, new Date(),
             d.stage||'inspiration', d.storeGrade||null, d.department||null, d.supplierAllocation||null, d.theme||null, req.headers['x-user-company']||d.company||null, d.block||null]
        );
        // Re-fetch the newly created dev so formatDev normalises it correctly
        const newDev = await pool.query('SELECT * FROM developments WHERE id = $1', [id]);
        const formatted = newDev.rows[0] ? formatDev(newDev.rows[0]) : { id, ...d };
        res.json({ success: true, development: formatted });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/developments/:id', async (req, res) => {
    try {
        const d = req.body;
        const id = req.params.id;
        const fields = [];
        const values = [];
        let idx = 1;
        const add = (col, val) => { fields.push(`${col}=$${idx++}`); values.push(val); };

        if (d.brand !== undefined)              add('brand', d.brand);
        if (d.category !== undefined)           add('category', d.category);
        if (d.description !== undefined)        add('description', d.description);
        if (d.seasonCode !== undefined)         add('season_code', d.seasonCode);
        if (d.fabric !== undefined)             add('fabric', d.fabric);
        if (d.priceTarget !== undefined)        add('price_target', d.priceTarget||0);
        if (d.orderQty !== undefined)           add('order_qty', d.orderQty||0);
        if (d.leadTimeTarget !== undefined)     add('lead_time_target', d.leadTimeTarget);
        if (d.labellingReqs !== undefined)      add('labelling_reqs', d.labellingReqs);
        if (d.files !== undefined)              add('files', JSON.stringify(d.files||[]));
        if (d.specsFiles !== undefined)         add('specs_files', JSON.stringify(d.specsFiles||[]));
        if (d.products !== undefined)           add('products', JSON.stringify(d.products||[]));
        if (d.stage !== undefined)              add('stage', d.stage);
        if (d.storeGrade !== undefined)         add('store_grade', d.storeGrade);
        if (d.department !== undefined)         add('department', d.department);
        if (d.supplierAllocation !== undefined) add('supplier_allocation', d.supplierAllocation);
        if (d.agreedPrice !== undefined)        add('agreed_price', d.agreedPrice);
        if (d.agreedSupplier !== undefined)     add('agreed_supplier', d.agreedSupplier);
        if (d.agreedAt !== undefined)           add('agreed_at', d.agreedAt);
        if (d.status !== undefined)             add('status', d.status);
        if (d.theme !== undefined)              add('theme', d.theme);
        if (d.block !== undefined)              add('block', d.block);

        if (fields.length === 0) return res.json({ success: true });
        fields.push(`edited_at=NOW()`);
        values.push(id);
        await pool.query(
            `UPDATE developments SET ${fields.join(', ')} WHERE id=$${idx}`,
            values
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
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
        const body = req.body;
        const commentId = 'cmt-' + Date.now();
        const userName = req.headers['x-user-name'] || body.userName || body.author || 'Unknown';
        const commentText = body.comment || body.text || '';
        await pool.query(
            'INSERT INTO dev_comments (id,dev_id,author_name,author_type,text,created_at) VALUES ($1,$2,$3,$4,$5,$6)',
            [commentId, req.params.id, userName, 'buyer', commentText, new Date()]
        );
        res.json({ success: true, comment: { id: commentId, userName, comment: commentText, createdAt: new Date() } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/developments/:devId/comments/:commentId', async (req, res) => {
    try {
        await pool.query('DELETE FROM dev_comments WHERE id=$1 AND dev_id=$2', [req.params.commentId, req.params.devId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});


// ── DIRECT MESSAGING ─────────────────────────────────────────────────────────

app.get('/direct-messages', async (req, res) => {
    try {
        const userId = req.headers['x-user-id'];
        const result = await pool.query(
            `SELECT * FROM direct_messages
             WHERE from_user_id=$1 OR to_user_id=$1
             ORDER BY created_at ASC`,
            [userId]
        );
        res.json({ messages: result.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/direct-messages', async (req, res) => {
    try {
        const { toUserId, toUserName, message } = req.body;
        const fromUserId = req.headers['x-user-id'];
        const fromUserName = req.headers['x-user-name'];
        const id = 'dm-' + Date.now();
        await pool.query(
            `INSERT INTO direct_messages (id,from_user_id,from_user_name,to_user_id,to_user_name,message,created_at)
             VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
            [id, fromUserId, fromUserName, toUserId, toUserName, message]
        );
        res.json({ success: true, id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/direct-messages/read', async (req, res) => {
    try {
        const userId = req.headers['x-user-id'];
        const { fromUserId } = req.body;
        await pool.query(
            `UPDATE direct_messages SET read_at=NOW()
             WHERE to_user_id=$1 AND from_user_id=$2 AND read_at IS NULL`,
            [userId, fromUserId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/direct-messages/:id', async (req, res) => {
    try {
        const userId = req.headers['x-user-id'];
        await pool.query(
            `DELETE FROM direct_messages WHERE id=$1 AND from_user_id=$2`,
            [req.params.id, userId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});




// ── COMP SHOP ─────────────────────────────────────────────────────────────────

app.get('/comp-shops', async (req, res) => {
    try {
        const company = req.headers['x-user-company'] || '';
        const shops = await pool.query(
            `SELECT cs.*, COUNT(ci.id) as image_count
             FROM comp_shops cs
             LEFT JOIN comp_shop_images ci ON ci.shop_id = cs.id
             WHERE LOWER(cs.company)=LOWER($1)
             GROUP BY cs.id ORDER BY cs.created_at DESC`,
            [company]
        );
        // Fetch first 4 thumbnails per shop
        const result = [];
        for (const shop of shops.rows) {
            const thumbs = await pool.query(
                `SELECT image_data FROM comp_shop_images WHERE shop_id=$1 AND image_data IS NOT NULL ORDER BY sort_order ASC, created_at ASC LIMIT 4`,
                [shop.id]
            );
            result.push({ ...shop, thumbs: thumbs.rows.map(r => r.image_data) });
        }
        res.json({ shops: result });
    } catch(err){ res.status(500).json({ error: err.message }); }
});

app.post('/comp-shops', async (req, res) => {
    try {
        const d = req.body;
        const company = req.headers['x-user-company'] || '';
        const id = 'cs-' + Date.now();
        await pool.query(
            `INSERT INTO comp_shops (id,name,trip_date,location,company,created_by,created_at)
             VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
            [id, d.name, d.tripDate||null, d.location||null, company, req.headers['x-user-id']]
        );
        const r = await pool.query('SELECT * FROM comp_shops WHERE id=$1', [id]);
        res.json({ success: true, shop: r.rows[0] });
    } catch(err){ res.status(500).json({ error: err.message }); }
});

app.delete('/comp-shops/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM comp_shop_images WHERE shop_id=$1', [req.params.id]);
        await pool.query('DELETE FROM comp_shops WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch(err){ res.status(500).json({ error: err.message }); }
});

app.get('/comp-shops/:id/images', async (req, res) => {
    try {
        const r = await pool.query(
            'SELECT * FROM comp_shop_images WHERE shop_id=$1 ORDER BY sort_order ASC, created_at ASC',
            [req.params.id]
        );
        res.json({ images: r.rows });
    } catch(err){ res.status(500).json({ error: err.message }); }
});

app.post('/comp-shops/:id/images', async (req, res) => {
    try {
        const company = req.headers['x-user-company'] || '';
        const images = req.body.images || [];
        for (let i = 0; i < images.length; i++) {
            const img = images[i];
            const imgId = 'ci-' + Date.now() + '-' + i;
            await pool.query(
                `INSERT INTO comp_shop_images (id,shop_id,image_data,store,notes,action_flag,sort_order,company,created_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
                [imgId, req.params.id, img.imageData||null, img.store||null,
                 img.notes||null, img.actionFlag||'reference', img.sortOrder||i, company]
            );
        }
        res.json({ success: true });
    } catch(err){ res.status(500).json({ error: err.message }); }
});

app.put('/comp-shop-images/:id', async (req, res) => {
    try {
        const d = req.body;
        const fields = []; const values = []; let idx = 1;
        const add = (col, val) => { fields.push(`${col}=$${idx++}`); values.push(val); };
        if(d.store !== undefined) add('store', d.store);
        if(d.category !== undefined) add('category', d.category);
        if(d.colour !== undefined) add('colour', d.colour);
        if(d.price !== undefined) add('price', d.price);
        if(d.fabric !== undefined) add('fabric', d.fabric);
        if(d.type !== undefined) add('type', d.type);
        if(d.theme !== undefined) add('theme', d.theme);
        if(d.notes !== undefined) add('notes', d.notes);
        if(d.actionFlag !== undefined) add('action_flag', d.actionFlag);
        if(!fields.length) return res.json({ success: true });
        values.push(req.params.id);
        await pool.query(`UPDATE comp_shop_images SET ${fields.join(',')} WHERE id=$${idx}`, values);
        res.json({ success: true });
    } catch(err){ res.status(500).json({ error: err.message }); }
});

app.delete('/comp-shop-images/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM comp_shop_images WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch(err){ res.status(500).json({ error: err.message }); }
});

// ── ECOM STYLING ──────────────────────────────────────────────────────────────

app.get('/ecom-styling', async (req, res) => {
    try {
        const company = req.headers['x-user-company'] || '';
        const result = await pool.query(
            'SELECT * FROM ecom_styling WHERE LOWER(company)=LOWER($1)',
            [company]
        );
        res.json({ styles: result.rows });
    } catch(err){ res.status(500).json({ error: err.message }); }
});

app.put('/ecom-styling/:id', async (req, res) => {
    try {
        const d = req.body;
        const company = req.headers['x-user-company'] || '';
        // Upsert
        await pool.query(`
            INSERT INTO ecom_styling (id, dev_id, product_idx, model, shot_type, styling_notes, props, status, styling_with, company, created_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
            ON CONFLICT (id) DO UPDATE SET
              model=EXCLUDED.model, shot_type=EXCLUDED.shot_type,
              styling_notes=EXCLUDED.styling_notes, props=EXCLUDED.props,
              status=EXCLUDED.status, styling_with=EXCLUDED.styling_with, edited_at=NOW()
        `, [req.params.id, d.devId, d.productIdx||0, d.model||null,
            d.shotType||null, d.stylingNotes||null,
            JSON.stringify(d.props||[]), d.status||'unstyled', company]);
        res.json({ success: true });
    } catch(err){ res.status(500).json({ error: err.message }); }
});

// ── PACKS ─────────────────────────────────────────────────────────────────────

app.get('/packs', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM packs ORDER BY created_at DESC');
        res.json({ packs: result.rows.map(p => ({
            ...p, looks: p.looks || []
        }))});
    } catch(err){ res.status(500).json({ error: err.message }); }
});

app.post('/packs', async (req, res) => {
    try {
        const d = req.body;
        const id = 'pack-' + Date.now();
        await pool.query(
            `INSERT INTO packs (id,name,shoot_date,location,season,shoot_type,trade_deadline,samples_ready_by,brand,status,looks,notes,attachments,created_by,created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())`,
            [id, d.name, d.shootDate||null, d.location||null, d.season||null,
             d.shootType||null, d.tradeDeadline||null, d.samplesReadyBy||null,
             d.brand||null, d.status||'draft',
             JSON.stringify(d.looks||[]), d.notes||null, JSON.stringify(d.attachments||[]), req.headers['x-user-id']]
        );
        const r = await pool.query('SELECT * FROM packs WHERE id=$1', [id]);
        res.json({ success: true, pack: r.rows[0] });
    } catch(err){ res.status(500).json({ error: err.message }); }
});

app.put('/packs/:id', async (req, res) => {
    try {
        const d = req.body;
        const fields = []; const values = []; let idx = 1;
        const add = (col, val) => { fields.push(`${col}=$${idx++}`); values.push(val); };
        if(d.name !== undefined) add('name', d.name);
        if(d.shootDate !== undefined) add('shoot_date', d.shootDate||null);
        if(d.location !== undefined) add('location', d.location||null);
        if(d.season !== undefined) add('season', d.season||null);
        if(d.shootType !== undefined) add('shoot_type', d.shootType||null);
        if(d.tradeDeadline !== undefined) add('trade_deadline', d.tradeDeadline||null);
        if(d.samplesReadyBy !== undefined) add('samples_ready_by', d.samplesReadyBy||null);
        if(d.brand !== undefined) add('brand', d.brand||null);
        if(d.status !== undefined) add('status', d.status);
        if(d.looks !== undefined) add('looks', JSON.stringify(d.looks));
        if(d.notes !== undefined) add('notes', d.notes||null);
        if(d.attachments !== undefined) add('attachments', JSON.stringify(d.attachments||[]));
        if(!fields.length) return res.json({ success: true });
        fields.push(`edited_at=NOW()`);
        values.push(req.params.id);
        await pool.query(`UPDATE packs SET ${fields.join(',')} WHERE id=$${idx}`, values);
        res.json({ success: true });
    } catch(err){ res.status(500).json({ error: err.message }); }
});

app.delete('/packs/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM packs WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch(err){ res.status(500).json({ error: err.message }); }
});

// ── TENDERS ───────────────────────────────────────────────────────────────────

app.get('/tenders', async (req, res) => {
    try {
        const { company, role, categories } = req.query;
        let result;
        if (role === 'buyer' && company && company.trim() !== '') {
            // Buyers only see tenders from their own company
            result = await pool.query(
                'SELECT t.* FROM tenders t LEFT JOIN users u ON t.created_by = u.id WHERE LOWER(COALESCE(u.company,\'\')) = LOWER($1) ORDER BY t.created_at DESC',
                [company]
            );
        } else if (role === 'supplier' && categories) {
            // Suppliers see tenders matching their categories
            // BUT if tender has invited_suppliers, only show if their company is invited
            const cats = categories.split(',');
            const supplierCompany = req.query.supplierCompany || '';
            result = await pool.query(
                `SELECT * FROM tenders WHERE category = ANY($1)
                 AND (
                     invited_suppliers IS NULL
                     OR invited_suppliers = '[]'::jsonb
                     OR invited_suppliers @> $2::jsonb
                 )
                 ORDER BY created_at DESC`,
                [cats, JSON.stringify([supplierCompany.toLowerCase()])]
            );
        } else {
            result = await pool.query('SELECT * FROM tenders ORDER BY created_at DESC');
        }
        res.json({ tenders: result.rows.map(t => formatTender(t)) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/tenders', async (req, res) => {
    try {
        const t = req.body;
        await pool.query(
            `INSERT INTO tenders (id,brand,category,description,season_code,fabric,price_target,order_qty,lead_time_target,deadline,deadline_date,labelling_reqs,files,specs_files,products,sent_from_dev,invited_suppliers,created_by,created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
            [t.id, t.brand, t.category, t.description, t.seasonCode, t.fabric,
             t.priceTarget, t.orderQty, t.leadTimeTarget, t.deadline, t.deadlineDate,
             t.labellingReqs, JSON.stringify(t.files||[]), JSON.stringify(t.specsFiles||[]),
             JSON.stringify(t.products||[]), t.sentFromDev||null,
             JSON.stringify((t.invitedSuppliers||[]).map(s => s.toLowerCase())),
             t.createdBy, t.createdAt||new Date()]
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
        const { company, role, supplierId } = req.query;
        let result;
        if (role === 'supplier' && supplierId) {
            // Suppliers see bids from their whole company (same company name)
            result = await pool.query(
                'SELECT b.* FROM bids b JOIN users u ON b.supplier_id = u.id WHERE LOWER(u.company) = (SELECT LOWER(company) FROM users WHERE id = $1) ORDER BY b.created_at DESC',
                [supplierId]
            );
        } else if (role === 'buyer' && company) {
            // Buyers see all bids on their company tenders
            result = await pool.query(
                'SELECT b.* FROM bids b JOIN tenders t ON b.tender_id = t.id LEFT JOIN users u ON t.created_by = u.id WHERE LOWER(COALESCE(u.company,\'\')) = LOWER($1) ORDER BY b.created_at DESC',
                [company]
            );
        } else {
            result = await pool.query('SELECT * FROM bids ORDER BY created_at DESC');
        }
        res.json({ bids: result.rows.map(b => formatBid(b)) });
    } catch (err) {
        console.error(err);
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
        products: d.products||[],
        stage: d.stage||'concept',
        storeGrade: d.store_grade||null,
        department: d.department||null,
        supplierAllocation: d.supplier_allocation||null,
        agreedPrice: d.agreed_price||null,
        agreedSupplier: d.agreed_supplier||null,
        agreedAt: d.agreed_at||null,
        theme: d.theme||null,
        block: d.block||null,
        status: d.status||'active',
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
