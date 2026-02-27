// WoT Playground - Frontend Application

let graph = null;
let graphData = { nodes: [], edges: [] };
let is3D = false;
let selectedNode = null;

// Color scheme
const COLORS = {
  root: '#4F46E5',    // Blue
  high: '#10B981',    // Green (≥70%)
  medium: '#F59E0B',  // Orange (30-69%)
  low: '#EF4444',     // Red (<30%)
  edge: '#333340',
  edgeHighlight: '#6366F1'
};

// Initialize the app
async function init() {
  await loadProfiles();
  setupEventListeners();
  
  // Auto-load default graph
  const defaultProfile = document.getElementById('profile-select').value;
  if (defaultProfile) {
    loadGraph();
  }
}

// Load available profiles
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
    document.getElementById('profile-select').innerHTML = 
      '<option value="">Error loading profiles</option>';
  }
}

// Setup event listeners
function setupEventListeners() {
  // Load button
  document.getElementById('load-btn').addEventListener('click', loadGraph);
  
  // Profile change
  document.getElementById('profile-select').addEventListener('change', loadGraph);
  
  // Hops slider
  const hopsSlider = document.getElementById('hops-slider');
  const hopsValue = document.getElementById('hops-value');
  hopsSlider.addEventListener('input', () => {
    hopsValue.textContent = hopsSlider.value;
  });
  hopsSlider.addEventListener('change', loadGraph);
  
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
  
  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.getElementById('details-panel').classList.add('hidden');
      selectedNode = null;
    }
  });
}

// Load graph data
async function loadGraph() {
  const profile = document.getElementById('profile-select').value;
  const hops = document.getElementById('hops-slider').value;
  
  if (!profile) return;
  
  showLoading(true);
  
  try {
    const response = await fetch(`/api/graph?profile=${profile}&hops=${hops}`);
    if (!response.ok) throw new Error('Failed to fetch graph');
    
    graphData = await response.json();
    updateStats(graphData.stats);
    renderGraph();
    // Lazy-load metadata after graph is rendered
    loadMetadataLazy(graphData.nodes);
  } catch (error) {
    console.error('Failed to load graph:', error);
    alert('Failed to load graph. Please try again.');
  } finally {
    showLoading(false);
  }
}

// Fetch metadata in background batches and update nodes in-place
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
      // Patch nodes in graphData
      for (const node of graphData.nodes) {
        const p = profiles[node.id];
        if (p) {
          node.name    = p.name    || node.name;
          node.about   = p.about   || node.about;
          node.picture = p.picture || node.picture;
        }
      }
      // Refresh graph node labels without full re-render
      if (graph && graph.nodeLabel) {
        graph.nodeLabel(n => `${n.name}\n${Math.round(n.trustScore * 100)}% trusted`);
      }
    } catch (e) {
      // non-fatal, keep going
    }
  }
}

// Render the graph
function renderGraph() {
  const container = document.getElementById('graph');
  container.innerHTML = '';
  
  // Prepare data for force-graph
  const nodes = graphData.nodes.map(n => ({
    ...n,
    color: getNodeColor(n),
    size: getNodeSize(n)
  }));
  
  const links = graphData.edges.map(e => ({
    source: e.source,
    target: e.target,
    type: e.type
  }));
  
  const data = { nodes, links };
  
  if (is3D) {
    graph = ForceGraph3D()(container)
      .graphData(data)
      .nodeLabel(n => `${n.name}\n${Math.round(n.trustScore * 100)}% trusted`)
      .nodeColor(n => n.color)
      .nodeRelSize(1)
      .nodeVal(n => n.size)
      .linkColor(() => COLORS.edge)
      .linkOpacity(0.3)
      .linkWidth(0.5)
      .onNodeClick(handleNodeClick)
      .onNodeHover(handleNodeHover)
      .backgroundColor('#0a0a0f');
  } else {
    graph = ForceGraph()(container)
      .graphData(data)
      .nodeLabel(n => `${n.name}\n${Math.round(n.trustScore * 100)}% trusted`)
      .nodeColor(n => n.color)
      .nodeRelSize(4)
      .nodeVal(n => n.size)
      .linkColor(() => COLORS.edge)
      .linkWidth(0.5)
      .onNodeClick(handleNodeClick)
      .onNodeHover(handleNodeHover)
      .backgroundColor('#0a0a0f');
  }
  
  // Zoom to fit after a short delay
  setTimeout(() => {
    if (graph.zoomToFit) {
      graph.zoomToFit(400, 50);
    }
  }, 500);
}

