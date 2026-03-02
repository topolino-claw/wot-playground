// WoT Playground - Extension-First Frontend
// Primary data source: Nostr WoT Browser Extension
// Fallback: Server-side BFS with seed profiles

let graph = null;
let graphIs3D = null; // tracks which mode the current graph instance was built for
let graphData = { nodes: [], edges: [] };
let is3D = false;
let selectedNode = null;

// Extension state
let extensionConnected = false;
let myPubkey = null;

// Mode: 'extension', 'server', or 'seeders'
let currentMode = 'extension';

// Seeders mode state
let seedersGraphData = null;
let selectedSeeder = 'all';
// Local cache for per-seeder distance maps (lazily fetched, never re-fetched)
const seederDistancesCache = new Map();
// Profiles (groups) data for seed grouping
let profilesData = []; // [{name, label, seeds:[npub,...], seedCount}]

// Extension mode caps
const MAX_NODES_PER_HOP = 300;
const MAX_TOTAL_NODES   = 800;

// Seeders mode: max rendered nodes per hop setting (top-N by trust score)
const MAX_RENDER_BY_HOPS = { 1: 500, 2: 1200, 3: 1800, 4: 2500 };

// Color scheme — 5 trust levels matching nostr-wot-extension getTrustLevel()
// Very High (≥0.9) → emerald | High (≥0.5) → green | Medium (≥0.25) → amber
// Low (≥0.1) → orange | Very Low (<0.1) → red | Root → indigo
const COLORS = {
  root:      '#4F46E5', // indigo  — self / seed root
  veryHigh:  '#10B981', // emerald — ≥ 0.9
  high:      '#22C55E', // green   — ≥ 0.5
  medium:    '#F59E0B', // amber   — ≥ 0.25
  low:       '#F97316', // orange  — ≥ 0.1
  veryLow:   '#EF4444', // red     — < 0.1
  edge:      '#333340',
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
    badgeEl.querySelector('.status-text').textContent = '🔐 Personal WoT';
    npubEl.textContent = toNpub(pubkey).slice(0, 16) + '…';
    npubEl.title = 'Connected via Nostr WoT Extension: ' + toNpub(pubkey);
    statusEl.classList.remove('hidden');
  } else {
    badgeEl.classList.remove('connected');
    badgeEl.classList.add('disconnected');
    badgeEl.querySelector('.status-text').textContent = 'No Extension';
    npubEl.textContent = '';
    npubEl.title = 'Install Nostr WoT extension to use your personal trust graph';
    statusEl.classList.remove('hidden');
  }
}

// Update trust source indicator in the stats bar
function updateTrustSourceIndicator(source) {
  let indicator = document.getElementById('trust-source-indicator');
  if (!indicator) {
    // Create indicator in stats bar
    const statsBar = document.getElementById('stats-bar');
    indicator = document.createElement('div');
    indicator.id = 'trust-source-indicator';
    indicator.className = 'stat-item trust-source';
    statsBar.insertBefore(indicator, statsBar.firstChild);
  }
  
  if (source === 'extension') {
    indicator.innerHTML = '<span class="stat-label">Trust Source:</span><span class="stat-value trust-local">🔐 Local</span>';
    indicator.title = 'Using your personal trust graph from the Nostr WoT extension (full privacy)';
  } else if (source === 'seeders') {
    indicator.innerHTML = '<span class="stat-label">Trust Source:</span><span class="stat-value trust-oracle">🌐 Oracle</span>';
    indicator.title = 'Using curated seed profiles from the public WoT Oracle';
  } else {
    indicator.innerHTML = '<span class="stat-label">Trust Source:</span><span class="stat-value trust-oracle">📡 Server</span>';
    indicator.title = 'Using server-side graph computation';
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
  // Setup scoring panel (always available regardless of mode)
  setupScoringPanel();

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
    document.getElementById('seeder-controls').classList.add('hidden');
    showInstallPrompt(false);
    
    // Auto-load user's WoT
    loadExtensionGraph();
  } else {
    // Seeders mode: no extension, use pre-cached graph
    currentMode = 'seeders';
    document.getElementById('mode-toggle').value = 'server'; // Select shows "Seed Profiles" for now
    document.getElementById('profile-controls').classList.add('hidden');
    document.getElementById('my-wot-btn').classList.add('hidden');
    showInstallPrompt(false);
    
    // Show seeders banner and auto-load
    document.getElementById('seeder-controls').classList.remove('hidden');
    loadSeedersGraph();
  }
}

// ============================================
// Event Listeners
// ============================================

