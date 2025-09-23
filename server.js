const express = require('express');
const { Client } = require('pg');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const fetch = require('node-fetch');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// PostgreSQL configuration (Neon database)
const pgConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000
};

// Brevo Email Configuration
const brevoConfig = {
    apiKey: process.env.BREVO_API_KEY,
    fromEmail: process.env.BREVO_FROM_EMAIL || 'sheikhnoorabdullah02@gmail.com',
    fromName: process.env.BREVO_FROM_NAME || 'ICE Jersey Team'
};

// Database connection function
async function connectDatabase() {
    try {
        console.log('Attempting PostgreSQL connection...');
        console.log('Database URL:', process.env.DATABASE_URL ? 'Configured' : 'Missing');
        
        if (!process.env.DATABASE_URL) {
            throw new Error('DATABASE_URL environment variable is required');
        }

        const client = new Client(pgConfig);
        await client.connect();
        
        // Test the connection
        await client.query('SELECT NOW()');
        console.log('Connected to PostgreSQL database successfully');
        return client;
    } catch (error) {
        console.error('PostgreSQL connection error:', error.message);
        if (error.code === 'ENOTFOUND') {
            console.error('DNS resolution failed - check your internet connection');
        } else if (error.code === 'ECONNREFUSED') {
            console.error('Connection refused - check if the database server is accessible');
        } else if (error.code === '28P01') {
            console.error('Authentication failed - check your database credentials');
        }
        throw error;
    }
}

// Initialize database tables
async function initializeDatabase() {
    const client = await connectDatabase();
    
    try {
        console.log('Initializing PostgreSQL database...');
        
        // Create orders table
        const createOrdersTable = `
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                name VARCHAR(30) NOT NULL,
                student_id VARCHAR(50) NOT NULL,
                jersey_number INTEGER NOT NULL UNIQUE,
                batch VARCHAR(15) NULL,
                size VARCHAR(10) NOT NULL,
                collar_type VARCHAR(20) NOT NULL,
                sleeve_type VARCHAR(20) NOT NULL,
                email VARCHAR(40) NOT NULL,
                transaction_id VARCHAR(100) NULL,
                notes TEXT NULL,
                final_price DECIMAL(10, 2) NOT NULL,
                order_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                department VARCHAR(10) DEFAULT 'ICE',
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `;
        
        await client.query(createOrdersTable);
        console.log('PostgreSQL orders table created/verified');
        
        // Create indexes
        const indexes = [
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_jersey_unique ON orders(jersey_number)',
            'CREATE INDEX IF NOT EXISTS idx_name ON orders(name)',
            'CREATE INDEX IF NOT EXISTS idx_email ON orders(email)',
            'CREATE INDEX IF NOT EXISTS idx_status ON orders(status)',
            'CREATE INDEX IF NOT EXISTS idx_created_at ON orders(created_at)'
        ];
        
        for (const indexQuery of indexes) {
            await client.query(indexQuery);
        }
        
        console.log('PostgreSQL indexes created/verified');
        console.log('Database initialization completed successfully');
        
    } finally {
        await client.end();
    }
}

// Database query execution - FIXED VERSION
async function executeQuery(query, params = []) {
    const client = await connectDatabase();
    try {
        console.log('Executing query:', query);
        console.log('With params:', params);
        
        const result = await client.query(query, params);
        return result.rows;
    } catch (error) {
        console.error('PostgreSQL Query Error:', error.message);
        console.error('Query:', query);
        console.error('Params:', params);
        throw error;
    } finally {
        await client.end();
    }
}

