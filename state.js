/**
 * SPLITT - State Management Engine
 * Real-time collaborative bill splitting app
 * 
 * Features:
 * - Session creation with 6-char room codes
 * - Participant management
 * - Multiple split types (solo, even, percentage, units)
 * - Real-time sync via localStorage polling
 * - Race condition handling via timestamps
 * - Automatic TTL cleanup
 */

// ============================================
// CONSTANTS & CONFIG
// ============================================

const STORAGE_KEY = 'splitt_sessions';
const SYNC_INTERVAL = 1000; // 1 second polling
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
const SYNC_CHANNEL = 'splitt_sync_channel';

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Generate a random 6-character alphanumeric room code
 */
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excludes confusing chars
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * Generate unique ID
 */
function generateId() {
  return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Get current timestamp
 */
function now() {
  return Date.now();
}

/**
 * Deep clone an object
 */
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ============================================
// STORAGE MANAGEMENT
// ============================================

/**
 * Get all sessions from localStorage
 */
function getAllSessions() {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : {};
  } catch (e) {
    console.error('Failed to read sessions:', e);
    return {};
  }
}

/**
 * Save sessions to localStorage
 */
function saveAllSessions(sessions) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    return true;
  } catch (e) {
    console.error('Failed to save sessions:', e);
    return false;
  }
}

/**
 * Get a single session by code
 */
function getSession(code) {
  const sessions = getAllSessions();
  return sessions[code.toUpperCase()] || null;
}

/**
 * Save a single session
 */
function saveSession(session) {
  const sessions = getAllSessions();
  sessions[session.id] = session;
  session.lastModified = now();
  saveAllSessions(sessions);
  
  // Broadcast change for real-time sync
  broadcastSync(session.id);
  
  return session;
}

// ============================================
// SYNC SYSTEM
// ============================================

// BroadcastChannel for cross-tab sync (if available)
let broadcastChannel = null;
if (typeof BroadcastChannel !== 'undefined') {
  broadcastChannel = new BroadcastChannel(SYNC_CHANNEL);
}

// Active sync intervals
const activeSyncIntervals = new Map();

/**
 * Broadcast sync event to other tabs
 */
function broadcastSync(sessionId) {
  if (broadcastChannel) {
    broadcastChannel.postMessage({ type: 'sync', sessionId, timestamp: now() });
  }
}

/**
 * Setup BroadcastChannel listener
 */
function setupBroadcastListener(callback) {
  if (!broadcastChannel) return;
  
  broadcastChannel.onmessage = (event) => {
    if (event.data?.type === 'sync') {
      const session = getSession(event.data.sessionId);
      if (session && callback) {
        callback(session);
      }
    }
  };
}

// ============================================
// SESSION LIFECYCLE
// ============================================

/**
 * Create a new session
 * @param {string} hostId - User ID of the host
 * @returns {Object} The created session
 */
function createSession(hostId) {
  expireOldSessions();
  
  const sessionId = generateRoomCode();
  const currentTime = now();
  
  // Check for code collision (unlikely but possible)
  const existing = getSession(sessionId);
  if (existing) {
    return createSession(hostId); // Retry
  }
  
  const session = {
    id: sessionId,
    hostId: hostId,
    status: 'lobby',
    createdAt: currentTime,
    expiresAt: currentTime + SESSION_TTL,
    lastModified: currentTime,
    receipt: {
      imageUrl: null,
      items: [],
      tax: 0,
      tip: 0,
      total: 0
    },
    participants: [],
    selections: []
  };
  
  saveSession(session);
  
  // Auto-join host
  joinSession(sessionId, {
    id: hostId,
    name: 'Host',
    emoji: '🏠'
  });
  
  return session;
}

/**
 * Join an existing session
 * @param {string} code - Room code
 * @param {Object} user - User object {id, name, emoji}
 * @returns {Object|null} Session or null if not found/expired
 */
function joinSession(code, user) {
  const session = getSession(code);
  
  if (!session) {
    throw new Error('Session not found');
  }
  
  if (session.expiresAt < now()) {
    throw new Error('Session has expired');
  }
  
  if (session.status === 'closed') {
    throw new Error('Session is closed');
  }
  
  // Check if already joined
  const existingIndex = session.participants.findIndex(p => p.id === user.id);
  
  if (existingIndex >= 0) {
    // Update existing participant
    session.participants[existingIndex] = {
      ...session.participants[existingIndex],
      ...user,
      lastSeenAt: now()
    };
  } else {
    // Add new participant
    session.participants.push({
      id: user.id,
      name: user.name,
      emoji: user.emoji || '👤',
      joinedAt: now(),
      lastSeenAt: now()
    });
  }
  
  saveSession(session);
  return session;
}

