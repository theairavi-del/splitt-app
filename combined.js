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
/**
 * SPLITT - Receipt OCR Parser
 * Extracts structured data from receipt OCR text
 */

class ReceiptParser {
  constructor() {
    // Regex patterns for various receipt formats
    this.patterns = {
      // Currency symbols
      currency: /[$€£]/,
      
      // Price patterns with various formats
      price: /[$€£]?\s*(\d{1,3}(?:[,\.]\d{3})*|\d+)(?:[\.,](\d{2}))?/,
      
      // Quantity patterns (2x, 2*, qty: 2, @ 2, etc.)
      quantity: /^(\d+)\s*[@x×\*]\s*|^@?\s*(\d+)\s*[:\-]?\s*|^qty[:\s]*(\d+)/i,
      
      // Item with dots/dashes to price (CHICKEN WINGS..............$24.00)
      dottedItem: /^(.+?)[\.\s\-_]{3,}\s*[$€£]?(\d[\d,\.]+)/i,
      
      // Standard item line patterns
      itemLine: /^(?:(\d+)\s*[@x×\*]\s*)?(.+?)(?:\s+[$€£]?(\d[\d,\.]+)\s*$)/i,
      
      // Summary line patterns
      subtotal: /^(?:sub[-\s]?total|subttl|before\s*tax|net|pre[-\s]?tax)[:\s]*[$€£]?(\d[\d,\.]+)/i,
      tax: /^(?:tax|vat|gst|hst|sales\s*tax)(?:\s*\(?\d*[%\s)]*)?[:\s]*[$€£]?(\d[\d,\.]+)/i,
      tip: /^(?:tip|gratuity|service\s*charge)[:\s]*[$€£]?(\d[\d,\.]+)/i,
      total: /^(?:total|amount\s*due|balance\s*due|grand\s*total)[:\s]*[$€£]?(\d[\d,\.]+)/i,
      
      // Date patterns
      date: /(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*\d{1,2},?\s*\d{4})/i,
      
      // Merchant name (usually first non-empty line or line in ALL CAPS)
      merchant: /^[A-Z][A-Za-z0-9\s&'\-]+(?:LLC|Inc|Ltd|Corp|Restaurant|Cafe|Store|Shop|Market)?$/,
      
      // Skip patterns (headers, footers, non-item lines)
      skip: /^(?:receipt|invoice|order|ticket|cashier|server|table|guest|thank|call|visit|www\.|http|tel|phone|fax|email|date\s*:)/i
    };
    
    // Fuzzy matching configuration
    this.fuzzyConfig = {
      threshold: 0.8,
      maxDistance: 3
    };
  }

  /**
   * Main entry point - parses raw OCR text into structured receipt data
   * @param {string} text - Raw OCR text from receipt
   * @returns {object} Structured receipt data
   */
  parseReceiptText(text) {
    if (!text || typeof text !== 'string') {
      return this.createEmptyReceipt();
    }

    const lines = this.preprocessText(text);
    const items = this.extractItems(lines);
    const summary = this.extractSummary(lines);
    const metadata = this.extractMetadata(lines);

    const receipt = {
      merchant: metadata.merchant,
      date: metadata.date,
      items: items,
      tax: summary.tax,
      tip: summary.tip,
      total: summary.total,
      subtotal: summary.subtotal,
      confidence: this.calculateConfidence(items, summary)
    };

    return receipt;
  }

  /**
   * Preprocess OCR text into clean lines
   */
  preprocessText(text) {
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !this.patterns.skip.test(line));
  }

  /**
   * Extract items from receipt lines
   * @param {string[]} lines - Preprocessed lines
   * @returns {array} Array of item objects
   */
  extractItems(lines) {
    const items = [];
    
    for (const line of lines) {
      const categorized = this.categorizeLine(line);
      
      if (categorized.type === 'item') {
        items.push({
          name: this.cleanItemName(categorized.data.name),
          price: categorized.data.price,
          quantity: categorized.data.quantity || 1,
          raw: line,
          confidence: categorized.data.confidence
        });
      }
    }

    return items;
  }

