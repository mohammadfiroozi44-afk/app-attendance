/**
 * تنخواه‌یار — Google Apps Script backend.
 *
 * Completely independent from the تردد‌یار (attendance) backend: deploy this as its own
 * script bound to its own new Google Sheet, with its own Web App URL. It shares no sheet,
 * no script project, and no employee/login list with the attendance app.
 *
 * Sheets are created automatically on first run:
 *   - Employees:    ID | Name | Username | PasswordHash | Role | Active | CreatedAt
 *   - Transactions: ID | DateTime | Type | FromID | FromName | ToID | ToName | Amount | Category | Description | CreatedByUsername | Voided | CreatedAt
 *
 * See SETUP.md in the same folder for step-by-step deployment instructions.
 */

var APP_VERSION = '1.0.0';
var COMPANY_ID = 'COMPANY';
var COMPANY_NAME = 'صندوق شرکت';
var TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h

// ---------- Entry points ----------

function doGet(e) {
  return handle(e, 'GET');
}
function doPost(e) {
  return handle(e, 'POST');
}

function handle(e, method) {
  var action = '';
  var params = {};
  try {
    if (method === 'GET') {
      params = e.parameter || {};
      action = params.action || '';
    } else {
      var body = (e.postData && e.postData.contents) ? JSON.parse(e.postData.contents) : {};
      params = body;
      action = body.action || '';
    }
    var result = route(action, params);
    return jsonOut(result);
  } catch (err) {
    return jsonOut({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function route(action, p) {
  switch (action) {
    case 'ping':
      return { ok: true, version: APP_VERSION };
    case 'setupAdmin':
      return setupAdmin(p);
    case 'login':
      return login(p);

    // everything below requires a valid token
    case 'getEmployees':
      return withAuth(p, true, function (me) { return getEmployeesList(); });
    case 'getEmployeeDirectory':
      return withAuth(p, false, function (me) { return getEmployeeDirectory(me); });
    case 'addEmployee':
      return withAuth(p, true, function (me) { return addEmployee(p); });
    case 'setEmployeeActive':
      return withAuth(p, true, function (me) { return setEmployeeActive(p); });
    case 'resetPassword':
      return withAuth(p, true, function (me) { return resetPassword(p); });
    case 'changeMyPassword':
      return withAuth(p, false, function (me) { return changeMyPassword(me, p); });
    case 'addTransaction':
      return withAuth(p, false, function (me) { return addTransaction(me, p); });
    case 'voidTransaction':
      return withAuth(p, true, function (me) { return voidTransaction(p); });
    case 'setReceiptStatus':
      return withAuth(p, true, function (me) { return setReceiptStatus(p); });
    case 'getTransactions':
      return withAuth(p, false, function (me) { return getTransactionsList(me, p); });
    case 'getBalance':
      return withAuth(p, false, function (me) { return getBalanceFor(me, p); });
    case 'getSummary':
      return withAuth(p, false, function (me) { return getSummary(me, p); });

    default:
      return { ok: false, error: 'عملیات نامعتبر: ' + action };
  }
}

// ---------- Auth ----------

function getSecret_() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('TOKEN_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('TOKEN_SECRET', secret);
  }
  return secret;
}

function signToken_(payloadObj) {
  var payload = JSON.stringify(payloadObj);
  var payloadB64 = Utilities.base64EncodeWebSafe(payload);
  var sigBytes = Utilities.computeHmacSha256Signature(payloadB64, getSecret_());
  var sigB64 = Utilities.base64EncodeWebSafe(sigBytes);
  return payloadB64 + '.' + sigB64;
}

function verifyToken_(token) {
  if (!token || token.indexOf('.') === -1) return null;
  var parts = token.split('.');
  var payloadB64 = parts[0], sigB64 = parts[1];
  var expectedSig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payloadB64, getSecret_()));
  if (expectedSig !== sigB64) return null;
  var payload;
  try { payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(payloadB64)).getDataAsString()); }
  catch (e) { return null; }
  if (!payload || !payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

function withAuth(p, requireAdmin, fn) {
  var payload = verifyToken_(p.token);
  if (!payload) return { ok: false, error: 'ورود منقضی شده — دوباره وارد شوید', authError: true };
  var emp = findEmployeeById_(payload.id);
  if (!emp || emp.active !== true) return { ok: false, error: 'کاربر غیرفعال یا حذف‌شده', authError: true };
  if (requireAdmin && emp.role !== 'admin') return { ok: false, error: 'این عملیات فقط برای مدیر مجاز است' };
  return fn(emp);
}

function setupAdmin(p) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = employeesSheet_();
    var rows = sh.getDataRange().getValues();
    if (rows.length > 1) return { ok: false, error: 'راه‌اندازی قبلاً انجام شده — یک مدیر از قبل وجود دارد' };
    var setupKey = PropertiesService.getScriptProperties().getProperty('SETUP_KEY') || 'CHANGE_ME';
    if (!p.setupKey || p.setupKey !== setupKey) return { ok: false, error: 'کلید راه‌اندازی نادرست است' };
    if (!p.name || !p.username || !p.passwordHash) return { ok: false, error: 'نام، نام‌کاربری و رمز عبور لازم است' };
    var id = Utilities.getUuid();
    sh.appendRow([id, p.name, String(p.username).toLowerCase(), p.passwordHash, 'admin', true, new Date().toISOString()]);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function login(p) {
  var emp = findEmployeeByUsername_(p.username);
  if (!emp || emp.active !== true || emp.passwordHash !== p.passwordHash) {
    return { ok: false, error: 'نام‌کاربری یا رمز عبور اشتباه است' };
  }
  var exp = Date.now() + TOKEN_TTL_MS;
  var token = signToken_({ id: emp.id, role: emp.role, exp: exp });
  return { ok: true, token: token, expiresAt: exp, employee: publicEmployee_(emp) };
}

function changeMyPassword(me, p) {
  if (!p.oldPasswordHash || !p.newPasswordHash) return { ok: false, error: 'اطلاعات ناقص' };
  var sh = employeesSheet_();
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === me.id) {
      if (data[i][3] !== p.oldPasswordHash) return { ok: false, error: 'رمز فعلی اشتباه است' };
      sh.getRange(i + 1, 4).setValue(p.newPasswordHash);
      return { ok: true };
    }
  }
  return { ok: false, error: 'کاربر یافت نشد' };
}