// Email functions
async function sendEmailViaBrevo(emailData) {
    if (!brevoConfig.apiKey) {
        console.warn('Brevo API key not configured, skipping email');
        return { success: false, message: 'Email service not configured' };
    }

    const { to, subject, htmlContent, textContent } = emailData;

    const payload = {
        sender: {
            name: brevoConfig.fromName,
            email: brevoConfig.fromEmail
        },
        to: [{ email: to, name: to.split('@')[0] }],
        subject: subject,
        htmlContent: htmlContent,
        textContent: textContent
    };

    try {
        const response = await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'api-key': brevoConfig.apiKey
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Brevo API Error: ${errorData.message || response.statusText}`);
        }

        const result = await response.json();
        console.log('Email sent successfully via Brevo:', result.messageId);
        return { success: true, messageId: result.messageId };
    } catch (error) {
        console.error('Error sending email via Brevo:', error);
        return { success: false, error: error.message };
    }
}

async function sendConfirmationEmail(orderData) {
    const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center;">
                <h1 style="color: white; margin: 0;">Order Confirmation</h1>
                <p style="color: white; margin: 5px 0;">Institute of Computer Engineering</p>
            </div>
            
            <div style="padding: 20px; background: #f8f9fa;">
                <h2 style="color: #333;">Hello ${orderData.name}!</h2>
                <p>Thank you for ordering your ICE Department jersey. Your order has been received successfully.</p>
                
                <div style="background: white; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <h3 style="color: #667eea; margin-top: 0;">Order Details:</h3>
                    <table style="width: 100%; border-collapse: collapse;">
                        <tr><td><strong>Name:</strong></td><td>${orderData.name}</td></tr>
                        <tr><td><strong>Student ID:</strong></td><td>${orderData.studentId}</td></tr>
                        <tr><td><strong>Jersey Number:</strong></td><td>${orderData.jerseyNumber}</td></tr>
                        ${orderData.batch ? `<tr><td><strong>Batch:</strong></td><td>${orderData.batch}</td></tr>` : ''}
                        <tr><td><strong>Size:</strong></td><td>${orderData.size}</td></tr>
                        <tr><td><strong>Collar Type:</strong></td><td>${orderData.collarType}</td></tr>
                        <tr><td><strong>Sleeve Type:</strong></td><td>${orderData.sleeveType}</td></tr>
                        ${orderData.transactionId ? `<tr><td><strong>Transaction ID:</strong></td><td>${orderData.transactionId}</td></tr>` : ''}
                        <tr><td><strong>Total Price:</strong></td><td>৳${orderData.finalPrice}</td></tr>
                    </table>
                    ${orderData.notes ? `<p><strong>Special Instructions:</strong> ${orderData.notes}</p>` : ''}
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
                        If you have any questions, please contact us at ice.department@university.edu
                    </small>
                </p>
            </div>
            
            <div style="background: #333; color: white; text-align: center; padding: 15px;">
                <p style="margin: 0;">&copy; 2025 Institute of Computer Engineering. All rights reserved.</p>
            </div>
        </div>
    `;

    const textContent = `
        ICE Jersey Order Confirmation
        
        Hello ${orderData.name}!
        
        Thank you for ordering your ICE Department jersey. Your order has been received successfully.
        
        Order Details:
        - Name: ${orderData.name}
        - Student ID: ${orderData.studentId}
        - Jersey Number: ${orderData.jerseyNumber}
        ${orderData.batch ? `- Batch: ${orderData.batch}` : ''}
        - Size: ${orderData.size}
        - Collar Type: ${orderData.collarType}
        - Sleeve Type: ${orderData.sleeveType}
        ${orderData.transactionId ? `- Transaction ID: ${orderData.transactionId}` : ''}
        - Total Price: ৳${orderData.finalPrice}
        ${orderData.notes ? `- Special Instructions: ${orderData.notes}` : ''}
        
        What's Next?
        - Our team will verify your payment details
        - You'll receive another email once your order is confirmed
        - Production will begin within 2-3 business days
        - Expected delivery: 7-10 business days
        
        If you have any questions, please contact us at ice.department@university.edu
        
        © 2025 Institute of Computer Engineering. All rights reserved.
    `;

    try {
        const result = await sendEmailViaBrevo({
            to: orderData.email,
            subject: 'ICE Jersey Order Confirmation - Order Received',
            htmlContent: htmlContent,
            textContent: textContent
        });
        
        if (result.success) {
            console.log('Confirmation email sent successfully to:', orderData.email);
        } else {
            console.warn('Failed to send confirmation email:', result.error);
        }
        
        return result;
    } catch (error) {
        console.error('Error sending confirmation email:', error);
        return { success: false, error: error.message };
    }
}

async function sendAdminNotification(orderData) {
    const adminEmail = process.env.ADMIN_EMAIL || 'sheikhnoorabdullah02@gmail.com';
    
    const htmlContent = `
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
                        <tr><td><strong>Student Name:</strong></td><td>${orderData.name}</td></tr>
                        <tr><td><strong>Student ID:</strong></td><td>${orderData.studentId}</td></tr>
                        <tr><td><strong>Email:</strong></td><td>${orderData.email}</td></tr>
                        ${orderData.batch ? `<tr><td><strong>Batch:</strong></td><td>${orderData.batch}</td></tr>` : ''}
                    </table>
                </div>
                
                <div style="background: white; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <h3 style="color: #dc3545; margin-top: 0;">Jersey Details:</h3>
                    <table style="width: 100%; border-collapse: collapse;">
                        <tr><td><strong>Jersey Number:</strong></td><td>#${orderData.jerseyNumber}</td></tr>
                        <tr><td><strong>Size:</strong></td><td>${orderData.size}</td></tr>
                        <tr><td><strong>Collar Type:</strong></td><td>${orderData.collarType}</td></tr>
                        <tr><td><strong>Sleeve Type:</strong></td><td>${orderData.sleeveType}</td></tr>
                        <tr><td><strong>Price:</strong></td><td><strong>৳${orderData.finalPrice}</strong></td></tr>
                    </table>
                </div>
                
                <div style="background: white; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <h3 style="color: #dc3545; margin-top: 0;">Payment Information:</h3>
                    ${orderData.transactionId ? `<p><strong>Transaction ID:</strong> ${orderData.transactionId}</p>` : '<p><em>No transaction ID provided</em></p>'}
                    ${orderData.notes ? `<p><strong>Special Instructions:</strong> ${orderData.notes}</p>` : ''}
                </div>
            </div>
            
            <div style="background: #333; color: white; text-align: center; padding: 15px;">
                <p style="margin: 0;">ICE Jersey Management System</p>
            </div>
        </div>
    `;

    const textContent = `
        NEW JERSEY ORDER ALERT!
        
        Customer Information:
        - Student Name: ${orderData.name}
        - Student ID: ${orderData.studentId}
        - Email: ${orderData.email}
        ${orderData.batch ? `- Batch: ${orderData.batch}` : ''}
        
        Jersey Details:
        - Jersey Number: #${orderData.jerseyNumber}
        - Size: ${orderData.size}
        - Collar Type: ${orderData.collarType}
        - Sleeve Type: ${orderData.sleeveType}
        - Price: ৳${orderData.finalPrice}
        
        Payment Information:
        ${orderData.transactionId ? `- Transaction ID: ${orderData.transactionId}` : '- No transaction ID provided'}
        ${orderData.notes ? `- Special Instructions: ${orderData.notes}` : ''}
    `;

    try {
        const result = await sendEmailViaBrevo({
            to: adminEmail,
            subject: `New Jersey Order - ${orderData.name} (#${orderData.jerseyNumber})`,
            htmlContent: htmlContent,
            textContent: textContent
        });
        
        if (result.success) {
            console.log('Admin notification sent successfully');
        } else {
            console.warn('Failed to send admin notification:', result.error);
        }
        
        return result;
    } catch (error) {
        console.error('Error sending admin notification:', error);
        return { success: false, error: error.message };
    }
}

// Utility function to format dates for SQL
function formatDateForSQL(date = new Date()) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

// API Routes

// Health check
app.get('/api/health', async (req, res) => {
    const healthCheck = {
        status: 'OK', 
        timestamp: new Date().toISOString(),
        database: 'PostgreSQL (Neon)',
        emailService: brevoConfig.apiKey ? 'Brevo configured' : 'Not configured',
        nodeVersion: process.version,
        memory: process.memoryUsage(),
        uptime: process.uptime()
    };

    // Test database connection
    try {
        const client = await connectDatabase();
        await client.query('SELECT NOW()');
        await client.end();
        healthCheck.databaseConnection = 'PostgreSQL Connected';
    } catch (error) {
        healthCheck.status = 'WARNING';
        healthCheck.databaseConnection = `Database Error: ${error.message}`;
    }

    res.json(healthCheck);
});

// Check name existence - FIXED
app.get('/api/orders/check-name', async (req, res) => {
    try {
        const { name } = req.query;
        
        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }

        const query = 'SELECT id FROM orders WHERE LOWER(name) = LOWER($1)';
        const results = await executeQuery(query, [name.trim()]);
        
        res.json({ 
            exists: results.length > 0,
            conflictingOrders: results.length,
            message: results.length > 0 ? 
                `Name "${name}" already exists in the database` : 
                `Name "${name}" is available`
        });
    } catch (error) {
        console.error('Error checking name existence:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

// Check jersey number availability - FIXED
app.get('/api/orders/check-jersey', async (req, res) => {
    try {
        const { number, batch } = req.query;
        
        if (!number) {
            return res.status(400).json({ error: 'Jersey number is required' });
        }

        // Jersey numbers must be globally unique regardless of batch
        const query = 'SELECT id, name, batch FROM orders WHERE jersey_number = $1';
        const results = await executeQuery(query, [parseInt(number)]);
        
        res.json({ 
            available: results.length === 0,
            conflictingOrders: results.length,
            conflictDetails: results.length > 0 ? results[0] : null,
            message: results.length > 0 ? 
                `Jersey number ${number} is already taken` : 
                `Jersey number ${number} is available`
        });
    } catch (error) {
        console.error('Error checking jersey availability:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

// Submit new order - FIXED
app.post('/api/orders', async (req, res) => {
    try {
        const {
            name, studentId, jerseyNumber, batch, size,
            collarType, sleeveType, email, transactionId,
            notes, finalPrice, orderDate, department
        } = req.body;

        // Validate required fields
        const requiredFields = ['name', 'studentId', 'jerseyNumber', 'size', 'collarType', 'sleeveType', 'email', 'finalPrice'];
        const missingFields = requiredFields.filter(field => !req.body[field] || req.body[field].toString().trim() === '');
        
        if (missingFields.length > 0) {
            return res.status(400).json({ 
                error: 'Missing required fields', 
                missingFields 
            });
        }

        // Validate jersey number
        const jerseyNum = parseInt(jerseyNumber);
        if (isNaN(jerseyNum) || jerseyNum < 1 || jerseyNum > 99) {
            return res.status(400).json({ 
                error: 'Jersey number must be between 1 and 99' 
            });
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email.trim())) {
            return res.status(400).json({ 
                error: 'Please provide a valid email address' 
            });
        }

        // Check if jersey number is already taken (globally unique)
        const checkQuery = 'SELECT id, name FROM orders WHERE jersey_number = $1';
        const existing = await executeQuery(checkQuery, [jerseyNumber]);
        
        if (existing.length > 0) {
            return res.status(409).json({ 
                error: `Jersey number ${jerseyNumber} is already taken by ${existing[0].name}` 
            });
        }

        // Prepare data for insertion
        const cleanBatch = batch && batch.trim() ? batch.trim() : null;
        const cleanTransactionId = transactionId && transactionId.trim() ? transactionId.trim() : null;
        const cleanNotes = notes && notes.trim() ? notes.trim() : null;

        // Insert new order - FIXED POSTGRESQL SYNTAX
        const insertQuery = `
            INSERT INTO orders (
                name, student_id, jersey_number, batch, size, 
                collar_type, sleeve_type, email, transaction_id, 
                notes, final_price, order_date, department
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING id
        `;

        const insertParams = [
            name.trim(), studentId.trim(), jerseyNumber, cleanBatch, size,
            collarType, sleeveType, email.trim(), cleanTransactionId,
            cleanNotes, finalPrice, 
            formatDateForSQL(orderDate ? new Date(orderDate) : new Date()), 
            department || 'ICE'
        ];

        const result = await executeQuery(insertQuery, insertParams);
        
        // Generate order ID
        const orderId = result[0]?.id || Date.now().toString().slice(-6);
        const orderIdFormatted = `ICE-${orderId.toString().padStart(6, '0')}`;

        // Send confirmation emails (async)
        Promise.allSettled([
            sendConfirmationEmail(req.body),
            sendAdminNotification(req.body)
        ]).then((results) => {
            results.forEach((result, index) => {
                if (result.status === 'rejected') {
                    console.warn(`Email ${index === 0 ? 'confirmation' : 'admin notification'} failed:`, result.reason);
                }
            });
        });

        res.status(201).json({
            success: true,
            message: 'Order placed successfully',
            orderId: orderIdFormatted,
            details: {
                name: name.trim(),
                jerseyNumber: jerseyNumber,
                batch: cleanBatch,
                email: email.trim(),
                finalPrice: finalPrice
            }
        });

    } catch (error) {
        console.error('Error creating order:', error);
        
        if (error.code === '23505') {
            // Unique constraint violation
            res.status(409).json({ 
                error: 'Jersey number is already taken' 
            });
        } else {
            res.status(500).json({ 
                error: 'Internal server error',
                message: error.message 
            });
        }
    }
});

// Get all orders - FIXED



// app.get('/api/orders', async (req, res) => {
//     try {
//         const query = 'SELECT * FROM orders ORDER BY created_at DESC';
//         const orders = await executeQuery(query);
//         res.json({
//             success: true,
//             count: orders.length,
//             orders: orders
//         });
//     } catch (error) {
//         console.error('Error fetching orders:', error);
//         res.status(500).json({ error: 'Internal server error', details: error.message });
//     }
// });




// Get order by ID - FIXED
// app.get('/api/orders/:id', async (req, res) => {
//     try {
//         const query = 'SELECT * FROM orders WHERE id = $1';
//         const orders = await executeQuery(query, [req.params.id]);
        
//         if (orders.length === 0) {
//             return res.status(404).json({ error: 'Order not found' });
//         }
        
//         res.json({
//             success: true,
//             order: orders[0]
//         });
//     } catch (error) {
//         console.error('Error fetching order:', error);
//         res.status(500).json({ error: 'Internal server error', details: error.message });
//     }
// });



// Update order status - FIXED



// app.patch('/api/orders/:id/status', async (req, res) => {
//     try {
//         const { status } = req.body;
//         const validStatuses = ['pending', 'confirmed', 'in_production', 'ready', 'delivered', 'cancelled'];
        
//         if (!validStatuses.includes(status)) {
//             return res.status(400).json({ 
//                 error: 'Invalid status',
//                 validStatuses: validStatuses
//             });
//         }

//         const updateQuery = 'UPDATE orders SET status = $1, updated_at = $2 WHERE id = $3';
//         const updateParams = [status, formatDateForSQL(), req.params.id];
        
//         await executeQuery(updateQuery, updateParams);
        
//         res.json({ 
//             success: true, 
//             message: 'Order status updated successfully',
//             newStatus: status
//         });
//     } catch (error) {
//         console.error('Error updating order status:', error);
//         res.status(500).json({ error: 'Internal server error', details: error.message });
//     }
// });

// // Delete order - FIXED
// app.delete('/api/orders/:id', async (req, res) => {
//     try {
//         const deleteQuery = 'DELETE FROM orders WHERE id = $1';
//         await executeQuery(deleteQuery, [req.params.id]);
        
//         res.json({ 
//             success: true, 
//             message: 'Order deleted successfully'
//         });
//     } catch (error) {
//         console.error('Error deleting order:', error);
//         res.status(500).json({ error: 'Internal server error', details: error.message });
//     }
// });

// // Get orders by batch - FIXED
// app.get('/api/orders/batch/:batch', async (req, res) => {
//     try {
//         const query = 'SELECT * FROM orders WHERE batch = $1 ORDER BY created_at DESC';
//         const orders = await executeQuery(query, [req.params.batch]);
        
//         res.json({
//             success: true,
//             batch: req.params.batch,
//             count: orders.length,
//             orders: orders
//         });
//     } catch (error) {
//         console.error('Error fetching orders by batch:', error);
//         res.status(500).json({ error: 'Internal server error', details: error.message });
//     }
// });

// // Get orders by status - FIXED
// app.get('/api/orders/status/:status', async (req, res) => {
//     try {
//         const query = 'SELECT * FROM orders WHERE status = $1 ORDER BY created_at DESC';
//         const orders = await executeQuery(query, [req.params.status]);
        
//         res.json({
//             success: true,
//             status: req.params.status,
//             count: orders.length,
//             orders: orders
//         });
//     } catch (error) {
//         console.error('Error fetching orders by status:', error);
//         res.status(500).json({ error: 'Internal server error', details: error.message });
//     }
// });

// Serve frontend files
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ 
        error: 'Internal server error',
        message: error.message
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Route not found',
        availableRoutes: [
            // 'GET /api/health',
            // 'GET /api/orders/check-name',
            // 'GET /api/orders/check-jersey',
            // 'POST /api/orders',
            // 'GET /api/orders',
            // 'GET /api/orders/:id',
            // 'GET /api/orders/batch/:batch',
            // 'GET /api/orders/status/:status',
            // 'PATCH /api/orders/:id/status',
            // 'DELETE /api/orders/:id'
        ]
    });
});

// Start server
async function startServer() {
    try {
        console.log('Starting Jersey Order System...');
        
        // Validate DATABASE_URL
        if (!process.env.DATABASE_URL) {
            console.error('DATABASE_URL environment variable is required');
            console.error('Please set DATABASE_URL in your .env file');
            process.exit(1);
        }
        
        console.log('Initializing database...');
        await initializeDatabase();
        
        app.listen(PORT, () => {
            console.log('');
            console.log('Jersey Order System Started Successfully!');
            console.log('================================');
            console.log(`Database: PostgreSQL (Neon)`);
            console.log(`Email Service: ${brevoConfig.apiKey ? 'Brevo configured' : 'Not configured'}`);
            console.log(`Server URL: http://localhost:${PORT}`);
            console.log(`API Base URL: http://localhost:${PORT}/api`);
            console.log('================================');
            console.log('');
            console.log('Available API Endpoints:');
            console.log('  GET    /api/health - Server health check');
            console.log('  GET    /api/orders/check-name - Check name existence');
            console.log('  GET    /api/orders/check-jersey - Check jersey availability');
            console.log('  POST   /api/orders - Submit new order');
            console.log('  GET    /api/orders - Get all orders');
            console.log('  GET    /api/orders/:id - Get order by ID');
            console.log('  GET    /api/orders/batch/:batch - Get orders by batch');
            console.log('  GET    /api/orders/status/:status - Get orders by status');
            console.log('  PATCH  /api/orders/:id/status - Update order status');
            console.log('  DELETE /api/orders/:id - Delete order');
            console.log('');
            
            if (!brevoConfig.apiKey) {
                console.log('WARNING: Brevo API key not configured. Email notifications will not work.');
                console.log('Set BREVO_API_KEY environment variable to enable email features.');
                console.log('');
            }
        });
    } catch (error) {
        console.error('Failed to start server:', error.message);
        console.error('\nTroubleshooting:');
        console.error('- Verify DATABASE_URL is correct');
        console.error('- Check internet connectivity');
        console.error('- Ensure Neon database is accessible');
        console.error('- Check SSL configuration');
        console.error('');
        
        process.exit(1);
    }
}

// Graceful shutdown
function gracefulShutdown(signal) {
    console.log(`\nReceived ${signal}. Shutting down gracefully...`);
    console.log('Closing database connections...');
    console.log('Server stopped');
    console.log('Jersey Order System shutdown complete.');
    
    process.exit(0);
}

// Process signal handlers
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Enhanced error handlers
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    console.error('Stack:', error.stack);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise);
    console.error('Reason:', reason);
    process.exit(1);
});


// Start the server
startServer();