function setupEventListeners() {
  // Load button
  document.getElementById('load-btn').addEventListener('click', () => {
    if (currentMode === 'seeders') {
      loadSeedersGraph();
    } else if (currentMode === 'extension') {
      loadExtensionGraph();
    } else {
      loadServerGraph();
    }
  });
  
  // Mode toggle
  document.getElementById('mode-toggle').addEventListener('change', (e) => {
    const newMode = e.target.value;
    
    if (newMode === 'extension') {
      if (!extensionConnected) {
        showInstallPrompt(true);
        e.target.value = 'server';
        return;
      }
      currentMode = 'extension';
      document.getElementById('profile-controls').classList.add('hidden');
      document.getElementById('my-wot-btn').classList.remove('hidden');
      document.getElementById('seeder-controls').classList.add('hidden');
      showInstallPrompt(false);
      loadExtensionGraph();
    } else {
      // Server/seeders mode - prefer seeders if cache available
      document.getElementById('profile-controls').classList.add('hidden');
      document.getElementById('my-wot-btn').classList.add('hidden');
      document.getElementById('seeder-controls').classList.remove('hidden');
      currentMode = 'seeders';
      loadSeedersGraph();
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
  hopsSlider.addEventListener('change', async () => {
    if (currentMode === 'seeders') {
      // Client-side filtering only — await in case specific seeder needs distance fetch
      await applySeederPerspective(selectedSeeder);
      renderGraph();
    } else if (currentMode === 'extension') {
      loadExtensionGraph();
    } else {
      loadServerGraph();
    }
  });
  
  // Seeder selector (for seeders mode)
  document.getElementById('seeder-select').addEventListener('change', async (e) => {
    if (currentMode === 'seeders') {
      await applySeederPerspective(e.target.value);
      renderGraph();
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

  // Copy npub on click
  document.getElementById('node-npub').addEventListener('click', async () => {
    const npubEl = document.getElementById('node-npub');
    const npub = npubEl.textContent;
    if (!npub) return;
    try {
      await navigator.clipboard.writeText(npub);
      const original = npubEl.textContent;
      npubEl.textContent = '✓ Copied!';
      npubEl.style.color = 'var(--trust-very-high)';
      setTimeout(() => {
        npubEl.textContent = original;
        npubEl.style.color = '';
      }, 1500);
    } catch (e) {
      console.warn('Failed to copy:', e);
    }
  });
  
  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.getElementById('details-panel').classList.add('hidden');
      selectedNode = null;
    }
  });

  // Export graph data
  document.getElementById('export-btn').addEventListener('click', exportGraph);
}

// ============================================
// Export Graph Data
// ============================================

function exportGraph() {
  if (!graphData.nodes || graphData.nodes.length === 0) {
    showError('No graph data to export');
    return;
  }

  const exportData = {
    exportedAt: new Date().toISOString(),
    mode: currentMode,
    hops: parseInt(document.getElementById('hops-slider').value),
    perspective: selectedSeeder || 'all',
    stats: {
      nodes: graphData.nodes.length,
      edges: graphData.edges?.length || 0,
      avgTrust: graphData.nodes.length > 0
        ? (graphData.nodes.reduce((a, n) => a + n.trustScore, 0) / graphData.nodes.length).toFixed(4)
        : 0
    },
    nodes: graphData.nodes.map(n => ({
      id: n.id,
      npub: n.npub,
      name: n.name,
      trustScore: Math.round(n.trustScore * 10000) / 10000,
      hops: n.hops,
      paths: n.paths,
      parentAvgTrust: n.parentAvgTrust,
      isRoot: n.isRoot || false,
      isMutual: n.isMutual || false
    })),
    edges: (graphData.edges || []).map(e => ({
      source: e.source,
      target: e.target
    }))
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `wot-graph-${exportData.perspective}-${exportData.hops}hop-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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
    updateTrustSourceIndicator('extension');
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
  
  // Build parent map for parentAvgTrust calculation
  const parentMap = new Map(); // child → [parent pubkeys]
  for (const edge of edges) {
    if (!parentMap.has(edge.target)) parentMap.set(edge.target, []);
    parentMap.get(edge.target).push(edge.source);
  }

  // Build nodes array — two passes for parent trust propagation
  const nodesById = new Map();
  let totalTrust = 0;
  let maxDist = 0;
  let mutualCount = 0;
  
  // First pass: create nodes with basic info, sorted by hop
  const sortedVisited = Array.from(visited.entries())
    .sort((a, b) => a[1].hop - b[1].hop);
  
  for (const [pubkey, info] of sortedVisited) {
    const isMutual = mutuals.has(pubkey);
    const npub = toNpub(pubkey);
    
    // Calculate parent average trust (weighted)
    let parentAvgTrust = 1.0;
    if (!info.isRoot && parentMap.has(pubkey)) {
      const parentPubkeys = parentMap.get(pubkey);
      const parentScores = parentPubkeys
        .map(pk => nodesById.get(pk)?.trustScore)
        .filter(s => s !== undefined && s !== null);
      if (parentScores.length > 0) {
        parentAvgTrust = weightedParentAvg(parentScores);
      }
    }
    
    // Use extension trust score if available, else calculate with parent propagation
    let trustScore = trustScores[pubkey];
    if (trustScore === undefined || trustScore === null) {
      trustScore = info.isRoot ? 1.0 : calculateTrustScore(info.hop, info.paths, parentAvgTrust);
    }
    
    const node = {
      id: pubkey,
      npub,
      name: npub.slice(0, 12) + '…',
      about: '',
      picture: '',
      trustScore,
      hops: info.hop,
      paths: info.paths,
      parentAvgTrust,
      isMutual,
      isRoot: info.isRoot,
      trustSource: 'extension'
    };
    
    nodesById.set(pubkey, node);
    totalTrust += trustScore;
    maxDist = Math.max(maxDist, info.hop);
    if (isMutual) mutualCount++;
  }
  
  const nodes = Array.from(nodesById.values());
  
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
// Seeders Graph (No Extension Mode)
// ============================================

async function loadSeedersGraph() {
  showLoading(true, 'Loading curated trust graph...');
  
  try {
    // First, populate the seeder selector
    await populateSeederSelector();
    
    // Fetch the cached graph
    const response = await fetch('/api/seeders-graph');
    
    if (response.status === 202) {
      // Cache is building, poll until ready
      showLoading(true, 'Warming up cache, first load takes a minute...');
      pollForSeedersGraph();
      return;
    }
    
    if (!response.ok) {
      throw new Error('Failed to fetch seeders graph');
    }
    
    seedersGraphData = await response.json();
    
    // Update info text with actual seed count
    const seedCount = seedersGraphData.seeders?.length || 25;
      `Using ${seedCount} curated seed accounts · No extension needed`;
    
    // Apply the default perspective (all seeds)
    await applySeederPerspective('all');
    
    // Update stats
    updateStats(seedersGraphData.stats || {
      nodes: seedersGraphData.graph?.nodes?.length || 0,
      edges: seedersGraphData.graph?.edges?.length || 0,
      avgTrust: 0.5,
      maxDist: seedersGraphData.hops || 4,
      mutuals: 0
    });
    
    updateTrustSourceIndicator('seeders');
    renderGraph();
    
    // Load metadata lazily
    loadMetadataLazy(graphData.nodes);
    
  } catch (error) {
    console.error('Seeders graph error:', error);
    showError('Failed to load seeders graph: ' + error.message);
    // Fall back to server mode
    currentMode = 'server';
    document.getElementById('seeder-controls').classList.add('hidden');
    document.getElementById('profile-controls').classList.remove('hidden');
    showInstallPrompt(true);
  } finally {
    showLoading(false);
  }
}

async function pollForSeedersGraph() {
  const maxAttempts = 20; // 5 minutes max
  let attempts = 0;
  
  const poll = async () => {
    attempts++;
    
    try {
      const response = await fetch('/api/seeders-graph');
      
      if (response.status === 202) {
        if (attempts < maxAttempts) {
          updateLoadingText(`Building cache... (attempt ${attempts}/${maxAttempts})`);
          setTimeout(poll, 15000);
        } else {
          showError('Cache build taking too long, please refresh later');
          showLoading(false);
        }
        return;
      }
      
      if (response.ok) {
        seedersGraphData = await response.json();
        
        const seedCount = seedersGraphData.seeders?.length || 25;
          `Using ${seedCount} curated seed accounts · No extension needed`;
        
        await applySeederPerspective('all');
        updateStats(seedersGraphData.stats || {});
        renderGraph();
        loadMetadataLazy(graphData.nodes);
        showLoading(false);
      } else {
        throw new Error('Failed to fetch');
      }
    } catch (e) {
      if (attempts < maxAttempts) {
        setTimeout(poll, 15000);
      } else {
        showError('Failed to load seeders graph');
        showLoading(false);
      }
    }
  };
  
  poll();
}

async function populateSeederSelector() {
  try {
    // Fetch seeder metadata (names/nodeCount) and tag-based seed groups
    const [seedersResp, groupsResp] = await Promise.all([
      fetch('/api/seeders'),
      fetch('/api/seed-groups')
    ]);
    if (!seedersResp.ok || !groupsResp.ok) return;

    const seeders = await seedersResp.json();  // [{npub, name, picture, nodeCount}]
    const groups  = await groupsResp.json();   // [{tag, label, seeds:[npub,...]}]

    // Store groups globally for use in applySeederPerspective
    profilesData = groups;

    // Build lookup: npub → seeder metadata
    const seederMap = new Map(seeders.map(s => [s.npub, s]));

    const select = document.getElementById('seeder-select');
    select.innerHTML = '<option value="all">🌐 All Seeds (Consensus)</option>';

    for (const group of groups) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = group.label;

      // "All [group]" option — covers all 10 seeds in this group
      const allOpt = document.createElement('option');
      allOpt.value = `group:${group.tag}`;
      allOpt.textContent = `All ${group.label} (${group.seeds.length})`;
      optgroup.appendChild(allOpt);

      // Individual seeds in this group
      for (const npub of group.seeds) {
        const meta = seederMap.get(npub);
        const name = (meta?.name && !meta.name.startsWith('npub'))
          ? meta.name
          : npub.slice(0, 12) + '…';
        const count = meta?.nodeCount ? ` · ${meta.nodeCount}` : '';
        const opt = document.createElement('option');
        opt.value  = npub;
        opt.textContent = `  ${name}${count}`;
        opt.title  = npub;
        optgroup.appendChild(opt);
      }

      select.appendChild(optgroup);
    }
  } catch (e) {
    console.error('Failed to load seed groups:', e);
  }
}

// Fetch distance map for a single seeder (lazy, cached)
async function fetchSeederDistances(npub) {
  if (seederDistancesCache.has(npub)) return seederDistancesCache.get(npub);
  try {
    const r = await fetch(`/api/seeder-distances/${npub}`);
    const distances = r.ok ? ((await r.json()).distances || {}) : {};
    seederDistancesCache.set(npub, distances);
    return distances;
  } catch (_) {
    seederDistancesCache.set(npub, {});
    return {};
  }
}

async function applySeederPerspective(seederNpub) {
  if (!seedersGraphData || !seedersGraphData.graph) return;

  selectedSeeder = seederNpub;

  const originalNodes = seedersGraphData.graph.nodes;
  const edges         = seedersGraphData.graph.edges;

  if (seederNpub === 'all') {
    // Use nodes as-is (consensus distances already baked in)
    graphData = { nodes: originalNodes.map(n => ({ ...n })), edges };

  } else if (seederNpub.startsWith('group:')) {
    // ── Group perspective: union distances across all seeds in this tag group ──
    const profileName = seederNpub.slice(6);
    const profile     = profilesData.find(p => p.tag === profileName);
    if (!profile) { graphData = { nodes: originalNodes.map(n => ({ ...n })), edges }; }
    else {
      showLoading(true, `Loading ${profile.label} perspective…`);
      try {
        // Fetch all group seed distances in parallel (cached after first fetch)
        const groupSeedNpubs = profile.seeds || [];
        const distanceMaps = await Promise.all(groupSeedNpubs.map(fetchSeederDistances));

        // Build set of root hexes for this group
        const rootHexes = new Set(
          groupSeedNpubs.map(npub => seedersGraphData.seeders?.find(s => s.npub === npub)?.hex).filter(Boolean)
        );

        graphData = {
          nodes: originalNodes.map(n => {
            const isRoot = rootHexes.has(n.id);
            if (isRoot) return { ...n, hops: 0, trustScore: 1.0, isRoot: true };

            // Pick minimum hop from any seed in this group
            let minHop = Infinity;
            for (const dist of distanceMaps) {
              const h = dist[n.id];
              if (h !== undefined && h < minHop) minHop = h;
            }

            if (minHop === Infinity) return { ...n, hops: 99, trustScore: 0.05, isRoot: false };

            const trustScore = calculateTrustScore(minHop, n.paths, n.parentAvgTrust ?? 1.0);
            return { ...n, hops: minHop, trustScore, isRoot: false };
          }).filter(n => n.hops <= 4),
          edges
        };
      } finally {
        showLoading(false);
      }
    }

  } else {
    // ── Single-seeder perspective ──
    showLoading(true, 'Loading perspective…');
    try {
      const distances = await fetchSeederDistances(seederNpub);
      const seederHex = seedersGraphData.seeders?.find(s => s.npub === seederNpub)?.hex;

      graphData = {
        nodes: originalNodes.map(n => {
          const hop    = distances[n.id];
          const isRoot = n.id === seederHex;

          if (hop === undefined && !isRoot) return { ...n, hops: 99, trustScore: 0.05, isRoot: false };

          const trustScore = isRoot ? 1.0 : calculateTrustScore(hop || n.hops, n.paths, n.parentAvgTrust ?? 1.0);
          return { ...n, hops: isRoot ? 0 : (hop ?? n.hops), trustScore, isRoot };
        }).filter(n => n.hops <= 4),
        edges
      };
    } finally {
      showLoading(false);
    }
  }

  // Apply hops filter
  const maxHops = parseInt(document.getElementById('hops-slider').value);
  graphData.nodes = graphData.nodes.filter(n => n.hops <= maxHops);

  // Hard cap on rendered nodes — keep top-N by trust score (always keep roots & hop-1)
  const maxRender = MAX_RENDER_BY_HOPS[maxHops] ?? 1200;
  if (graphData.nodes.length > maxRender) {
    const roots    = graphData.nodes.filter(n => n.isRoot || n.hops <= 1);
    const rest     = graphData.nodes.filter(n => !n.isRoot && n.hops > 1)
                       .sort((a, b) => b.trustScore - a.trustScore)
                       .slice(0, Math.max(0, maxRender - roots.length));
    graphData.nodes = [...roots, ...rest];
  }

  // Re-filter edges to only visible nodes
  const visibleIds = new Set(graphData.nodes.map(n => n.id));
  graphData.edges  = edges.filter(e => visibleIds.has(e.source) && visibleIds.has(e.target));

  // Update stats
  const stats = {
    nodes:    graphData.nodes.length,
    edges:    graphData.edges.length,
    avgTrust: graphData.nodes.length > 0
      ? (graphData.nodes.reduce((sum, n) => sum + n.trustScore, 0) / graphData.nodes.length).toFixed(2)
      : 0,
    maxDist:  Math.max(...graphData.nodes.map(n => n.hops), 0),
    mutuals:  graphData.nodes.filter(n => n.isMutual).length
  };
  updateStats(stats);
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
    updateTrustSourceIndicator('server');
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
      
      // Update the source-of-truth graph (seeders mode) so perspective
      // switches don't lose metadata, then also patch the current view.
      const sourceNodes = seedersGraphData?.graph?.nodes;
      const patchList = sourceNodes
        ? [...(sourceNodes), ...(graphData.nodes)]
        : graphData.nodes;

      const seen = new Set();
      for (const node of patchList) {
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        const p = profiles[node.id];
        if (p) {
          node.name    = p.name    || node.name;
          node.about   = p.about   || node.about;
          node.picture = p.picture || node.picture;
        }
      }

      if (graph && graph.nodeLabel) {
        graph.nodeLabel(n => `${n.name && !n.name.startsWith('npub') ? n.name : n.npub?.slice(0,16)+'…'}\n${Math.round(n.trustScore * 100)}% trusted`);
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

  const nodeLabel = n =>
    `${n.name && !n.name.startsWith('npub') ? n.name : n.npub.slice(0,16)+'…'} · ${Math.round(n.trustScore * 100)}% · hop ${n.hops}`;

  // ── In-place update: same graph type already initialised ──────────────────
  // Preserve node positions — no WebGL context reset, no physics restart.
  if (graph && graphIs3D === is3D) {
    // Snapshot current positions from the live force-graph node objects
    const posMap = new Map();
    try {
      for (const n of graph.graphData().nodes) {
        if (n.x !== undefined) posMap.set(n.id, { x: n.x, y: n.y, z: n.z });
      }
    } catch (_) {}

    // Inject saved positions into the new node list
    const nodesWithPos = nodes.map(n => {
      const pos = posMap.get(n.id);
      return pos ? { ...n, ...pos, vx: 0, vy: 0, vz: 0 } : n;
    });

    graph
      .nodeLabel(nodeLabel)
      .nodeColor(n => n.color)
      .nodeVal(n => n.size)
      .graphData({ nodes: nodesWithPos, links });
    return;
  }

  // ── Full init: first render OR 2D ↔ 3D switch ────────────────────────────
  const container = document.getElementById('graph');
  container.innerHTML = '';
  graphIs3D = is3D;

  const data = { nodes, links };

  if (is3D) {
    graph = ForceGraph3D()(container)
      .graphData(data)
      .nodeLabel(nodeLabel)
      .nodeColor(n => n.color)
      .nodeRelSize(4)
      .nodeVal(n => n.size)
      .nodeResolution(12)
      .nodeOpacity(0.92)
      .linkColor(() => 'rgba(99,102,241,0.18)')
      .linkWidth(0.5)
      .linkDirectionalParticles(0)
      .linkDirectionalArrowLength(0)
      .onNodeClick(handleNodeClick)
      .onNodeHover(handleNodeHover)
      .backgroundColor('#0a0a0f')
      .d3AlphaDecay(0.04)
      .d3VelocityDecay(0.4)
      .d3AlphaMin(0.01);
  } else {
    graph = ForceGraph()(container)
      .graphData(data)
      .nodeLabel(nodeLabel)
      .nodeColor(n => n.color)
      .nodeRelSize(5)
      .nodeVal(n => n.size)
      .linkColor(() => 'rgba(99,102,241,0.2)')
      .linkWidth(0.8)
      .linkDirectionalParticles(0)
      .linkDirectionalArrowLength(0)
      .onNodeClick(handleNodeClick)
      .onNodeHover(handleNodeHover)
      .onBackgroundClick(() => {
        document.getElementById('details-panel').classList.add('hidden');
        selectedNode = null;
      })
      .backgroundColor('#0a0a0f')
      .d3AlphaDecay(0.04)
      .d3VelocityDecay(0.4)
      .d3AlphaMin(0.01)
      .warmupTicks(80)
      .cooldownTicks(100);
  }

  // Fit after sim settles — only run once, no loop
  if (graph.d3Force) graph.d3Force('charge').strength(-80);
  if (graph.zoomToFit) setTimeout(() => graph.zoomToFit(400, 60), 800);
}

function getNodeColor(node) {
  if (node.isRoot || node.hops === 0) return COLORS.root;
  const t = node.trustScore;
  if (t >= 0.9) return COLORS.veryHigh;
  if (t >= 0.5) return COLORS.high;
  if (t >= 0.25) return COLORS.medium;
  if (t >= 0.1) return COLORS.low;
  return COLORS.veryLow;
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

function handleNodeClick(node, event) {
  if (!node) return;
  // Stop the canvas from consuming this event further
  if (event) { event.stopPropagation(); event.preventDefault(); }
  selectedNode = node;
  // Run async but never let it crash silently
  showNodeDetails(node).catch(err => {
    console.error('showNodeDetails error:', err);
    // Fallback: at least show the panel with minimal info
    const panel = document.getElementById('details-panel');
    if (panel) panel.classList.remove('hidden');
    const nameEl = document.getElementById('node-name');
    if (nameEl) nameEl.textContent = node.name || node.npub?.slice(0,20) || 'Unknown';
  });
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
  
  // Trust badge — 5 levels matching extension scoring
  const trustPercent = Math.round(node.trustScore * 100);
  const trustBadge = document.getElementById('trust-badge');
  const trustLevelLabel = getTrustLevel(node.trustScore);
  document.getElementById('trust-percent').textContent = trustPercent + '% · ' + trustLevelLabel;

  trustBadge.classList.remove('very-high', 'high', 'medium', 'low', 'very-low');
  if (node.trustScore >= 0.9)       trustBadge.classList.add('very-high');
  else if (node.trustScore >= 0.5)  trustBadge.classList.add('high');
  else if (node.trustScore >= 0.25) trustBadge.classList.add('medium');
  else if (node.trustScore >= 0.1)  trustBadge.classList.add('low');
  else                               trustBadge.classList.add('very-low');
  
  // Stats
  document.getElementById('node-hops').textContent = node.hops;
  document.getElementById('node-paths').textContent = node.paths;
  document.getElementById('node-parent-trust').textContent =
    node.isRoot ? '—' : Math.round((node.parentAvgTrust ?? 1.0) * 100) + '%';
  document.getElementById('node-mutual').textContent = node.isMutual ? '✓' : '—';
  
  // Bio
  document.getElementById('node-bio').textContent = node.about || 'No bio available';

  // Link
  document.getElementById('node-link').href = `https://njump.me/${node.npub}`;

  // "Explore their WoT" button — load on-demand oracle graph for this user
  const exploreBtn = document.getElementById('explore-wot-btn');
  if (exploreBtn) {
    if (node.isRoot) {
      exploreBtn.classList.add('hidden');
    } else {
      exploreBtn.classList.remove('hidden');
      exploreBtn.onclick = () => exploreUserWoT(node);
    }
  }
  
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
// Explore User WoT
// Loads the on-demand oracle graph for any clicked node
// ============================================

async function exploreUserWoT(node) {
  const seed = node.npub || node.id;
  const hops = document.getElementById('hops-slider').value;
  const name = (node.name && !node.name.startsWith('npub')) ? node.name : node.npub?.slice(0, 16) + '…';

  // Close the details panel so graph is visible
  document.getElementById('details-panel').classList.add('hidden');

  showLoading(true, `Loading ${name}'s Web of Trust…`);

  try {
    const response = await fetch(`/api/graph?seed=${encodeURIComponent(seed)}&hops=${hops}`);
    if (!response.ok) throw new Error('API error ' + response.status);

    const data = await response.json();
    graphData = data;
    graphData.source = 'explore';

    // Mark the explored user's node as root
    for (const n of graphData.nodes) {
      if (n.id === node.id || n.npub === node.npub) n.isRoot = true;
    }

    updateStats(graphData.stats || {
      nodes:    graphData.nodes?.length || 0,
      edges:    graphData.edges?.length || 0,
      avgTrust: 0,
      maxDist:  parseInt(hops),
      mutuals:  0
    });
    renderGraph();
    loadMetadataLazy(graphData.nodes);
  } catch (error) {
    console.error('Explore WoT error:', error);
    showError(`Failed to load ${name}'s WoT: ` + error.message);
  } finally {
    showLoading(false);
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

// Trust formula — identical to nostr-wot-extension/lib/scoring.js
// Additive: score = base + pathBonus (NOT multiplicative)
// Path bonus only applies for hops > 1, scales per hop level
// Mutable — updated live by the scoring sliders
// Severe & calibrated — hop 4 structurally red, hop 3 orange at best
// Mirrors server-side scoring exactly so sliders are consistent
const SCORING_DEFAULTS = {
  distanceWeights: { 1: 1.0, 2: 0.40, 3: 0.12, 4: 0.04 },
  pathBonus:       { 2: 0.12, 3: 0.06, 4: 0.02 },
  maxPathBonus:    0.30,
  maxScorePerHop:  { 1: 1.0, 2: 0.70, 3: 0.24, 4: 0.09 }
};

let SCORING = JSON.parse(JSON.stringify(SCORING_DEFAULTS));

// Mirrors server-side formula exactly — severe decay + per-hop hard ceilings
function calculateTrustScore(hop, paths, parentAvgTrust = 1.0) {
  if (hop === 0) return 1.0;
  if (!hop) return 0;
  const hopKey = Math.min(hop, 4);
  const base = (SCORING.distanceWeights[hopKey] ?? 0.04) * parentAvgTrust;
  let bonus = 0;
  if (paths > 1 && hop > 1) {
    const bonusPerPath = SCORING.pathBonus[hopKey] ?? 0.02;
    bonus = Math.min(bonusPerPath * (paths - 1), SCORING.maxPathBonus) * parentAvgTrust;
  }
  const ceiling = (SCORING.maxScorePerHop?.[hopKey]) ?? 0.09;
  return Math.min(Math.max(base + bonus, 0), ceiling);
}

// Weighted average: high-trust parents count more (weighted by their own score²)
function weightedParentAvg(parentScores) {
  if (!parentScores || parentScores.length === 0) return 1.0;
  const sum  = parentScores.reduce((a, b) => a + b, 0);
  const wSum = parentScores.reduce((a, b) => a + b * b, 0);
  return sum > 0 ? wSum / sum : 1.0;
}

function getTrustLevel(score) {
  if (score === null || score === undefined) return 'Unknown';
  if (score >= 0.9)  return 'Very High';
  if (score >= 0.5)  return 'High';
  if (score >= 0.25) return 'Medium';
  if (score >= 0.1)  return 'Low';
  return 'Very Low';
}

// ============================================
// Scoring Panel
// ============================================

function setupScoringPanel() {
  const toggleBtn = document.getElementById('scoring-toggle');
  const panel     = document.getElementById('scoring-panel');

  toggleBtn.addEventListener('click', () => {
    const open = !panel.classList.contains('hidden');
    panel.classList.toggle('hidden', open);
    toggleBtn.classList.toggle('active', !open);
  });

  // Close button inside the panel
  const closeBtn = document.getElementById('scoring-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      panel.classList.add('hidden');
      toggleBtn.classList.remove('active');
    });
  }

  // Map slider id → SCORING field + display
  const sliders = [
    // Base weights
    { id: 'w1',   get: () => SCORING.distanceWeights[1],   set: v => { SCORING.distanceWeights[1] = v; },   fmt: v => v.toFixed(2) },
    { id: 'w2',   get: () => SCORING.distanceWeights[2],   set: v => { SCORING.distanceWeights[2] = v; },   fmt: v => v.toFixed(2) },
    { id: 'w3',   get: () => SCORING.distanceWeights[3],   set: v => { SCORING.distanceWeights[3] = v; },   fmt: v => v.toFixed(2) },
    { id: 'w4',   get: () => SCORING.distanceWeights[4],   set: v => { SCORING.distanceWeights[4] = v; },   fmt: v => v.toFixed(2) },
    // Path bonus
    { id: 'p2',   get: () => SCORING.pathBonus[2],         set: v => { SCORING.pathBonus[2] = v; },         fmt: v => '+' + v.toFixed(2) },
    { id: 'p3',   get: () => SCORING.pathBonus[3],         set: v => { SCORING.pathBonus[3] = v; },         fmt: v => '+' + v.toFixed(2) },
    { id: 'p4',   get: () => SCORING.pathBonus[4],         set: v => { SCORING.pathBonus[4] = v; },         fmt: v => '+' + v.toFixed(2) },
    { id: 'pmax', get: () => SCORING.maxPathBonus,         set: v => { SCORING.maxPathBonus = v; },          fmt: v => v.toFixed(2) },
    // Hard ceilings per hop
    { id: 'c2',   get: () => SCORING.maxScorePerHop[2],    set: v => { SCORING.maxScorePerHop[2] = v; },    fmt: v => v.toFixed(2) },
    { id: 'c3',   get: () => SCORING.maxScorePerHop[3],    set: v => { SCORING.maxScorePerHop[3] = v; },    fmt: v => v.toFixed(2) },
    { id: 'c4',   get: () => SCORING.maxScorePerHop[4],    set: v => { SCORING.maxScorePerHop[4] = v; },    fmt: v => v.toFixed(3) },
  ];

  for (const s of sliders) {
    const input = document.getElementById(s.id);
    const valEl = document.getElementById(s.id + '-val');
    if (!input || !valEl) continue;

    input.value = s.get();
    valEl.textContent = s.fmt(s.get());

    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      s.set(v);
      valEl.textContent = s.fmt(v);
      recalculateAndRefresh();
    });
  }

  document.getElementById('scoring-reset').addEventListener('click', () => {
    SCORING = JSON.parse(JSON.stringify(SCORING_DEFAULTS));
    for (const s of sliders) {
      const input = document.getElementById(s.id);
      const valEl = document.getElementById(s.id + '-val');
      if (!input || !valEl) continue;
      input.value = s.get();
      valEl.textContent = s.fmt(s.get());
    }
    recalculateAndRefresh();
  });
}

// Recalculate trust scores hop-by-hop with parent propagation,
// then re-color the graph — no re-fetch, purely client-side
function recalculateAndRefresh() {
  if (!graphData.nodes.length) return;
  // Allow scoring recalculation in ALL modes (including extension)

  // Build parent map from edges: target → [source pubkeys]
  const parentMap = new Map();
  for (const edge of (graphData.edges || [])) {
    if (!parentMap.has(edge.target)) parentMap.set(edge.target, []);
    parentMap.get(edge.target).push(edge.source);
  }

  // Index our data nodes by id
  const nodeMap = new Map(graphData.nodes.map(n => [n.id, n]));

  // Propagate hop-by-hop so parents are always computed first
  const sorted = [...graphData.nodes].sort((a, b) => a.hops - b.hops);

  for (const node of sorted) {
    if (node.isRoot || node.hops === 0) { node.trustScore = 1.0; continue; }

    const parentPubkeys = parentMap.get(node.id) || [];
    const parentScores  = parentPubkeys
      .map(pid => nodeMap.get(pid)).filter(Boolean)
      .map(p => p.trustScore ?? 0);

    const parentAvgTrust = parentScores.length > 0
      ? weightedParentAvg(parentScores)
      : (node.parentAvgTrust ?? 1.0);

    node.trustScore = calculateTrustScore(node.hops, node.paths, parentAvgTrust);
  }

  // KEY FIX: force-graph holds copies of our nodes (spread during render)
  // We need to patch trustScore onto the internal force-graph node objects too
  if (graph && graph.graphData) {
    const internalNodes = graph.graphData().nodes;
    for (const iNode of internalNodes) {
      const updated = nodeMap.get(iNode.id);
      if (updated) iNode.trustScore = updated.trustScore;
    }
    // Now re-color using the updated internal nodes
    graph.nodeColor(n => getNodeColor(n));
  }

  // Update avg trust stat
  const total = graphData.nodes.reduce((a, n) => a + n.trustScore, 0);
  document.getElementById('stat-avg-trust').textContent =
    Math.round((total / graphData.nodes.length) * 100) + '%';
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
