/**
 * SPLITT - Receipt OCR Parser
 * Extracts structured data from receipt OCR text
 */

class ReceiptParser {
  constructor() {
    this.patterns = {
      // Currency symbols
      currency: /[$€£]/,
      
      // Price patterns: handles $24.00, 24.00, 24,00, etc.
      price: /[$€£]?\s*(\d{1,3}(?:[,\.]\d{3})*|\d+)(?:[\.,](\d{2}))?/,
      
      // Quantity patterns: 2x, 2*, qty: 2, @ 2
      quantity: /^(\d+)\s*[@x×\*]\s*|^@?\s*(\d+)\s*[:\-]?\s*|^qty[:\s]*(\d+)/i,
      
      // Item with dots: CHICKEN WINGS..............$24.00
      dottedItem: /^(.+?)[\.\s\-_]{3,}\s*[$€£]?(\d[\d,\.]+)/i,
      
      // Standard item line: (Qty) Name (Price)
      itemLine: /^(?:(\d+)\s*[@x×\*]\s*)?(.+?)(?:\s+[$€£]?(\d[0-9,\.]+)\s*$)/i,
      
      // Summary lines
      subtotal: /^(?:sub[-\s]?total|subttl|before\s*tax|net|pre[-\s]?tax)[:\s]*[$€£]?(\d[0-9,\.]+)/i,
      tax: /^(?:tax|vat|gst|hst|sales\s*tax)(?:\s*\(?\d*[%\s)]*)?[:\s]*[$€£]?(\d[0-9,\.]+)/i,
      tip: /^(?:tip|gratuity|service\s*charge)[:\s]*[$€£]?(\d[0-9,\.]+)/i,
      total: /^(?:total|amount\s*due|balance\s*due|grand\s*total)[:\s]*[$€£]?(\d[0-9,\.]+)/i,
      
      // Metadata
      date: /(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*\d{1,2},?\s*\d{4})/i,
      merchant: /^[A-Z][A-Za-z0-9\s&'\-]+(?:LLC|Inc|Ltd|Corp|Restaurant|Cafe|Store|Shop|Market)?$/,
      
      // Lines to skip during item extraction
      skip: /^(?:receipt|invoice|order|ticket|cashier|server|table|guest|thank|call|visit|www\.|http|tel|phone|fax|email)/i
    };
    
    this.fuzzyThreshold = 0.8;
  }

  /**
   * 1. parseReceiptText(text) - main entry point
   */
  parseReceiptText(text) {
    if (!text) return this.createEmptyReceipt();
    
    const allLines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    const itemLines = allLines.filter(line => !this.patterns.skip.test(line));
    
    const items = this.extractItems(itemLines);
    const summary = this.extractSummary(itemLines);
    const metadata = this.extractMetadata(allLines);

    return {
      merchant: metadata.merchant,
      date: metadata.date,
      items: items,
      tax: summary.tax,
      tip: summary.tip,
      total: summary.total,
      subtotal: summary.subtotal,
      confidence: this.calculateConfidence(items, summary)
    };
  }

  /**
   * 2. extractItems(lines) - identifies item lines vs tax/tip/total
   */
  extractItems(lines) {
    const items = [];
    for (const line of lines) {
      const cat = this.categorizeLine(line);
      if (cat.type === 'item') {
        items.push({
          name: this.cleanItemName(cat.data.name),
          price: cat.data.price,
          quantity: cat.data.quantity || 1,
          confidence: cat.data.confidence
        });
      }
    }
    return items;
  }

  /**
   * 3. categorizeLine(line) - returns {type, data}
   */
  categorizeLine(line) {
    // Check summary types first
    const taxMatch = line.match(this.patterns.tax);
    if (taxMatch) return { type: 'tax', data: { amount: this.parsePrice(taxMatch[1]) } };
    
    const tipMatch = line.match(this.patterns.tip);
    if (tipMatch) return { type: 'tip', data: { amount: this.parsePrice(tipMatch[1]) } };
    
    const totalMatch = line.match(this.patterns.total);
    if (totalMatch) return { type: 'total', data: { amount: this.parsePrice(totalMatch[1]) } };
    
    const subtotalMatch = line.match(this.patterns.subtotal);
    if (subtotalMatch) return { type: 'subtotal', data: { amount: this.parsePrice(subtotalMatch[1]) } };

    // Check for dotted items
    const dottedMatch = line.match(this.patterns.dottedItem);
    if (dottedMatch) {
      const name = dottedMatch[1].trim();
      const price = this.parsePrice(dottedMatch[2]);
      if (this.isValidItemName(name)) {
        return { 
          type: 'item', 
          data: { 
            name: this.removeQuantityFromName(name, 1), 
            price, 
            quantity: this.extractQuantity(name), 
            confidence: 0.92 
          } 
        };
      }
    }

    // Standard item line
    const itemMatch = line.match(this.patterns.itemLine);
    if (itemMatch) {
      const qtyStr = itemMatch[1];
      const rawName = itemMatch[2].trim();
      const price = this.parsePrice(itemMatch[3]);
      const qty = qtyStr ? parseInt(qtyStr, 10) : this.extractQuantity(rawName);
      const name = this.removeQuantityFromName(rawName, qty);
      
      if (this.isValidItemName(name)) {
        return { 
          type: 'item', 
          data: { name, price, quantity: qty, confidence: qtyStr ? 0.95 : 0.85 } 
        };
      }
    }

    return { type: 'unknown', data: {} };
  }

  // --- Helper Functions ---

  extractSummary(lines) {
    const summary = { tax: 0, tip: 0, total: 0, subtotal: 0 };
    for (const line of lines) {
      const cat = this.categorizeLine(line);
      if (summary[cat.type] !== undefined) {
        summary[cat.type] = cat.data.amount;
      }
    }
    return summary;
  }

  extractMetadata(lines) {
    let merchant = "Unknown Restaurant";
    let date = "";
    
    // Merchant: Usually in first 3 lines
    for (let i = 0; i < Math.min(3, lines.length); i++) {
      if (this.patterns.merchant.test(lines[i]) && !this.patterns.date.test(lines[i])) {
        merchant = lines[i];
        break;
      }
    }
    
    // Date: Look anywhere
    for (const line of lines) {
      const cleanLine = line.replace(/^date\s*:\s*/i, '');
      const match = cleanLine.match(this.patterns.date);
      if (match) {
        date = this.normalizeDate(match[1]);
        break;
      }
    }
    return { merchant, date };
  }

  parsePrice(str) {
    if (!str) return 0;
    // Remove symbols and handle thousand separators (assume last dot/comma is decimal)
    let clean = str.replace(/[$€£\s]/g, '').replace(/,/g, '');
    const val = parseFloat(clean);
    return isNaN(val) ? 0 : val;
  }

  extractQuantity(text) {
    const match = text.match(this.patterns.quantity);
    return match ? parseInt(match[1] || match[2] || match[3], 10) : 1;
  }

  removeQuantityFromName(name, qty) {
    let n = name.replace(/^@\s*/, '');
    if (qty > 1) {
      n = n.replace(/^\d+\s*[@x×\*:]\s*/i, '').replace(/^qty[:\s]*\d+\s*/i, '').replace(/^\d+\s+/, '');
    }
    return n.trim();
  }

  cleanItemName(name) {
    return name.replace(/\s+/g, ' ').replace(/^[\s\-]+|[\s\-]+$/g, '').trim()
      .toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  }

  isValidItemName(name) {
    if (!name || name.length < 2 || /^[\d\W]+$/.test(name)) return false;
    // Filter out common summary/address keywords
    if (/^(total|subtotal|tax|tip|cash|card|payment|date|address)$/i.test(name.trim())) return false;
    if (/^\d+\s+(main|street|st|ave|road|rd|drive|dr)/i.test(name)) return false;
    return true;
  }

  normalizeDate(str) {
    try {
      const d = new Date(str);
      if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
    } catch(e) {}
    // Fallback regex normalization
    const iso = str.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) return `${iso[1]}-${iso[2].padStart(2,'0')}-${iso[3].padStart(2,'0')}`;
    return str;
  }