  /**
   * Categorize a single line and extract relevant data
   * @param {string} line - Single receipt line
   * @returns {object} {type, data}
   */
  categorizeLine(line) {
    const result = {
      type: 'unknown',
      data: {}
    };

    // Try dotted item format first (CHICKEN WINGS..............$24.00)
    const dottedMatch = line.match(this.patterns.dottedItem);
    if (dottedMatch) {
      const name = dottedMatch[1].trim();
      const priceStr = dottedMatch[2];
      const price = this.parsePrice(priceStr);
      const quantity = this.extractQuantity(name);
      
      if (price > 0 && this.isValidItemName(name)) {
        result.type = 'item';
        result.data = {
          name: this.removeQuantityFromName(name, quantity),
          price: price,
          quantity: quantity,
          confidence: 0.92
        };
        return result;
      }
    }

    // Try summary patterns
    const taxMatch = line.match(this.patterns.tax);
    if (taxMatch) {
      result.type = 'tax';
      result.data = { amount: this.parsePrice(taxMatch[1]) };
      return result;
    }

    const tipMatch = line.match(this.patterns.tip);
    if (tipMatch) {
      result.type = 'tip';
      result.data = { amount: this.parsePrice(tipMatch[1]) };
      return result;
    }

    const totalMatch = line.match(this.patterns.total);
    if (totalMatch) {
      result.type = 'total';
      result.data = { amount: this.parsePrice(totalMatch[1]) };
      return result;
    }

    const subtotalMatch = line.match(this.patterns.subtotal);
    if (subtotalMatch) {
      result.type = 'subtotal';
      result.data = { amount: this.parsePrice(subtotalMatch[1]) };
      return result;
    }

    // Try item line patterns
    const itemMatch = line.match(this.patterns.itemLine);
    if (itemMatch) {
      const qty = itemMatch[1] ? parseInt(itemMatch[1], 10) : null;
      let name = itemMatch[2].trim();
      const priceStr = itemMatch[3];
      const price = this.parsePrice(priceStr);
      
      // Extract quantity from name if not explicitly provided
      const extractedQty = qty || this.extractQuantity(name);
      name = this.removeQuantityFromName(name, extractedQty);
      
      if (price > 0 && this.isValidItemName(name)) {
        // Confidence based on format clarity
        let confidence = 0.85;
        if (qty) confidence = 0.95; // Explicit quantity
        if (line.includes('...') || line.includes('---')) confidence = 0.90;
        
        result.type = 'item';
        result.data = {
          name: name,
          price: price,
          quantity: extractedQty,
          confidence: confidence
        };
        return result;
      }
    }

    // Try to extract any line with price that looks like an item
    const priceMatch = line.match(this.patterns.price);
    if (priceMatch) {
      const price = this.parsePrice(priceMatch[0]);
      const name = line.replace(this.patterns.price, '').trim();
      const quantity = this.extractQuantity(name);
      
      // Additional check: reject if name looks like an address/street
      if (price > 0 && this.isValidItemName(name) && name.length > 2) {
        // Extra validation: if the price looks like a street number (100-99999) and name like a street, skip
        if (price >= 100 && price <= 99999 && /^(main|street|st|ave|avenue|blvd|boulevard|road|rd|drive|dr|lane|ln|way|court|ct)\b/i.test(name)) {
          // This looks like an address, not an item
        } else {
          result.type = 'item';
          result.data = {
            name: this.removeQuantityFromName(name, quantity),
            price: price,
            quantity: quantity,
            confidence: 0.70 // Lower confidence for fuzzy match
          };
          return result;
        }
      }
    }

    return result;
  }

  /**
   * Extract summary values (tax, tip, total, subtotal)
   */
  extractSummary(lines) {
    const summary = {
      tax: 0,
      tip: 0,
      total: 0,
      subtotal: 0
    };

    // Find the last occurrence of each (in case of multiple)
    for (const line of lines) {
      const categorized = this.categorizeLine(line);
      
      switch (categorized.type) {
        case 'tax':
          summary.tax = categorized.data.amount;
          break;
        case 'tip':
          summary.tip = categorized.data.amount;
          break;
        case 'total':
          summary.total = categorized.data.amount;
          break;
        case 'subtotal':
          summary.subtotal = categorized.data.amount;
          break;
      }
    }

    // Infer subtotal if not present but total and tax are
    if (summary.subtotal === 0 && summary.total > 0 && summary.tax > 0) {
      summary.subtotal = summary.total - summary.tax - summary.tip;
    }

    return summary;
  }

