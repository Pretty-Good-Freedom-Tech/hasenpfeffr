/**
 * NostrUser Data Queries
 * Handles retrieval of individual NostrUser data from Neo4j
 */

const neo4j = require('neo4j-driver');
const { getConfigFromFile } = require('../../../../utils/config');

/**
 * Get detailed data for a specific user
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
function handleGetUserData(req, res) {
  try {
    // Get query parameters for filtering
    const pubkey = req.query.pubkey;
    
    if (!pubkey) {
      return res.status(400).json({ error: 'Missing pubkey parameter' });
    }
    
    // Create Neo4j driver
    const neo4jUri = getConfigFromFile('NEO4J_URI', 'bolt://localhost:7687');
    const neo4jUser = getConfigFromFile('NEO4J_USER', 'neo4j');
    const neo4jPassword = getConfigFromFile('NEO4J_PASSWORD', 'neo4j');
    
    const driver = neo4j.driver(
      neo4jUri,
      neo4j.auth.basic(neo4jUser, neo4jPassword)
    );
    
    const session = driver.session();
    
    // Build the Cypher query to get user data and counts
    const query = `
      MATCH (u:NostrUser {pubkey: $pubkey})
      
      // Count users that this user follows
      OPTIONAL MATCH (u)-[f:FOLLOWS]->(following:NostrUser)
      WITH u, count(following) as followingCount
      
      // Count users that follow this user
      OPTIONAL MATCH (follower:NostrUser)-[f2:FOLLOWS]->(u)
      WITH u, followingCount, count(follower) as followerCount

      // Count verified users (influence > 0.05) that follow this user
      OPTIONAL MATCH (follower:NostrUser)-[f2:FOLLOWS]->(u)
      WHERE follower.influence > 0.05
      WITH u, followingCount, followerCount, count(follower) as verifiedFollowerCount

      // Count users that this user mutes
      OPTIONAL MATCH (u)-[m:MUTES]->(muted:NostrUser)
      WITH u, followingCount, followerCount, verifiedFollowerCount, count(muted) as mutingCount
      
      // Count users that mute this user
      OPTIONAL MATCH (muter:NostrUser)-[m2:MUTES]->(u)
      WITH u, followingCount, followerCount, verifiedFollowerCount, mutingCount, count(muter) as muterCount
      
      // Count users that this user reports
      OPTIONAL MATCH (u)-[r:REPORTS]->(reported:NostrUser)
      WITH u, followingCount, followerCount, verifiedFollowerCount, mutingCount, muterCount, count(reported) as reportingCount
      
      // Count users that report this user
      OPTIONAL MATCH (reporter:NostrUser)-[r2:REPORTS]->(u)
      
      RETURN u.pubkey as pubkey,
             u.personalizedPageRank as personalizedPageRank,
             u.hops as hops,
             u.influence as influence,
             u.average as average,
             u.confidence as confidence,
             u.input as input,
             followingCount,
             verifiedFollowerCount,
             followerCount,
             mutingCount,
             muterCount,
             reportingCount,
             count(reporter) as reporterCount
    `;
    
    // Execute the query
    session.run(query, { pubkey })
      .then(result => {
        const user = result.records[0];
        
        if (!user) {
          return res.status(404).json({ error: 'User not found' });
        }
        
        res.json({
          success: true,
          data: {
            pubkey: user.get('pubkey'),
            personalizedPageRank: user.get('personalizedPageRank') ? parseFloat(user.get('personalizedPageRank').toString()) : null,
            hops: user.get('hops') ? parseInt(user.get('hops').toString()) : null,
            influence: user.get('influence') ? parseFloat(user.get('influence').toString()) : null,
            average: user.get('average') ? parseFloat(user.get('average').toString()) : null,
            confidence: user.get('confidence') ? parseFloat(user.get('confidence').toString()) : null,
            input: user.get('input') ? parseFloat(user.get('input').toString()) : null,
            followingCount: user.get('followingCount') ? parseInt(user.get('followingCount').toString()) : 0,
            followerCount: user.get('followerCount') ? parseInt(user.get('followerCount').toString()) : 0,
            verifiedFollowerCount: user.get('verifiedFollowerCount') ? parseInt(user.get('verifiedFollowerCount').toString()) : 0,
            mutingCount: user.get('mutingCount') ? parseInt(user.get('mutingCount').toString()) : 0,
            muterCount: user.get('muterCount') ? parseInt(user.get('muterCount').toString()) : 0,
            reportingCount: user.get('reportingCount') ? parseInt(user.get('reportingCount').toString()) : 0,
            reporterCount: user.get('reporterCount') ? parseInt(user.get('reporterCount').toString()) : 0
          }
        });
      })
      .catch(error => {
        console.error('Error fetching user data:', error);
        res.status(500).json({
          success: false,
          message: `Error fetching user data: ${error.message}`
        });
      })
      .finally(() => {
        session.close();
        driver.close();
      });
  } catch (error) {
    console.error('Error in handleGetUserData:', error);
    res.status(500).json({
      success: false,
      message: `Server error: ${error.message}`
    });
  }
}

module.exports = {
  handleGetUserData
};