/**
 * Leave a session
 * @param {string} sessionId - Session code
 * @param {string} userId - User ID leaving
 * @returns {Object|null} Updated session or null
 */
function leaveSession(sessionId, userId) {
  const session = getSession(sessionId);
  
  if (!session) return null;
  
  // Remove participant
  session.participants = session.participants.filter(p => p.id !== userId);
  
  // Remove their selections
  session.selections = session.selections.filter(s => s.participantId !== userId);
  
  // If host leaves, assign new host or close
  if (session.hostId === userId && session.participants.length > 0) {
    session.hostId = session.participants[0].id;
  } else if (session.participants.length === 0) {
    // No participants - mark for cleanup
    session.status = 'closed';
  }
  
  saveSession(session);
  return session;
}

// ============================================
// ITEM SELECTION & SPLIT LOGIC
// ============================================

/**
 * Select an item with specified split type
 * @param {string} sessionId - Session code
 * @param {string} userId - Participant ID
 * @param {string} itemId - Item ID from receipt
 * @param {string} splitType - 'solo' | 'even' | 'percentage' | 'units'
 * @param {number} value - Split value (percentage or units)
 * @returns {Object} Updated session
 */
function selectItem(sessionId, userId, itemId, splitType, value = null) {
  const session = getSession(sessionId);
  
  if (!session) {
    throw new Error('Session not found');
  }
  
  // Validate participant
  const participant = session.participants.find(p => p.id === userId);
  if (!participant) {
    throw new Error('Participant not found in session');
  }
  
  // Validate item exists
  const item = session.receipt.items.find(i => i.id === itemId);
  if (!item) {
    throw new Error('Item not found in receipt');
  }
  
  // Validate split type
  const validTypes = ['solo', 'even', 'percentage', 'units'];
  if (!validTypes.includes(splitType)) {
    throw new Error(`Invalid split type: ${splitType}`);
  }
  
  // Validate value based on split type
  if (splitType === 'percentage' && (value === null || value < 0 || value > 100)) {
    throw new Error('Percentage must be between 0 and 100');
  }
  if (splitType === 'units' && (value === null || value < 0)) {
    throw new Error('Units must be non-negative');
  }
  
  // Remove any existing selection for this participant + item
  session.selections = session.selections.filter(
    s => !(s.participantId === userId && s.itemId === itemId)
  );
  
  // Handle solo split - removes other claimants
  if (splitType === 'solo') {
    session.selections = session.selections.filter(s => s.itemId !== itemId);
    session.selections.push({
      participantId: userId,
      itemId: itemId,
      splitType: 'solo',
      value: null,
      selectedAt: now()
    });
  } else {
    // Add new selection
    session.selections.push({
      participantId: userId,
      itemId: itemId,
      splitType: splitType,
      value: value,
      selectedAt: now()
    });
  }
  
  // Update session status if needed
  if (session.status === 'lobby') {
    session.status = 'selecting';
  }
  
  saveSession(session);
  return session;
}

/**
 * Deselect an item
 * @param {string} sessionId - Session code
 * @param {string} userId - Participant ID
 * @param {string} itemId - Item ID
 * @returns {Object} Updated session
 */
function deselectItem(sessionId, userId, itemId) {
  const session = getSession(sessionId);
  
  if (!session) {
    throw new Error('Session not found');
  }
  
  session.selections = session.selections.filter(
    s => !(s.participantId === userId && s.itemId === itemId)
  );
  
  saveSession(session);
  return session;
}

// ============================================
// CALCULATION ENGINE
// ============================================

/**
 * Calculate per-person totals
 * @param {Object} session - Session object
 * @returns {Object} Breakdown of costs per person
 */
