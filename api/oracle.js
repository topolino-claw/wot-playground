const WebSocket = require('ws');
const { nip19 } = require('nostr-tools');

// Cache with TTL
const graphCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const profileCache = new Map();
const PROFILE_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// Relays to query
const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://purplepag.es'
];

// Convert npub to hex if needed
function toHex(pubkey) {
  if (!pubkey || typeof pubkey !== 'string') return null;
  if (pubkey.startsWith('npub')) {
    try {
      const decoded = nip19.decode(pubkey);
      return decoded.data;
    } catch (e) {
      console.error('Invalid npub:', pubkey);
      return null;
    }
  }
  return pubkey;
}

// Convert hex to npub
function toNpub(hex) {
  try {
    return nip19.npubEncode(hex);
  } catch (e) {
    return hex.slice(0, 12) + '...';
  }
}

// Query relay for kind-3 (follow list) events
async function queryRelay(relay, filter, timeout = 8000) {
  return new Promise((resolve) => {
    const events = [];
    let ws;
    const timer = setTimeout(() => {
      if (ws) ws.close();
      resolve(events);
    }, timeout);

    try {
      ws = new WebSocket(relay);
      const subId = Math.random().toString(36).slice(2);

      ws.on('open', () => {
        ws.send(JSON.stringify(['REQ', subId, filter]));
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg[0] === 'EVENT' && msg[1] === subId) {
            events.push(msg[2]);
          } else if (msg[0] === 'EOSE') {
            clearTimeout(timer);
            ws.close();
            resolve(events);
          }
        } catch (e) {}
      });

      ws.on('error', () => {
        clearTimeout(timer);
        resolve(events);
      });
    } catch (e) {
      clearTimeout(timer);
      resolve(events);
    }
  });
}

// Query multiple relays in parallel
async function queryRelays(filter, timeout = 8000) {
  const results = await Promise.all(
    RELAYS.map(relay => queryRelay(relay, filter, timeout))
  );
  
  // Deduplicate by event id, prefer newest
  const eventMap = new Map();
  for (const events of results) {
    for (const event of events) {
      const existing = eventMap.get(event.pubkey);
      if (!existing || event.created_at > existing.created_at) {
        eventMap.set(event.pubkey, event);
      }
    }
  }
  return Array.from(eventMap.values());
}

// Get follows from a kind-3 event
function getFollows(event) {
  if (!event || !event.tags) return [];
  return event.tags
    .filter(tag => tag[0] === 'p' && tag[1])
    .map(tag => tag[1]);
}

// Fetch profile metadata (kind-0)
async function fetchProfiles(pubkeys, timeout = 5000) {
  if (pubkeys.length === 0) return {};
  
  // Check cache first
  const uncached = pubkeys.filter(pk => !profileCache.has(pk));
  
  if (uncached.length > 0) {
    // Batch into chunks of 50
    const chunks = [];
    for (let i = 0; i < uncached.length; i += 50) {
      chunks.push(uncached.slice(i, i + 50));
    }
    
    for (const chunk of chunks) {
      const events = await queryRelays({ kinds: [0], authors: chunk }, timeout);
      for (const event of events) {
        try {
          const content = JSON.parse(event.content);
          profileCache.set(event.pubkey, {
            name: content.name || content.display_name || '',
            about: content.about || '',
            picture: content.picture || '',
            nip05: content.nip05 || '',
            fetchedAt: Date.now()
          });
        } catch (e) {
          profileCache.set(event.pubkey, { name: '', about: '', picture: '', fetchedAt: Date.now() });
        }
      }
    }
  }
  
  const result = {};
  for (const pk of pubkeys) {
    result[pk] = profileCache.get(pk) || { name: '', about: '', picture: '' };
  }
  return result;
}

// Trust score calculation
function calculateTrustScore(hop, pathCount) {
  const distanceWeights = { 1: 1.0, 2: 0.5, 3: 0.25, 4: 0.1 };
  const distanceWeight = distanceWeights[hop] || 0.1;
  const pathBonus = Math.min(0.5, (pathCount - 1) * 0.1);
  return Math.min(1, distanceWeight * (1 + pathBonus));
}

// BFS to build the graph
const MAX_NODES_PER_HOP = 300;  // cap per hop to keep it snappy
const MAX_TOTAL_NODES   = 800;  // hard total cap

