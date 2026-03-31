// ══════════════════════════════════════════════════════════════════════════════
// OVB Closeout & Warranty Tracker — Google Apps Script
// ══════════════════════════════════════════════════════════════════════════════
//
// SETUP — DO THIS ONCE (takes about 3 minutes):
//
//  STEP 1 — Create the sheet
//    • Go to sheets.google.com → create a new blank sheet
//    • Name it: OVB Closeout Tracker
//    • Leave all tabs empty — setupSheet() builds everything
//
//  STEP 2 — Paste this script
//    • In the sheet: Extensions → Apps Script
//    • Delete all existing code and paste this entire file
//    • Click the floppy disk icon to save (Ctrl/Cmd + S)
//
//  STEP 3 — Run setupSheet (builds all tabs + headers)
//    • In the function dropdown (top toolbar), select: setupSheet
//    • Click ▶ Run
//    • Approve permissions when prompted (Google will ask once)
//    • You should see "Sheet setup complete." in the execution log
//
//  STEP 4 — Deploy as Web App
//    • Click Deploy → New Deployment
//    • Type: Web App
//    • Execute as: Me
//    • Who has access: Anyone
//    • Click Deploy → copy the Web App URL
//
//  STEP 5 — Wire it to the tool
//    • Open OVB-Closeout-Tracker.html in a text editor
//    • Find:  const SCRIPT_URL = 'YOUR_APPS_SCRIPT_URL_HERE';
//    • Replace with your Web App URL
//    • Save and upload to GitHub → Vercel auto-deploys
//
//  FUTURE EDITS — if you change this script:
//    • Deploy → Manage Deployments → pencil icon → Version: New Version → Deploy
//    • The URL stays the same. No changes needed in the HTML.
//
// ══════════════════════════════════════════════════════════════════════════════


// ── Schema ────────────────────────────────────────────────────────────────────

var SCHEMA = {
  Projects: {
    headers: ['id', 'client', 'address', 'projectType', 'closeDate', 'pm', 'createdAt', 'warrantyMonths', 'warrantyNote'],
    widths:  [180,  200,      280,       140,            110,         160,  160,         110,              300],
    labels:  ['ID', 'Client', 'Address', 'Project Type', 'Close Date', 'PM', 'Created At', 'Warranty Mo', 'Warranty Note']
  },
  WeOwes: {
    headers: ['id', 'projectId', 'description', 'trade', 'priority', 'status', 'cost', 'dueDate', 'assignedTo', 'internalNotes', 'completedDate', 'createdAt'],
    widths:  [180,  180,         320,           120,     90,         110,      90,     100,        160,          260,             110,             160],
    labels:  ['ID', 'Project ID', 'Description', 'Trade', 'Priority', 'Status', 'Cost', 'Due Date', 'Assigned To', 'Internal Notes', 'Completed', 'Created At']
  },
  Punchlist: {
    headers: ['id', 'projectId', 'description', 'trade', 'priority', 'status', 'dueDate', 'responsibleParty', 'subName', 'recoveryStatus', 'recoveryAmount', 'assignedTo', 'internalNotes', 'completedDate', 'createdAt'],
    widths:  [180,  180,         320,           120,     90,         110,      100,        140,                180,       130,              110,              160,          260,             110,             160],
    labels:  ['ID', 'Project ID', 'Description', 'Trade', 'Priority', 'Status', 'Due Date', 'Responsible Party', 'Sub Name', 'Recovery Status', 'Recovery Amt', 'Assigned To', 'Internal Notes', 'Completed', 'Created At']
  },
  Warranty: {
    headers: ['id', 'projectId', 'description', 'trade', 'priority', 'status', 'requestDate', 'responseDate', 'resolutionDate', 'responsibleParty', 'subName', 'recoveryStatus', 'recoveryAmount', 'assignedTo', 'internalNotes', 'completedDate', 'createdAt'],
    widths:  [180,  180,         320,           120,     90,         110,      110,            110,            110,              140,                180,       130,              110,              160,          260,             110,             160],
    labels:  ['ID', 'Project ID', 'Description', 'Trade', 'Priority', 'Status', 'Request Date', 'Response Date', 'Resolution Date', 'Responsible Party', 'Sub Name', 'Recovery Status', 'Recovery Amt', 'Assigned To', 'Internal Notes', 'Completed', 'Created At']
  }
};

var TAB_ORDER = ['Projects', 'WeOwes', 'Punchlist', 'Warranty'];

// OVB colors
var COLOR_BG     = '#1E1C1A';
var COLOR_TAN    = '#C7AA8B';
var COLOR_WHITE  = '#FFFFFF';
var COLOR_BORDER = '#E5E2DF';


// ── setupSheet ────────────────────────────────────────────────────────────────
// Run this once manually from the Apps Script editor.
// Safe to re-run — won't delete existing data, only creates missing tabs.

function setupSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.rename('OVB Closeout Tracker');

  TAB_ORDER.forEach(function(name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
    }
    applyHeaders(sheet, name);
  });

  // Reorder tabs to match TAB_ORDER
  TAB_ORDER.forEach(function(name, i) {
    var sheet = ss.getSheetByName(name);
    if (sheet) ss.setActiveSheet(sheet);
    ss.moveActiveSheet(i + 1);
  });

  // Remove default "Sheet1" if it still exists and is empty
  var defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && defaultSheet.getLastRow() <= 1) {
    ss.deleteSheet(defaultSheet);
  }

  Logger.log('✅ Sheet setup complete. All tabs created and formatted.');
  Logger.log('Next step: Deploy → New Deployment → Web App → Anyone → Deploy → Copy URL');
}


// ── applyHeaders ──────────────────────────────────────────────────────────────
// Writes header row with OVB formatting. Only touches row 1.

function applyHeaders(sheet, tabName) {
  var schema  = SCHEMA[tabName];
  var numCols = schema.labels.length;

  // Write labels
  var headerRange = sheet.getRange(1, 1, 1, numCols);
  headerRange.setValues([schema.labels]);

  // Style
  headerRange
    .setBackground(COLOR_BG)
    .setFontColor(COLOR_TAN)
    .setFontFamily('DM Mono')
    .setFontSize(9)
    .setFontWeight('bold')
    .setVerticalAlignment('middle');

  // Row height
  sheet.setRowHeight(1, 28);

  // Freeze header row
  sheet.setFrozenRows(1);

  // Column widths
  schema.widths.forEach(function(w, i) {
    sheet.setColumnWidth(i + 1, w);
  });

  // Tab color
  sheet.setTabColor(COLOR_BG);
}


// ── ensureTabs ────────────────────────────────────────────────────────────────
// Called on every doGet as a safety net. Creates any missing tabs silently.

function ensureTabs() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  TAB_ORDER.forEach(function(name) {
    if (!ss.getSheetByName(name)) {
      var sheet = ss.insertSheet(name);
      applyHeaders(sheet, name);
    }
  });
}


// ── doGet ─────────────────────────────────────────────────────────────────────

function doGet(e) {
  try {
    ensureTabs();
    var raw     = e.parameter.d
      ? decodeURIComponent(Utilities.newBlob(Utilities.base64Decode(e.parameter.d)).getDataAsString())
      : '{}';
    var payload = JSON.parse(raw);
    var result  = dispatch(payload);
    return respond({ ok: true, data: result });
  } catch (err) {
    return respond({ ok: false, error: err.message });
  }
}

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function dispatch(d) {
  switch (d.action) {
    case 'getProjects':  return getProjects();
    case 'getProject':   return getProject(d.projectId);
    case 'saveProject':  return saveProject(d.project);
    case 'upsertItem':   return upsertItem(d.tab, d.item);
    case 'deleteItem':   return deleteItem(d.tab, d.id);
    default: throw new Error('Unknown action: ' + d.action);
  }
}


// ── Sheet helpers ─────────────────────────────────────────────────────────────

function getSheet(name) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    applyHeaders(sheet, name);
  }
  return sheet;
}

function sheetToObjects(sheetName) {
  var sheet  = getSheet(sheetName);
  var schema = SCHEMA[sheetName];
  var last   = sheet.getLastRow();
  if (last <= 1) return [];
  var vals = sheet.getRange(2, 1, last - 1, schema.headers.length).getValues();
  return vals
    .filter(function(row) { return row[0] && String(row[0]).trim() !== ''; })
    .map(function(row) {
      var obj = {};
      schema.headers.forEach(function(h, i) {
        obj[h] = row[i] !== undefined && row[i] !== null ? String(row[i]) : '';
      });
      return obj;
    });
}

function upsertRow(sheetName, obj) {
  var sheet  = getSheet(sheetName);
  var schema = SCHEMA[sheetName];

  if (!obj.id || String(obj.id).trim() === '') {
    obj.id        = Utilities.getUuid();
    obj.createdAt = new Date().toISOString();
  }

  var last = sheet.getLastRow();
  if (last > 1) {
    var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(obj.id)) {
        // Update existing row
        sheet.getRange(i + 2, 1, 1, schema.headers.length)
          .setValues([schema.headers.map(function(h) { return obj[h] || ''; })]);
        return obj;
      }
    }
  }

  // Append new row
  sheet.appendRow(schema.headers.map(function(h) { return obj[h] || ''; }));
  return obj;
}


// ── Actions ───────────────────────────────────────────────────────────────────

function getProjects() {
  return sheetToObjects('Projects').sort(function(a, b) {
    return b.createdAt.localeCompare(a.createdAt);
  });
}

function getProject(projectId) {
  return {
    weOwes:    sheetToObjects('WeOwes'   ).filter(function(r) { return r.projectId === projectId; }),
    punchlist: sheetToObjects('Punchlist').filter(function(r) { return r.projectId === projectId; }),
    warranty:  sheetToObjects('Warranty' ).filter(function(r) { return r.projectId === projectId; }),
  };
}

function saveProject(proj) {
  return upsertRow('Projects', proj);
}

function upsertItem(tab, item) {
  if (!SCHEMA[tab]) throw new Error('Unknown tab: ' + tab);
  return upsertRow(tab, item);
}

function deleteItem(tab, id) {
  var sheet = getSheet(tab);
  var last  = sheet.getLastRow();
  if (last <= 1) return { deleted: null };
  var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) {
      sheet.deleteRow(i + 2);
      return { deleted: id };
    }
  }
  return { deleted: null };
}