  calculateConfidence(items, summary) {
    if (items.length === 0) return 0;
    const itemConf = items.reduce((s, i) => s + i.confidence, 0) / items.length;
    
    // Cross-check items vs total
    const itemsSum = items.reduce((s, i) => s + (i.price * i.quantity), 0);
    let totalConf = 1.0;
    if (summary.total > 0) {
      const calculated = itemsSum + summary.tax + summary.tip;
      const diff = Math.abs(calculated - summary.total);
      if (diff > 0.05) totalConf = 0.7; // Minor discrepancy
      if (diff > 1.00) totalConf = 0.5; // Major discrepancy
    }
    
    return Math.round((itemConf * 0.7 + totalConf * 0.3) * 100) / 100;
  }

  /**
   * Fuzzy string matching (Levenshtein Distance)
   */
  levenshtein(a, b) {
    const tmp = [];
    for (let i = 0; i <= a.length; i++) tmp[i] = [i];
    for (let j = 0; j <= b.length; j++) tmp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        tmp[i][j] = Math.min(
          tmp[i - 1][j] + 1,
          tmp[i][j - 1] + 1,
          tmp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
    }
    return tmp[a.length][b.length];
  }
}

const parser = new ReceiptParser();

// Exports
module.exports = {
  ReceiptParser,
  parseReceiptText: (text) => parser.parseReceiptText(text),
  extractItems: (lines) => parser.extractItems(lines),
  categorizeLine: (line) => parser.categorizeLine(line)
};

// --- CLI Test Runner ---
if (require.main === module) {
  const sample = `
    Joe's Restaurant
    123 Main St, NY
    Date: 2024-01-15

    2x Chicken Wings $24.00
    Wings $12.00
    CHICKEN WINGS..............$24.00
    Subtotal: $50.00
    Tax (8%): $4.00
    Tip: $10.00
    Total: $64.00
  `;
  
  console.log(JSON.stringify(parser.parseReceiptText(sample), null, 2));
}