async function buildGraph(rootPubkey, maxHops, seedPubkeys = null) {
  const hex = toHex(rootPubkey);
  if (!hex) throw new Error('Invalid pubkey');

  // Use seed pubkeys if provided (for profile-based queries)
  const rootHexes = seedPubkeys ? seedPubkeys.map(s => toHex(s)).filter(Boolean) : [hex];

  const visited = new Map(); // pubkey -> { hop, paths, isRoot }
  const edges = [];
  const followsMap = new Map(); // pubkey -> follows array

  // Initialize with roots at hop 0
  for (const root of rootHexes) {
    visited.set(root, { hop: 0, paths: 1, isRoot: true });
  }

  let currentLayer = rootHexes;

  for (let hop = 1; hop <= maxHops; hop++) {
    if (currentLayer.length === 0) break;
    if (visited.size >= MAX_TOTAL_NODES) break;

    // Cap current layer to avoid relay overload
    if (currentLayer.length > MAX_NODES_PER_HOP) {
      currentLayer = currentLayer.slice(0, MAX_NODES_PER_HOP);
    }

    console.log(`Hop ${hop}: Processing ${currentLayer.length} nodes... (total visited: ${visited.size})`);

    // Fetch follow lists in batches of 50 to avoid relay timeouts
    const BATCH = 50;
    for (let i = 0; i < currentLayer.length; i += BATCH) {
      const batch = currentLayer.slice(i, i + BATCH);
      const followEvents = await queryRelays({ kinds: [3], authors: batch }, 6000);
      for (const event of followEvents) {
        followsMap.set(event.pubkey, getFollows(event));
      }
    }

    const nextLayer = new Set();

    for (const pubkey of currentLayer) {
      const follows = followsMap.get(pubkey) || [];

      for (const follow of follows) {
        // Add edge (cap edges too)
        if (edges.length < 3000) {
          edges.push({ source: pubkey, target: follow, type: 'follow' });
        }

        if (visited.has(follow)) {
          const existing = visited.get(follow);
          if (existing.hop === hop) existing.paths++;
        } else if (visited.size < MAX_TOTAL_NODES) {
          visited.set(follow, { hop, paths: 1, isRoot: false });
          if (hop < maxHops) nextLayer.add(follow);
        }
      }
    }

    currentLayer = Array.from(nextLayer);
  }
  
  // Check for mutual follows
  const mutuals = new Set();
  for (const [pk, follows] of followsMap) {
    for (const follow of follows || []) {
      if (followsMap.has(follow) && followsMap.get(follow)?.includes(pk)) {
        mutuals.add(pk);
        mutuals.add(follow);
      }
    }
  }
  
  // Build nodes array WITHOUT fetching profiles (done lazily by frontend)
  const nodes = [];
  let totalTrust = 0;
  let maxDist = 0;
  let mutualCount = 0;

  for (const [pubkey, info] of visited) {
    const trustScore = info.isRoot ? 1.0 : calculateTrustScore(info.hop, info.paths);
    const isMutual = mutuals.has(pubkey);
    const npub = toNpub(pubkey);

    nodes.push({
      id: pubkey,
      npub,
      name: npub.slice(0, 12) + '…', // placeholder until metadata loaded
      about: '',
      picture: '',
      trustScore,
      hops: info.hop,
      paths: info.paths,
      isMutual,
      isRoot: info.isRoot
    });
    
    totalTrust += trustScore;
    maxDist = Math.max(maxDist, info.hop);
    if (isMutual) mutualCount++;
  }
  
  return {
    nodes,
    edges,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      avgTrust: nodes.length > 0 ? (totalTrust / nodes.length).toFixed(2) : 0,
      maxDist,
      mutuals: mutualCount
    },
    rootPubkey: hex,
    timestamp: Date.now()
  };
}

// Main API function
async function getGraph(rootPubkey, hops = 2, profileName = null) {
  const hex = toHex(rootPubkey);
  const cacheKey = `${hex}-${hops}-${profileName || 'default'}`;
  
  // Check cache
  const cached = graphCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log('Returning cached graph');
    return cached;
  }
  
  // Get seed pubkeys if profile specified
  let seedPubkeys = null;
  if (profileName) {
    const profilesApi = require('./profiles');
    const profile = profilesApi.getProfile(profileName);
    if (profile && profile.seeds) {
      seedPubkeys = [profile.root, ...profile.seeds];
    }
  }
  
  const graph = await buildGraph(hex, hops, seedPubkeys);
  
  // Cache the result
  graphCache.set(cacheKey, graph);
  
  return graph;
}

// Clean old cache entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of graphCache) {
    if (now - value.timestamp > CACHE_TTL) {
      graphCache.delete(key);
    }
  }
  for (const [key, value] of profileCache) {
    if (now - value.fetchedAt > PROFILE_CACHE_TTL) {
      profileCache.delete(key);
    }
  }
}, 60000);

module.exports = { getGraph, toHex, toNpub, calculateTrustScore, fetchProfilesBatch: fetchProfiles };