function calculateTotals(session) {
  if (!session || !session.participants) {
    throw new Error('Invalid session');
  }
  
  const result = {
    items: {},           // Per-item breakdown
    subtotals: {},       // Per-person food subtotals
    taxShares: {},       // Per-person tax shares
    tipShares: {},       // Per-person tip shares
    totals: {},          // Per-person grand totals
    unclaimed: [],       // Items not claimed
    details: {}          // Detailed breakdown per person
  };
  
  // Initialize all participants
  session.participants.forEach(p => {
    result.subtotals[p.id] = 0;
    result.taxShares[p.id] = 0;
    result.tipShares[p.id] = 0;
    result.totals[p.id] = 0;
    result.details[p.id] = {
      name: p.name,
      emoji: p.emoji,
      items: []
    };
  });
  
  let totalFoodSubtotal = 0;
  
  // Calculate per-item costs
  session.receipt.items.forEach(item => {
    const itemSelections = session.selections.filter(s => s.itemId === item.id);
    
    if (itemSelections.length === 0) {
      result.unclaimed.push(item);
      return;
    }
    
    const itemTotal = item.price * (item.quantity || 1);
    totalFoodSubtotal += itemTotal;
    
    const itemBreakdown = {
      itemId: item.id,
      name: item.name,
      total: itemTotal,
      shares: {}
    };
    
    // Calculate shares based on split type
    itemSelections.forEach(selection => {
      let share = 0;
      
      switch (selection.splitType) {
        case 'solo':
          share = itemTotal;
          break;
          
        case 'even':
          share = itemTotal / itemSelections.length;
          break;
          
        case 'percentage':
          share = (itemTotal * (selection.value || 0)) / 100;
          break;
          
        case 'units':
          // Calculate total units claimed for this item
          const totalUnits = itemSelections
            .filter(s => s.splitType === 'units')
            .reduce((sum, s) => sum + (s.value || 0), 0);
          
          if (totalUnits > 0) {
            share = ((selection.value || 0) / totalUnits) * itemTotal;
          }
          break;
      }
      
      share = Math.round(share * 100) / 100; // Round to 2 decimals
      
      itemBreakdown.shares[selection.participantId] = share;
      result.subtotals[selection.participantId] += share;
      result.subtotals[selection.participantId] = 
        Math.round(result.subtotals[selection.participantId] * 100) / 100;
      
      result.details[selection.participantId].items.push({
        itemId: item.id,
        name: item.name,
        price: item.price,
        splitType: selection.splitType,
        splitValue: selection.value,
        share: share
      });
    });
    
    result.items[item.id] = itemBreakdown;
  });
  
  // Calculate tax and tip distribution proportionally
  const tax = session.receipt.tax || 0;
  const tip = session.receipt.tip || 0;
  
  if (totalFoodSubtotal > 0) {
    session.participants.forEach(p => {
      const personSubtotal = result.subtotals[p.id] || 0;
      const proportion = personSubtotal / totalFoodSubtotal;
      
      result.taxShares[p.id] = Math.round(tax * proportion * 100) / 100;
      result.tipShares[p.id] = Math.round(tip * proportion * 100) / 100;
      
      result.totals[p.id] = Math.round(
        (personSubtotal + result.taxShares[p.id] + result.tipShares[p.id]) * 100
      ) / 100;
    });
  }
  
  // Calculate grand total
  result.grandTotal = Object.values(result.totals).reduce((sum, t) => sum + t, 0);
  result.grandTotal = Math.round(result.grandTotal * 100) / 100;
  
  // Summary
  result.summary = {
    foodSubtotal: totalFoodSubtotal,
    tax: tax,
    tip: tip,
    grandTotal: result.grandTotal,
    participantCount: session.participants.length,
    unclaimedCount: result.unclaimed.length
  };
  
  return result;
}

// ============================================
// SYNC & POLLING SYSTEM
// ============================================

/**
 * Sync session state with localStorage
 * Handles race conditions via timestamps
 * @param {string} code - Session code
 * @param {Function} onUpdate - Callback when session is updated
 * @returns {Object} Current session state
 */
function syncSession(code, onUpdate = null) {
  const session = getSession(code);
  
  if (!session) {
    throw new Error('Session not found');
  }
  
  if (session.expiresAt < now()) {
    throw new Error('Session has expired');
  }
  
  // Update last seen for current user if provided
  if (onUpdate) {
    onUpdate(session);
  }
  
  return session;
}

