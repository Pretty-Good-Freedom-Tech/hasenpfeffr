#!/usr/bin/env node

/**
 * Hasenpfeffr Control Panel
 * 
 * This script starts the Hasenpfeffr Control Panel web interface
 * and API server for managing NIP-85 data generation and publication.
 */

const express = require('express');
const neo4j = require('neo4j-driver');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { exec, execSync } = require('child_process');
const WebSocket = require('ws');
const { NDKEvent, NDK } = require('@nostr-dev-kit/ndk');
// Set up WebSocket implementation for NDK in Node.js environment
const { useWebSocketImplementation } = require('nostr-tools/pool');
require('websocket-polyfill');
useWebSocketImplementation(WebSocket);

// Import API modules
const api = require('../src/api');

// Import centralized configuration utility
const { getConfigFromFile } = require('../src/utils/config');

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

// Register API modules
api.register(app);

// Serve static files from the public directory with proper MIME types
app.use(express.static(path.join(__dirname, '../public'), {
    setHeaders: (res, path, stat) => {
        if (path.endsWith('.css')) {
            console.log('Setting CSS MIME type for:', path);
            res.set('Content-Type', 'text/css');
        } else if (path.endsWith('.js')) {
            console.log('Setting JS MIME type for:', path);
            res.set('Content-Type', 'text/javascript');
        }
    }
}));

// Also serve /control/ as static files (mirror of public)
app.use('/control', express.static(path.join(__dirname, '../public'), {
    setHeaders: (res, path, stat) => {
        if (path.endsWith('.css')) {
            console.log('Setting CSS MIME type for /control path:', path);
            res.set('Content-Type', 'text/css');
        } else if (path.endsWith('.js')) {
            console.log('Setting JS MIME type for /control path:', path);
            res.set('Content-Type', 'text/javascript');
        }
    }
}));

// Session middleware
app.use(session({
    secret: getConfigFromFile('SESSION_SECRET', 'hasenpfeffr-default-session-secret-please-change-in-production'),
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set to true if using HTTPS
}));

// Helper function to serve HTML files
function serveHtmlFile(filename, res) {
    try {
        const filePath = path.join(__dirname, '../public', filename);
        if (fs.existsSync(filePath)) {
            res.sendFile(filePath);
        } else {
            res.status(404).send('File not found');
        }
    } catch (error) {
        console.error('Error serving HTML file:', error);
        res.status(500).send('Internal server error');
    }
}

// Serve the HTML files
app.get('/', (req, res) => {
    serveHtmlFile('index.html', res);
});

app.get('/overview.html', (req, res) => {
    serveHtmlFile('overview.html', res);
});

app.get('/control/overview.html', (req, res) => {
    serveHtmlFile('overview.html', res);
});

app.get('/control', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/nip85-control-panel.html'));
});

app.get('/control/profiles', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/profiles-control-panel.html'));
});

app.get('/control/profile.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/profile.html'));
});

app.get('/control/nip85-control-panel.html', (req, res) => {
    serveHtmlFile('control/nip85-control-panel.html', res);
});

app.get('/control/sign-in.html', (req, res) => {
    serveHtmlFile('control/sign-in.html', res);
});

// For backward compatibility, redirect old URLs to new ones
app.get('/control-panel.html', (req, res) => {
    res.redirect('/control/nip85-control-panel.html');
});

app.get('/nip85-control-panel.html', (req, res) => {
    res.redirect('/control/nip85-control-panel.html');
});

app.get('/sign-in.html', (req, res) => {
    res.redirect('/control/sign-in.html');
});

// Authentication middleware
const authMiddleware = (req, res, next) => {
    // Skip auth for static resources, sign-in page and auth-related endpoints
    if (req.path === '/sign-in.html' || 
        req.path === '/index.html' ||
        req.path.startsWith('/api/auth/') ||
        req.path === '/' || 
        req.path === '/control-panel.html' ||
        req.path === '/nip85-control-panel.html' ||
        !req.path.startsWith('/api/')) {
        return next();
    }
    
    // Check if user is authenticated for API calls
    if (req.session && req.session.authenticated) {
        return next();
    } else {
        // For API calls that modify data, return unauthorized status
        const writeEndpoints = [
            '/batch-transfer',
            '/generate',
            '/publish',
            '/negentropy-sync',
            '/strfry-plugin',
            '/create-kind10040',
            '/publish-kind10040',
            '/publish-kind30382',
            '/hasenpfeffr-control'
        ];
        
        // Check if the current path is a write endpoint
        const isWriteEndpoint = writeEndpoints.some(endpoint => 
            req.path.includes(endpoint) && (req.method === 'POST' || req.path.includes('?action=enable') || req.path.includes('?action=disable'))
        );
        
        if (isWriteEndpoint) {
            return res.status(401).json({ error: 'Authentication required for this action' });
    }
    
        // Allow read-only API access
        return next();
}
};

// Apply auth middleware
app.use(authMiddleware);

// Define API routes

// API endpoint for setting up Neo4j constraints and indexes
app.post('/api/neo4j-setup-constraints-and-indexes', handleNeo4jSetupConstraintsAndIndexes);

// API endpoint to publish NIP-85 events
app.get('/api/publish', handlePublish);

// API endpoint to create kind 10040 events 
app.post('/api/create-kind10040', handleCreateKind10040);

// Add route handler for Hasenpfeffr control
app.post('/api/hasenpfeffr-control', handleHasenpfeffrControl);

