/**
 * Relay API Module
 * Exports relay-related operation handlers
 */

const { handleGetRelayConfig } = require('./queries/config');

// Export handlers directly - this allows the central router 
// to register endpoints without creating multiple routers
module.exports = {
    // Queries (read operations)
    handleGetRelayConfig
};
