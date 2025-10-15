const express = require('express');
const { Client } = require('pg');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"]
    }
  }
}));

// Rate limiting
const orderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each IP to 10 requests per windowMs
  message: 'Too many order submissions, please try again later'
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});

// Basic middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Database connection
const connectDB = async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  await client.connect();
  return client;
};

// Database initialization
const initDB = async () => {
  const client = await connectDB();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        name VARCHAR(40) NOT NULL,
        student_id VARCHAR(30) NOT NULL,
        jersey_number VARCHAR(8) NOT NULL,
        batch VARCHAR(20),
        size VARCHAR(10) NOT NULL,
        collar_type VARCHAR(20) NOT NULL,
        sleeve_type VARCHAR(20) NOT NULL,
        email VARCHAR(40) NOT NULL,
        transaction_id VARCHAR(30),
        notes TEXT,
        final_price DECIMAL(10, 2) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(10) UNIQUE NOT NULL,
        password_hash VARCHAR(70) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    //   // Create default admin if not exists


    //   const adminExists = await client.query('SELECT id FROM admin_users WHERE username = $1', ['admin']);
    //   if (adminExists.rows.length === 0) {
    //     const hashedPassword = await bcrypt.hash('admin123', 12);
    //     await client.query('INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)',
    //       ['admin', hashedPassword]);
    //     console.log('Default admin created: admin/admin123');
    //   }

    // } finally {
    //   await client.end();
    // }


    const defaultAdmins = [
      { username: 'ice_dep', password: 'ice_dep12' },
      { username: 'aldrik', password: 'aldrik123' },
      { username: 'noor', password: 'noorabdullah' }
    ];

    for (const admin of defaultAdmins) {
      const adminExists = await client.query(
        'SELECT id FROM admin_users WHERE username = $1',
        [admin.username]
      );

      if (adminExists.rows.length === 0) {
        const hashedPassword = await bcrypt.hash(admin.password, 12);
        await client.query(
          'INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)',
          [admin.username, hashedPassword]
        );
        console.log(`Default admin created: ${admin.username}/${admin.password}`);
      }
    }
  } finally {
    await client.end();
  }
};



// JWT Auth middleware
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret');
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid token' });
  }
};

// Email service
const sendEmail = async (to, subject, htmlContent, textContent) => {
  if (!process.env.BREVO_API_KEY) {
    console.warn('Email service not configured');
    return { success: false };
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'api-key': process.env.BREVO_API_KEY
      },
      body: JSON.stringify({
        sender: {
          name: process.env.BREVO_FROM_NAME || 'ICE Jersey',
          email: process.env.BREVO_FROM_EMAIL
        },
        to: [{ email: to }],
        subject,
        htmlContent,
        textContent
      })
    });

    return { success: response.ok };
  } catch (error) {
    console.error('Email error:', error.message);
    return { success: false };
  }
};

// Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Admin login
app.post('/api/admin/login', apiLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const client = await connectDB();
    try {
      const result = await client.query('SELECT * FROM admin_users WHERE username = $1', [username]);
      const user = result.rows[0];

      if (!user || !await bcrypt.compare(password, user.password_hash)) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const token = jwt.sign(
        { id: user.id, username: user.username },
        process.env.JWT_SECRET || 'fallback-secret',
        { expiresIn: '24h' }
      );

      res.json({
        success: true,
        token,
        admin: { username: user.username }
      });
    } finally {
      await client.end();
    }
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Verify token
app.get('/api/admin/verify', authenticateToken, (req, res) => {
  res.json({
    success: true,
    admin: { username: req.user.username }
  });
});

// Check jersey number availability
app.get('/api/orders/check-jersey', apiLimiter, async (req, res) => {
  try {
    const { number } = req.query;

    if (!number) {
      return res.status(400).json({ error: 'Jersey number required' });
    }

    const client = await connectDB();
    try {
      const result = await client.query('SELECT name FROM orders WHERE jersey_number = $1', [parseInt(number)]);

      res.json({
        available: result.rows.length === 0,
        message: result.rows.length > 0
          ? `Jersey #${number} is taken by ${result.rows[0].name}`
          : `Jersey #${number} is available`
      });
    } finally {
      await client.end();
    }
  } catch (error) {
    console.error('Jersey check error:', error);
    res.status(500).json({ error: 'Check failed' });
  }
});

// Check name existence
app.get('/api/orders/check-name', apiLimiter, async (req, res) => {
  try {
    const { name } = req.query;

    if (!name) {
      return res.status(400).json({ error: 'Name required' });
    }

    const client = await connectDB();
    try {
      const result = await client.query('SELECT id FROM orders WHERE LOWER(name) = LOWER($1)', [name.trim()]);

      res.json({
        exists: result.rows.length > 0,
        message: result.rows.length > 0
          ? `Name "${name}" already exists`
          : `Name "${name}" is available`
      });
    } finally {
      await client.end();
    }
  } catch (error) {
    console.error('Name check error:', error);
    res.status(500).json({ error: 'Check failed' });
  }
});

// Submit new order
app.post('/api/orders', orderLimiter, async (req, res) => {
  try {
    const {
      name, studentId, jerseyNumber, batch, size,
      collarType, sleeveType, email, transactionId,
      notes, finalPrice
    } = req.body;

    // Validate required fields
    if (!name || !studentId || !jerseyNumber || !size ||
      !collarType || !sleeveType || !email || !finalPrice) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate email
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Validate jersey number
    const jerseyNum = parseInt(jerseyNumber);
    if (isNaN(jerseyNum) || jerseyNum < 0 || jerseyNum > 500) {
      return res.status(400).json({ error: 'Jersey number must be 0-500' });
    }

    const client = await connectDB();
    try {
      // Check if jersey number exists



      // const existingJersey = await client.query('SELECT name FROM orders WHERE jersey_number = $1', [jerseyNum]);
      // if (existingJersey.rows.length > 0) {
      //   return res.status(409).json({
      //     error: `Jersey #${jerseyNum} is already taken by ${existingJersey.rows[0].name}`
      //   });
      // }





      // Insert order
      const result = await client.query(`
        INSERT INTO orders (
          name, student_id, jersey_number, batch, size,
          collar_type, sleeve_type, email, transaction_id,
          notes, final_price, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *
      `, [
        name.trim(), studentId.trim(), jerseyNum,
        batch?.trim() || null, size, collarType, sleeveType,
        email.trim(), transactionId?.trim() || null,
        notes?.trim() || null, finalPrice, 'pending'
      ]);

      const order = result.rows[0]; // Get the full order object

      // Send confirmation email
      const confirmationHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center;">
                <h1 style="color: white; margin: 0;">Order Confirmation</h1>
                <p style="color: white; margin: 5px 0;">Department of Information & Communication Engineering</p>
            </div>
            
            <div style="padding: 20px; background: #f8f9fa;">
                <h2 style="color: #333;">Hello ${order.name}!</h2>
                <p>Thank you for ordering your ICE Department jersey. Your order has been received successfully.</p>
                
                <div style="background: white; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <h3 style="color: #667eea; margin-top: 0;">Order Details:</h3>
                    <table style="width: 100%; border-collapse: collapse;">
                        <tr><td><strong>Name:</strong></td><td>${order.name}</td></tr>
                        <tr><td><strong>Student ID:</strong></td><td>${order.student_id}</td></tr>
                        <tr><td><strong>Jersey Number:</strong></td><td>${order.jersey_number}</td></tr>
                        ${order.batch ? `<tr><td><strong>Batch:</strong></td><td>${order.batch}</td></tr>` : ''}
                        <tr><td><strong>Size:</strong></td><td>${order.size}</td></tr>
                        <tr><td><strong>Collar Type:</strong></td><td>${order.collar_type}</td></tr>
                        <tr><td><strong>Sleeve Type:</strong></td><td>${order.sleeve_type}</td></tr>
                        ${order.transaction_id ? `<tr><td><strong>Transaction ID:</strong></td><td>${order.transaction_id}</td></tr>` : ''}
                        <tr><td><strong>Total Price:</strong></td><td>৳${order.final_price}</td></tr>
                    </table>
                    ${order.notes ? `<p><strong>Special Instructions:</strong> ${order.notes}</p>` : ''}
                </div>
                
                <div style="background: #e3f2fd; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <h4 style="color: #1976d2; margin-top: 0;">What's Next?</h4>
                    <ul style="margin: 0; padding-left: 20px;">
                        <li>Our team will verify your payment details</li>
                        <li>You'll receive another email once your order is confirmed</li>
                        <li>Production will begin within 2-3 business days</li>
                        <li>Expected delivery: 7-10 business days</li>
                    </ul>
                </div>
                
                <p style="text-align: center; margin-top: 30px;">
                    <small style="color: #666;">
                        If you have any questions, please contact us:
                        <br/> Name: <strong>Aldrik</strong>, Phone: <strong>01850685667</strong>
                        <br/> Name: <strong>Munna</strong>, Phone: <strong>01637964859</strong>

                    </small>
                    
                </p>
            </div>
            
            <div style="background: #333; color: white; text-align: center; padding: 15px;">
                <p style="margin: 0;">&copy; 2025 Depertment of Information & Communication Engineering. All rights reserved.</p>
            </div>
        </div>
    `;
      const textContent = `
        ICE Jersey Order Confirmation
        
        Hello ${order.name}!
        
        Thank you for ordering your ICE Department jersey. Your order has been received successfully.
        
        Order Details:
        - Name: ${order.name}
        - Student ID: ${order.student_id}
        - Jersey Number: ${order.jersey_number}
        ${order.batch ? `- Batch: ${order.batch}` : ''}
        - Size: ${order.size}
        - Collar Type: ${order.collar_type}
        - Sleeve Type: ${order.sleeve_type}
        ${order.transaction_id ? `- Transaction ID: ${order.transaction_id}` : ''}
        - Total Price: ৳${order.final_price}
        ${order.notes ? `- Special Instructions: ${order.notes}` : ''}
        
        What's Next?
        - Our team will verify your payment details
        - You'll receive another email once your order is confirmed
        - Production will begin within 2-3 business days
        - Expected delivery: 7-10 business days
        
        If you have any questions, please contact us:
        - Name: Aldrik 
        - Phone: 01850685667
        - Name: Munna
        - Phone: 01637964859
        
        © 2025 Depertment of Information & Communication Engineering. All rights reserved.
    `;

      await sendEmail(
        email,
        'ICE Jersey Order Confirmation - Order Received',
        confirmationHtml,
        textContent
      );

      // Send admin notification
      if (process.env.ADMIN_EMAIL) {
        const adminHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #dc3545; padding: 20px; text-align: center;">
                <h1 style="color: white; margin: 0;">New Jersey Order</h1>
                <p style="color: white; margin: 5px 0;">ICE Department</p>
            </div>
            
            <div style="padding: 20px; background: #f8f9fa;">
                <h2 style="color: #dc3545;">Order Alert!</h2>
                <p>A new jersey order has been placed. Please review and process:</p>
                
                <div style="background: white; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <h3 style="color: #dc3545; margin-top: 0;">Customer Information:</h3>
                    <table style="width: 100%; border-collapse: collapse;">
                        <tr><td><strong>Student Name:</strong></td><td>${order.name}</td></tr>
                        <tr><td><strong>Student ID:</strong></td><td>${order.student_id}</td></tr>
                        <tr><td><strong>Email:</strong></td><td>${order.email}</td></tr>
                        ${order.batch ? `<tr><td><strong>Batch:</strong></td><td>${order.batch}</td></tr>` : ''}
                    </table>
                </div>
                
                <div style="background: white; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <h3 style="color: #dc3545; margin-top: 0;">Jersey Details:</h3>
                    <table style="width: 100%; border-collapse: collapse;">
                        <tr><td><strong>Jersey Number:</strong></td><td>${order.jersey_number}</td></tr>
                        <tr><td><strong>Size:</strong></td><td>${order.size}</td></tr>
                        <tr><td><strong>Collar Type:</strong></td><td>${order.collar_type}</td></tr>
                        <tr><td><strong>Sleeve Type:</strong></td><td>${order.sleeve_type}</td></tr>
                        <tr><td><strong>Price:</strong></td><td><strong>৳${order.final_price}</strong></td></tr>
                    </table>
                </div>
                
                <div style="background: white; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <h3 style="color: #dc3545; margin-top: 0;">Payment Information:</h3>
                    ${order.transaction_id ? `<p><strong>Transaction ID:</strong> ${order.transaction_id}</p>` : '<p><em>No transaction ID provided</em></p>'}
                    ${order.notes ? `<p><strong>Special Instructions:</strong> ${order.notes}</p>` : ''}
                </div>
            </div>
            
            <div style="background: #333; color: white; text-align: center; padding: 15px;">
                <p style="margin: 0;">ICE Jersey Management System</p>
            </div>
        </div>
        `;

        const textContentAdmin = `
        NEW JERSEY ORDER ALERT!
        
        Customer Information:
        - Student Name: ${order.name}
        - Student ID: ${order.student_id}
        - Email: ${order.email}
        ${order.batch ? `- Batch: ${order.batch}` : ''}
        
        Jersey Details:
        - Jersey Number: #${order.jersey_number}
        - Size: ${order.size}
        - Collar Type: ${order.collar_type}
        - Sleeve Type: ${order.sleeve_type}
        - Price: ৳${order.final_price}
        
        Payment Information:
        ${order.transaction_id ? `- Transaction ID: ${order.transaction_id}` : '- No transaction ID provided'}
        ${order.notes ? `- Special Instructions: ${order.notes}` : ''}
    `;

        await sendEmail(
          process.env.ADMIN_EMAIL,
          `New Jersey Order - ${order.name} (#${order.jersey_number})`,
          adminHtml,
          textContentAdmin
        );
      }

      res.status(201).json({
        success: true,
        message: 'Order placed successfully',
        orderId: `ICE-${order.id.toString().padStart(3, '0')}`,
        status: 'pending'
      });

    } finally {
      await client.end();
    }
  } catch (error) {
    console.error('Order submission error:', error);
    res.status(500).json({ error: 'Order submission failed' });
  }
});