  /**
   * Extract metadata (merchant, date)
   */
  extractMetadata(lines) {
    const metadata = {
      merchant: '',
      date: ''
    };

    // Find merchant (usually first few lines, often in caps)
    for (let i = 0; i < Math.min(5, lines.length); i++) {
      const line = lines[i];
      if (this.patterns.merchant.test(line) && line.length > 2 && line.length < 50) {
        // Skip if it looks like a date or price
        if (!this.patterns.date.test(line) && !this.patterns.price.test(line)) {
          metadata.merchant = line.trim();
          break;
        }
      }
    }

    // Find date (also check for "Date: " prefix)
    for (const line of lines) {
      // Remove "Date: " prefix if present
      const cleanLine = line.replace(/^date\s*:\s*/i, '');
      const dateMatch = cleanLine.match(this.patterns.date);
      if (dateMatch) {
        metadata.date = this.normalizeDate(dateMatch[1]);
        break;
      }
    }

    return metadata;
  }

  /**
   * Parse price string to number
   */
  parsePrice(priceStr) {
    if (!priceStr) return 0;
    
    // Remove currency symbols and whitespace
    let clean = priceStr.replace(/[$€£\s]/g, '');
    
    // Handle thousand separators and decimal
    // If there are multiple dots/commas, the last one is likely the decimal
    const parts = clean.split(/[.,]/);
    
    if (parts.length > 2) {
      // Multiple separators - assume last is decimal
      const decimal = parts.pop();
      clean = parts.join('') + '.' + decimal;
    } else if (parts.length === 2) {
      // One separator - determine if it's decimal or thousands
      const firstPart = parts[0];
      const secondPart = parts[1];
      
      // If second part is exactly 2 digits, it's likely a decimal (cents)
      // This handles cases like "12.5" -> 12.50 or "12.50" -> 12.50
      if (secondPart.length === 2) {
        clean = firstPart + '.' + secondPart;
      } else if (secondPart.length === 1) {
        // Single digit after separator - likely decimal with implied 0 (e.g., 12.5 -> 12.50)
        clean = firstPart + '.' + secondPart + '0';
      } else if (secondPart.length > 2) {
        // More than 2 digits in second part - likely thousands separator
        clean = firstPart + secondPart;
      } else {
        clean = firstPart + '.' + secondPart;
      }
    }
    
    const value = parseFloat(clean);
    return isNaN(value) ? 0 : value;
  }

  /**
   * Extract quantity from item name
   */
  extractQuantity(text) {
    if (!text) return 1;
    
    const qtyMatch = text.match(this.patterns.quantity);
    if (qtyMatch) {
      return parseInt(qtyMatch[1] || qtyMatch[2] || qtyMatch[3], 10);
    }
    
    return 1;
  }

  /**
   * Remove quantity indicators from item name
   */
  removeQuantityFromName(name, quantity) {
    // Always remove @ prefix patterns regardless of quantity
    name = name.replace(/^@\s*/, '');
    
    if (quantity > 1) {
      // Remove common quantity patterns
      name = name.replace(/^\d+\s*[@x×\*:]\s*/i, '');
      name = name.replace(/^qty[:\s]*\d+\s*/i, '');
      name = name.replace(/^\d+\s+/, '');
    }
    return name.trim();
  }