// ---------- Employees ----------

function employeesSheet_() {
  return getOrCreateSheet_('Employees', ['ID', 'Name', 'Username', 'PasswordHash', 'Role', 'Active', 'CreatedAt']);
}

function rowToEmployee_(row) {
  return { id: row[0], name: row[1], username: row[2], passwordHash: row[3], role: row[4], active: row[5] === true || row[5] === 'TRUE', createdAt: row[6] };
}

function publicEmployee_(emp) {
  return { id: emp.id, name: emp.name, username: emp.username, role: emp.role, active: emp.active };
}

function allEmployees_() {
  var sh = employeesSheet_();
  var data = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    out.push(rowToEmployee_(data[i]));
  }
  return out;
}

function findEmployeeById_(id) {
  var list = allEmployees_();
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

function findEmployeeByUsername_(username) {
  if (!username) return null;
  var uname = String(username).toLowerCase();
  var list = allEmployees_();
  for (var i = 0; i < list.length; i++) if (list[i].username === uname) return list[i];
  return null;
}

function getEmployeesList() {
  var employees = allEmployees_();
  var balances = computeAllBalances_();
  var out = employees.map(function (emp) {
    var pub = publicEmployee_(emp);
    pub.balance = balances[emp.id] || 0;
    return pub;
  });
  return { ok: true, employees: out };
}

// Every logged-in user (not just admins) needs to see the names of active coworkers to pick
// a recipient for a transfer, without exposing usernames, roles or balances.
function getEmployeeDirectory(me) {
  var employees = allEmployees_().filter(function (e) { return e.active && e.id !== me.id; });
  return { ok: true, employees: employees.map(function (e) { return { id: e.id, name: e.name }; }) };
}

function addEmployee(p) {
  if (!p.name || !p.username || !p.passwordHash) return { ok: false, error: 'نام، نام‌کاربری و رمز عبور لازم است' };
  var uname = String(p.username).toLowerCase();
  if (findEmployeeByUsername_(uname)) return { ok: false, error: 'این نام‌کاربری قبلاً ثبت شده' };
  var role = (p.role === 'admin') ? 'admin' : 'employee';
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = employeesSheet_();
    var id = Utilities.getUuid();
    sh.appendRow([id, p.name, uname, p.passwordHash, role, true, new Date().toISOString()]);
    return { ok: true, id: id };
  } finally {
    lock.releaseLock();
  }
}

