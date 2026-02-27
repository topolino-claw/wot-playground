// WoT Playground - Extension-First Frontend
// Primary data source: Nostr WoT Browser Extension
// Fallback: Server-side BFS with seed profiles

let graph = null;
let graphData = { nodes: [], edges: [] };
let is3D = false;
let selectedNode = null;

// Extension state
let extensionConnected = false;
let myPubkey = null;

// Mode: 'extension' or 'server'
let currentMode = 'extension';

// Caps (same as server)
const MAX_NODES_PER_HOP = 300;
const MAX_TOTAL_NODES = 800;

// Color scheme
const COLORS = {
  root: '#4F46E5',
  high: '#10B981',
  medium: '#F59E0B',
  low: '#EF4444',
  edge: '#333340',
  edgeHighlight: '#6366F1'
};

// ============================================
// Extension Detection
// ============================================

async function detectExtension() {
  if (!window.nostr?.wot) {
    console.log('Extension not available');
    return false;
  }
  
  try {
    const status = await window.nostr.wot.isConfigured();
    if (!status?.configured) {
      console.log('Extension not configured');
      return false;
    }
    
    myPubkey = await window.nostr.wot.getMyPubkey();
    if (!myPubkey) {
      console.log('Could not get pubkey from extension');
      return false;
    }
    
    console.log('Extension connected, pubkey:', myPubkey.slice(0, 12) + '...');
    return true;
  } catch (e) {
    console.error('Extension detection error:', e);
    return false;
  }
}

function showExtensionStatus(connected, pubkey) {
  const statusEl = document.getElementById('extension-status');
  const badgeEl = document.getElementById('extension-badge');
  const npubEl = document.getElementById('extension-npub');
  
  if (connected && pubkey) {
    badgeEl.classList.add('connected');
    badgeEl.classList.remove('disconnected');
    badgeEl.querySelector('.status-text').textContent = 'Extension Connected';
    npubEl.textContent = toNpub(pubkey).slice(0, 16) + '…';
    npubEl.title = toNpub(pubkey);
    statusEl.classList.remove('hidden');
  } else {
    badgeEl.classList.remove('connected');
    badgeEl.classList.add('disconnected');
    badgeEl.querySelector('.status-text').textContent = 'No Extension';
    npubEl.textContent = '';
    statusEl.classList.remove('hidden');
  }
}

function showInstallPrompt(show) {
  const promptEl = document.getElementById('install-prompt');
  if (show) {
    promptEl.classList.remove('hidden');
  } else {
    promptEl.classList.add('hidden');
  }
}

// ============================================
// Initialize
// ============================================

async function init() {
  // Check extension first
  extensionConnected = await detectExtension();
  showExtensionStatus(extensionConnected, myPubkey);
  
  // Setup UI based on extension status
  setupEventListeners();
  await loadProfiles();
  
  if (extensionConnected) {
    // Extension mode: use My WoT by default
    currentMode = 'extension';
    document.getElementById('mode-toggle').value = 'extension';
    document.getElementById('profile-controls').classList.add('hidden');
    document.getElementById('my-wot-btn').classList.remove('hidden');
    showInstallPrompt(false);
    
    // Auto-load user's WoT
    loadExtensionGraph();
  } else {
    // Server mode: show install prompt + allow seed profile exploration
    currentMode = 'server';
    document.getElementById('mode-toggle').value = 'server';
    document.getElementById('profile-controls').classList.remove('hidden');
    document.getElementById('my-wot-btn').classList.add('hidden');
    showInstallPrompt(true);
    
    // Load default seed profile
    const defaultProfile = document.getElementById('profile-select').value;
    if (defaultProfile) {
      loadServerGraph();
    }
  }
}

// ============================================
// Event Listeners
// ============================================