  /**
   * Clean item name (remove extra spaces, normalize)
   */
  cleanItemName(name) {
    return name
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-]+|[\s\-]+$/g, '')
      .trim()
      .toLowerCase()
      .replace(/\b\w/g, c => c.toUpperCase()); // Title case
  }

  /**
   * Check if string looks like a valid item name
   */
  isValidItemName(name) {
    if (!name || name.length < 2) return false;
    
    // Reject if it's just numbers or special chars
    if (/^[\d\W]+$/.test(name)) return false;
    
    // Reject common non-item words
    const invalidWords = /^(?:total|subtotal|tax|tip|change|cash|credit|debit|card|payment|balance|amount|due|check|bill|date)$/i;
    if (invalidWords.test(name.trim())) return false;
    
    // Reject addresses (street numbers followed by street names)
    if (/^\d+\s+(main|street|st|ave|avenue|blvd|boulevard|road|rd|drive|dr|lane|ln|way|court|ct)/i.test(name)) return false;
    
    // Reject lines that look like standalone street names with prices
    if (/^(main|street|st|ave|avenue|blvd|boulevard|road|rd|drive|dr|lane|ln|way|court|ct)\s+\d+$/i.test(name)) return false;
    
    // Reject order numbers and ticket numbers
    if (/^(order|ticket|table|check|receipt)\s*#?\s*\d+/i.test(name)) return false;
    
    return true;
  }

  /**
   * Normalize date string to ISO format
   */
  normalizeDate(dateStr) {
    if (!dateStr) return '';
    
    try {
      const date = new Date(dateStr);
      if (!isNaN(date.getTime())) {
        return date.toISOString().split('T')[0];
      }
    } catch (e) {
      // Continue to manual parsing
    }
    
    // Manual parsing for common formats
    const formats = [
      // MM/DD/YYYY or MM-DD-YYYY
      { regex: /(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/, order: [1, 2, 3] },
      // YYYY/MM/DD
      { regex: /(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/, order: [3, 2, 1] },
    ];
    
    for (const fmt of formats) {
      const match = dateStr.match(fmt.regex);
      if (match) {
        const year = match[fmt.order[2]];
        const month = String(match[fmt.order[0]]).padStart(2, '0');
        const day = String(match[fmt.order[1]]).padStart(2, '0');
        return `${year}-${month}-${day}`;
      }
    }
    
    return dateStr;
  }

  /**
   * Calculate overall confidence score
   */
  calculateConfidence(items, summary) {
    if (items.length === 0) return 0;
    
    // Average item confidence
    const itemConfidence = items.reduce((sum, item) => sum + (item.confidence || 0.5), 0) / items.length;
    
    // Check if totals make sense
    const itemsTotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    let totalConfidence = 1.0;
    
    if (summary.total > 0) {
      const calculatedTotal = itemsTotal + summary.tax + summary.tip;
      const diff = Math.abs(calculatedTotal - summary.total);
      const tolerance = summary.total * 0.05; // 5% tolerance
      
      if (diff <= tolerance) {
        totalConfidence = 1.0;
      } else if (diff <= tolerance * 2) {
        totalConfidence = 0.8;
      } else {
        totalConfidence = 0.5;
      }
    }
    
    return Math.round((itemConfidence * 0.6 + totalConfidence * 0.4) * 100) / 100;
  }

  /**
   * Create empty receipt structure
   */
  createEmptyReceipt() {
    return {
      merchant: '',
      date: '',
      items: [],
      tax: 0,
      tip: 0,
      total: 0,
      subtotal: 0,
      confidence: 0
    };
  }

  // ==================== FUZZY MATCHING ====================

  /**
   * Calculate Levenshtein distance between two strings
   */
  levenshteinDistance(str1, str2) {
    const m = str1.length;
    const n = str2.length;
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (str1[i - 1] === str2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = Math.min(
            dp[i - 1][j] + 1,
            dp[i][j - 1] + 1,
            dp[i - 1][j - 1] + 1
          );
        }
      }
    }

    return dp[m][n];
  }

  /**
   * Calculate similarity score between two strings (0-1)
   */
  calculateSimilarity(str1, str2) {
    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();
    
    if (s1 === s2) return 1.0;
    
    const maxLength = Math.max(s1.length, s2.length);
    if (maxLength === 0) return 1.0;
    
    const distance = this.levenshteinDistance(s1, s2);
    return 1 - (distance / maxLength);
  }

  /**
   * Find best matching item from a catalog using fuzzy matching
   */
  findBestMatch(itemName, catalog) {
    let bestMatch = null;
    let bestScore = 0;

    for (const catalogItem of catalog) {
      const score = this.calculateSimilarity(itemName, catalogItem);
      if (score > bestScore && score >= this.fuzzyConfig.threshold) {
        bestScore = score;
        bestMatch = catalogItem;
      }
    }

    return {
      match: bestMatch,
      score: bestScore,
      isFuzzy: bestScore < 1.0
    };
  }

  /**
   * Merge duplicate items that might be the same with typos
   */
  mergeSimilarItems(items, similarityThreshold = 0.85) {
    const merged = [];
    const used = new Set();

    for (let i = 0; i < items.length; i++) {
      if (used.has(i)) continue;

      const current = items[i];
      const group = [current];
      used.add(i);

      for (let j = i + 1; j < items.length; j++) {
        if (used.has(j)) continue;

        const other = items[j];
        const similarity = this.calculateSimilarity(current.name, other.name);

        if (similarity >= similarityThreshold) {
          group.push(other);
          used.add(j);
        }
      }

      // Merge the group
      const mergedItem = {
        name: group[0].name,
        price: group.reduce((sum, item) => sum + item.price, 0) / group.length,
        quantity: group.reduce((sum, item) => sum + item.quantity, 0),
        confidence: Math.max(...group.map(item => item.confidence)) * 0.95,
        mergedFrom: group.length > 1 ? group.map(g => g.raw) : undefined
      };

      merged.push(mergedItem);
    }

    return merged;
  }
}