function setEmployeeActive(p) {
  if (!p.id) return { ok: false, error: 'شناسه لازم است' };
  var sh = employeesSheet_();
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === p.id) {
      sh.getRange(i + 1, 6).setValue(p.active === false ? false : true);
      return { ok: true };
    }
  }
  return { ok: false, error: 'کارمند یافت نشد' };
}

function resetPassword(p) {
  if (!p.id || !p.newPasswordHash) return { ok: false, error: 'اطلاعات ناقص' };
  var sh = employeesSheet_();
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === p.id) {
      sh.getRange(i + 1, 4).setValue(p.newPasswordHash);
      return { ok: true };
    }
  }
  return { ok: false, error: 'کارمند یافت نشد' };
}

// ---------- Transactions ----------

function transactionsSheet_() {
  return getOrCreateSheet_('Transactions', ['ID', 'DateTime', 'Type', 'FromID', 'FromName', 'ToID', 'ToName', 'Amount', 'Category', 'Description', 'CreatedByUsername', 'Voided', 'CreatedAt', 'VoucherNo', 'Counterparty', 'ReceiptStatus', 'ReceiptImageUrl']);
}

// A single running voucher number across every transaction type, mirroring "شماره سند" in
// the user's existing spreadsheet — lets them cite one short number instead of a UUID.
function nextVoucherNo_(sh) {
  var data = sh.getDataRange().getValues();
  var max = 0;
  for (var i = 1; i < data.length; i++) {
    var v = Number(data[i][13]);
    if (!isNaN(v) && v > max) max = v;
  }
  return max + 1;
}

var VALID_TYPES = ['receipt', 'payment', 'transfer', 'expense'];

