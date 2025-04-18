#!/usr/bin/env node

/**
 * Brainstorm Control Panel
 * 
 * This script starts the Brainstorm Control Panel web interface
 * and API server for managing NIP-85 data generation and publication.
 */

const express = require('express');
const https = require('https');
const http = require('http');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const { useWebSocketImplementation } = require('nostr-tools/pool');
const { authMiddleware } = require('../src/middleware/auth');
require('websocket-polyfill');
useWebSocketImplementation(WebSocket);

// Import API modules
const api = require('../src/api');

// Import centralized configuration utility
const { getConfigFromFile } = require('../src/utils/config');

// Determine if we should use HTTPS (local development) or HTTP (behind proxy)
let useHTTPS = process.env.USE_HTTPS === 'true';

try {
    console.log('QWERTY A');
    console.log('Using HTTPS: ', useHTTPS);
    console.log('QWERTY B');
  } catch (e) {
    console.error('QWERTY Top-level error:', e);
  }

// Only load certificates if using HTTPS
let credentials = null;
if (useHTTPS) {
  try {
    const privateKey = fs.readFileSync(path.join(process.env.HOME, '.ssl', 'localhost.key'), 'utf8');
    const certificate = fs.readFileSync(path.join(process.env.HOME, '.ssl', 'localhost.crt'), 'utf8');
    credentials = { key: privateKey, cert: certificate };
    console.log('HTTPS credentials loaded successfully');
  } catch (error) {
    console.warn(`Warning: Could not load SSL certificates: ${error.message}`);
    console.warn('Falling back to HTTP mode');
    useHTTPS = false;
  }
}

// Import configuration
let config;
try {
  const configModule = require('../lib/config');
  config = configModule.getAll();
} catch (error) {
  console.warn('Could not load configuration:', error.message);
  config = {};
}

// Function to get Neo4j connection details
function getNeo4jConnection() {
  // Try to get from config module first
  if (config && config.neo4j) {
    return config.neo4j;
  }
  
  // Fall back to direct file access
  return {
    uri: getConfigFromFile('NEO4J_URI', 'bolt://localhost:7687'),
    user: getConfigFromFile('NEO4J_USER', 'neo4j'),
    password: getConfigFromFile('NEO4J_PASSWORD')
  };
}

// Create Express app
const app = express();
const port = process.env.CONTROL_PANEL_PORT || 7778;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from the public directory with proper MIME types
app.use(express.static(path.join(__dirname, '../public'), {
    setHeaders: (res, path, stat) => {
        if (path.endsWith('.css')) {
            console.log('QWERTY C', 'Setting CSS MIME type for:', path);
            res.set('Content-Type', 'text/css');
        } else if (path.endsWith('.js')) {
            console.log('QWERTY D', 'Setting JS MIME type for:', path);
            res.set('Content-Type', 'text/javascript');
        }
    }
}));

// Session middleware
app.use(session({
    secret: getConfigFromFile('SESSION_SECRET', 'brainstorm-default-session-secret-please-change-in-production'),
    resave: false,
    saveUninitialized: true,
    cookie: { secure: useHTTPS } // Set to true if using HTTPS
}));

// Helper function to serve HTML files
function serveHtmlFile(filename, res) {
    console.log('QWERTY E', `[SERVER] Attempting to serve file: ${filename}`);
    
    try {
        // Build all possible file paths to check
        const pagesPath = path.join(__dirname, '../public/pages', filename);
        const originalPath = path.join(__dirname, '../public', filename);
        
        console.log('QWERTY F', `[SERVER] Checking paths:
            Pages path: ${pagesPath}
            Original path: ${originalPath}`);
        
        // Check if files exist
        const pagesExists = fs.existsSync(pagesPath);
        const originalExists = fs.existsSync(originalPath);
        
        console.log('QWERTY G', `[SERVER] File existence:
            In pages directory: ${pagesExists}
            In original directory: ${originalExists}`);
        
        // Determine which file to serve
        if (pagesExists) {
            console.log('QWERTY H', `[SERVER] Serving from pages directory: ${pagesPath}`);
            res.sendFile(pagesPath);
        } else if (originalExists) {
            console.log('QWERTY I', `[SERVER] Serving from original directory: ${originalPath}`);
            res.sendFile(originalPath);
        } else {
            console.log('QWERTY J', `[SERVER] File not found in either location: ${filename}`);
            res.status(404).send(`File not found: ${filename}<br>
                Checked pages path: ${pagesPath}<br>
                Checked original path: ${originalPath}`);
        }
    } catch (error) {
        console.error(`[SERVER] Error serving HTML file: ${error.message}`);
        res.status(500).send(`Internal server error: ${error.message}`);
    }
}

// Serve the HTML files - consolidated approach
// Root path serves index.html
app.get('/', (req, res) => {
    serveHtmlFile('index.html', res);
});

// Generic handler for all HTML files
app.get('/:filename.html', (req, res) => {
    const filename = req.params.filename + '.html';
    console.log('QWERTY K', `[SERVER] Route hit: /${filename}`);
    serveHtmlFile(filename, res);
});

// Apply auth middleware
app.use(authMiddleware);

// Register API modules
api.register(app);

// Start the server
if (useHTTPS) {
  console.log('QWERTY L', 'Starting in HTTPS mode with credentials:', {
    keyLength: credentials.key.length,
    certLength: credentials.cert.length
  });
  const httpsServer = https.createServer(credentials, app);
  // Add error handling
  httpsServer.on('error', (err) => {
    console.error('HTTPS server error:', err);
  });
  httpsServer.listen(port, () => {
    console.log('QWERTY M', `Brainstorm Control Panel running on HTTPS port ${port}`);
  });
} else {
  const httpServer = http.createServer(app);
  httpServer.listen(port, () => {
    console.log('QWERTY N', `Brainstorm Control Panel running on HTTP port ${port}`);
  });
}

// Export utility functions for testing and reuse
module.exports = {
    getConfigFromFile,
    getNeo4jConnection
};