function setupEventListeners() {
  // Load button
  document.getElementById('load-btn').addEventListener('click', () => {
    if (currentMode === 'extension') {
      loadExtensionGraph();
    } else {
      loadServerGraph();
    }
  });
  
  // Mode toggle
  document.getElementById('mode-toggle').addEventListener('change', (e) => {
    currentMode = e.target.value;
    if (currentMode === 'extension') {
      if (!extensionConnected) {
        showInstallPrompt(true);
        e.target.value = 'server';
        currentMode = 'server';
        return;
      }
      document.getElementById('profile-controls').classList.add('hidden');
      document.getElementById('my-wot-btn').classList.remove('hidden');
      showInstallPrompt(false);
      loadExtensionGraph();
    } else {
      document.getElementById('profile-controls').classList.remove('hidden');
      document.getElementById('my-wot-btn').classList.add('hidden');
      loadServerGraph();
    }
  });
  
  // My WoT button (when extension connected)
  document.getElementById('my-wot-btn').addEventListener('click', () => {
    if (extensionConnected) {
      loadExtensionGraph();
    }
  });
  
  // Profile change
  document.getElementById('profile-select').addEventListener('change', () => {
    if (currentMode === 'server') {
      loadServerGraph();
    }
  });
  
  // Hops slider
  const hopsSlider = document.getElementById('hops-slider');
  const hopsValue = document.getElementById('hops-value');
  hopsSlider.addEventListener('input', () => {
    hopsValue.textContent = hopsSlider.value;
  });
  hopsSlider.addEventListener('change', () => {
    if (currentMode === 'extension') {
      loadExtensionGraph();
    } else {
      loadServerGraph();
    }
  });
  
  // 2D/3D toggle
  const toggleBtns = document.querySelectorAll('.toggle-btn');
  toggleBtns.forEach((btn, index) => {
    btn.addEventListener('click', () => {
      toggleBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      is3D = index === 1;
      if (graphData.nodes.length > 0) {
        renderGraph();
      }
    });
  });
  
  // Search
  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', debounce(handleSearch, 300));
  
  // Close panel
  document.getElementById('close-panel').addEventListener('click', () => {
    document.getElementById('details-panel').classList.add('hidden');
    selectedNode = null;
  });
  
  // Dismiss install prompt
  document.getElementById('dismiss-prompt').addEventListener('click', () => {
    showInstallPrompt(false);
  });
  
  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.getElementById('details-panel').classList.add('hidden');
      selectedNode = null;
    }
  });
}

// ============================================
// Extension Graph Building
// ============================================

async function loadExtensionGraph() {
  if (!extensionConnected || !myPubkey) {
    console.error('Extension not connected');
    return;
  }
  
  const maxHops = parseInt(document.getElementById('hops-slider').value);
  
  showLoading(true, 'Building graph from your Web of Trust...');
  
  try {
    graphData = await buildGraphFromExtension(myPubkey, maxHops);
    updateStats(graphData.stats);
    renderGraph();
    
    // Load metadata for names/pictures
    loadMetadataLazy(graphData.nodes);
  } catch (error) {
    console.error('Extension graph error:', error);
    showError('Failed to build graph: ' + error.message);
  } finally {
    showLoading(false);
  }
}