function addTransaction(me, p) {
  var type = p.type;
  if (VALID_TYPES.indexOf(type) === -1) return { ok: false, error: 'نوع تراکنش نامعتبر است' };
  var amount = Number(p.amount);
  if (!amount || amount <= 0) return { ok: false, error: 'مبلغ باید عددی مثبت باشد' };

  var fromId, fromName, toId, toName;

  if (type === 'receipt') {
    // company -> employee. Admin only.
    if (me.role !== 'admin') return { ok: false, error: 'ثبت دریافتی فقط برای مدیر مجاز است' };
    var toEmp = findEmployeeById_(p.toId);
    if (!toEmp) return { ok: false, error: 'کارمند گیرنده یافت نشد' };
    fromId = COMPANY_ID; fromName = COMPANY_NAME;
    toId = toEmp.id; toName = toEmp.name;
  } else if (type === 'payment') {
    // employee -> company (e.g. returning unused tankhah). Admin only.
    if (me.role !== 'admin') return { ok: false, error: 'ثبت پرداختی فقط برای مدیر مجاز است' };
    var fromEmp = findEmployeeById_(p.fromId);
    if (!fromEmp) return { ok: false, error: 'کارمند پرداخت‌کننده یافت نشد' };
    fromId = fromEmp.id; fromName = fromEmp.name;
    toId = COMPANY_ID; toName = COMPANY_NAME;
  } else if (type === 'transfer') {
    // employee -> employee. Employees may only move money out of their own balance;
    // admin may record a transfer between any two employees.
    var srcId = (me.role === 'admin') ? p.fromId : me.id;
    var srcEmp = findEmployeeById_(srcId);
    var dstEmp = findEmployeeById_(p.toId);
    if (!srcEmp || !dstEmp) return { ok: false, error: 'کارمند مبدا یا مقصد یافت نشد' };
    if (srcEmp.id === dstEmp.id) return { ok: false, error: 'مبدا و مقصد نمی‌توانند یکی باشند' };
    fromId = srcEmp.id; fromName = srcEmp.name;
    toId = dstEmp.id; toName = dstEmp.name;
  } else if (type === 'expense') {
    // employee spends from their own tankhah. Employees record for themselves; admin may
    // record on behalf of anyone.
    var spenderId = (me.role === 'admin' && p.fromId) ? p.fromId : me.id;
    var spender = findEmployeeById_(spenderId);
    if (!spender) return { ok: false, error: 'کارمند یافت نشد' };
    if (!p.category) return { ok: false, error: 'دسته‌بندی خرج لازم است' };
    fromId = spender.id; fromName = spender.name;
    toId = null; toName = null;
  }

  if (type === 'expense' && !p.description) return { ok: false, error: 'توضیحات خرج لازم است' };

  // "طرف‌حساب" — who the money was effectively paid to/for. Usually the same person as
  // fromName/toName, but real usage sometimes differs (e.g. one person's tankhah covers an
  // expense attributed to a colleague or to the company) — mirrors the source spreadsheet.
  var counterparty = (p.counterparty && String(p.counterparty).trim()) || fromName || toName || '';
  var receiptStatus = (type === 'expense') ? 'pending' : '';
  var receiptImageUrl = '';
  var warning = '';
  if (type === 'expense' && p.receiptImageBase64) {
    try {
      receiptImageUrl = uploadReceiptImage_(p.receiptImageBase64, p.receiptImageMime || 'image/jpeg');
    } catch (err) {
      warning = 'تراکنش ثبت شد ولی آپلود عکس رسید ناموفق بود: ' + String(err && err.message ? err.message : err);
    }
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = transactionsSheet_();
    var id = Utilities.getUuid();
    var now = new Date();
    var voucherNo = nextVoucherNo_(sh);
    sh.appendRow([id, now.toISOString(), type, fromId || '', fromName || '', toId || '', toName || '', amount, p.category || '', p.description || '', me.username, false, now.toISOString(), voucherNo, counterparty, receiptStatus, receiptImageUrl]);
    var result = { ok: true, id: id, voucherNo: voucherNo };
    if (warning) result.warning = warning;
    return result;
  } finally {
    lock.releaseLock();
  }
}

// ---------- Receipt photo storage (Google Drive) ----------

function getOrCreateReceiptsFolder_() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty('RECEIPTS_FOLDER_ID');
  if (folderId) {
    try { return DriveApp.getFolderById(folderId); } catch (e) { /* fall through and recreate */ }
  }
  var folder = DriveApp.createFolder('تنخواه‌یار - رسیدها');
  props.setProperty('RECEIPTS_FOLDER_ID', folder.getId());
  return folder;
}

// Stores the photo and returns a directly embeddable URL. Sharing is set to "anyone with the
// link" because the frontend renders it in a plain <img>/<a> with no Google auth of its own —
// acceptable for this internal tool, but worth knowing: the link isn't password-protected.
function uploadReceiptImage_(base64Data, mimeType) {
  var folder = getOrCreateReceiptsFolder_();
  var bytes = Utilities.base64Decode(base64Data);
  var blob = Utilities.newBlob(bytes, mimeType, 'receipt-' + Date.now() + '.jpg');
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://drive.google.com/uc?export=view&id=' + file.getId();
}