// Get all orders (admin only)
app.get('/api/admin/orders', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 50, status, search } = req.query;
    const offset = (page - 1) * limit;

    let query = 'SELECT * FROM orders';
    let countQuery = 'SELECT COUNT(*) FROM orders';
    let params = [];
    let conditions = [];

    if (status && status !== 'all') {
      conditions.push(`status = $${params.length + 1}`);
      params.push(status);
    }

    if (search) {
      conditions.push(`(name ILIKE $${params.length + 1} OR student_id ILIKE $${params.length + 1} OR email ILIKE $${params.length + 1} OR batch ILIKE $${params.length + 1})`);
      params.push(`%${search}%`);
    }

    if (conditions.length > 0) {
      const whereClause = ' WHERE ' + conditions.join(' AND ');
      query += whereClause;
      countQuery += whereClause;
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const client = await connectDB();
    try {
      const [ordersResult, countResult] = await Promise.all([
        client.query(query, params),
        client.query(countQuery, params.slice(0, -2))
      ]);

      const totalCount = parseInt(countResult.rows[0].count);
      const totalPages = Math.ceil(totalCount / limit);

      res.json({
        success: true,
        orders: ordersResult.rows,
        pagination: {
          page: parseInt(page),
          totalPages,
          total: totalCount
        }
      });
    } finally {
      await client.end();
    }
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Get order stats (admin only)
app.get('/api/admin/stats', authenticateToken, async (req, res) => {
  try {
    const client = await connectDB();
    try {
      const [totalResult, pendingResult, doneResult, revenueResult] = await Promise.all([
        client.query('SELECT COUNT(*) FROM orders'),
        client.query('SELECT COUNT(*) FROM orders WHERE status = $1', ['pending']),
        client.query('SELECT COUNT(*) FROM orders WHERE status = $1', ['done']),
        client.query('SELECT SUM(final_price) FROM orders WHERE status = $1', ['done'])
      ]);

      res.json({
        success: true,
        stats: {
          totalOrders: parseInt(totalResult.rows[0].count),
          ordersByStatus: {
            pending: parseInt(pendingResult.rows[0].count),
            done: parseInt(doneResult.rows[0].count)
          },
          totalRevenue: parseFloat(revenueResult.rows[0].sum || 0)
        }
      });
    } finally {
      await client.end();
    }
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Get single order (admin only)
app.get('/api/admin/orders/:id', authenticateToken, async (req, res) => {
  try {
    const client = await connectDB();
    try {
      const result = await client.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Order not found' });
      }

      res.json({
        success: true,
        order: result.rows[0]
      });
    } finally {
      await client.end();
    }
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// Update order status (admin only)
app.patch('/api/admin/orders/:id/status', authenticateToken, async (req, res) => {
  try {
    const { status, note } = req.body;

    if (!['pending', 'done'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Only pending/done allowed.' });
    }

    const client = await connectDB();
    try {
      // Get current order
      const orderResult = await client.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);

      if (orderResult.rows.length === 0) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const order = orderResult.rows[0];

      // Update status
      await client.query(
        'UPDATE orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [status, req.params.id]
      );

      // Send email notification when status changes to 'done'
      if (status === 'done' && order.status !== 'done') {
        const confirmationHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 20px; text-align: center;">
              <h1 style="color: white; margin: 0;">Payment Confirmed!</h1>
            </div>
            <div style="padding: 20px;">
              <h2>Hello ${order.name}!</h2>
              <p>Great news! Your payment has been confirmed and your jersey order is now complete.</p>
              <div style="background: #d1fae5; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #10b981;">
                <h3 style="color: #065f46; margin-top: 0;">Order Confirmed:</h3>
                <p style="color: #065f46;"><strong>Order ID:</strong> ICE-${order.id.toString().padStart(3, '0')}</p>
                <p style="color: #065f46;"><strong>Jersey Number:</strong> #${order.jersey_number}</p>
                <p style="color: #065f46;"><strong>Status:</strong> Confirmed & Processing</p>
              </div>
              <p><strong>What's next:</strong></p>
              <ul>
                <li>Your jersey will be manufactured</li>
                <li>Expected delivery: 7-10 business days</li>
                <li>You'll be contacted for pickup/delivery details</li>
              </ul>
              <p>Thank you for your order!</p>
            </div>
          </div>
        `;

        await sendEmail(
          order.email,
          'Payment Confirmed - ICE Jersey Order',
          confirmationHtml,
          `Your payment has been confirmed for Jersey #${order.jersey_number}. Order ID: ICE-${order.id.toString().padStart(3, '0')}`
        );
      }

      res.json({
        success: true,
        message: 'Order status updated successfully',
        newStatus: status
      });

    } finally {
      await client.end();
    }
  } catch (error) {
    console.error('Update status error:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// Delete order (admin only)
app.delete('/api/admin/orders/:id', authenticateToken, async (req, res) => {
  try {
    const client = await connectDB();
    try {
      const result = await client.query('DELETE FROM orders WHERE id = $1 RETURNING *', [req.params.id]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Order not found' });
      }

      res.json({
        success: true,
        message: 'Order deleted successfully'
      });
    } finally {
      await client.end();
    }
  } catch (error) {
    console.error('Delete order error:', error);
    res.status(500).json({ error: 'Failed to delete order' });
  }
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((error, req, res, next) => {
  console.error('Global error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const startServer = async () => {
  try {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is required');
    }

    await initDB();

    app.listen(PORT, () => {
      console.log(`\n🚀 Jersey Order Server Started Successfully!`);
      console.log(`📍 Server: http://localhost:${PORT}`);
      console.log(`🔒 Security: Helmet + Rate Limiting enabled`);
      console.log(`📧 Email: ${process.env.BREVO_API_KEY ? 'Configured' : 'Not configured'}`);
      console.log(`👤 Default Admin: admin/admin123\n`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Server shutting down gracefully...');
  process.exit(0);
});

startServer();