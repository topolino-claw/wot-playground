const oracleApi = require('./oracle');
const profilesApi = require('./profiles');

// Consensus scoring algorithm
function consensusScore(scores) {
  if (scores.length === 0) return 0;
  const sorted = [...scores].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const consensusBonus = 1 + Math.log(scores.length) / Math.log(4); // Assuming ~3 profiles
  return Math.min(1, median * consensusBonus);
}

// Get consensus graph from all profiles
async function getConsensusGraph(hops = 2) {
  const profiles = profilesApi.getProfiles();
  const profileNames = Object.keys(profiles);
  
  if (profileNames.length === 0) {
    throw new Error('No profiles available');
  }
  
  // Collect all seeds from all profiles
  const allSeeds = new Set();
  const allRoots = new Set();
  
  for (const name of profileNames) {
    const profile = profiles[name];
    if (profile.root) {
      const rootHex = oracleApi.toHex(profile.root);
      if (rootHex) allRoots.add(rootHex);
    }
    if (profile.seeds) {
      for (const seed of profile.seeds) {
        const hex = oracleApi.toHex(seed);
        if (hex) allSeeds.add(hex);
      }
    }
  }
  
  // Use the consensus profile if it exists, otherwise merge all
  const consensusProfile = profiles['consensus'];
  let rootPubkey;
  
  if (consensusProfile && consensusProfile.root) {
    rootPubkey = consensusProfile.root;
  } else {
    // Use first available root
    rootPubkey = Array.from(allRoots)[0] || Array.from(allSeeds)[0];
  }
  
  if (!rootPubkey) {
    throw new Error('No root pubkey found in profiles');
  }
  
  // Get graph starting from consensus root
  const graph = await oracleApi.getGraph(rootPubkey, hops, 'consensus');
  
  // Mark nodes that appear in multiple profiles
  const nodeProfileCounts = new Map();
  
  for (const name of profileNames) {
    const profile = profiles[name];
    if (profile.seeds) {
      for (const seed of profile.seeds) {
        const hex = oracleApi.toHex(seed);
        if (hex) {
          nodeProfileCounts.set(hex, (nodeProfileCounts.get(hex) || 0) + 1);
        }
      }
    }
  }
  
  // Adjust trust scores based on consensus
  for (const node of graph.nodes) {
    const profileCount = nodeProfileCounts.get(node.id) || 0;
    if (profileCount > 1) {
      // Boost score for nodes appearing in multiple profiles
      const bonus = Math.min(0.3, profileCount * 0.1);
      node.trustScore = Math.min(1, node.trustScore + bonus);
      node.consensusProfiles = profileCount;
    }
  }
  
  // Recalculate average trust
  const totalTrust = graph.nodes.reduce((sum, n) => sum + n.trustScore, 0);
  graph.stats.avgTrust = graph.nodes.length > 0 ? (totalTrust / graph.nodes.length).toFixed(2) : 0;
  
  return graph;
}

module.exports = { getConsensusGraph, consensusScore };
