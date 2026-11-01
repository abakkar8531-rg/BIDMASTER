
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// DATABASE
const databaseFolder = path.join(__dirname, 'database');

if (!fs.existsSync(databaseFolder)) {
    fs.mkdirSync(databaseFolder);
}

const db = new Database(
    path.join(databaseFolder, 'auction.db')
);

db.pragma('foreign_keys = ON');

// CREATE TABLES
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auctions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        starting_price REAL NOT NULL,
        current_bid REAL NOT NULL,
        end_time TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bids (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        auction_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(auction_id) REFERENCES auctions(id)
    );
`);

// SAMPLE AUCTIONS
const auctionCount = db.prepare(
    'SELECT COUNT(*) AS count FROM auctions'
).get().count;

if (auctionCount === 0) {
    const insertAuction = db.prepare(
        'INSERT INTO auctions ' +
        '(title, description, starting_price, current_bid, end_time) ' +
        'VALUES (?, ?, ?, ?, ?)'
    );

    insertAuction.run(
        'Smartphone',
        'Latest smartphone with excellent features.',
        10000, 10000, '2027-12-31T23:59'
    );

    insertAuction.run(
        'Laptop',
        'High performance laptop for work and gaming.',
        25000, 25000, '2027-12-31T23:59'
    );

    insertAuction.run(
        'Digital Camera',
        'Professional digital camera.',
        15000, 15000, '2027-12-31T23:59'
    );
}

// MIDDLEWARE
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'change-this-secret-before-deployment',
    resave: false,
    saveUninitialized: false
}));

// USER LOGIN CHECK
function requireLogin(req, res, next) {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    next();
}

// ADMIN LOGIN CHECK
function requireAdmin(req, res, next) {
    if (!req.session.admin) {
        return res.redirect('/admin-login');
    }
    next();
}

// HOME
app.get('/', (req, res) => {
    res.render('index');
});

// REGISTER PAGE
app.get('/register', (req, res) => {
    res.render('register');
});

// REGISTER USER
app.post('/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password || password.length < 8) {
            return res.send(
                'Enter all details. Password must have at least 8 characters.'
            );
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        db.prepare(
            'INSERT INTO users (name, email, password) VALUES (?, ?, ?)'
        ).run(name.trim(), email.trim().toLowerCase(), hashedPassword);

        res.redirect('/login');

    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.send('This email is already registered.');
        }

        console.error(error);
        res.status(500).send('Registration failed.');
    }
});

// LOGIN PAGE
app.get('/login', (req, res) => {
    res.render('login');
});

// USER LOGIN
app.post('/login', async (req, res) => {
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';

    const user = db.prepare(
        'SELECT * FROM users WHERE email = ?'
    ).get(email);

    if (!user) {
        return res.send('Invalid email or password.');
    }

    const validPassword = await bcrypt.compare(
        password,
        user.password
    );

    if (!validPassword) {
        return res.send('Invalid email or password.');
    }

    req.session.user = {
        id: user.id,
        name: user.name,
        email: user.email
    };

    res.redirect('/dashboard');
});

// USER DASHBOARD
app.get('/dashboard', requireLogin, (req, res) => {
    res.render('dashboard', {
        user: req.session.user
    });
});

// AUCTIONS PAGE WITH SEARCH
app.get('/auctions', requireLogin, (req, res) => {
    const search = (req.query.search || '').trim();

    const auctions = db.prepare(
        'SELECT * FROM auctions ' +
        'WHERE title LIKE ? OR description LIKE ? ' +
        'ORDER BY id DESC'
    ).all(
        '%' + search + '%',
        '%' + search + '%'
    );

    res.render('auctions', {
        auctions: auctions,
        search: search
    });
});

// INDIVIDUAL AUCTION
app.get('/auction/:id', requireLogin, (req, res) => {
    const auction = db.prepare(
        'SELECT * FROM auctions WHERE id = ?'
    ).get(req.params.id);

    if (!auction) {
        return res.status(404).send('Auction not found.');
    }

    res.render('auction-detail', {
        auction: auction
    });
});

// PLACE BID
app.post('/bid/:id', requireLogin, (req, res) => {
    const auctionId = Number(req.params.id);
    const amount = Number(req.body.amount);

    const auction = db.prepare(
        'SELECT * FROM auctions WHERE id = ?'
    ).get(auctionId);

    if (!auction) {
        return res.status(404).send('Auction not found.');
    }

    if (new Date(auction.end_time).getTime() <= Date.now()) {
        return res.send('This auction has ended.');
    }

    if (!Number.isFinite(amount) || amount <= auction.current_bid) {
        return res.send(
            'Your bid must be higher than the current bid.'
        );
    }

    const placeBid = db.transaction(() => {
        db.prepare(
            'INSERT INTO bids (user_id, auction_id, amount) VALUES (?, ?, ?)'
        ).run(req.session.user.id, auctionId, amount);

        db.prepare(
            'UPDATE auctions SET current_bid = ? WHERE id = ?'
        ).run(amount, auctionId);
    });

    try {
        placeBid();

        io.emit('bidUpdated', {
            auctionId: auctionId,
            amount: amount
        });

        res.redirect('/auction/' + auctionId);

    } catch (error) {
        console.error(error);
        res.status(500).send('Could not place your bid.');
    }
});

// MY BIDS
app.get('/my-bids', requireLogin, (req, res) => {
    const bids = db.prepare(
        'SELECT bids.*, auctions.title AS auction_title ' +
        'FROM bids ' +
        'JOIN auctions ON bids.auction_id = auctions.id ' +
        'WHERE bids.user_id = ? ' +
        'ORDER BY bids.id DESC'
    ).all(req.session.user.id);

    res.render('my-bids', {
        bids: bids
    });
});

// USER LOGOUT
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

// ADMIN LOGIN PAGE
app.get('/admin-login', (req, res) => {
    res.render('admin-login');
});

// ADMIN LOGIN
app.post('/admin-login', (req, res) => {
    const email = req.body.email;
    const password = req.body.password;

    if (
        email === 'admin@bidmaster.com' &&
        password === 'Admin@12345'
    ) {
        req.session.admin = true;
        return res.redirect('/admin-dashboard');
    }

    res.send('Invalid admin email or password.');
});

// ADMIN DASHBOARD
app.get('/admin-dashboard', requireAdmin, (req, res) => {
    const totalUsers = db.prepare(
        'SELECT COUNT(*) AS count FROM users'
    ).get().count;

    const totalAuctions = db.prepare(
        'SELECT COUNT(*) AS count FROM auctions'
    ).get().count;

    const totalBids = db.prepare(
        'SELECT COUNT(*) AS count FROM bids'
    ).get().count;

    const auctions = db.prepare(
        'SELECT * FROM auctions ORDER BY id DESC'
    ).all();

    res.render('admin-dashboard', {
        totalUsers,
        totalAuctions,
        totalBids,
        auctions
    });
});

// REGISTERED USERS
app.get('/admin/users', requireAdmin, (req, res) => {
    const users = db.prepare(
        'SELECT id, name, email FROM users ORDER BY id DESC'
    ).all();

    res.render('admin-users', {
        users: users
    });
});

// ALL BIDS
app.get('/admin/bids', requireAdmin, (req, res) => {
    const bids = db.prepare(
        'SELECT bids.*, ' +
        'users.name AS user_name, ' +
        'users.email AS user_email, ' +
        'auctions.title AS auction_title ' +
        'FROM bids ' +
        'JOIN users ON bids.user_id = users.id ' +
        'JOIN auctions ON bids.auction_id = auctions.id ' +
        'ORDER BY bids.id DESC'
    ).all();

    res.render('admin-bids', {
        bids: bids
    });
});

// AUCTION WINNERS
app.get('/admin/winners', requireAdmin, (req, res) => {
    const auctions = db.prepare(
        'SELECT * FROM auctions ORDER BY id DESC'
    ).all();

    const results = auctions.map(auction => {
        const highestBid = db.prepare(
            'SELECT bids.amount, ' +
            'users.name AS winner_name, ' +
            'users.email AS winner_email ' +
            'FROM bids ' +
            'JOIN users ON bids.user_id = users.id ' +
            'WHERE bids.auction_id = ? ' +
            'ORDER BY bids.amount DESC, bids.id ASC LIMIT 1'
        ).get(auction.id);

        const ended =
            new Date(auction.end_time).getTime() <= Date.now();

        return {
            ...auction,
            ended: ended,
            winner: ended ? (highestBid || null) : null
        };
    });

    res.render('admin-winners', {
        auctions: results
    });
});

// ADD AUCTION PAGE
app.get('/admin/add-auction', requireAdmin, (req, res) => {
    res.render('add-auction');
});

// ADD NEW AUCTION
app.post('/admin/add-auction', requireAdmin, (req, res) => {
    const {
        title,
        description,
        starting_price,
        end_time
    } = req.body;

    const price = Number(starting_price);

    if (
        !title ||
        !Number.isFinite(price) ||
        price <= 0 ||
        !end_time ||
        new Date(end_time).getTime() <= Date.now()
    ) {
        return res.send(
            'Enter valid auction details and a future end time.'
        );
    }

    db.prepare(
        'INSERT INTO auctions ' +
        '(title, description, starting_price, current_bid, end_time) ' +
        'VALUES (?, ?, ?, ?, ?)'
    ).run(
        title.trim(),
        description || '',
        price,
        price,
        end_time
    );

    res.redirect('/admin-dashboard');
});

// DELETE AUCTION
app.post('/admin/delete-auction/:id', requireAdmin, (req, res) => {
    const auctionId = Number(req.params.id);

    const deleteAuction = db.transaction(() => {
        db.prepare(
            'DELETE FROM bids WHERE auction_id = ?'
        ).run(auctionId);

        db.prepare(
            'DELETE FROM auctions WHERE id = ?'
        ).run(auctionId);
    });

    deleteAuction();

    res.redirect('/admin-dashboard');
});

// ADMIN LOGOUT
app.post('/admin-logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/admin-login');
    });
});

// HEALTH CHECK
app.get('/health', (req, res) => {
    res.send('BIDMASTER server is working!');
});

// SOCKET.IO LIVE BIDDING
io.on('connection', (socket) => {
    console.log('A user connected to live bidding.');

    socket.on('disconnect', () => {
        console.log('A user disconnected.');
    });
});

// START SERVER
const PORT = 3000;

server.listen(PORT, () => {
    console.log(
        'BIDMASTER running at http://localhost:' + PORT
    );
});