function setReceiptStatus(p) {
  if (!p.id || (p.status !== 'received' && p.status !== 'pending')) return { ok: false, error: 'اطلاعات نامعتبر' };
  var sh = transactionsSheet_();
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === p.id) {
      sh.getRange(i + 1, 16).setValue(p.status);
      return { ok: true };
    }
  }
  return { ok: false, error: 'تراکنش یافت نشد' };
}

function voidTransaction(p) {
  if (!p.id) return { ok: false, error: 'شناسه لازم است' };
  var sh = transactionsSheet_();
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === p.id) {
      sh.getRange(i + 1, 12).setValue(true);
      return { ok: true };
    }
  }
  return { ok: false, error: 'تراکنش یافت نشد' };
}

function allTransactions_(includeVoided) {
  var sh = transactionsSheet_();
  var data = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (!row[0]) continue;
    var voided = row[11] === true || row[11] === 'TRUE';
    if (voided && !includeVoided) continue;
    out.push({
      id: row[0], dateTime: row[1], type: row[2],
      fromId: row[3], fromName: row[4], toId: row[5], toName: row[6],
      amount: Number(row[7]), category: row[8], description: row[9],
      createdBy: row[10], voided: voided, createdAt: row[12],
      voucherNo: row[13] || null, counterparty: row[14] || '', receiptStatus: row[15] || '', receiptImageUrl: row[16] || ''
    });
  }
  return out;
}

function computeAllBalances_() {
  var txs = allTransactions_(false);
  var balances = {};
  txs.forEach(function (t) {
    if (t.fromId && t.fromId !== COMPANY_ID) balances[t.fromId] = (balances[t.fromId] || 0) - t.amount;
    if (t.toId && t.toId !== COMPANY_ID) balances[t.toId] = (balances[t.toId] || 0) + t.amount;
  });
  return balances;
}

function getTransactionsList(me, p) {
  var txs = allTransactions_(me.role === 'admin' && p.includeVoided === true);
  var employeeFilter = p.employeeId;
  if (me.role !== 'admin') {
    // employees only ever see their own transactions, regardless of what was requested
    employeeFilter = me.id;
  }
  if (employeeFilter) {
    txs = txs.filter(function (t) { return t.fromId === employeeFilter || t.toId === employeeFilter; });
  }
  if (p.type) txs = txs.filter(function (t) { return t.type === p.type; });
  if (p.dateFrom) txs = txs.filter(function (t) { return t.dateTime >= p.dateFrom; });
  if (p.dateTo) txs = txs.filter(function (t) { return t.dateTime <= p.dateTo; });
  txs.sort(function (a, b) { return b.dateTime < a.dateTime ? -1 : (b.dateTime > a.dateTime ? 1 : 0); });
  return { ok: true, transactions: txs };
}

function getBalanceFor(me, p) {
  var targetId = (me.role === 'admin' && p.employeeId) ? p.employeeId : me.id;
  var balances = computeAllBalances_();
  return { ok: true, employeeId: targetId, balance: balances[targetId] || 0 };
}

function getSummary(me, p) {
  var balances = computeAllBalances_();
  if (me.role !== 'admin') {
    return { ok: true, myBalance: balances[me.id] || 0 };
  }
  var employees = allEmployees_().filter(function (e) { return e.active; });
  var totalHeld = 0;
  employees.forEach(function (e) { totalHeld += (balances[e.id] || 0); });
  var txs = allTransactions_(false);
  var totalReceipts = 0, totalExpenses = 0, totalPayments = 0;
  txs.forEach(function (t) {
    if (t.type === 'receipt') totalReceipts += t.amount;
    else if (t.type === 'expense') totalExpenses += t.amount;
    else if (t.type === 'payment') totalPayments += t.amount;
  });
  return { ok: true, totalHeld: totalHeld, totalReceipts: totalReceipts, totalExpenses: totalExpenses, totalPayments: totalPayments, employeeCount: employees.length };
}

// ---------- Sheet helpers ----------

function getOrCreateSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  }
  return sh;
}