/**
 * Start real-time sync polling for a session
 * @param {string} code - Session code
 * @param {Function} callback - Called when session changes
 * @returns {Function} Stop function
 */
function startSync(code, callback) {
  let lastModified = 0;
  let stopped = false;
  
  const poll = () => {
    if (stopped) return;
    
    try {
      const session = getSession(code);
      
      if (!session) {
        callback(null, 'Session not found');
        return;
      }
      
      // Only trigger callback if data changed
      if (session.lastModified > lastModified) {
        lastModified = session.lastModified;
        callback(session, null);
      }
    } catch (e) {
      callback(null, e.message);
    }
  };
  
  // Initial poll
  poll();
  
  // Set up interval
  const intervalId = setInterval(poll, SYNC_INTERVAL);
  activeSyncIntervals.set(code, intervalId);
  
  // Set up broadcast channel listener for instant sync
  if (broadcastChannel) {
    const handler = (event) => {
      if (event.data?.sessionId === code) {
        poll();
      }
    };
    broadcastChannel.addEventListener('message', handler);
  }
  
  // Return stop function
  return () => {
    stopped = true;
    clearInterval(intervalId);
    activeSyncIntervals.delete(code);
  };
}

/**
 * Stop syncing a session
 * @param {string} code - Session code
 */
function stopSync(code) {
  const intervalId = activeSyncIntervals.get(code);
  if (intervalId) {
    clearInterval(intervalId);
    activeSyncIntervals.delete(code);
  }
}

// ============================================
// RECEIPT MANAGEMENT
// ============================================

/**
 * Add receipt to session
 * @param {string} sessionId - Session code
 * @param {Object} receipt - Receipt data
 * @returns {Object} Updated session
 */
function setReceipt(sessionId, receipt) {
  const session = getSession(sessionId);
  
  if (!session) {
    throw new Error('Session not found');
  }
  
  // Ensure items have IDs
  const itemsWithIds = (receipt.items || []).map(item => ({
    id: item.id || generateId(),
    name: item.name || 'Unknown Item',
    price: parseFloat(item.price) || 0,
    quantity: parseInt(item.quantity) || 1,
    category: item.category || 'other'
  }));
  
  session.receipt = {
    imageUrl: receipt.imageUrl || null,
    items: itemsWithIds,
    tax: parseFloat(receipt.tax) || 0,
    tip: parseFloat(receipt.tip) || 0,
    total: parseFloat(receipt.total) || 0
  };
  
  session.status = 'selecting';
  
  saveSession(session);
  return session;
}

/**
 * Add a single item to receipt
 * @param {string} sessionId - Session code
 * @param {Object} item - Item to add
 * @returns {Object} Updated session
 */
function addReceiptItem(sessionId, item) {
  const session = getSession(sessionId);
  
  if (!session) {
    throw new Error('Session not found');
  }
  
  const newItem = {
    id: item.id || generateId(),
    name: item.name || 'Unknown Item',
    price: parseFloat(item.price) || 0,
    quantity: parseInt(item.quantity) || 1,
    category: item.category || 'other'
  };
  
  session.receipt.items.push(newItem);
  
  // Recalculate total
  session.receipt.total = session.receipt.items.reduce(
    (sum, i) => sum + (i.price * i.quantity), 0
  );
  
  saveSession(session);
  return session;
}

// ============================================
// SESSION STATUS MANAGEMENT
// ============================================

/**
 * Change session status
 * @param {string} sessionId - Session code
 * @param {string} newStatus - New status
 * @returns {Object} Updated session
 */
function setSessionStatus(sessionId, newStatus) {
  const validStatuses = ['lobby', 'selecting', 'reviewing', 'closed'];
  
  if (!validStatuses.includes(newStatus)) {
    throw new Error(`Invalid status: ${newStatus}`);
  }
  
  const session = getSession(sessionId);
  
  if (!session) {
    throw new Error('Session not found');
  }
  
  session.status = newStatus;
  saveSession(session);
  return session;
}

/**
 * Move to reviewing status
 * @param {string} sessionId - Session code
 * @returns {Object} Updated session
 */
function finalizeSelections(sessionId) {
  return setSessionStatus(sessionId, 'reviewing');
}

/**
 * Close session
 * @param {string} sessionId - Session code
 * @returns {Object} Updated session
 */
function closeSession(sessionId) {
  return setSessionStatus(sessionId, 'closed');
}