async function buildGraphFromExtension(rootPubkey, maxHops) {
  const visited = new Map(); // pubkey -> { hop, paths, isRoot }
  const edges = [];
  const followsCache = new Map();
  
  // Root node
  visited.set(rootPubkey, { hop: 0, paths: 1, isRoot: true });
  
  let currentLayer = [rootPubkey];
  
  for (let hop = 1; hop <= maxHops; hop++) {
    if (currentLayer.length === 0) break;
    if (visited.size >= MAX_TOTAL_NODES) break;
    
    // Cap layer size
    if (currentLayer.length > MAX_NODES_PER_HOP) {
      currentLayer = currentLayer.slice(0, MAX_NODES_PER_HOP);
    }
    
    console.log(`Hop ${hop}: Processing ${currentLayer.length} nodes...`);
    updateLoadingText(`Building hop ${hop}... (${visited.size} nodes)`);
    
    const nextLayer = new Set();
    
    // Process each node in current layer
    for (const pubkey of currentLayer) {
      let follows;
      try {
        // getFollows(pubkey) returns follows for that pubkey
        follows = await window.nostr.wot.getFollows(pubkey);
        followsCache.set(pubkey, follows);
      } catch (e) {
        console.warn(`Failed to get follows for ${pubkey.slice(0, 8)}:`, e);
        follows = [];
      }
      
      for (const follow of follows) {
        // Add edge
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
  
  // Get trust scores from extension
  updateLoadingText('Calculating trust scores...');
  const allPubkeys = Array.from(visited.keys());
  let trustScores = {};
  
  try {
    // Batch in groups of 100
    for (let i = 0; i < allPubkeys.length; i += 100) {
      const batch = allPubkeys.slice(i, i + 100);
      const batchScores = await window.nostr.wot.getTrustScoreBatch(batch);
      trustScores = { ...trustScores, ...batchScores };
    }
  } catch (e) {
    console.warn('Failed to get trust scores:', e);
  }
  
  // Check for mutual follows
  const mutuals = new Set();
  for (const [pk, follows] of followsCache) {
    for (const follow of follows || []) {
      if (followsCache.has(follow) && followsCache.get(follow)?.includes(pk)) {
        mutuals.add(pk);
        mutuals.add(follow);
      }
    }
  }
  
  // Build nodes array
  const nodes = [];
  let totalTrust = 0;
  let maxDist = 0;
  let mutualCount = 0;
  
  for (const [pubkey, info] of visited) {
    // Use extension trust score if available, else calculate
    let trustScore = trustScores[pubkey];
    if (trustScore === undefined || trustScore === null) {
      trustScore = info.isRoot ? 1.0 : calculateTrustScore(info.hop, info.paths);
    }
    
    const isMutual = mutuals.has(pubkey);
    const npub = toNpub(pubkey);
    
    nodes.push({
      id: pubkey,
      npub,
      name: npub.slice(0, 12) + '…',
      about: '',
      picture: '',
      trustScore,
      hops: info.hop,
      paths: info.paths,
      isMutual,
      isRoot: info.isRoot,
      trustSource: 'extension'
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
    rootPubkey,
    timestamp: Date.now(),
    source: 'extension'
  };
}

// ============================================
// Server Graph (Seed Profile Mode)
// ============================================

async function loadServerGraph() {
  const profile = document.getElementById('profile-select').value;
  const hops = document.getElementById('hops-slider').value;
  
  if (!profile) return;
  
  showLoading(true, 'Building graph from seed profile...');
  
  try {
    const response = await fetch(`/api/graph?profile=${profile}&hops=${hops}`);
    if (!response.ok) throw new Error('Failed to fetch graph');
    
    graphData = await response.json();
    graphData.source = 'server';
    updateStats(graphData.stats);
    renderGraph();
    loadMetadataLazy(graphData.nodes);
  } catch (error) {
    console.error('Server graph error:', error);
    showError('Failed to load graph: ' + error.message);
  } finally {
    showLoading(false);
  }
}

// ============================================
// Profiles
// ============================================

async function loadProfiles() {
  try {
    const response = await fetch('/api/profiles');
    const profiles = await response.json();
    
    const select = document.getElementById('profile-select');
    select.innerHTML = profiles.map(p => 
      `<option value="${p.name}">${p.label} (${p.seedCount} seeds)</option>`
    ).join('');
    
    if (profiles.length > 0) {
      select.value = profiles[0].name;
    }
  } catch (error) {
    console.error('Failed to load profiles:', error);
  }
}

// ============================================
// Metadata Loading
// ============================================

async function loadMetadataLazy(nodes) {
  const BATCH = 50;
  const pubkeys = nodes.map(n => n.id);
  
  for (let i = 0; i < pubkeys.length; i += BATCH) {
    const batch = pubkeys.slice(i, i + BATCH);
    try {
      const res = await fetch('/api/metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkeys: batch })
      });
      if (!res.ok) continue;
      const profiles = await res.json();
      
      for (const node of graphData.nodes) {
        const p = profiles[node.id];
        if (p) {
          node.name = p.name || node.name;
          node.about = p.about || node.about;
          node.picture = p.picture || node.picture;
        }
      }
      
      if (graph && graph.nodeLabel) {
        graph.nodeLabel(n => `${n.name}\n${Math.round(n.trustScore * 100)}% trusted`);
      }
    } catch (e) {
      // Non-fatal
    }
  }
}

// ============================================
// Graph Rendering
// ============================================

function renderGraph() {
  const container = document.getElementById('graph');
  container.innerHTML = '';

  const nodes = graphData.nodes.map(n => ({
    ...n,
    color: getNodeColor(n),
    size: getNodeSize(n)
  }));

  // Only keep edges where BOTH endpoints exist in capped node set
  const nodeIds = new Set(nodes.map(n => n.id));
  const links = (graphData.edges || [])
    .filter(e => nodeIds.has(e.source) && nodeIds.has(e.target))
    .map(e => ({ source: e.source, target: e.target, type: e.type }));

  const data = { nodes, links };
  const nodeLabel = n =>
    `${n.name && !n.name.startsWith('npub') ? n.name : n.npub.slice(0,16)+'…'} · ${Math.round(n.trustScore * 100)}% · hop ${n.hops}`;

  if (is3D) {
    graph = ForceGraph3D()(container)
      .graphData(data)
      .nodeLabel(nodeLabel)
      .nodeColor(n => n.color)
      .nodeRelSize(4)
      .nodeVal(n => n.size)
      .nodeResolution(16)
      .nodeOpacity(0.92)
      .linkColor(() => 'rgba(99,102,241,0.18)')
      .linkWidth(0.6)
      .linkDirectionalParticles(1)
      .linkDirectionalParticleWidth(1)
      .onNodeClick(handleNodeClick)
      .onNodeHover(handleNodeHover)
      .backgroundColor('#0a0a0f')
      .d3AlphaDecay(0.02)
      .d3VelocityDecay(0.25);
  } else {
    graph = ForceGraph()(container)
      .graphData(data)
      .nodeLabel(nodeLabel)
      .nodeColor(n => n.color)
      .nodeRelSize(5)
      .nodeVal(n => n.size)
      .linkColor(() => 'rgba(99,102,241,0.2)')
      .linkWidth(0.8)
      .onNodeClick(handleNodeClick)
      .onNodeHover(handleNodeHover)
      .backgroundColor('#0a0a0f')
      .d3AlphaDecay(0.02)
      .d3VelocityDecay(0.3)
      .warmupTicks(50)
      .cooldownTicks(300);
  }

  setTimeout(() => {
    if (graph.zoomToFit) graph.zoomToFit(600, 80);
  }, 1200);
}

function getNodeColor(node) {
  if (node.isRoot || node.hops === 0) return COLORS.root;
  const trust = node.trustScore;
  if (trust >= 0.7) return COLORS.high;
  if (trust >= 0.3) return COLORS.medium;
  return COLORS.low;
}

function getNodeSize(node) {
  if (node.isRoot || node.hops === 0) return 25;
  if (node.hops === 1) return 10 + (node.trustScore * 5);
  if (node.hops === 2) return 4 + (node.trustScore * 3);
  return 2 + (node.trustScore * 2);
}

// ============================================
// Node Interaction
// ============================================

function handleNodeClick(node) {
  if (!node) return;
  selectedNode = node;
  showNodeDetails(node);
}

function handleNodeHover(node) {
  document.body.style.cursor = node ? 'pointer' : 'default';
}

async function showNodeDetails(node) {
  const panel = document.getElementById('details-panel');
  panel.classList.remove('hidden');
  
  // Avatar
  const avatar = document.getElementById('node-avatar');
  avatar.src = node.picture || `https://api.dicebear.com/7.x/identicon/svg?seed=${node.id.slice(0,8)}`;
  
  // Name
  document.getElementById('node-name').textContent = node.name || 'Unknown';
  
  // Npub
  document.getElementById('node-npub').textContent = node.npub;
  
  // Trust badge
  const trustPercent = Math.round(node.trustScore * 100);
  const trustBadge = document.getElementById('trust-badge');
  document.getElementById('trust-percent').textContent = trustPercent + '%';
  
  trustBadge.classList.remove('high', 'medium', 'low');
  if (trustPercent >= 70) trustBadge.classList.add('high');
  else if (trustPercent >= 30) trustBadge.classList.add('medium');
  else trustBadge.classList.add('low');
  
  // Stats
  document.getElementById('node-hops').textContent = node.hops;
  document.getElementById('node-paths').textContent = node.paths;
  document.getElementById('node-mutual').textContent = node.isMutual ? '✓' : '—';
  
  // Bio
  document.getElementById('node-bio').textContent = node.about || 'No bio available';
  
  // Link
  document.getElementById('node-link').href = `https://njump.me/${node.npub}`;
  
  // Trust path - use extension if available
  const pathChain = document.getElementById('path-chain');
  const extDetails = document.getElementById('ext-details');
  
  if (node.isRoot) {
    pathChain.innerHTML = '<span class="path-node">You (Root)</span>';
    extDetails.classList.add('hidden');
  } else if (extensionConnected && currentMode === 'extension') {
    // Get detailed info from extension
    try {
      const [details, path] = await Promise.all([
        window.nostr.wot.getDetails(node.id).catch(() => null),
        window.nostr.wot.getPath(node.id).catch(() => null)
      ]);
      
      // Show path if available
      if (path && path.length > 0) {
        const pathHtml = path.map((pk, i) => {
          const npub = toNpub(pk);
          const label = i === 0 ? 'You' : (i === path.length - 1 ? node.name : npub.slice(0, 8) + '…');
          return `<span class="path-node" title="${npub}">${label}</span>`;
        }).join('<span class="path-arrow">→</span>');
        pathChain.innerHTML = pathHtml;
      } else {
        pathChain.innerHTML = `<span class="path-node">You</span>
          <span class="path-arrow">→</span>
          <span class="path-node">${node.hops} hop${node.hops > 1 ? 's' : ''}</span>
          <span class="path-arrow">→</span>
          <span class="path-node">${node.name}</span>`;
      }
      
      // Show extension details
      if (details) {
        extDetails.classList.remove('hidden');
        document.getElementById('ext-distance').textContent = details.hops ?? '?';
        document.getElementById('ext-paths').textContent = details.paths ?? '?';
      } else {
        extDetails.classList.add('hidden');
      }
      
      // Common follows button
      const commonBtn = document.getElementById('common-follows-btn');
      if (commonBtn) {
        commonBtn.onclick = async () => {
          try {
            const common = await window.nostr.wot.getCommonFollows(node.id);
            if (common && common.length > 0) {
              alert(`Common follows (${common.length}):\n${common.slice(0, 10).map(pk => toNpub(pk).slice(0, 16)).join('\n')}${common.length > 10 ? '\n...' : ''}`);
            } else {
              alert('No common follows found');
            }
          } catch (e) {
            alert('Error: ' + e.message);
          }
        };
        commonBtn.classList.remove('hidden');
      }
    } catch (e) {
      console.warn('Failed to get extension details:', e);
      pathChain.innerHTML = `<span class="path-node">Seed</span>
        <span class="path-arrow">→</span>
        <span class="path-node">${node.hops} hops</span>
        <span class="path-arrow">→</span>
        <span class="path-node">${node.name}</span>`;
      extDetails.classList.add('hidden');
    }
  } else {
    // Server mode - simple path display
    const hopsText = node.hops === 1 ? 'Direct follow' : `${node.hops} hops away`;
    const pathsText = node.paths > 1 ? ` (${node.paths} paths)` : '';
    pathChain.innerHTML = `<span class="path-node">Seed</span>
      <span class="path-arrow">→</span>
      <span class="path-node">${hopsText}${pathsText}</span>
      <span class="path-arrow">→</span>
      <span class="path-node">${node.name}</span>`;
    extDetails.classList.add('hidden');
    
    const commonBtn = document.getElementById('common-follows-btn');
    if (commonBtn) commonBtn.classList.add('hidden');
  }
}

// ============================================
// Search
// ============================================

function handleSearch(e) {
  const query = e.target.value.toLowerCase().trim();
  
  if (!graph || !graphData.nodes.length) return;
  
  if (!query) {
    graph.nodeColor(n => getNodeColor(n));
    return;
  }
  
  graph.nodeColor(n => {
    const matches = n.name.toLowerCase().includes(query) || 
                    n.npub.toLowerCase().includes(query) ||
                    n.id.toLowerCase().includes(query);
    if (matches) return '#FFFFFF';
    return getNodeColor(n);
  });
  
  const match = graphData.nodes.find(n => 
    n.name.toLowerCase().includes(query) || 
    n.npub.toLowerCase().includes(query)
  );
  
  if (match && graph.centerAt) {
    graph.centerAt(match.x, match.y, 500);
    graph.zoom(4, 500);
  }
}

// ============================================
// UI Helpers
// ============================================

function updateStats(stats) {
  document.getElementById('stat-nodes').textContent = stats.nodes;
  document.getElementById('stat-edges').textContent = stats.edges;
  document.getElementById('stat-avg-trust').textContent = Math.round(stats.avgTrust * 100) + '%';
  document.getElementById('stat-max-dist').textContent = stats.maxDist;
  document.getElementById('stat-mutuals').textContent = stats.mutuals;
}

function showLoading(show, text = 'Building trust graph...') {
  const loadingEl = document.getElementById('loading');
  const textEl = loadingEl.querySelector('p');
  if (textEl) textEl.textContent = text;
  loadingEl.classList.toggle('hidden', !show);
  document.getElementById('load-btn').disabled = show;
}

function updateLoadingText(text) {
  const subEl = document.querySelector('#loading .loading-sub');
  if (subEl) subEl.textContent = text;
}

function showError(msg) {
  let el = document.getElementById('error-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'error-banner';
    el.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:#7f1d1d;color:#fca5a5;padding:12px 20px;border-radius:8px;border:1px solid #ef4444;z-index:1000;font-size:13px;max-width:500px;text-align:center;cursor:pointer;';
    el.title = 'Click to dismiss';
    el.onclick = () => el.remove();
    document.body.appendChild(el);
  }
  el.textContent = msg;
  setTimeout(() => el?.remove(), 8000);
}

// ============================================
// Utility Functions
// ============================================

function toNpub(hex) {
  try {
    // Simple bech32 encode for npub
    // In production, use nostr-tools nip19.npubEncode
    const BECH32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const prefix = 'npub';
    
    // Convert hex to 5-bit groups
    const data = [];
    for (let i = 0; i < hex.length; i += 2) {
      data.push(parseInt(hex.substr(i, 2), 16));
    }
    
    // Convert 8-bit to 5-bit
    const converted = [];
    let acc = 0;
    let bits = 0;
    for (const value of data) {
      acc = (acc << 8) | value;
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        converted.push((acc >> bits) & 31);
      }
    }
    if (bits > 0) {
      converted.push((acc << (5 - bits)) & 31);
    }
    
    // Checksum (simplified - just for display)
    const polymod = (values) => {
      const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
      let chk = 1;
      for (const v of values) {
        const b = chk >> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ v;
        for (let i = 0; i < 5; i++) {
          if ((b >> i) & 1) chk ^= GEN[i];
        }
      }
      return chk;
    };
    
    const hrpExpand = (hrp) => {
      const ret = [];
      for (const c of hrp) ret.push(c.charCodeAt(0) >> 5);
      ret.push(0);
      for (const c of hrp) ret.push(c.charCodeAt(0) & 31);
      return ret;
    };
    
    const createChecksum = (hrp, data) => {
      const values = hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
      const polymodValue = polymod(values) ^ 1;
      const checksum = [];
      for (let i = 0; i < 6; i++) {
        checksum.push((polymodValue >> (5 * (5 - i))) & 31);
      }
      return checksum;
    };
    
    const checksum = createChecksum(prefix, converted);
    const combined = converted.concat(checksum);
    
    return prefix + '1' + combined.map(i => BECH32_ALPHABET[i]).join('');
  } catch (e) {
    return hex.slice(0, 12) + '...';
  }
}

function calculateTrustScore(hop, pathCount) {
  const distanceWeights = { 1: 1.0, 2: 0.5, 3: 0.25, 4: 0.1 };
  const distanceWeight = distanceWeights[hop] || 0.1;
  const pathBonus = Math.min(0.5, (pathCount - 1) * 0.1);
  return Math.min(1, distanceWeight * (1 + pathBonus));
}

function debounce(fn, delay) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// Initialize on load
document.addEventListener('DOMContentLoaded', init);
