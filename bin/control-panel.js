#!/usr/bin/env node

/**
 * Hasenpfeffr Control Panel
 * 
 * This script starts the Hasenpfeffr Control Panel web interface
 * and API server for managing NIP-85 data generation and publication.
 */

const express = require('express');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Import configuration
let config;
try {
  const configModule = require('../lib/config');
  config = configModule.getAll();
} catch (error) {
  console.warn('Could not load configuration:', error.message);
  config = {};
}

// Function to get configuration values directly from /etc/hasenpfeffr.conf
function getConfigFromFile(varName, defaultValue = null) {
  try {
    const confFile = '/etc/hasenpfeffr.conf';
    if (fs.existsSync(confFile)) {
      const result = execSync(`source ${confFile} && echo $${varName}`).toString().trim();
      return result || defaultValue;
    }
    return defaultValue;
  } catch (error) {
    console.error(`Error getting configuration value ${varName}:`, error.message);
    return defaultValue;
  }
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

// Serve static files from the public directory
// First try to find the public directory in the bin directory
let publicPath = path.join(__dirname, 'public');
if (!fs.existsSync(publicPath)) {
    // If not found, try the parent directory (project root)
    publicPath = path.join(__dirname, '../public');
}
app.use(express.static(publicPath));

// Serve the control panel HTML file
app.get('/', (req, res) => {
    // First try to find the HTML file in the bin directory
    let htmlPath = path.join(__dirname, 'public/control-panel.html');
    
    // If not found, try the parent directory (project root)
    if (!fs.existsSync(htmlPath)) {
        htmlPath = path.join(__dirname, '../public/control-panel.html');
    }
    
    if (fs.existsSync(htmlPath)) {
        res.sendFile(htmlPath);
    } else {
        res.status(404).send('Control panel HTML file not found. Looked in: ' + 
                            path.join(__dirname, 'public/control-panel.html') + ' and ' +
                            path.join(__dirname, '../public/control-panel.html'));
    }
});

// Define API routes for both direct access and nginx proxy
// Direct access: /api/...
// Nginx proxy: /control/api/...

// API endpoint to check system status
app.get('/api/status', handleStatus);
app.get('/control/api/status', handleStatus);

// API endpoint to get strfry event statistics
app.get('/api/strfry-stats', handleStrfryStats);
app.get('/control/api/strfry-stats', handleStrfryStats);

// API endpoint to get Neo4j status information
app.get('/api/neo4j-status', handleNeo4jStatus);
app.get('/control/api/neo4j-status', handleNeo4jStatus);

// API endpoint for Negentropy sync
app.post('/api/negentropy-sync', handleNegentropySync);
app.post('/control/api/negentropy-sync', handleNegentropySync);

// API endpoint to generate NIP-85 data
app.get('/api/generate', handleGenerate);
app.get('/control/api/generate', handleGenerate);
app.post('/api/generate', handleGenerate);
app.post('/control/api/generate', handleGenerate);

// API endpoint to publish NIP-85 events
app.get('/api/publish', handlePublish);
app.get('/control/api/publish', handlePublish);
app.post('/api/publish', handlePublish);
app.post('/control/api/publish', handlePublish);

// API endpoint for systemd services management
app.get('/api/systemd-services', handleSystemdServices);
app.get('/control/api/systemd-services', handleSystemdServices);

// API endpoint for strfry plugin management
app.get('/api/strfry-plugin', handleStrfryPlugin);
app.get('/control/api/strfry-plugin', handleStrfryPlugin);

// API endpoint for bulk transfer
app.post('/api/bulk-transfer', handleBulkTransfer);
app.post('/control/api/bulk-transfer', handleBulkTransfer);

// Handler functions for API endpoints
function handleStatus(req, res) {
    console.log('Checking status...');
    
    exec('systemctl status strfry', (error, stdout, stderr) => {
        return res.json({
            output: stdout || stderr
        });
    });
}

function handleStrfryStats(req, res) {
    console.log('Getting strfry event statistics...');
    
    // Set the response header to ensure it's always JSON
    res.setHeader('Content-Type', 'application/json');
    
    exec('hasenpfeffr-strfry-stats', (error, stdout, stderr) => {
        if (error) {
            console.error(`Error executing strfry stats: ${stderr || error.message}`);
            return res.json({
                success: false,
                stats: {
                    total: 0,
                    kind3: 0,
                    kind1984: 0,
                    kind10000: 0,
                    error: `Error executing strfry stats: ${stderr || error.message}`
                },
                error: `Error executing strfry stats: ${stderr || error.message}`
            });
        }
        
        try {
            // Parse the JSON output from the script
            const stats = JSON.parse(stdout);
            console.log('Strfry stats:', stats);
            
            return res.json({
                success: true,
                stats: {
                    ...stats,
                    error: null
                },
                error: null
            });
        } catch (parseError) {
            console.error('Error parsing strfry stats output:', parseError, 'Output was:', stdout);
            return res.json({
                success: false,
                stats: {
                    total: 0,
                    kind3: 0,
                    kind1984: 0,
                    kind10000: 0,
                    error: `Error parsing strfry stats output: ${parseError.message}`
                },
                error: `Error parsing strfry stats output: ${parseError.message}`
            });
        }
    });
}

function handleNeo4jStatus(req, res) {
    console.log('Getting Neo4j status information...');
    
    const neo4jStatus = {
        running: false,
        userCount: 0,
        relationships: {
            follow: 0,
            mute: 0,
            report: 0
        },
        constraints: [],
        indexes: [],
        error: null
    };

    // Check if Neo4j service is running
    exec('systemctl is-active neo4j', (serviceError, serviceStdout) => {
        neo4jStatus.running = serviceStdout.trim() === 'active';
        
        // If not running, return early
        if (!neo4jStatus.running) {
            return res.json({
                success: true,
                status: neo4jStatus
            });
        }
        
        // Helper function to execute Cypher queries
        const executeCypher = (query, handler) => {
            // Get Neo4j credentials from the configuration system
            const neo4jConnection = getNeo4jConnection();
            const neo4jUser = neo4jConnection.user;
            const neo4jPassword = neo4jConnection.password;
            
            if (!neo4jPassword) {
                neo4jStatus.error = 'Neo4j password not configured. Please update /etc/hasenpfeffr.conf with NEO4J_PASSWORD.';
                return handler('');
            }
            
            const command = `cypher-shell -u ${neo4jUser} -p ${neo4jPassword} "${query}"`;
            exec(command, (error, stdout, stderr) => {
                if (error) {
                    neo4jStatus.error = `Error executing Neo4j query: ${stderr || error.message}`;
                } else {
                    handler(stdout);
                }
            });
        };

        // Get user count
        executeCypher('MATCH (u:NostrUser) RETURN count(u) as count;', (output) => {
            const match = output.match(/(\d+)/);
            if (match && match[1]) {
                neo4jStatus.userCount = parseInt(match[1], 10);
            }
            
            // Get relationship counts
            executeCypher('MATCH ()-[r:FOLLOWS]->() RETURN count(r) as count;', (output) => {
                const match = output.match(/(\d+)/);
                if (match && match[1]) {
                    neo4jStatus.relationships.follow = parseInt(match[1], 10);
                }
                
                executeCypher('MATCH ()-[r:MUTES]->() RETURN count(r) as count;', (output) => {
                    const match = output.match(/(\d+)/);
                    if (match && match[1]) {
                        neo4jStatus.relationships.mute = parseInt(match[1], 10);
                    }
                    
                    executeCypher('MATCH ()-[r:REPORTS]->() RETURN count(r) as count;', (output) => {
                        const match = output.match(/(\d+)/);
                        if (match && match[1]) {
                            neo4jStatus.relationships.report = parseInt(match[1], 10);
                        }
                        
                        // Get constraints
                        executeCypher('SHOW CONSTRAINTS;', (output) => {
                            neo4jStatus.constraints = output
                                .split('\n')
                                .filter(line => line.includes('|'))
                                .map(line => line.trim());
                            
                            // Get indexes
                            executeCypher('SHOW INDEXES;', (output) => {
                                neo4jStatus.indexes = output
                                    .split('\n')
                                    .filter(line => line.includes('|'))
                                    .map(line => line.trim());
                                
                                // Return the final result
                                res.json({
                                    success: !neo4jStatus.error,
                                    status: neo4jStatus,
                                    error: neo4jStatus.error
                                });
                            });
                        });
                    });
                });
            });
        });
    });
}

function handleNegentropySync(req, res) {
    console.log('Syncing with Negentropy...');
    
    // Set the response header to ensure it's always JSON
    res.setHeader('Content-Type', 'application/json');
    
    // Set a timeout to ensure the response doesn't hang
    const timeoutId = setTimeout(() => {
        console.log('Negentropy sync is taking longer than expected, sending initial response...');
        res.json({
            success: true,
            output: 'Negentropy sync started. This process will continue in the background.\n',
            error: null
        });
    }, 30000); // 30 seconds timeout
    
    exec('hasenpfeffr-negentropy-sync', (error, stdout, stderr) => {
        // Clear the timeout if the command completes before the timeout
        clearTimeout(timeoutId);
        
        // Check if the response has already been sent
        if (res.headersSent) {
            console.log('Response already sent, negentropy sync continuing in background');
            return;
        }
        
        return res.json({
            success: !error,
            output: stdout || stderr,
            error: error ? error.message : null
        });
    });
}

function handleGenerate(req, res) {
    console.log('Generating NIP-85 data...');
    
    exec('hasenpfeffr-generate', (error, stdout, stderr) => {
        return res.json({
            success: !error,
            output: stdout || stderr
        });
    });
}

function handlePublish(req, res) {
    console.log('Publishing NIP-85 events...');
    
    exec('hasenpfeffr-publish', (error, stdout, stderr) => {
        return res.json({
            success: !error,
            output: stdout || stderr
        });
    });
}

// Function to get systemd service status
function getServiceStatus(serviceName) {
  try {
    const result = execSync(`sudo systemctl is-active ${serviceName}`).toString().trim();
    return result === 'active' ? 'active' : 'inactive';
  } catch (error) {
    return 'inactive';
  }
}

// Function to control systemd service
function controlService(serviceName, action) {
  try {
    execSync(`sudo systemctl ${action} ${serviceName}`);
    return { success: true, message: `Service ${serviceName} ${action} successful` };
  } catch (error) {
    return { success: false, message: `Failed to ${action} ${serviceName}: ${error.message}` };
  }
}

// Handler for systemd services
function handleSystemdServices(req, res) {
  const services = [
    'neo4j',
    'strfry',
    'hasenpfeffr-control-panel',
    'strfry-router',
    'addToQueue',
    'processQueue',
    'reconcile.timer',
    'calculateHops.timer',
    'calculatePersonalizedPageRank.timer'
  ];
  
  const action = req.query.action;
  const service = req.query.service;
  
  // If action and service are provided, perform the requested action
  if (action && service) {
    if (['start', 'stop', 'restart'].includes(action)) {
      const result = controlService(service, action);
      return res.json(result);
    } else {
      return res.status(400).json({ error: 'Invalid action. Use start, stop, or restart.' });
    }
  }
  
  // Otherwise, return status of all services
  const statuses = {};
  for (const service of services) {
    statuses[service] = getServiceStatus(service);
  }
  
  res.json({ services: statuses });
}

// Handler for strfry plugin toggle
async function handleStrfryPlugin(req, res) {
    const action = req.query.action;
    
    if (!action) {
        return res.status(400).json({ error: 'Missing action parameter' });
    }

    try {
        const strfryConfPath = '/etc/strfry.conf';
        let pluginStatus = 'unknown';
        
        // Check if strfry.conf exists
        if (!fs.existsSync(strfryConfPath)) {
            return res.status(404).json({ error: 'strfry.conf not found' });
        }
        
        // Read current config
        let confContent = fs.readFileSync(strfryConfPath, 'utf8');
        
        // Check current plugin status
        // Look for the plugin setting in the writePolicy section
        const writePolicyPluginRegex = /writePolicy\s*{[^}]*plugin\s*=\s*"([^"]*)"/s;
        const writePolicyMatch = confContent.match(writePolicyPluginRegex);
        
        // Also check for the relay.writePolicy.plugin line that might have been added incorrectly
        const relayPluginRegex = /relay\.writePolicy\.plugin\s*=\s*"([^"]*)"/;
        const relayMatch = confContent.match(relayPluginRegex);
        
        // Determine plugin status from either match
        if (writePolicyMatch) {
            pluginStatus = writePolicyMatch[1] ? 'enabled' : 'disabled';
        } else if (relayMatch) {
            pluginStatus = relayMatch[1] ? 'enabled' : 'disabled';
        }
        
        if (action === 'status') {
            return res.json({ status: pluginStatus });
        }
        
        if (action === 'enable') {
            // Set plugin path
            const pluginPath = '/usr/local/lib/strfry/plugins/hasenpfeffr.js';
            
            // Ensure plugin directory exists
            if (!fs.existsSync('/usr/local/lib/strfry/plugins')) {
                execSync('sudo mkdir -p /usr/local/lib/strfry/plugins');
            }
            
            // Copy plugin file if it doesn't exist at destination
            if (!fs.existsSync(pluginPath)) {
                execSync(`sudo cp /usr/local/lib/node_modules/hasenpfeffr/plugins/hasenpfeffr.js ${pluginPath}`);
                execSync(`sudo chmod +x ${pluginPath}`);
            }
            
            // Update strfry.conf
            if (writePolicyMatch) {
                // Update the existing plugin setting in the writePolicy section
                confContent = confContent.replace(writePolicyPluginRegex, (match) => {
                    return match.replace(/plugin\s*=\s*"[^"]*"/, `plugin = "${pluginPath}"`);
                });
            } else {
                // If writePolicy section exists but without plugin setting, we need to add it
                const writePolicySectionRegex = /(writePolicy\s*{[^}]*)(})/s;
                const writePolicySectionMatch = confContent.match(writePolicySectionRegex);
                
                if (writePolicySectionMatch) {
                    confContent = confContent.replace(writePolicySectionRegex, `$1        plugin = "${pluginPath}"\n    $2`);
                } else {
                    // If writePolicy section doesn't exist, this is unexpected but we'll add it
                    confContent += `\n    writePolicy {\n        plugin = "${pluginPath}"\n    }\n`;
                }
            }
            
            // Remove any incorrect relay.writePolicy.plugin line if it exists
            if (relayMatch) {
                confContent = confContent.replace(/\nrelay\.writePolicy\.plugin\s*=\s*"[^"]*"\n?/, '\n');
            }
            
            // Write config to a temporary file and then use sudo to move it
            const tempConfigPath = '/tmp/strfry.conf.tmp';
            fs.writeFileSync(tempConfigPath, confContent);
            execSync(`sudo cp ${tempConfigPath} ${strfryConfPath}`);
            fs.unlinkSync(tempConfigPath);
            
            return res.json({ status: 'enabled', message: 'Plugin enabled successfully' });
        }
        
        if (action === 'disable') {
            // Update strfry.conf
            if (writePolicyMatch) {
                // Update the existing plugin setting in the writePolicy section to empty string
                confContent = confContent.replace(writePolicyPluginRegex, (match) => {
                    return match.replace(/plugin\s*=\s*"[^"]*"/, 'plugin = ""');
                });
            } else {
                // If writePolicy section exists but without plugin setting, we need to add it
                const writePolicySectionRegex = /(writePolicy\s*{[^}]*)(})/s;
                const writePolicySectionMatch = confContent.match(writePolicySectionRegex);
                
                if (writePolicySectionMatch) {
                    confContent = confContent.replace(writePolicySectionRegex, `$1        plugin = ""\n    $2`);
                } else {
                    // If writePolicy section doesn't exist, this is unexpected but we'll add it
                    confContent += `\n    writePolicy {\n        plugin = ""\n    }\n`;
                }
            }
            
            // Remove any incorrect relay.writePolicy.plugin line if it exists
            if (relayMatch) {
                confContent = confContent.replace(/\nrelay\.writePolicy\.plugin\s*=\s*"[^"]*"\n?/, '\n');
            }
            
            // Write config to a temporary file and then use sudo to move it
            const tempConfigPath = '/tmp/strfry.conf.tmp';
            fs.writeFileSync(tempConfigPath, confContent);
            execSync(`sudo cp ${tempConfigPath} ${strfryConfPath}`);
            fs.unlinkSync(tempConfigPath);
            
            return res.json({ status: 'disabled', message: 'Plugin disabled successfully' });
        }
        
        return res.status(400).json({ error: 'Invalid action' });
    } catch (error) {
        console.error('Error handling strfry plugin:', error);
        return res.status(500).json({ error: error.message });
    }
}

// Handler for bulk transfer
function handleBulkTransfer(req, res) {
    console.log('Starting bulk transfer of kind 3 data from strfry to Neo4j...');
    
    // Create a child process to run the transfer script
    const transferProcess = exec('/usr/local/lib/node_modules/hasenpfeffr/src/pipeline/batch/transfer.sh');
    
    let output = '';
    
    transferProcess.stdout.on('data', (data) => {
        console.log(`Bulk Transfer stdout: ${data}`);
        output += data;
    });
    
    transferProcess.stderr.on('data', (data) => {
        console.error(`Bulk Transfer stderr: ${data}`);
        output += data;
    });
    
    transferProcess.on('close', (code) => {
        console.log(`Bulk Transfer process exited with code ${code}`);
        
        if (code === 0) {
            res.json({
                success: true,
                message: 'Bulk transfer completed successfully',
                output: output
            });
        } else {
            res.json({
                success: false,
                message: `Bulk transfer failed with exit code ${code}`,
                output: output
            });
        }
    });
    
    // Handle unexpected errors
    transferProcess.on('error', (error) => {
        console.error(`Bulk Transfer error: ${error.message}`);
        res.status(500).json({
            success: false,
            message: `Bulk transfer error: ${error.message}`
        });
    });
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