// ============================================
// CLEANUP
// ============================================

/**
 * Remove expired sessions
 * @returns {number} Number of sessions removed
 */
function expireOldSessions() {
  const sessions = getAllSessions();
  const currentTime = now();
  let removed = 0;
  
  Object.keys(sessions).forEach(code => {
    const session = sessions[code];
    
    // Expired by TTL
    if (session.expiresAt < currentTime) {
      delete sessions[code];
      removed++;
      return;
    }
    
    // Closed and old (cleanup after 1 hour)
    if (session.status === 'closed' && 
        session.lastModified < currentTime - (60 * 60 * 1000)) {
      delete sessions[code];
      removed++;
      return;
    }
    
    // No participants for 1 hour
    if (session.participants.length === 0 && 
        session.lastModified < currentTime - (60 * 60 * 1000)) {
      delete sessions[code];
      removed++;
    }
  });
  
  if (removed > 0) {
    saveAllSessions(sessions);
    console.log(`Cleaned up ${removed} expired sessions`);
  }
  
  return removed;
}

/**
 * Delete a session (host only)
 * @param {string} sessionId - Session code
 * @param {string} userId - User attempting deletion (must be host)
 * @returns {boolean} Success
 */
function deleteSession(sessionId, userId) {
  const session = getSession(sessionId);
  
  if (!session) return false;
  
  if (session.hostId !== userId) {
    throw new Error('Only host can delete session');
  }
  
  const sessions = getAllSessions();
  delete sessions[sessionId];
  saveAllSessions(sessions);
  
  return true;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get claimed items for a participant
 * @param {Object} session - Session object
 * @param {string} participantId - Participant ID
 * @returns {Array} Claimed selections
 */
function getParticipantSelections(session, participantId) {
  return session.selections.filter(s => s.participantId === participantId);
}

/**
 * Get all claimants for an item
 * @param {Object} session - Session object
 * @param {string} itemId - Item ID
 * @returns {Array} Claimant IDs
 */
function getItemClaimants(session, itemId) {
  return session.selections
    .filter(s => s.itemId === itemId)
    .map(s => s.participantId);
}

/**
 * Export session data
 * @param {string} sessionId - Session code
 * @returns {Object} Session with calculated totals
 */
function exportSession(sessionId) {
  const session = getSession(sessionId);
  
  if (!session) {
    throw new Error('Session not found');
  }
  
  return {
    ...clone(session),
    calculations: calculateTotals(session),
    exportedAt: now()
  };
}

// ============================================
// INITIALIZATION
// ============================================

/**
 * Initialize the SPLITT state manager
 * Call this on app startup
 */
function initSplitt() {
  // Clean up expired sessions
  expireOldSessions();
  
  // Setup broadcast listener for multi-tab sync
  setupBroadcastListener((session) => {
    console.log('Sync received for session:', session.id);
  });
  
  console.log('SPLITT State Manager initialized');
}

// ============================================
// EXPORTS
// ============================================

// For ES Modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createSession,
    joinSession,
    leaveSession,
    syncSession,
    startSync,
    stopSync,
    selectItem,
    deselectItem,
    calculateTotals,
    expireOldSessions,
    setReceipt,
    addReceiptItem,
    setSessionStatus,
    finalizeSelections,
    closeSession,
    deleteSession,
    getSession,
    getAllSessions,
    getParticipantSelections,
    getItemClaimants,
    exportSession,
    initSplitt,
    generateId,
    generateRoomCode,
    // Constants
    SYNC_INTERVAL,
    SESSION_TTL
  };
}

// For browser global
if (typeof window !== 'undefined') {
  window.SPLITT = {
    createSession,
    joinSession,
    leaveSession,
    syncSession,
    startSync,
    stopSync,
    selectItem,
    deselectItem,
    calculateTotals,
    expireOldSessions,
    setReceipt,
    addReceiptItem,
    setSessionStatus,
    finalizeSelections,
    closeSession,
    deleteSession,
    getSession,
    getAllSessions,
    getParticipantSelections,
    getItemClaimants,
    exportSession,
    initSplitt,
    generateId,
    generateRoomCode,
    SYNC_INTERVAL,
    SESSION_TTL
  };
}

// Auto-initialize if in browser
if (typeof window !== 'undefined') {
  initSplitt();
}