// Add route handler for running service management scripts
app.post('/api/run-script', handleRunScript);

function handlePublish(req, res) {
    console.log('Publishing NIP-85 events...');
    
    exec('hasenpfeffr-publish', (error, stdout, stderr) => {
        return res.json({
            success: !error,
            output: stdout || stderr
        });
    });
}

// Handler for creating kind 10040 events 
function handleCreateKind10040(req, res) {
    console.log('Creating kind 10040 events...');
    
    // Set the response header to ensure it's always JSON
    res.setHeader('Content-Type', 'application/json');
    
    // Get the full path to the script
    const scriptPath = path.join(__dirname, 'hasenpfeffr-create-kind10040.js');
    console.log('Using script path:', scriptPath);
    
    // Set a timeout to ensure the response doesn't hang
    const timeoutId = setTimeout(() => {
        console.log('Kind 10040 creation is taking longer than expected, sending initial response...');
        res.json({
            success: true,
            output: 'Kind 10040 creation started. This process will continue in the background.\n',
            error: null
        });
    }, 30000); // 30 seconds timeout
    
    exec(`node ${scriptPath}`, (error, stdout, stderr) => {
        // Clear the timeout if the command completes before the timeout
        clearTimeout(timeoutId);
        
        // Check if the response has already been sent
        if (res.headersSent) {
            console.log('Response already sent, kind 10040 creation continuing in background');
            return;
        }
        
        return res.json({
            success: !error,
            output: stdout || stderr,
            error: error ? error.message : null
        });
    });
}

// Handler for setting up Neo4j constraints and indexes
function handleNeo4jSetupConstraintsAndIndexes(req, res) {
    console.log('Setting up Neo4j constraints and indexes...');
    
    // Check authentication for write operations
    if (req.method !== 'GET' && (!req.session || !req.session.authenticated)) {
        return res.status(403).json({
            success: false,
            error: 'Authentication required for this operation'
        });
    }
    
    // Execute the setup script
    const setupScript = path.join(__dirname, '../setup', 'neo4jConstraintsAndIndexes.sh');
    
    // Check if the script exists
    if (!fs.existsSync(setupScript)) {
        return res.status(404).json({ 
            success: false, 
            error: 'Setup script not found',
            output: `Script not found at: ${setupScript}`
        });
    }
    
    // Make the script executable
    try {
        fs.chmodSync(setupScript, '755');
    } catch (error) {
        console.error('Error making script executable:', error);
    }
    
    // Execute the script
    exec(setupScript, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error executing Neo4j constraints setup: ${error.message}`);
            return res.json({
                success: false,
                error: error.message,
                output: stdout + '\n' + stderr
            });
        }
        
        console.log('Neo4j constraints and indexes set up successfully');
        res.json({
            success: true,
            message: 'Neo4j constraints and indexes set up successfully',
            output: stdout
        });
    });
}

// Handler for turning Hasenpfeffr on and off
async function handleHasenpfeffrControl(req, res) {
    const { action } = req.body;
    
    if (!action || (action !== 'on' && action !== 'off')) {
        return res.status(400).json({ 
            success: false, 
            error: 'Invalid action. Must be "on" or "off".' 
        });
    }
    
    try {
        let scriptPath;
        if (action === 'on') {
            scriptPath = '/usr/local/lib/node_modules/hasenpfeffr/src/manage/turnHasenpfeffrOn.sh';
        } else {
            scriptPath = '/usr/local/lib/node_modules/hasenpfeffr/src/manage/turnHasenpfeffrOff.sh';
        }
        
        // Check if script exists
        if (!fs.existsSync(scriptPath)) {
            return res.status(404).json({ 
                success: false, 
                error: `Script not found: ${scriptPath}` 
            });
        }
        
        // Make script executable if it's not already
        execSync(`sudo chmod +x ${scriptPath}`);
        
        // Execute the script
        console.log(`Executing ${scriptPath}...`);
        const output = execSync(`sudo ${scriptPath}`, { timeout: 60000 }).toString();
        
        return res.json({
            success: true,
            action,
            message: `Hasenpfeffr turned ${action} successfully`,
            output
        });
    } catch (error) {
        console.error(`Error turning Hasenpfeffr ${action}:`, error);
        return res.status(500).json({ 
            success: false, 
            error: `Failed to turn Hasenpfeffr ${action}: ${error.message}` 
        });
    }
}

// Handler for running service management scripts
function handleRunScript(req, res) {
    const { script } = req.body;
    
    if (!script) {
        return res.status(400).json({ error: 'Missing script parameter' });
    }
    
    try {
        // Check if script exists
        if (!fs.existsSync(script)) {
            return res.status(404).json({ 
                success: false, 
                error: `Script not found: ${script}` 
            });
        }
        
        // Make script executable if it's not already
        execSync(`sudo chmod +x ${script}`);
        
        // Execute the script
        console.log(`Executing ${script}...`);
        const output = execSync(`sudo ${script}`, { timeout: 60000 }).toString();
        
        return res.json({
            success: true,
            message: `Script ${script} executed successfully`,
            output
        });
    } catch (error) {
        console.error(`Error executing script ${script}:`, error);
        return res.status(500).json({ 
            success: false, 
            error: `Failed to execute script ${script}: ${error.message}` 
        });
    }
}

// Start the server
app.listen(port, () => {
    console.log(`Hasenpfeffr Control Panel running on port ${port}`);
});

// Export utility functions for testing and reuse
module.exports = {
    getConfigFromFile,
    getNeo4jConnection
};