// Get node color based on trust score
function getNodeColor(node) {
  if (node.isRoot) return COLORS.root;
  const trust = node.trustScore;
  if (trust >= 0.7) return COLORS.high;
  if (trust >= 0.3) return COLORS.medium;
  return COLORS.low;
}

// Get node size based on trust score
function getNodeSize(node) {
  const baseSize = node.isRoot ? 10 : 4;
  return baseSize + (node.trustScore * 6);
}

// Handle node click
function handleNodeClick(node) {
  if (!node) return;
  
  selectedNode = node;
  showNodeDetails(node);
}

// Handle node hover
function handleNodeHover(node) {
  document.body.style.cursor = node ? 'pointer' : 'default';
}

// Show node details panel
function showNodeDetails(node) {
  const panel = document.getElementById('details-panel');
  panel.classList.remove('hidden');
  
  // Avatar
  const avatar = document.getElementById('node-avatar');
  avatar.src = node.picture || '';
  
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
  
  // Trust path (simplified - just show hops)
  const pathChain = document.getElementById('path-chain');
  if (node.isRoot) {
    pathChain.innerHTML = '<span class="path-node">Root/Seed</span>';
  } else {
    const hopsText = node.hops === 1 ? 'Direct follow' : `${node.hops} hops away`;
    const pathsText = node.paths > 1 ? ` (${node.paths} paths)` : '';
    pathChain.innerHTML = `<span class="path-node">Seed</span>
      <span class="path-arrow">→</span>
      <span class="path-node">${hopsText}${pathsText}</span>
      <span class="path-arrow">→</span>
      <span class="path-node">${node.name}</span>`;
  }
}

// Handle search
function handleSearch(e) {
  const query = e.target.value.toLowerCase().trim();
  
  if (!graph || !graphData.nodes.length) return;
  
  if (!query) {
    // Reset all nodes
    graph.nodeColor(n => getNodeColor(n));
    return;
  }
  
  // Highlight matching nodes
  graph.nodeColor(n => {
    const matches = n.name.toLowerCase().includes(query) || 
                    n.npub.toLowerCase().includes(query) ||
                    n.id.toLowerCase().includes(query);
    if (matches) return '#FFFFFF';
    return getNodeColor(n);
  });
  
  // Find first match and focus on it
  const match = graphData.nodes.find(n => 
    n.name.toLowerCase().includes(query) || 
    n.npub.toLowerCase().includes(query)
  );
  
  if (match && graph.centerAt) {
    // For 2D graph
    graph.centerAt(match.x, match.y, 500);
    graph.zoom(4, 500);
  }
}

// Update stats bar
function updateStats(stats) {
  document.getElementById('stat-nodes').textContent = stats.nodes;
  document.getElementById('stat-edges').textContent = stats.edges;
  document.getElementById('stat-avg-trust').textContent = Math.round(stats.avgTrust * 100) + '%';
  document.getElementById('stat-max-dist').textContent = stats.maxDist;
  document.getElementById('stat-mutuals').textContent = stats.mutuals;
}

// Show/hide loading
function showLoading(show) {
  document.getElementById('loading').classList.toggle('hidden', !show);
  document.getElementById('load-btn').disabled = show;
}

// Debounce helper
function debounce(fn, delay) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// Initialize on load
document.addEventListener('DOMContentLoaded', init);