// ==================== EXPORT ====================

// Create singleton instance
const receiptParser = new ReceiptParser();

/**
 * Main parse function - extracts structured data from raw OCR text
 * @param {string} text - Raw OCR text from receipt
 * @returns {object} Structured receipt data
 */
function parseReceiptText(text) {
  return receiptParser.parseReceiptText(text);
}

/**
 * Extract items from receipt lines
 * @param {string[]} lines - Array of receipt lines
 * @returns {array} Array of item objects
 */
function extractItems(lines) {
  return receiptParser.extractItems(lines);
}

/**
 * Categorize a single line
 * @param {string} line - Receipt line
 * @returns {object} {type, data}
 */
function categorizeLine(line) {
  return receiptParser.categorizeLine(line);
}

/**
 * Parse price string to number
 * @param {string} priceStr - Price string
 * @returns {number} Parsed price
 */
function parsePrice(priceStr) {
  return receiptParser.parsePrice(priceStr);
}

/**
 * Calculate similarity between two strings
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} Similarity score (0-1)
 */
function calculateSimilarity(str1, str2) {
  return receiptParser.calculateSimilarity(str1, str2);
}

/**
 * Merge similar items in a receipt
 * @param {array} items - Array of item objects
 * @param {number} threshold - Similarity threshold (default 0.85)
 * @returns {array} Merged items
 */
function mergeSimilarItems(items, threshold = 0.85) {
  return receiptParser.mergeSimilarItems(items, threshold);
}

// Export for different module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ReceiptParser,
    parseReceiptText,
    extractItems,
    categorizeLine,
    parsePrice,
    calculateSimilarity,
    mergeSimilarItems
  };
}

// Browser global
if (typeof window !== 'undefined') {
  window.SplittOCR = {
    ReceiptParser,
    parseReceiptText,
    extractItems,
    categorizeLine,
    parsePrice,
    calculateSimilarity,
    mergeSimilarItems
  };
}

// ==================== TEST EXAMPLES ====================

const testReceipts = {
  simple: `Joe's Restaurant
123 Main St
Date: 2024-01-15

2x Chicken Wings $24.00
Caesar Salad $12.50
Soda $3.00

Subtotal: $39.50
Tax (8%): $3.16
Tip: $8.00
Total: $50.66`,

  dotted: `BURGER PALACE
Order #12345
01/15/2024

CHICKEN WINGS..............$24.00
CHEESE BURGER..............$15.50
FRENCH FRIES...............$6.00

Subtotal: $45.50
Tax: $3.64
Total: $49.14`,

  messy: `Cafe Roma
2024-01-15

@2 Wings $24
Salad 12.5
Drink 3.00

Tax 4.00
Tip 10.00
Total 64.00`
};

// Run tests if executed directly
if (typeof require !== 'undefined' && require.main === module) {
  console.log('=== SPLITT OCR Parser Tests ===\n');
  
  for (const [name, receipt] of Object.entries(testReceipts)) {
    console.log(`\n--- Test: ${name} ---`);
    console.log('Input:', receipt.substring(0, 50) + '...');
    
    const result = parseReceiptText(receipt);
    
    console.log('Output:');
    console.log('  Merchant:', result.merchant || '(not detected)');
    console.log('  Date:', result.date || '(not detected)');
    console.log('  Items:', result.items.length);
    result.items.forEach(item => {
      console.log(`    - ${item.name}: $${item.price.toFixed(2)} x${item.quantity} (conf: ${item.confidence})`);
    });
    console.log('  Subtotal:', result.subtotal.toFixed(2));
    console.log('  Tax:', result.tax.toFixed(2));
    console.log('  Tip:', result.tip.toFixed(2));
    console.log('  Total:', result.total.toFixed(2));
    console.log('  Confidence:', result.confidence);
  }
}
